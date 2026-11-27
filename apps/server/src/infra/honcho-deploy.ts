import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDING_DIMENSIONS, type SystemSecrets } from "@poke/domain";
import { GATEWAY_PORT } from "@poke/model-gateway";
import { HONCHO_URL } from "@poke/memory-honcho";
import type { PokePaths } from "./paths.js";

/** The pinned release (SDK 2.9.0 needs v3.6.0+; v3.7.0 was tagged but not released). */
export const HONCHO_VERSION = "v3.6.2";
export const HONCHO_REPO = "https://github.com/plastic-labs/honcho.git";
export const HONCHO_PORT = Number(new URL(HONCHO_URL).port);
/** bark-server on this machine (cloudflared reaches it inside Docker; this is for `poke doctor`). */
export const BARK_PORT = 8090;
const DIALECTIC_LEVELS = ["minimal", "low", "medium", "high", "max"] as const;

export interface MemoryLayout {
  /** The repo's infra/compose. */
  composeFile: string;
  /** ~/poke/services/compose.env */
  composeEnv: string;
  /** ~/poke/services/honcho.env */
  honchoEnv: string;
  /** ~/poke/services/honcho: the pinned checkout. */
  honchoDir: string;
  /** Written once the vector column was sized: `voyage-4 1024`. */
  embeddingsMarker: string;
  version: string;
}

/** The checkout Poke runs from (poke-server and the CLI both run from it). */
export function repoRoot(from = fileURLToPath(import.meta.url)): string {
  let dir = dirname(from);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error("Couldn't find Poke's checkout (no pnpm-workspace.yaml above it)");
    dir = up;
  }
}

export function memoryLayout(paths: Pick<PokePaths, "services">, root = repoRoot()): MemoryLayout {
  return {
    composeFile: join(root, "infra", "compose", "docker-compose.yml"),
    composeEnv: join(paths.services, "compose.env"),
    honchoEnv: join(paths.services, "honcho.env"),
    honchoDir: join(paths.services, "honcho"),
    embeddingsMarker: join(paths.services, "honcho.embeddings"),
    version: HONCHO_VERSION,
  };
}

/**
 * `{{name}}` values and `{{#list}}…{{/list}}` loops over arrays of objects. Every placeholder
 * must be filled, so a renamed key can't silently render as empty.
 */
export function renderTemplate(template: string, values: Record<string, unknown>): string {
  const loops = template.replace(
    /\{\{#(\w+)\}\}\n?([\s\S]*?)\{\{\/\1\}\}\n?/g,
    (_m, name: string, body: string) => {
      const list = values[name];
      if (!Array.isArray(list)) throw new Error(`Template list ${name} is missing`);
      return list
        .map((item: Record<string, unknown>) => renderTemplate(body, { ...values, ...item }))
        .join("");
    },
  );
  return loops.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    const value = values[name];
    if (value === undefined || value === null) throw new Error(`Template value ${name} is missing`);
    const text = String(value);
    if (/[\r\n]/.test(text)) throw new Error(`Template value ${name} has a line break`);
    return text;
  });
}

/** An admin JWT as Honcho's src/security.py checks it: HS256 over `{t, ad: true}`, no expiry. */
export function mintHonchoJwt(secret: string, now: number): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ t: new Date(now).toISOString(), ad: true })}`;
  return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`;
}

function ensureSecret(system: SystemSecrets, key: Parameters<SystemSecrets["get"]>[0], bytes = 32): string {
  const existing = system.get(key);
  if (existing) return existing;
  const value = randomBytes(bytes).toString("base64url");
  system.set(key, value);
  return value;
}

export function writePrivate(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Generates the gateway key, Honcho's JWT secret and the database password (kept in the vault's
 * system namespace, so re-running keeps them), then renders compose.env and honcho.env (0600).
 * Secrets never leave this machine and are never printed.
 */
export function prepareMemory(input: {
  system: SystemSecrets;
  paths: Pick<PokePaths, "services">;
  root?: string;
}): MemoryLayout {
  const layout = memoryLayout(input.paths, input.root);
  const templates = dirname(layout.composeFile);
  const gatewayKey = ensureSecret(input.system, "gateway.key");
  const jwtSecret = ensureSecret(input.system, "honcho.jwtSecret", 48);
  const postgresPassword = ensureSecret(input.system, "honcho.dbPassword", 24);
  mkdirSync(join(input.paths.services, "data"), { recursive: true });
  writePrivate(
    layout.composeEnv,
    renderTemplate(readFileSync(join(templates, "compose.env.template"), "utf8"), {
      services: input.paths.services,
      honcho_dir: layout.honchoDir,
      honcho_version: HONCHO_VERSION,
      honcho_port: HONCHO_PORT,
      bark_port: BARK_PORT,
      postgres_password: postgresPassword,
    }),
  );
  writePrivate(
    layout.honchoEnv,
    renderTemplate(readFileSync(join(templates, "honcho.env.template"), "utf8"), {
      honcho_version: HONCHO_VERSION,
      postgres_password: postgresPassword,
      jwt_secret: jwtSecret,
      gateway_key: gatewayKey,
      gateway_url: `http://host.docker.internal:${GATEWAY_PORT}/v1`,
      dimensions: EMBEDDING_DIMENSIONS,
      dialectic_levels: DIALECTIC_LEVELS.map((level) => ({ level })),
    }),
  );
  return layout;
}

/** Honcho is up: mint Poke's admin JWT. Memory turns on with it. */
export function finishMemory(system: SystemSecrets, now: number): void {
  const secret = system.get("honcho.jwtSecret");
  if (!secret) throw new Error("Run the memory setup first: Honcho has no JWT secret yet");
  system.set("honcho.jwt", mintHonchoJwt(secret, now));
}
