import { spawnSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  backupDatabase,
  HONCHO_VERSION,
  memoryLayout,
  migrateDatabase,
  prepareTunnel,
  type PokePaths,
  readSystemSecret,
  repoRoot,
  restoreDatabase,
} from "@poke/server";
import { type Context, createContext } from "../admin.js";
import { bad, cmd, dim, ok, p, warn } from "../ui.js";
import { composeArgs, memorySetup, prepare } from "./memory.js";
import { serverRunsUnderSystemd, serviceCommand } from "./services.js";

/**
 * `poke update` (brief section 21). Two phases, so everything after the build runs on the new
 * code: this process fetches, fast-forwards and builds, then hands over to the freshly built CLI
 * (`update --apply <previous>`), which exports the OTA bundle, fetches the IPA, stops the server,
 * backs up and migrates poke.db, re-renders the Docker services, restarts and checks health. If
 * anything fails, it rolls back to the previous commit and the database backup.
 *
 * The GitHub token goes to git through its environment (GIT_CONFIG_*), never on a command line.
 */

export interface UpdateOptions {
  ref?: string;
  honcho?: boolean;
  nightly?: boolean;
  apply?: string;
}

// ── helpers (exported for tests) ─────────────────────────────────────────────────────────────

/** Environment that gives git the token as an HTTP header for github.com only. */
export function gitAuthEnv(
  token: string | undefined,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_TERMINAL_PROMPT: "0" };
  if (!token) return env;
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  const n = Number(base.GIT_CONFIG_COUNT ?? 0);
  return {
    ...env,
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: "http.https://github.com/.extraheader",
    [`GIT_CONFIG_VALUE_${n}`]: `AUTHORIZATION: basic ${basic}`,
  };
}

/** owner/repo from a GitHub remote URL (https or ssh). */
export function githubSlug(remote: string): string | undefined {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

export interface GithubRelease {
  tag_name: string;
  draft?: boolean;
  assets: Array<{ id: number; name: string; size: number }>;
}

/** The release CI made for a native fingerprint (tag `ios-<build>-<sha>-<fingerprint[:12]>`). */
export function releaseFor(releases: GithubRelease[], fingerprint: string): GithubRelease | undefined {
  const suffix = `-${fingerprint.slice(0, 12)}`;
  return releases.find((r) => !r.draft && r.tag_name.startsWith("ios-") && r.tag_name.endsWith(suffix));
}

/** Keeps the newest `keep` entries of a directory whose names sort by age (oldest first). */
export function prune(dir: string, keep: number, filter: (name: string) => boolean = () => true): string[] {
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir).filter(filter);
  const sorted = names.sort((a, b) => {
    const na = Number.parseInt(a, 10);
    const nb = Number.parseInt(b, 10);
    return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : a.localeCompare(b);
  });
  const removed = sorted.slice(0, Math.max(0, sorted.length - keep));
  for (const name of removed) rmSync(join(dir, name), { recursive: true, force: true });
  return removed;
}

function sh(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; quiet?: boolean } = {},
) {
  const result = spawnSync(command, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: "utf8",
    stdio: opts.quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "inherit"],
    shell: process.platform === "win32",
  });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() };
}

function must(step: string, result: { ok: boolean; err: string }): void {
  if (!result.ok)
    throw new Error(`${step} failed${result.err ? `: ${result.err.split("\n").slice(-3).join(" ")}` : ""}`);
}

function stateFile(paths: PokePaths): string {
  return join(paths.run, "update.json");
}

function buildAll(root: string): void {
  must("pnpm install", sh("pnpm", ["install", "--frozen-lockfile"], { cwd: root }));
  must(
    "Build",
    sh("pnpm", ["build", "--filter=@poke/server...", "--filter=@poke/cli...", "--filter=@poke/mobile^..."], {
      cwd: root,
    }),
  );
}

// ── phase 1: fetch and build (old code) ──────────────────────────────────────────────────────

