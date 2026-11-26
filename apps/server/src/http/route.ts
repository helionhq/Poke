import { type Device, DomainError } from "@poke/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from "fastify";
import { z, type ZodType } from "zod";
import type { Services } from "../services.js";

export type Principal = { kind: "device"; device: Device } | { kind: "admin" };
export type AuthMode = "none" | "device" | "share" | "admin";

/** "public": 127.0.0.1:7070 behind the tunnel (device tokens). "admin": the 0600 unix socket. */
export type Surface = "public" | "admin";
export type RouteModule = (app: FastifyInstance, services: Services, surface: Surface) => void;

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface RouteDef<B, Q, P> {
  method: HTTPMethods;
  url: string;
  auth: AuthMode;
  summary?: string;
  body?: ZodType<B>;
  query?: ZodType<Q>;
  params?: ZodType<P>;
  /** Response schema, for the OpenAPI document only. */
  response?: ZodType;
  /** Let the handler read the raw request (multipart). */
  rawBody?: boolean;
}

export interface RouteCtx<B, Q, P> {
  body: B;
  query: Q;
  params: P;
  principal: Principal;
  req: FastifyRequest;
  reply: FastifyReply;
}

export interface RegisteredRoute {
  method: string;
  url: string;
  auth: AuthMode;
  summary?: string;
  body?: ZodType;
  query?: ZodType;
  response?: ZodType;
}

export const routeRegistry: RegisteredRoute[] = [];

/** A route with zod-validated input and a declared auth mode. */
export function route<B = undefined, Q = undefined, P = undefined>(
  app: FastifyInstance,
  def: RouteDef<B, Q, P>,
  handler: (ctx: RouteCtx<B, Q, P>) => unknown,
): void {
  if (!routeRegistry.some((r) => r.method === def.method && r.url === def.url)) {
    const entry: RegisteredRoute = { method: String(def.method), url: def.url, auth: def.auth };
    if (def.summary) entry.summary = def.summary;
    if (def.body) entry.body = def.body;
    if (def.query) entry.query = def.query;
    if (def.response) entry.response = def.response;
    routeRegistry.push(entry);
  }
  app.route({
    method: def.method,
    url: def.url,
    config: { auth: def.auth },
    handler: async (req, reply) => {
      const principal = req.principal;
      if (def.auth !== "none" && !principal)
        throw new DomainError("unauthorized", "Missing or invalid token");
      if (principal?.kind === "device") {
        if (def.auth === "admin")
          throw new DomainError("forbidden", "Admin only (use the poke CLI on Poke's machine)");
        if (def.auth === "device" && principal.device.scope !== "full") {
          throw new DomainError("forbidden", "This token can only share to Poke");
        }
      }
      const body = def.body && !def.rawBody ? parseOr400(def.body, req.body ?? {}) : (undefined as B);
      const query = def.query ? parseOr400(def.query, req.query ?? {}) : (undefined as Q);
      const params = def.params ? parseOr400(def.params, req.params ?? {}) : (undefined as P);
      const result = await handler({
        body,
        query,
        params,
        principal: principal ?? { kind: "admin" },
        req,
        reply,
      });
      if (reply.sent) return reply;
      return result ?? { ok: true };
    },
  });
}

function parseOr400<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new DomainError(
      "invalid",
      result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
    );
  }
  return result.data;
}

export const IdParams = z.object({ id: z.string().min(1) });

/** OpenAPI 3.1 document generated from the registered routes' zod schemas. */
export function openApiDocument(version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routeRegistry) {
    const path = r.url.replace(/:(\w+)/g, "{$1}");
    const op: Record<string, unknown> = {
      summary: r.summary ?? `${r.method} ${r.url}`,
      security: r.auth === "none" ? [] : [{ bearer: [] }],
    };
    if (r.body) {
      op.requestBody = { content: { "application/json": { schema: safeJsonSchema(r.body, "input") } } };
    }
    if (r.query) op["x-query"] = safeJsonSchema(r.query, "input");
    if (r.response) {
      op.responses = {
        200: { content: { "application/json": { schema: safeJsonSchema(r.response, "output") } } },
      };
    } else {
      op.responses = { 200: { description: "OK" } };
    }
    (paths[path] ??= {})[r.method.toLowerCase()] = op;
  }
  return {
    openapi: "3.1.0",
    info: { title: "Poke", version },
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    paths,
  };
}

function safeJsonSchema(schema: ZodType, io: "input" | "output"): unknown {
  try {
    return z.toJSONSchema(schema, { io, unrepresentable: "any" });
  } catch {
    return {};
  }
}
