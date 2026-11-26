import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { buildApp, type RouteModule } from "./http/app.js";
import { createLogger } from "./infra/logger.js";
import { resolvePaths, type PokePaths } from "./infra/paths.js";
import { createKernel } from "./kernel.js";
import { servicesFromKernel, type Services } from "./services.js";

export interface ServerOptions {
  paths?: PokePaths;
  host?: string;
  port?: number;
  /** Listen on the admin socket (default true). */
  admin?: boolean;
  modules?: RouteModule[];
}

export interface RunningServer {
  services: Services;
  publicApp: FastifyInstance;
  adminApp?: FastifyInstance;
  url: string;
  close(): Promise<void>;
}

export function serverVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

/** Start poke-server: the public API on 127.0.0.1 (behind the tunnel) and the admin socket. */
export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const paths = options.paths ?? resolvePaths();
  const log = createLogger({ logsDir: paths.logs });
  const kernel = createKernel({ paths, log });
  const services = servicesFromKernel(kernel, { version: serverVersion() });

  const host = options.host ?? process.env.POKE_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.POKE_PORT ?? 7070);
  const publicApp = await buildApp(services, "public", options.modules);
  const url = await publicApp.listen({ host, port });
  log.info({ url }, "poke-server listening");

  let adminApp: FastifyInstance | undefined;
  if (options.admin !== false) {
    adminApp = await buildApp(services, "admin", options.modules);
    if (process.platform !== "win32" && existsSync(paths.adminSocket)) rmSync(paths.adminSocket);
    await adminApp.listen({ path: paths.adminSocket });
    if (process.platform !== "win32") chmodSync(paths.adminSocket, 0o600);
    log.info({ socket: paths.adminSocket }, "admin socket ready");
  }

  return {
    services,
    publicApp,
    ...(adminApp ? { adminApp } : {}),
    url,
    async close() {
      await adminApp?.close();
      await publicApp.close();
      kernel.close();
    },
  };
}
