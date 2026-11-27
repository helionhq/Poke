import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SystemSecretKey, SystemSecrets } from "@poke/domain";
import { MIGRATIONS, openPokeDatabase } from "@poke/storage-sqlite";
import { openVault } from "@poke/vault-sodium";
import { writePrivate } from "./honcho-deploy.js";
import { loadMasterKey } from "./master-key.js";
import type { PokePaths } from "./paths.js";

/**
 * What `poke update` and the service commands need without a running server (brief sections 21
 * and 22). The server is stopped while these run, or they only read.
 */

/** One system secret, read straight from the vault (for `poke update`'s GitHub token). */
export async function readSystemSecret(
  paths: Pick<PokePaths, "vaultDb" | "masterKey">,
  key: SystemSecretKey,
): Promise<string | undefined> {
  if (!existsSync(paths.vaultDb) || !existsSync(paths.masterKey)) return undefined;
  const vault = await openVault({ path: paths.vaultDb, masterKey: loadMasterKey(paths.masterKey) });
  try {
    return vault.system.get(key);
  } finally {
    vault.close();
  }
}

const KEEP_BACKUPS = 5;

/**
 * Copies poke.db (and its WAL) aside before migrations. Call with the server stopped, so the
 * files are consistent. Keeps the newest five. Returns the backup's path.
 */
export function backupDatabase(paths: Pick<PokePaths, "data" | "db">, label: string): string | undefined {
  if (!existsSync(paths.db)) return undefined;
  const dir = join(paths.data, "backups");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `poke-${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.db`);
  copyFileSync(paths.db, file);
  if (existsSync(`${paths.db}-wal`)) copyFileSync(`${paths.db}-wal`, `${file}-wal`);
  const old = readdirSync(dir)
    .filter((f) => /^poke-.*\.db$/.test(f))
    .sort()
    .reverse()
    .slice(KEEP_BACKUPS);
  for (const f of old) {
    rmSync(join(dir, f), { force: true });
    rmSync(join(dir, `${f}-wal`), { force: true });
  }
  return file;
}

/** Puts a backup back (rollback). Server stopped. */
export function restoreDatabase(paths: Pick<PokePaths, "db">, backup: string): void {
  for (const suffix of ["-wal", "-shm"]) rmSync(`${paths.db}${suffix}`, { force: true });
  copyFileSync(backup, paths.db);
  if (existsSync(`${backup}-wal`)) copyFileSync(`${backup}-wal`, `${paths.db}-wal`);
}

/** Runs this build's migrations on poke.db. Returns the schema version it ends at. */
export function migrateDatabase(paths: Pick<PokePaths, "db">): number {
  const db = openPokeDatabase(paths.db);
  db.close();
  return MIGRATIONS.length;
}

/**
 * Renders ~/poke/services/cloudflared.env (0600) from the tunnel token in the vault. The token
 * reaches cloudflared through this file, never its command line. Returns false without a token.
 */
export function prepareTunnel(input: { system: SystemSecrets; paths: Pick<PokePaths, "services"> }): boolean {
  const token = input.system.get("cloudflare.tunnelToken");
  if (!token) return false;
  mkdirSync(input.paths.services, { recursive: true });
  writePrivate(join(input.paths.services, "cloudflared.env"), `TUNNEL_TOKEN=${token}\n`);
  return true;
}