export async function updateCommand(ctx: Context, opts: UpdateOptions): Promise<void> {
  if (opts.apply) return applyUpdate(ctx, opts.apply, opts);
  if (opts.nightly) {
    const auto = (await ctx.online())
      ? (await ctx.admin.call<{ settings: Record<string, unknown> }>("GET", "/admin/settings")).settings[
          "update.auto"
        ]
      : ctx.local().settings.get("update.auto");
    if (auto !== true) return;
  }
  const root = repoRoot();
  const dirty = sh("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, quiet: true });
  if (dirty.out) throw new Error(`The checkout at ${root} has local changes. Commit or discard them first.`);

  const token = await readSystemSecret(ctx.paths, "github.token");
  if (!token) p.log.warn(warn(`No GitHub token (${cmd("poke config github.token")}); trying without one.`));
  const env = gitAuthEnv(token);
  const spin = p.spinner();
  spin.start("Checking GitHub for updates");
  const fetched = sh("git", ["fetch", "--quiet", "--prune", "--tags", "origin"], {
    cwd: root,
    env,
    quiet: true,
  });
  spin.stop(fetched.ok ? "Checked GitHub" : bad("Couldn't reach GitHub"));
  must("git fetch", fetched);

  const current = sh("git", ["rev-parse", "HEAD"], { cwd: root, quiet: true }).out;
  const wanted = opts.ref ?? "origin/main";
  const candidates = opts.ref ? [`origin/${opts.ref}`, opts.ref] : [wanted];
  const target = candidates
    .map((r) => sh("git", ["rev-parse", "--verify", "--quiet", `${r}^{commit}`], { cwd: root, quiet: true }))
    .find((r) => r.ok)?.out;
  if (!target) throw new Error(`No branch, tag or commit called ${wanted}`);

  if (target === current && !opts.honcho) {
    p.log.success(ok(`Poke is up to date (${current.slice(0, 7)})`));
    // A fresh install, or a run after CI finished the native build: fetch it if it isn't here.
    try {
      reportIpa(await fetchIpa(root, ctx.paths, resolveRuntime(root)));
    } catch (error) {
      p.log.warn(warn(`Couldn't check for the iPhone build: ${(error as Error).message}`));
    }
    return;
  }
  if (
    !opts.ref &&
    !sh("git", ["merge-base", "--is-ancestor", current, target], { cwd: root, quiet: true }).ok
  )
    throw new Error("origin/main doesn't follow from this checkout. Use --ref to move to it anyway.");

  if (target !== current) {
    const log = sh("git", ["log", "--oneline", "--no-decorate", `${current}..${target}`], {
      cwd: root,
      quiet: true,
    }).out;
    if (log) p.note(log.split("\n").slice(0, 30).join("\n"), `Pulling ${log.split("\n").length} commit(s)`);
    writeFileSync(stateFile(ctx.paths), `${JSON.stringify({ previous: current, target, at: Date.now() })}\n`);
    must("git checkout", sh("git", ["checkout", "--quiet", "--detach", target], { cwd: root, quiet: true }));
    p.log.info(dim("Installing and building (a few minutes)…"));
    try {
      buildAll(root);
    } catch (error) {
      p.log.error(bad((error as Error).message));
      p.log.info(dim(`Going back to ${current.slice(0, 7)}…`));
      sh("git", ["checkout", "--quiet", "--detach", current], { cwd: root, quiet: true });
      buildAll(root);
      throw new Error("The update didn't build; Poke is still on the previous version (it kept running).", {
        cause: error,
      });
    }
  }

  // Hand over to the new CLI for everything that should run on the new code.
  const next = spawnSync(
    process.execPath,
    [
      join(root, "apps", "cli", "dist", "main.js"),
      "update",
      "--apply",
      current,
      ...(opts.honcho ? ["--honcho"] : []),
    ],
    { stdio: "inherit", env: process.env },
  );
  if (next.status !== 0) process.exitCode = next.status ?? 1;
}

// ── phase 2: apply (new code) ────────────────────────────────────────────────────────────────

async function applyUpdate(ctx: Context, previous: string, opts: UpdateOptions): Promise<void> {
  const root = repoRoot();
  const paths = ctx.paths;
  const commit = sh("git", ["rev-parse", "HEAD"], { cwd: root, quiet: true }).out;
  const done: { ota?: string; backup?: string; stopped?: boolean } = {};
  try {
    // 1. The JS update, while the server still runs.
    const spin = p.spinner();
    spin.start("Exporting the app update");
    const ota = exportOta(root, paths, commit);
    done.ota = ota.dir;
    spin.stop(ok(`App update ready (runtime ${ota.runtime.slice(0, 12)})`));

    // 2. The native build, if this fingerprint has one on GitHub.
    reportIpa(await fetchIpa(root, paths, ota.runtime));

    // 3. Stop, back up, migrate.
    if (serverRunsUnderSystemd()) await serviceCommand(ctx, "stop", "poke");
    done.stopped = true;
    const backup = backupDatabase(paths, commit.slice(0, 7));
    if (backup) done.backup = backup;
    const schema = migrateDatabase(paths);
    p.log.info(dim(`Database at schema ${schema}${backup ? `; backup in ${backup}` : ""}`));

    // 4. Docker services, if their definitions changed.
    const composeChanged = !sh("git", ["diff", "--quiet", previous, commit, "--", "infra/compose"], {
      cwd: root,
      quiet: true,
    }).ok;
    await updateDocker(paths, composeChanged, Boolean(opts.honcho));

    // 5. Start and check.
    if (!serverRunsUnderSystemd()) {
      rmSync(stateFile(paths), { force: true });
      p.log.warn(
        warn(
          `Updated to ${commit.slice(0, 7)}. poke.service isn't installed, so start Poke yourself (${cmd("poke setup --only service")}).`,
        ),
      );
      return;
    }
    await serviceCommand(createContext(), "start", "poke");
    if (!(await waitHealthy(ctx))) throw new Error("Poke didn't come back after the restart");
    rmSync(stateFile(paths), { force: true });
    p.log.success(ok(`Poke is on ${commit.slice(0, 7)}`));
  } catch (error) {
    p.log.error(bad((error as Error).message));
    await rollback(ctx, root, previous, done);
    process.exitCode = 1;
  }
}

async function waitHealthy(ctx: Context, timeoutMs = 45_000): Promise<boolean> {
  const port = Number(process.env.POKE_PORT ?? 7070);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok && (await ctx.admin.reachable())) return true;
    } catch {
      // starting
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function rollback(
  ctx: Context,
  root: string,
  previous: string,
  done: { ota?: string; backup?: string; stopped?: boolean },
): Promise<void> {
  p.log.info(dim(`Rolling back to ${previous.slice(0, 7)}…`));
  try {
    await serviceCommand(ctx, "stop", "poke").catch(() => {});
    if (done.ota) rmSync(done.ota, { recursive: true, force: true });
    if (done.backup) restoreDatabase(ctx.paths, done.backup);
    must(
      "git checkout",
      sh("git", ["checkout", "--quiet", "--detach", previous], { cwd: root, quiet: true }),
    );
    buildAll(root);
    if (serverRunsUnderSystemd()) await serviceCommand(createContext(), "start", "poke");
    if (await waitHealthy(ctx)) p.log.warn(warn(`Rolled back: Poke is on ${previous.slice(0, 7)} again.`));
    else
      p.log.error(
        bad(
          `Rolled back to ${previous.slice(0, 7)}, but Poke isn't answering. Check ${cmd("poke logs poke")}.`,
        ),
      );
  } catch (error) {
    p.log.error(bad(`The rollback failed too: ${(error as Error).message}. Check ${cmd("poke status")}.`));
  }
}

// ── the OTA bundle ───────────────────────────────────────────────────────────────────────────

const KEEP_OTA = 3;

/** `expo export` into ~/poke/updates/ota/<runtime>/<ms>-<commit>/ (the server's UpdateStore layout). */
export function exportOta(root: string, paths: PokePaths, commit: string): { runtime: string; dir: string } {
  const mobile = join(root, "apps", "mobile");
  const runtime = resolveRuntime(root);

  const createdAt = Date.now();
  const base = join(paths.updates, "ota", runtime);
  const tmp = join(paths.updates, "tmp", `${createdAt}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(base, { recursive: true });
  must(
    "expo export",
    sh("pnpm", ["exec", "expo", "export", "--platform", "ios", "--output-dir", tmp], {
      cwd: mobile,
      quiet: true,
    }),
  );
  const config = sh("pnpm", ["exec", "expo", "config", "--json", "--type", "public"], {
    cwd: mobile,
    quiet: true,
  });
  must("expo config", config);
  writeFileSync(join(tmp, "expoConfig.json"), config.out.slice(config.out.indexOf("{")));
  writeFileSync(join(tmp, "update.json"), `${JSON.stringify({ createdAt, commit })}\n`);
  if (!existsSync(join(tmp, "metadata.json"))) throw new Error("expo export left no metadata.json");
  const dir = join(base, `${createdAt}-${commit.slice(0, 7)}`);
  renameSync(tmp, dir);
  prune(base, KEEP_OTA);
  rmSync(join(paths.updates, "tmp"), { recursive: true, force: true });
  return { runtime, dir };
}

/** The app's runtime version (its native fingerprint) at this checkout. */
function resolveRuntime(root: string): string {
  const resolved = sh("pnpm", ["exec", "expo-updates", "runtimeversion:resolve", "--platform", "ios"], {
    cwd: join(root, "apps", "mobile"),
    quiet: true,
  });
  must("Resolving the app's runtime version", resolved);
  const runtime = (JSON.parse(resolved.out.slice(resolved.out.indexOf("{"))) as { runtimeVersion: string })
    .runtimeVersion;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(runtime)) throw new Error(`Unexpected runtime version ${runtime}`);
  return runtime;
}

function reportIpa(ipa: string): void {
  if (ipa === "have") p.log.info(dim("The iPhone app's native build is here."));
  else if (ipa === "missing")
    p.log.warn(
      warn(
        "CI hasn't published the iPhone build for this version yet. Run poke update again once the release workflow finishes.",
      ),
    );
  else p.log.success(ok(`New iPhone build ${ipa} is in SideStore`));
}

// ── the native build ─────────────────────────────────────────────────────────────────────────

const KEEP_IPA = 3;

/** "have" (already here), "missing" (CI hasn't published it) or the new build number. */
export async function fetchIpa(root: string, paths: PokePaths, fingerprint: string): Promise<string> {
  const ipaDir = join(paths.updates, "ipa");
  if (existsSync(ipaDir)) {
    for (const build of readdirSync(ipaDir)) {
      try {
        const release = JSON.parse(readFileSync(join(ipaDir, build, "release.json"), "utf8")) as {
          fingerprint?: string;
        };
        if (release.fingerprint === fingerprint && existsSync(join(ipaDir, build, "Poke.ipa"))) return "have";
      } catch {
        // not a release
      }
    }
  }
  const slug = githubSlug(sh("git", ["remote", "get-url", "origin"], { cwd: root, quiet: true }).out);
  if (!slug) throw new Error("The checkout's origin isn't a GitHub repository");
  const token = await readSystemSecret(paths, "github.token");
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "poke-update",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const res = await fetch(`https://api.github.com/repos/${slug}/releases?per_page=50`, { headers });
  if (!res.ok) throw new Error(`GitHub releases: ${res.status}`);
  const release = releaseFor((await res.json()) as GithubRelease[], fingerprint);
  const ipaAsset = release?.assets.find((a) => a.name.endsWith(".ipa"));
  const jsonAsset = release?.assets.find((a) => a.name === "release.json");
  if (!release || !ipaAsset || !jsonAsset) return "missing";

  const download = async (id: number) => {
    // GitHub redirects to storage; fetch drops the authorization header on the cross-origin hop.
    const r = await fetch(`https://api.github.com/repos/${slug}/releases/assets/${id}`, {
      headers: { ...headers, accept: "application/octet-stream" },
    });
    if (!r.ok || !r.body) throw new Error(`Downloading the iPhone build: ${r.status}`);
    return r;
  };
  const meta = (await (await download(jsonAsset.id)).json()) as {
    buildVersion: string;
    fingerprint?: string;
  };
  if (!/^[0-9]{1,9}$/.test(meta.buildVersion)) throw new Error("The release's build number is malformed");
  const dir = join(ipaDir, meta.buildVersion);
  mkdirSync(dir, { recursive: true });
  const part = join(dir, "Poke.ipa.part");
  const body = (await download(ipaAsset.id)).body!;
  await pipeline(Readable.fromWeb(body as never), createWriteStream(part));
  renameSync(part, join(dir, "Poke.ipa"));
  writeFileSync(
    join(dir, "release.json"),
    `${JSON.stringify({ ...meta, fingerprint: meta.fingerprint ?? fingerprint }, null, 2)}\n`,
  );
  prune(ipaDir, KEEP_IPA, (n) => /^[0-9]+$/.test(n));
  return meta.buildVersion;
}

// ── Docker ───────────────────────────────────────────────────────────────────────────────────

async function updateDocker(paths: PokePaths, changed: boolean, honcho: boolean): Promise<void> {
  const layout = memoryLayout(paths);
  if (!existsSync(layout.composeEnv)) return;
  const pinned = existsSync(layout.honchoDir)
    ? sh("git", ["-C", layout.honchoDir, "describe", "--tags", "--exact-match"], { quiet: true }).out
    : undefined;
  const honchoBump = Boolean(pinned) && pinned !== HONCHO_VERSION;
  if (honchoBump && !honcho) {
    p.log.warn(
      warn(
        `Honcho ${HONCHO_VERSION} is available (running ${pinned}). Update it with ${cmd("poke update --honcho")}.`,
      ),
    );
    return;
  }
  // The server is stopped here, so the CLI renders the env files from the vault itself.
  const ctx = createContext();
  try {
    if (honcho && honchoBump) {
      await memorySetup(ctx);
      return;
    }
    if (!changed) return;
    await prepare(ctx);
    prepareTunnel({ system: (await ctx.localModels()).vault.system, paths });
    const running = sh("docker", composeArgs(layout, ["ps", "--services", "--status", "running"]), {
      quiet: true,
    })
      .out.split("\n")
      .filter(Boolean);
    if (running.length > 0)
      must("docker compose up", sh("docker", composeArgs(layout, ["up", "-d", "--no-build", ...running])));
    p.log.info(dim("Docker services updated"));
  } finally {
    await ctx.close();
  }
}
