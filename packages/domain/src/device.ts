import type { DeviceId } from "./ids.js";

export type DeviceScope = "full" | "share";

export interface Device {
  id: DeviceId;
  name: string;
  platform: "ios" | "web" | "cli" | "shortcut";
  /** "share" tokens can only POST /v1/share. */
  scope: DeviceScope;
  /** sha256 of the bearer token; the token itself is never stored. */
  tokenHash: string;
  createdAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
}

export interface PairingCode {
  /** sha256 of the one-time code. */
  codeHash: string;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
  attempts: number;
}

export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const PAIRING_MAX_ATTEMPTS = 5;

export type Presence = "foreground" | "background";
