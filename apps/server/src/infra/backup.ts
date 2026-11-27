import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PokePaths } from "./paths.js";

/**
 * Full backups (brief section 26, milestone 12): one .tar.gz with everything needed to bring Poke
 * back on a new machine: the databases (consistent snapshots, taken while the server runs), the
 * master key, his files, skills and settings, Bark's data, and (when the CLI can make one) a dump
 * of Honcho's database. Not included: logs, app updates, caches and the Honcho checkout, which
 * Poke rebuilds.
 *
 * The archive holds the master key next to the vault, so whoever has it can read the vault. It is
 * written 0600; keep it somewhere only you can reach.
 */

export const BACKUP_FORMAT = 1;

export interface BackupManifest {
  format: number;
  createdAt: number;
  version: string;
  commit?: string;
  /** Paths inside the archive, relative to its root. */
  contents: string[];
  /** honcho.dump (pg_dump custom format), if memory was set up and running. */
  honcho?: boolean;
}

/** Top-level folders copied as they are (relative to ~/poke). */
const FOLDERS = ["keys", "workspace", "library", "skills", join("services", "data", "bark")];
/** In data/: SQLite files snapshot with VACUUM INTO; everything else copied, minus these. */
const DATA_SKIP = new Set(["backups", "tts"]);

function isSqlite(name: string): boolean {
  return /\.(db|sqlite)$/.test(name);
}

/** A consistent copy of a live SQLite database (WAL readers don't block it). */
export function snapshotSqlite(from: string, to: string): void {
  const db = new DatabaseSync(from);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

/** GNU tar reads `C:` as a remote host; on Windows (development only) use the system's bsdtar. */
function tarCommand(): string {
  const windows = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  return process.platform === "win32" && existsSync(windows) ? windows : "tar";
}

function tar(args: string[]): void {
  const result = spawnSync(tarCommand(), args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`tar failed: ${(result.stderr ?? "").trim() || result.status}`);
}

function stagingDir(paths: Pick<PokePaths, "run">, prefix: string): string {
  mkdirSync(paths.run, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(paths.run, prefix));
}

export function createBackup(input: {
  paths: PokePaths;
  out: string;
  version: string;
  commit?: string;
  /** Writes Honcho's dump to the given file; returns false when memory isn't running. */
  dumpHoncho?: (file: string) => boolean;
}): BackupManifest {
  const { paths } = input;
  const stage = stagingDir(paths, "backup-");
  try {
    const contents: string[] = [];
    if (existsSync(paths.data)) {
      mkdirSync(join(stage, "data"), { recursive: true });
      for (const name of readdirSync(paths.data)) {
        if (DATA_SKIP.has(name) || /-(wal|shm)$/.test(name)) continue;
        const from = join(paths.data, name);
        const to = join(stage, "data", name);
        if (isSqlite(name) && statSync(from).isFile()) snapshotSqlite(from, to);
        else cpSync(from, to, { recursive: true });
        contents.push(`data/${name}`);
      }
    }
    for (const folder of FOLDERS) {
      const from = join(paths.home, folder);
      if (!existsSync(from)) continue;
      cpSync(from, join(stage, folder), { recursive: true });
      contents.push(folder.replaceAll("\\", "/"));
    }
    if (existsSync(paths.config)) {
      cpSync(paths.config, join(stage, basename(paths.config)));
      contents.push(basename(paths.config));
    }
    const honcho = input.dumpHoncho?.(join(stage, "honcho.dump")) ?? false;
    if (honcho) contents.push("honcho.dump");
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      createdAt: Date.now(),
      version: input.version,
      ...(input.commit ? { commit: input.commit } : {}),
      contents,
      ...(honcho ? { honcho: true } : {}),
    };
    writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    tar(["-czf", input.out, "-C", stage, "."]);
    chmodSync(input.out, 0o600);
    return manifest;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Reads an archive's manifest without unpacking the rest. */
export function readBackupManifest(paths: Pick<PokePaths, "run">, file: string): BackupManifest {
  const stage = stagingDir(paths, "manifest-");
  try {
    tar(["-xzf", file, "-C", stage, "./manifest.json"]);
    return parseManifest(readFileSync(join(stage, "manifest.json"), "utf8"));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function parseManifest(text: string): BackupManifest {
  const manifest = JSON.parse(text) as BackupManifest;
  if (manifest.format !== BACKUP_FORMAT || !Array.isArray(manifest.contents))
    throw new Error("That file isn't a Poke backup this version can restore");
  for (const entry of manifest.contents)
    if (entry.startsWith("/") || entry.split("/").includes(".."))
      throw new Error(`Unsafe path in backup: ${entry}`);
  return manifest;
}

/**
 * Puts a backup in place. The server must be stopped. What it replaces is moved to
 * ~/poke/restore-previous-<time>/ rather than deleted. Returns the manifest and, if the backup
 * has one, the path of Honcho's dump (left in place for the caller to load, then delete).
 */
export function restoreBackup(input: { paths: PokePaths; file: string }): {
  manifest: BackupManifest;
  previous: string;
  honchoDump?: string;
} {
  const { paths } = input;
  const stage = stagingDir(paths, "restore-");
  let manifest: BackupManifest;
  try {
    tar(["-xzf", input.file, "-C", stage]);
    manifest = parseManifest(readFileSync(join(stage, "manifest.json"), "utf8"));
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  const previous = join(paths.home, `restore-previous-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(previous, { recursive: true, mode: 0o700 });
  for (const entry of manifest.contents) {
    if (entry === "honcho.dump") continue;
    const from = join(stage, ...entry.split("/"));
    const to = join(paths.home, ...entry.split("/"));
    if (!existsSync(from)) continue;
    if (existsSync(to)) {
      const aside = join(previous, ...entry.split("/"));
      mkdirSync(join(aside, ".."), { recursive: true });
      renameSync(to, aside);
      // A database's WAL belongs to the file that was moved aside.
      for (const suffix of ["-wal", "-shm"])
        if (existsSync(`${to}${suffix}`)) renameSync(`${to}${suffix}`, `${aside}${suffix}`);
    }
    mkdirSync(join(to, ".."), { recursive: true });
    cpSync(from, to, { recursive: true });
  }
  if (existsSync(paths.masterKey) && process.platform !== "win32") chmodSync(paths.masterKey, 0o600);
  if (existsSync(paths.keys) && process.platform !== "win32") chmodSync(paths.keys, 0o700);
  const dump = join(stage, "honcho.dump");
  if (manifest.honcho && existsSync(dump)) return { manifest, previous, honchoDump: dump };
  rmSync(stage, { recursive: true, force: true });
  return { manifest, previous };
}

/** Only Honcho's dump, for restoring memory after it was set up on a new machine. */
export function extractHonchoDump(paths: Pick<PokePaths, "run">, file: string): string | undefined {
  const stage = stagingDir(paths, "honcho-");
  try {
    tar(["-xzf", file, "-C", stage, "./honcho.dump"]);
    return join(stage, "honcho.dump");
  } catch {
    rmSync(stage, { recursive: true, force: true });
    return undefined;
  }
}
