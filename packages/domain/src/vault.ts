import type { VaultName } from "./ids.js";

export type VaultKind = "login" | "api_key" | "card" | "code" | "note";

/**
 * Metadata only. Secret field values never leave the vault adapter except through the
 * SecretResolver inside a tool executor (or a Face ID–gated reveal on the owner's phone).
 */
export interface VaultEntry {
  name: VaultName;
  kind: VaultKind;
  /** Non-secret fields: username, email, service, last4… */
  fields: Record<string, string>;
  /** Names of the secret fields (values are encrypted). */
  secretFields: string[];
  usedBy: string[];
  description?: string;
  /** One-time codes: single use, wiped after use or after 10 minutes. */
  ephemeral: boolean;
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

/** System namespace keys (provider tokens etc.). Agents can never list or resolve these. */
export type SystemSecretKey =
  | "anthropic.oauthToken"
  | "qwen.apiKey"
  | "qwenCn.apiKey"
  | "voyage.apiKey"
  | "assemblyai.key"
  | "keenable.key"
  | "executor.token"
  | "github.token"
  | "cloudflare.tunnelToken"
  | "gateway.key"
  | "bark.deviceKey"
  | "honcho.jwt"
  | "honcho.jwtSecret"
  | "honcho.dbPassword"
  | "sidestore.token";

export const VAULT_NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/** `{{vault:resy.login.password}}` → { name: "resy.login", field: "password" } */
export const VAULT_PLACEHOLDER_RE = /\{\{vault:([a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*)\}\}/g;

export function parsePlaceholderRef(
  ref: string,
  knownNames: ReadonlySet<string>,
): { name: string; field?: string } {
  if (knownNames.has(ref)) return { name: ref };
  const lastDot = ref.lastIndexOf(".");
  if (lastDot > 0) {
    const name = ref.slice(0, lastDot);
    if (knownNames.has(name)) return { name, field: ref.slice(lastDot + 1) };
  }
  return { name: ref };
}

/** Bash env var for a placeholder: resy.login.password → POKE_SECRET_RESY_LOGIN_PASSWORD */
export function secretEnvName(name: string, field?: string): string {
  const raw = field ? `${name}.${field}` : name;
  return `POKE_SECRET_${raw.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}
