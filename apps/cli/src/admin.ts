import { request } from "node:http";
import {
  createKernel,
  type Kernel,
  type ModelStack,
  openModelStack,
  type PokePaths,
  resolvePaths,
} from "@poke/server";

export class AdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** HTTP over the server's admin unix socket (0600; only Poke's own user can use it). */
export class AdminClient {
  constructor(readonly socketPath: string) {}

  async call<T = unknown>(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {},
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let data: unknown;
            try {
              data = text ? JSON.parse(text) : undefined;
            } catch {
              data = text;
            }
            if ((res.statusCode ?? 500) >= 400) {
              const err = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
              reject(new AdminError(res.statusCode ?? 500, err?.code ?? "error", err?.message ?? text));
            } else resolve(data as T);
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("admin socket timed out")));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async reachable(): Promise<boolean> {
    try {
      await this.call("GET", "/v1/health", undefined, 1500);
      return true;
    } catch {
      return false;
    }
  }
}

export interface Context {
  paths: PokePaths;
  admin: AdminClient;
  /** Whether poke-server is running (admin socket answers). */
  online(): Promise<boolean>;
  /** In-process kernel for when the server is down (setup, login, config, model). */
  local(): Kernel;
  /** Vault, logins and models in-process, for when the server is down. */
  localModels(): Promise<ModelStack>;
  close(): Promise<void>;
}

export function createContext(): Context {
  const paths = resolvePaths();
  const admin = new AdminClient(paths.adminSocket);
  let kernel: Kernel | undefined;
  let models: Promise<ModelStack> | undefined;
  let online: boolean | undefined;
  return {
    paths,
    admin,
    async online() {
      online ??= await admin.reachable();
      return online;
    },
    local() {
      kernel ??= createKernel({ paths });
      return kernel;
    },
    localModels() {
      models ??= openModelStack(this.local(), { claudeLive: true });
      return models;
    },
    async close() {
      if (models) (await models).close();
      kernel?.close();
    },
  };
}
