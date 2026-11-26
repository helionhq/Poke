import {
  CatalogList,
  IntegrationList,
  McpServerAddRequest,
  McpServerList,
  McpServerResponse,
  SERVICE_KEYS,
  type ServiceKey,
  ServiceKeyList,
  ServiceKeySetRequest,
} from "@poke/contracts";
import { DomainError } from "@poke/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireStack, type Services } from "../../services.js";
import { route, type Surface } from "../route.js";

const IdParams = z.object({ id: z.string().min(1).max(64) });
const KeyParams = z.object({ key: z.string().min(1).max(64) });

function serviceKey(key: string): ServiceKey {
  if (!(key in SERVICE_KEYS)) throw new DomainError("not_found", `Unknown service key ${key}`);
  return key as ServiceKey;
}

/** Section 11: connected apps, Executor's catalog, local MCP servers; service keys on the admin socket. */
export function registerIntegrationRoutes(app: FastifyInstance, s: Services, surface: Surface): void {
  route(app, { method: "GET", url: "/v1/integrations", auth: "device", response: IntegrationList }, () => {
    const stack = requireStack(s);
    return {
      integrations: s.db.integrations.list(),
      executor: { configured: stack.executor.configured() },
    };
  });
  route(
    app,
    { method: "GET", url: "/v1/integrations/catalog", auth: "device", response: CatalogList },
    async () => ({ apps: await requireStack(s).integrations.catalog() }),
  );
  route(app, { method: "GET", url: "/v1/integrations/mcp", auth: "device", response: McpServerList }, () => ({
    servers: requireStack(s).integrations.mcpServers(),
  }));
  route(
    app,
    {
      method: "POST",
      url: "/v1/integrations/mcp",
      auth: "device",
      body: McpServerAddRequest,
      response: McpServerResponse,
    },
    async ({ body }) => ({
      server: await requireStack(s).integrations.addMcpServer({
        id: body.id,
        ...(body.name ? { name: body.name } : {}),
        transport: body.transport,
      }),
    }),
  );
  route(
    app,
    { method: "DELETE", url: "/v1/integrations/mcp/:id", auth: "device", params: IdParams },
    async ({ params }) => {
      if (!(await requireStack(s).integrations.removeMcpServer(params.id)))
        throw new DomainError("not_found", `No MCP server called ${params.id}`);
      return { deleted: true };
    },
  );

  if (surface !== "admin") return;
  route(app, { method: "GET", url: "/admin/keys", auth: "admin", response: ServiceKeyList }, () => {
    const system = requireStack(s).vault.system;
    return {
      keys: Object.entries(SERVICE_KEYS).map(([key, label]) => ({
        key,
        label,
        set: system.has(key as ServiceKey),
      })),
    };
  });
  route(
    app,
    { method: "PUT", url: "/admin/keys/:key", auth: "admin", params: KeyParams, body: ServiceKeySetRequest },
    ({ params, body }) => {
      requireStack(s).vault.system.set(serviceKey(params.key), body.value.trim());
      return { saved: true };
    },
  );
  route(
    app,
    { method: "DELETE", url: "/admin/keys/:key", auth: "admin", params: KeyParams },
    ({ params }) => {
      requireStack(s).vault.system.delete(serviceKey(params.key));
      return { deleted: true };
    },
  );
}
