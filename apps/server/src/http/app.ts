import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { MAX_ATTACHMENT_BYTES } from "@poke/application";
import type { Services } from "../services.js";
import { installErrorHandler } from "./errors.js";
import type { AuthMode, RouteModule, Surface } from "./route.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { registerBlockRoutes } from "./routes/blocks.js";
import { registerVaultRoutes } from "./routes/vault.js";
import { registerAttachmentRoutes } from "./routes/attachments.js";
import { registerCoreRoutes } from "./routes/core.js";
import { registerEventsSocket } from "./routes/events.js";
import { registerThreadRoutes } from "./routes/thread.js";

/**
 * One Fastify app per surface: "public" (127.0.0.1:7070 behind the Cloudflare Tunnel, device
 * tokens) and "admin" (the 0600 unix socket the CLI uses; every request is the owner).
 */
export type { RouteModule, Surface };

export async function buildApp(
  services: Services,
  surface: Surface,
  modules: RouteModule[] = [],
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => services.ids.next("run").slice(4),
  });
  installErrorHandler(app, services.log);
  await app.register(websocket, {
    options: {
      maxPayload: 4 * 1024 * 1024,
      // Clients offer ["poke.v1", "poke.bearer.<token>"]; never echo the bearer protocol back.
      handleProtocols: (protocols: Set<string>) => (protocols.has("poke.v1") ? "poke.v1" : false),
    },
  });
  await app.register(multipart, { limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 20, fields: 20 } });

  app.addHook("onRequest", async (req) => {
    if (surface === "admin") {
      req.principal = { kind: "admin" };
      return;
    }
    const token = bearerFrom(req.headers.authorization, req.headers["sec-websocket-protocol"]);
    if (token) {
      const device = services.devices.authenticate(token);
      if (device) req.principal = { kind: "device", device };
    }
    const mode = (req.routeOptions.config as { auth?: AuthMode } | undefined)?.auth;
    if (mode === "admin") return; // the route itself rejects non-admin principals
  });

  app.addHook("onResponse", async (req, reply) => {
    if (reply.statusCode >= 400) {
      services.log.debug({ reqId: req.id, url: req.url.split("?")[0], status: reply.statusCode }, "request");
    }
  });

  registerCoreRoutes(app, services, surface);
  registerThreadRoutes(app, services, surface);
  registerAttachmentRoutes(app, services, surface);
  registerAgentRoutes(app, services, surface);
  registerBlockRoutes(app, services, surface);
  registerVaultRoutes(app, services, surface);
  registerApprovalRoutes(app, services, surface);
  registerEventsSocket(app, services);
  for (const register of modules) register(app, services, surface);
  return app;
}

/** `Authorization: Bearer <token>`, or the WebSocket subprotocol `poke.bearer.<token>`. */
export function bearerFrom(authorization?: string, protocol?: string | string[]): string | undefined {
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim();
  const protocols = Array.isArray(protocol) ? protocol.join(",") : protocol;
  const match = protocols
    ?.split(",")
    .map((p) => p.trim())
    .find((p) => p.startsWith("poke.bearer."));
  return match?.slice("poke.bearer.".length);
}
