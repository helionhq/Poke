import { chmodSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  type Clock,
  DomainError,
  type SystemSecretKey,
  type SystemSecrets,
  systemClock,
  VAULT_NAME_RE,
  type VaultEntry,
  type VaultKind,
  type VaultPort,
  type VaultPutInput,
} from "@poke/domain";
import sodium from "libsodium-wrappers";

const FIELD_RE = /^[a-z0-9_]{1,40}$/;
/** One-time codes live at most this long. */
export const EPHEMERAL_TTL_MS = 10 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  fields TEXT NOT NULL,
  description TEXT,
  used_by TEXT NOT NULL,
  ephemeral INTEGER NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS secrets (
  name TEXT NOT NULL REFERENCES entries(name) ON DELETE CASCADE,
  field TEXT NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  PRIMARY KEY (name, field)
);
CREATE TABLE IF NOT EXISTS system (
  key TEXT PRIMARY KEY,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);`;

interface EntryRow {
  name: string;
  kind: string;
  fields: string;
  description: string | null;
  used_by: string;
  ephemeral: number;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

export interface OpenVaultOptions {
  /** vault.db path, or ":memory:" in tests. */
  path: string;
  /** 32 random bytes (keys/master.key). */
  masterKey: Uint8Array;
  clock?: Clock;
  /** Called after every change, so redaction can refresh its set of live secrets. */
  onChange?: () => void;
}

/**
 * The vault: entries in their own SQLite file, each secret field sealed with
 * XChaCha20-Poly1305 under a key derived from the master key. The associated data binds a
 * ciphertext to its slot, so a value can't be moved to another entry or field.
 */
export async function openVault(options: OpenVaultOptions): Promise<SodiumVault> {
  await sodium.ready;
  if (options.masterKey.length !== 32) throw new Error("Vault master key must be 32 bytes");
  const created = options.path !== ":memory:" && !existsSync(options.path);
  const db = new DatabaseSync(options.path);
  if (created && process.platform !== "win32") chmodSync(options.path, 0o600);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return new SodiumVault(db, options);
}

export class SodiumVault implements VaultPort {
  readonly system: SystemSecrets;
  readonly #db: DatabaseSync;
  readonly #entryKey: Uint8Array;
  readonly #systemKey: Uint8Array;
  readonly #clock: Clock;
  readonly #onChange: (() => void) | undefined;

  constructor(db: DatabaseSync, options: OpenVaultOptions) {
    this.#db = db;
    this.#clock = options.clock ?? systemClock;
    this.#onChange = options.onChange;
    this.#entryKey = sodium.crypto_kdf_derive_from_key(32, 1, "pokevlt1", options.masterKey);
    this.#systemKey = sodium.crypto_kdf_derive_from_key(32, 2, "pokevlt1", options.masterKey);
    this.system = {
      get: (key) => this.#systemGet(key),
      set: (key, value) => this.#systemSet(key, value),
      delete: (key) => {
        this.#db.prepare("DELETE FROM system WHERE key = ?").run(key);
        this.#changed();
      },
      has: (key) => this.#db.prepare("SELECT 1 FROM system WHERE key = ?").get(key) !== undefined,
      updatedAt: (key) =>
        (
          this.#db.prepare("SELECT updated_at FROM system WHERE key = ?").get(key) as
            { updated_at: number } | undefined
        )?.updated_at,
      keys: () =>
        (this.#db.prepare("SELECT key FROM system ORDER BY key").all() as Array<{ key: string }>).map(
          (r) => r.key as SystemSecretKey,
        ),
    };
  }

  list(): VaultEntry[] {
    const rows = this.#db.prepare("SELECT * FROM entries ORDER BY name").all() as unknown as EntryRow[];
    return rows.map((row) => this.#toEntry(row));
  }

  get(name: string): VaultEntry | undefined {
    const row = this.#db.prepare("SELECT * FROM entries WHERE name = ?").get(name) as EntryRow | undefined;
    return row ? this.#toEntry(row) : undefined;
  }

  put(input: VaultPutInput): VaultEntry {
    const name = input.name.trim().toLowerCase();
    if (!VAULT_NAME_RE.test(name)) {
      throw new DomainError(
        "invalid",
        "Vault names are lowercase letters, digits, dots, dashes and underscores",
      );
    }
    validateFields(input.secrets, "secret");
    if (Object.keys(input.secrets).length === 0)
      throw new DomainError("invalid", "A vault entry needs a secret");
    validateFields(input.fields ?? {}, "field");
    const now = this.#clock.now();
    const existing = this.get(name);
    const ephemeral = input.ephemeral ?? input.kind === "code";
    const expiresAt = ephemeral
      ? Math.min(input.expiresAt ?? Infinity, now + EPHEMERAL_TTL_MS)
      : input.expiresAt;
    this.#tx(() => {
      this.#db
        .prepare(
          `INSERT INTO entries (name, kind, fields, description, used_by, ephemeral, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET kind = excluded.kind, fields = excluded.fields,
             description = excluded.description, used_by = excluded.used_by, ephemeral = excluded.ephemeral,
             expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
        )
        .run(
          name,
          input.kind,
          JSON.stringify(input.fields ?? {}),
          input.description ?? null,
          JSON.stringify(input.usedBy ?? existing?.usedBy ?? []),
          ephemeral ? 1 : 0,
          expiresAt ?? null,
          existing?.createdAt ?? now,
          now,
        );
      this.#db.prepare("DELETE FROM secrets WHERE name = ?").run(name);
      for (const [field, value] of Object.entries(input.secrets)) this.#sealField(name, field, value);
    });
    this.#changed();
    return this.get(name)!;
  }

  update(name: string, patch: Partial<Omit<VaultPutInput, "name">>): VaultEntry {
    const entry = this.get(name);
    if (!entry) throw new DomainError("not_found", `No vault entry named ${name}`);
    validateFields(patch.secrets ?? {}, "secret");
    validateFields(patch.fields ?? {}, "field");
    const now = this.#clock.now();
    this.#tx(() => {
      this.#db
        .prepare(
          "UPDATE entries SET kind = ?, fields = ?, description = ?, used_by = ?, updated_at = ? WHERE name = ?",
        )
        .run(
          patch.kind ?? entry.kind,
          JSON.stringify({ ...entry.fields, ...patch.fields }),
          patch.description ?? entry.description ?? null,
          JSON.stringify(patch.usedBy ?? entry.usedBy),
          now,
          name,
        );
      for (const [field, value] of Object.entries(patch.secrets ?? {})) this.#sealField(name, field, value);
    });
    this.#changed();
    return this.get(name)!;
  }

  delete(name: string): boolean {
    const result = this.#db.prepare("DELETE FROM entries WHERE name = ?").run(name);
    if (result.changes > 0) this.#changed();
    return result.changes > 0;
  }

  reveal(name: string): Record<string, string> {
    const entry = this.get(name);
    if (!entry) throw new DomainError("not_found", `No vault entry named ${name}`);
    const out: Record<string, string> = {};
    for (const field of entry.secretFields) out[field] = this.#openField(name, field)!;
    return out;
  }

  resolve(name: string, field?: string): string | undefined {
    const entry = this.get(name);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.#clock.now()) return undefined;
    if (field) {
      if (entry.secretFields.includes(field)) return this.#openField(name, field);
      return entry.fields[field];
    }
    const only = entry.secretFields.length === 1 ? entry.secretFields[0] : primaryField(entry);
    return only ? this.#openField(name, only) : undefined;
  }

  markUsed(name: string, by?: string): void {
    const entry = this.get(name);
    if (!entry) return;
    if (entry.ephemeral) {
      this.delete(name);
      return;
    }
    const usedBy = by && !entry.usedBy.includes(by) ? [...entry.usedBy, by] : entry.usedBy;
    this.#db
      .prepare("UPDATE entries SET last_used_at = ?, used_by = ? WHERE name = ?")
      .run(this.#clock.now(), JSON.stringify(usedBy), name);
  }

  liveSecrets(): Array<{ name: string; value: string }> {
    const out: Array<{ name: string; value: string }> = [];
    const rows = this.#db.prepare("SELECT name, field FROM secrets").all() as Array<{
      name: string;
      field: string;
    }>;
    for (const row of rows) {
      const value = this.#openField(row.name, row.field);
      if (value) out.push({ name: `${row.name}.${row.field}`, value });
    }
    for (const key of this.system.keys()) {
      const value = this.#systemGet(key);
      if (value) out.push({ name: `system:${key}`, value });
    }
    return out;
  }

  sweep(now: number): string[] {
    const rows = this.#db
      .prepare("SELECT name FROM entries WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .all(now) as Array<{ name: string }>;
    for (const row of rows) this.#db.prepare("DELETE FROM entries WHERE name = ?").run(row.name);
    if (rows.length > 0) this.#changed();
    return rows.map((r) => r.name);
  }

  close(): void {
    sodium.memzero(this.#entryKey);
    sodium.memzero(this.#systemKey);
    this.#db.close();
  }

  #toEntry(row: EntryRow): VaultEntry {
    const secretFields = (
      this.#db.prepare("SELECT field FROM secrets WHERE name = ? ORDER BY field").all(row.name) as Array<{
        field: string;
      }>
    ).map((r) => r.field);
    const entry: VaultEntry = {
      name: row.name,
      kind: row.kind as VaultKind,
      fields: JSON.parse(row.fields) as Record<string, string>,
      secretFields,
      usedBy: JSON.parse(row.used_by) as string[],
      ephemeral: row.ephemeral === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.description !== null) entry.description = row.description;
    if (row.expires_at !== null) entry.expiresAt = row.expires_at;
    if (row.last_used_at !== null) entry.lastUsedAt = row.last_used_at;
    return entry;
  }

  #sealField(name: string, field: string, value: string): void {
    const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      value,
      `entry:${name}:${field}`,
      null,
      nonce,
      this.#entryKey,
    );
    this.#db
      .prepare("INSERT OR REPLACE INTO secrets (name, field, nonce, ciphertext) VALUES (?, ?, ?, ?)")
      .run(name, field, nonce, ciphertext);
  }

  #openField(name: string, field: string): string | undefined {
    const row = this.#db
      .prepare("SELECT nonce, ciphertext FROM secrets WHERE name = ? AND field = ?")
      .get(name, field) as { nonce: Uint8Array; ciphertext: Uint8Array } | undefined;
    if (!row) return undefined;
    return sodium.to_string(
      sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        row.ciphertext,
        `entry:${name}:${field}`,
        row.nonce,
        this.#entryKey,
      ),
    );
  }

  #systemGet(key: SystemSecretKey): string | undefined {
    const row = this.#db.prepare("SELECT nonce, ciphertext FROM system WHERE key = ?").get(key) as
      { nonce: Uint8Array; ciphertext: Uint8Array } | undefined;
    if (!row) return undefined;
    return sodium.to_string(
      sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        row.ciphertext,
        `system:${key}`,
        row.nonce,
        this.#systemKey,
      ),
    );
  }

  #systemSet(key: SystemSecretKey, value: string): void {
    if (!value) throw new DomainError("invalid", `${key} can't be empty`);
    const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      value,
      `system:${key}`,
      null,
      nonce,
      this.#systemKey,
    );
    this.#db
      .prepare("INSERT OR REPLACE INTO system (key, nonce, ciphertext, updated_at) VALUES (?, ?, ?, ?)")
      .run(key, nonce, ciphertext, this.#clock.now());
    this.#changed();
  }

  #tx(fn: () => void): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #changed(): void {
    this.#onChange?.();
  }
}

function validateFields(fields: Record<string, string>, what: string): void {
  for (const [key, value] of Object.entries(fields)) {
    if (!FIELD_RE.test(key)) throw new DomainError("invalid", `Bad ${what} name "${key}"`);
    if (typeof value !== "string") throw new DomainError("invalid", `${what} ${key} must be text`);
  }
}

function primaryField(entry: VaultEntry): string | undefined {
  for (const candidate of ["password", "key", "token", "code", "number", "value"]) {
    if (entry.secretFields.includes(candidate)) return candidate;
  }
  return undefined;
}
