import { createPublicKey, type KeyObject, randomBytes, verify } from "node:crypto";
import { type Clock, type Device, DomainError } from "@poke/domain";

/** How long a challenge can be answered. */
const CHALLENGE_TTL_MS = 60_000;
/** Wrong proofs a device may send in a window before it has to wait. */
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 5 * 60_000;
const MAX_OPEN_CHALLENGES = 20;

export type VaultAction = "list" | "add" | "edit" | "delete" | "reveal";

interface Challenge {
  deviceId: string;
  purpose: string;
  nonce: string;
  expiresAt: number;
}

/** The text the phone signs: one device, one challenge, one action on one entry. */
export function proofMessage(deviceId: string, challengeId: string, nonce: string, purpose: string): string {
  return ["poke-vault-proof:v1", deviceId, challengeId, nonce, purpose].join("\n");
}

export function vaultPurpose(action: VaultAction, name?: string): string {
  return `${action}:${name ?? ""}`;
}

/** A raw 32-byte Ed25519 public key in base64url, as the phone sends it at pairing. */
export function ed25519Key(base64url: string): KeyObject {
  try {
    return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: base64url }, format: "jwk" });
  } catch {
    throw new DomainError("invalid", "vaultKey isn't an Ed25519 public key");
  }
}

/**
 * Face ID for the vault, checked on the server. At pairing the phone makes an Ed25519 key pair,
 * keeps the private key in the Keychain behind Face ID (readable only after a successful scan)
 * and sends the public key. Each vault request first asks for a challenge, then carries
 * `X-Poke-Vault-Proof: <challengeId>.<signature>` over `proofMessage(...)`. A stolen device token
 * alone can't open the vault; a proof can't be replayed or used for another action or entry.
 */
export class VaultProofs {
  readonly #challenges = new Map<string, Challenge>();
  readonly #failures = new Map<string, number[]>();

  constructor(private readonly clock: Clock) {}

  issue(device: Device, purpose: string): { challengeId: string; nonce: string; expiresAt: number } {
    this.#requireKey(device);
    this.#prune();
    const open = [...this.#challenges.values()].filter((c) => c.deviceId === device.id).length;
    if (open >= MAX_OPEN_CHALLENGES) throw new DomainError("rate_limited", "Too many vault requests at once");
    const challengeId = randomBytes(16).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const expiresAt = this.clock.now() + CHALLENGE_TTL_MS;
    this.#challenges.set(challengeId, { deviceId: device.id, purpose, nonce, expiresAt });
    return { challengeId, nonce, expiresAt };
  }

  /** Throws unless the header is a fresh, valid proof from this device for this purpose. */
  verify(device: Device, header: string | undefined, purpose: string): void {
    const key = this.#requireKey(device);
    const now = this.clock.now();
    const failures = (this.#failures.get(device.id) ?? []).filter((at) => now - at < FAILURE_WINDOW_MS);
    this.#failures.set(device.id, failures);
    if (failures.length >= MAX_FAILURES)
      throw new DomainError("rate_limited", "Too many failed Face ID checks. Try again in a few minutes.");
    const fail = (message: string): never => {
      failures.push(now);
      throw new DomainError("unauthorized", message);
    };
    if (!header) return fail("Unlock the vault with Face ID first");
    const [challengeId, signature] = header.split(".");
    if (!challengeId || !signature) return fail("That Face ID proof is malformed");
    const challenge = this.#challenges.get(challengeId);
    // Single use: gone whether or not it checks out.
    this.#challenges.delete(challengeId);
    if (!challenge || challenge.expiresAt <= now) return fail("That Face ID check expired; try again");
    if (challenge.deviceId !== device.id || challenge.purpose !== purpose)
      return fail("That Face ID check was for something else");
    const message = Buffer.from(proofMessage(device.id, challengeId, challenge.nonce, purpose), "utf8");
    if (!safeVerify(message, key, signature)) fail("Face ID check failed");
  }

  #requireKey(device: Device): KeyObject {
    if (!device.vaultKey)
      throw new DomainError(
        "forbidden",
        "This device can't open the vault. Pair it again from the Poke app.",
      );
    return ed25519Key(device.vaultKey);
  }

  #prune(): void {
    const now = this.clock.now();
    for (const [id, challenge] of this.#challenges)
      if (challenge.expiresAt <= now) this.#challenges.delete(id);
  }
}

function safeVerify(message: Buffer, key: KeyObject, signature: string): boolean {
  try {
    return verify(null, message, key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}
