import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  createBackup,
  extractHonchoDump,
  memoryLayout,
  readBackupManifest,
  repoRoot,
  restoreBackup,
  serverVersion,
} from "@poke/server";
import type { Context } from "../admin.js";
import { bad, cmd, dim, isInteractive, ok, p, printJson, unwrap, warn } from "../ui.js";
import { composeArgs } from "./memory.js";
import { serverRunsUnderSystemd, serviceCommand } from "./services.js";

/**
 * `poke backup [file]` and `poke restore <file>` (brief section 26, milestone 12). The archive
 * holds the databases, the master key and his files, plus Honcho's database when memory runs.
 */

const KEEP = 10;

function postgresRunning(ctx: Context): boolean {
  const layout = memoryLayout(ctx.paths);
  if (!existsSync(layout.composeEnv)) return false;
  const ps = spawnSync("docker", composeArgs(layout, ["ps", "--services", "--status", "running"]), {
    encoding: "utf8",
  });
  return (ps.stdout ?? "").split("\n").includes("postgres");
}

/** `pg_dump -Fc` of Honcho's database, streamed straight into the file. */
function dumpHoncho(ctx: Context, file: string): boolean {
  if (!postgresRunning(ctx)) return false;
  const fd = openSync(file, "w", 0o600);
  try {
    const result = spawnSync(
      "docker",
      composeArgs(memoryLayout(ctx.paths), [
        "exec",
        "-T",
        "postgres",
        "pg_dump",
        "-U",
        "honcho",
        "-d",
        "honcho",
        "-Fc",
      ]),
      { stdio: ["ignore", fd, "inherit"] },
    );
    return result.status === 0;
  } finally {
    closeSync(fd);
  }
}

/** Loads a dump into Honcho's database with Honcho stopped. */
function loadHoncho(ctx: Context, dump: string): boolean {
  const layout = memoryLayout(ctx.paths);
  const run = (args: string[], stdin: "ignore" | number = "ignore") =>
    spawnSync("docker", composeArgs(layout, args), { stdio: [stdin, "inherit", "inherit"] }).status === 0;
  run(["stop", "honcho-api", "honcho-deriver"]);
  const fd = openSync(dump, "r");
  try {
    return run(
      [
        "exec",
        "-T",
        "postgres",
        "pg_restore",
        "-U",
        "honcho",
        "-d",
        "honcho",
        "--clean",
        "--if-exists",
        "--no-owner",
      ],
      fd,
    );
  } finally {
    closeSync(fd);
    run(["start", "honcho-api", "honcho-deriver"]);
  }
}

function size(bytes: number): string {
  return bytes > 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

export async function backupCommand(
  ctx: Context,
  file: string | undefined,
  opts: { json?: boolean },
): Promise<void> {
  const dir = join(ctx.paths.home, "backups");
  const out = file
    ? resolve(file)
    : join(dir, `poke-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.tar.gz`);
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot(), encoding: "utf8" });
  const spin = opts.json ? undefined : p.spinner();
  spin?.start("Backing up Poke");
  const manifest = createBackup({
    paths: ctx.paths,
    out,
    version: serverVersion(),
    ...(commit.status === 0 ? { commit: commit.stdout.trim() } : {}),
    dumpHoncho: (f) => dumpHoncho(ctx, f),
  });
  spin?.stop(ok(`Backed up to ${out} ${dim(`(${size(statSync(out).size)})`)}`));
  if (!file) {
    const old = readdirSync(dir)
      .filter((f) => /^poke-.*\.tar\.gz$/.test(f))
      .sort()
      .reverse()
      .slice(KEEP);
    for (const f of old) rmSync(join(dir, f), { force: true });
  }
  if (opts.json) {
    printJson({ file: out, ...manifest });
    return;
  }
  if (!manifest.honcho && existsSync(memoryLayout(ctx.paths).composeEnv))
    p.log.warn(warn("Memory (Honcho) wasn't running, so its database isn't in this backup."));
  p.log.warn(
    warn(
      "The backup holds the master key and the vault: anyone with the file can read the vault. Keep it private.",
    ),
  );
}

export async function restoreCommand(
  ctx: Context,
  file: string,
  opts: { yes?: boolean; memory?: boolean },
): Promise<void> {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`No file at ${path}`);
  const manifest = readBackupManifest(ctx.paths, path);

  if (opts.memory) {
    if (!manifest.honcho) throw new Error("This backup has no memory (Honcho) database in it.");
    if (!postgresRunning(ctx))
      throw new Error(`Memory isn't running. Set it up first: ${cmd("poke setup --only memory")}.`);
    const dump = extractHonchoDump(ctx.paths, path);
    if (!dump) throw new Error("Couldn't read the memory database from the backup");
    try {
      if (!loadHoncho(ctx, dump)) throw new Error("Loading the memory database failed");
    } finally {
      rmSync(dirname(dump), { recursive: true, force: true });
    }
    p.log.success(ok("Memory restored"));
    return;
  }

  p.note(
    [
      `Made ${new Date(manifest.createdAt).toLocaleString()} by Poke ${manifest.version}${manifest.commit ? ` (${manifest.commit})` : ""}`,
      `Contains: ${manifest.contents.join(", ")}`,
      "",
      "This replaces Poke's thread, vault, master key, files, skills and settings on this machine.",
      "What's here now is moved aside, not deleted.",
    ].join("\n"),
    "Restore",
  );
  if (!opts.yes) {
    if (!isInteractive())
      throw new Error("Restoring replaces Poke's data: run it in a terminal, or pass --yes.");
    if (!unwrap(await p.confirm({ message: "Restore this backup?", initialValue: false }))) return;
  }

  const systemd = serverRunsUnderSystemd();
  if (await ctx.online()) {
    if (!systemd) throw new Error("Stop poke-server first: the databases can't be replaced while it runs.");
    await serviceCommand(ctx, "stop", "poke");
  }
  const result = restoreBackup({ paths: ctx.paths, file: path });
  p.log.success(ok("Poke's data is restored"));
  p.log.info(dim(`What was here before is in ${result.previous}`));

  if (result.honchoDump) {
    try {
      if (postgresRunning(ctx)) {
        p.log.info(dim("Restoring memory (Honcho)…"));
        if (loadHoncho(ctx, result.honchoDump)) p.log.success(ok("Memory restored"));
        else
          p.log.error(bad(`Memory didn't restore. Try again with ${cmd(`poke restore ${file} --memory`)}.`));
      } else
        p.log.warn(
          warn(
            `Memory isn't set up on this machine yet. Run ${cmd("poke setup --only memory")}, then ${cmd(`poke restore ${file} --memory`)}.`,
          ),
        );
    } finally {
      rmSync(dirname(result.honchoDump), { recursive: true, force: true });
    }
  }
  if (systemd) {
    await serviceCommand(ctx, "start", "poke");
  } else p.log.info(`Start Poke when you're ready: ${cmd("poke start")}`);
  if (!existsSync(ctx.paths.masterKey))
    p.log.error(bad("The backup had no master key: the vault can't be read."));
}
