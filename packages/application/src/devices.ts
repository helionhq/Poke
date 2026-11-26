import {
  type Clock,
  type CryptoPort,
  type Device,
  type DeviceRepository,
  DomainError,
  type IdGenerator,
  PAIRING_TTL_MS,
} from "@poke/domain";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const MAX_FAILURES_PER_WINDOW = 10;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

export interface PairingCodeIssued {
  code: string;
  expiresAt: number;
}

/**
 * Device pairing: `poke setup` / `poke config` → Devices prints a QR with URL + one-time code; the
 * app exchanges it for a long-lived bearer token (hashed at rest, revocable).
 */
export class DeviceService {
  #failures: number[] = [];

  constructor(
    private readonly devices: DeviceRepository,
    private readonly crypto: CryptoPort,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  issuePairingCode(): PairingCodeIssued {
    // Rejection sampling: 256 isn't a multiple of the alphabet size, so a plain modulo is biased.
    const limit = 256 - (256 % CODE_ALPHABET.length);
    let raw = "";
    while (raw.length < 10) {
      for (const b of this.crypto.randomBytes(16)) {
        if (b < limit && raw.length < 10) raw += CODE_ALPHABET[b % CODE_ALPHABET.length];
      }
    }
    const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
    const now = this.clock.now();
    const expiresAt = now + PAIRING_TTL_MS;
    this.devices.savePairingCode({
      codeHash: this.crypto.sha256Hex(normalizeCode(code)),
      createdAt: now,
      expiresAt,
      attempts: 0,
    });
    return { code, expiresAt };
  }

  pair(input: { code: string; deviceName: string; platform: Device["platform"]; vaultKey?: string }): {
    token: string;
    device: Device;
  } {
    const now = this.clock.now();
    this.#failures = this.#failures.filter((at) => now - at < FAILURE_WINDOW_MS);
    if (this.#failures.length >= MAX_FAILURES_PER_WINDOW) {
      throw new DomainError("rate_limited", "Too many pairing attempts. Try again in a few minutes.");
    }
    const hash = this.crypto.sha256Hex(normalizeCode(input.code));
    const record = this.devices.pairingCode(hash);
    if (!record || record.usedAt !== undefined || record.expiresAt <= now) {
      this.#failures.push(now);
      throw new DomainError(
        "unauthorized",
        "That pairing code is wrong or expired. Run `poke config` → Devices for a new one.",
      );
    }
    this.devices.savePairingCode({ ...record, usedAt: now, attempts: record.attempts + 1 });
    return this.#createDevice({
      name: input.deviceName,
      platform: input.platform,
      scope: "full",
      ...(input.vaultKey ? { vaultKey: input.vaultKey } : {}),
    });
  }

  /** A scoped token that can only POST /v1/share (for the iOS Shortcut). */
  createShareToken(name = "Share to Poke shortcut"): { token: string; device: Device } {
    return this.#createDevice({ name, platform: "shortcut", scope: "share" });
  }

  /** A full-scope token minted locally (e.g. for the CLI over the tunnel). */
  createLocalToken(name: string, platform: Device["platform"] = "cli"): { token: string; device: Device } {
    return this.#createDevice({ name, platform, scope: "full" });
  }

  authenticate(token: string): Device | undefined {
    if (!token) return undefined;
    const device = this.devices.byTokenHash(this.crypto.sha256Hex(token));
    if (!device || device.revokedAt !== undefined) return undefined;
    const now = this.clock.now();
    if (device.lastSeenAt === undefined || now - device.lastSeenAt > 60_000) {
      this.devices.save({ ...device, lastSeenAt: now });
    }
    return device;
  }

  list(): Device[] {
    return this.devices.list();
  }

  revoke(id: string): Device {
    const device = this.devices.get(id);
    if (!device) throw new DomainError("not_found", "Device not found");
    const revoked = { ...device, revokedAt: device.revokedAt ?? this.clock.now() };
    this.devices.save(revoked);
    return revoked;
  }

  #createDevice(input: {
    name: string;
    platform: Device["platform"];
    scope: Device["scope"];
    vaultKey?: string;
  }) {
    const token = `pk_${this.crypto.randomToken(32)}`;
    const device: Device = {
      id: this.ids.next("dev"),
      name: input.name,
      platform: input.platform,
      scope: input.scope,
      tokenHash: this.crypto.sha256Hex(token),
      createdAt: this.clock.now(),
      ...(input.vaultKey ? { vaultKey: input.vaultKey } : {}),
    };
    this.devices.save(device);
    return { token, device };
  }
}

function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** A device as clients see it: no token hash, and whether it can open the vault. */
export function publicDevice(device: Device): Omit<Device, "tokenHash" | "vaultKey"> & { vault: boolean } {
  const { tokenHash: _hash, vaultKey, ...rest } = device;
  return { ...rest, vault: Boolean(vaultKey) };
}
