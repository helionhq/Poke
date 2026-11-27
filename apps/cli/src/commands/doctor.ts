import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { memoryLayout, repoRoot } from "@poke/server";
import type { Context } from "../admin.js";
import { bad, cmd, dim, isInteractive, ok, p, pc, printJson, unwrap, warn } from "../ui.js";
import { loginCommand } from "./models.js";
import { composeArgs } from "./memory.js";
import { type Check as PreflightCheck, preflight } from "./preflight.js";
import { serverRunsUnderSystemd, serviceCommand, serviceSetup } from "./services.js";
import { getStatus } from "./status.js";

/**
 * `poke doctor` (brief section 21): deep checks, each problem with a fix to run. Sends a test
 * push when Bark is set up (section 18) and warns 30 days before the Claude token expires
 * (section 3).
 */

export interface DoctorCheck {
  id: string;
  group: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix?: { label: string; run: () => Promise<void> } | { label: string; command: string };
}

const DAY = 86_400_000;
export const TOKEN_WARN_DAYS = 30;

/** The Claude token's state, from when it was saved (it lasts about a year). */
export function claudeTokenCheck(
  expiresAt: number | undefined,
  now: number,
): Pick<DoctorCheck, "status" | "detail"> {
  if (expiresAt === undefined) return { status: "ok", detail: "logged in" };
  const days = Math.floor((expiresAt - now) / DAY);
  if (days < 0)
    return { status: "fail", detail: `the token expired on ${new Date(expiresAt).toDateString()}` };
  if (days <= TOKEN_WARN_DAYS)
    return { status: "warn", detail: `the token expires in ${days} day${days === 1 ? "" : "s"}` };
  return { status: "ok", detail: `token good until ${new Date(expiresAt).toDateString()}` };
}

/** Files that hold secrets must be readable by Poke's user only. */
export function privateFiles(home: string, services: string): Array<{ path: string; mode: number }> {
  const files = [
    { path: join(home, "keys"), mode: 0o700 },
    { path: join(home, "keys", "master.key"), mode: 0o600 },
    ...["compose.env", "honcho.env", "cloudflared.env"].map((f) => ({
      path: join(services, f),
      mode: 0o600,
    })),
  ];
  return files.filter((f) => existsSync(f.path));
}

async function logins(ctx: Context) {
  if (await ctx.online())
    return (
      await ctx.admin.call<{
        logins: Array<{
          id: string;
          name: string;
          providers: string[];
          loggedIn: boolean;
          expiresAt?: number;
        }>;
      }>("GET", "/admin/logins")
    ).logins;
  return (await ctx.localModels()).logins.list();
}

export async function runChecks(ctx: Context): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (check: DoctorCheck) => checks.push(check);
  const online = await ctx.online();

  // The machine (same checks as setup's preflight, with their fixes).
  for (const c of await preflight(ctx.paths.home, { serverRunning: online })) add(fromPreflight(c));

  // The server
  const systemd = serverRunsUnderSystemd();
  add(
    online
      ? {
          id: "server",
          group: "Poke",
          label: "poke-server",
          status: "ok",
          detail: "answering on the admin socket",
        }
      : {
          id: "server",
          group: "Poke",
          label: "poke-server",
          status: "fail",
          detail: "not running",
          fix: systemd
            ? { label: "Start Poke", run: () => serviceCommand(ctx, "start", "poke") }
            : { label: "Install and start poke.service", run: async () => void (await serviceSetup(ctx)) },
        },
  );
  if (process.platform === "linux")
    add(
      systemd
        ? { id: "service", group: "Poke", label: "poke.service", status: "ok", detail: "installed" }
        : {
            id: "service",
            group: "Poke",
            label: "poke.service",
            status: "warn",
            detail: "not installed: Poke won't start with the machine",
            fix: { label: "Install poke.service", run: async () => void (await serviceSetup(ctx)) },
          },
    );
  const port = Number(process.env.POKE_PORT ?? 7070);
  if (online) {
    const local = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(3000) })
      .then((r) => r.ok)
      .catch(() => false);
    add({
      id: "api",
      group: "Poke",
      label: "API",
      status: local ? "ok" : "fail",
      detail: local ? `127.0.0.1:${port}` : `127.0.0.1:${port} doesn't answer`,
      ...(local || !systemd
        ? {}
        : { fix: { label: "Restart Poke", run: () => serviceCommand(ctx, "restart", "poke") } }),
    });
  }

  // Secrets on disk
  if (process.platform !== "win32") {
    const loose = privateFiles(ctx.paths.home, ctx.paths.services).filter(
      (f) => (statSync(f.path).mode & 0o777 & ~f.mode) !== 0,
    );
    add(
      loose.length === 0
        ? { id: "perms", group: "Poke", label: "Key files", status: "ok", detail: "private to this user" }
        : {
            id: "perms",
            group: "Poke",
            label: "Key files",
            status: "fail",
            detail: `readable by others: ${loose.map((f) => f.path).join(", ")}`,
            fix: {
              label: "Make them private",
              run: async () => {
                for (const f of loose) chmodSync(f.path, f.mode);
              },
            },
          },
    );
  }

  // Logins and models
  const report = await getStatus(ctx);
  const now = Date.now();
  const pokeModel = report.models.find((m) => m.role === "poke")?.assignment;
  for (const login of await logins(ctx)) {
    const used = report.models.some((m) => m.assignment && login.providers.includes(m.assignment.provider));
    if (!login.loggedIn) {
      if (used)
        add({
          id: `login.${login.id}`,
          group: "Logins",
          label: login.name,
          status: "fail",
          detail: "not logged in, but a role uses it",
          fix: { label: `Log in to ${login.name}`, run: () => loginCommand(ctx, login.id, {}) },
        });
      continue;
    }
    const state =
      login.id === "anthropic"
        ? claudeTokenCheck(login.expiresAt, now)
        : { status: "ok" as const, detail: "logged in" };
    add({
      id: `login.${login.id}`,
      group: "Logins",
      label: login.name,
      ...state,
      ...(state.status === "ok"
        ? {}
        : {
            fix: {
              label: "Make a new token (claude setup-token)",
              run: () => loginCommand(ctx, login.id, {}),
            },
          }),
    });
  }
  add(
    pokeModel
      ? {
          id: "model.poke",
          group: "Models",
          label: "Poke",
          status: "ok",
          detail: `${pokeModel.model} · ${pokeModel.provider}`,
        }
      : {
          id: "model.poke",
          group: "Models",
          label: "Poke",
          status: "fail",
          detail: "no model: Poke can't reply",
          fix: { label: "Pick models", command: "poke model" },
        },
  );
  const unset = report.models.filter((m) => !m.assignment && m.role !== "poke").map((m) => m.label);
  if (unset.length > 0)
    add({
      id: "models",
      group: "Models",
      label: "Other roles",
      status: "warn",
      detail: `not set: ${unset.join(", ")}`,
      fix: { label: "Pick models", command: "poke model" },
    });

  // Docker services
  const layout = memoryLayout(ctx.paths);
  if (existsSync(layout.composeEnv)) {
    const ps = spawnSync(
      "docker",
      composeArgs(layout, ["ps", "-a", "--format", "{{.Service}}\t{{.State}}\t{{.Health}}"]),
      {
        encoding: "utf8",
      },
    );
    for (const line of (ps.stdout ?? "").split("\n").filter(Boolean)) {
      const [name = "", state = "", health = ""] = line.split("\t");
      const good = state === "running" && (health === "" || health === "healthy");
      add({
        id: `docker.${name}`,
        group: "Services",
        label: name,
        status: good ? "ok" : health === "starting" ? "warn" : "fail",
        detail: health ? `${state}, ${health}` : state,
        ...(good
          ? {}
          : { fix: { label: `Restart ${name}`, run: () => serviceCommand(ctx, "restart", name) } }),
      });
    }
  }
  const memory = report.sections.memory as { on: boolean; deployed: boolean } | undefined;
  if (memory && memory.deployed && !memory.on)
    add({
      id: "memory",
      group: "Services",
      label: "Memory",
      status: "warn",
      detail: "Honcho is set up but the Memory models aren't picked",
      fix: { label: "Pick the Memory models", command: "poke model" },
    });

  // Tunnel
  if (existsSync(join(ctx.paths.services, "cloudflared.env"))) {
    const ready = await fetch("http://127.0.0.1:20241/ready", { signal: AbortSignal.timeout(2000) })
      .then((r) => r.ok)
      .catch(() => false);
    add({
      id: "tunnel",
      group: "Tunnel",
      label: "cloudflared",
      status: ready ? "ok" : "fail",
      detail: ready ? "connected to Cloudflare" : "not connected",
      ...(ready
        ? {}
        : { fix: { label: "Restart the tunnel", run: () => serviceCommand(ctx, "restart", "tunnel") } }),
    });
    const publicUrl = await setting(ctx, "public.url");
    if (ready && publicUrl) {
      const res = await fetch(`${publicUrl.replace(/\/+$/, "")}/v1/health`, {
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
      }).catch(() => undefined);
      add({
        id: "public",
        group: "Tunnel",
        label: new URL(publicUrl).host,
        status: res?.ok ? "ok" : "fail",
        detail: res?.ok
          ? "reaches Poke from outside"
          : res
            ? `answers ${res.status}: check the route points at http://localhost:${port}`
            : "doesn't answer: check the tunnel's routes and DNS",
      });
    }
  } else {
    add({
      id: "tunnel",
      group: "Tunnel",
      label: "cloudflared",
      status: "warn",
      detail: "not set up: the phone can't reach Poke away from this machine",
      fix: { label: "Set up the tunnel", command: "poke setup --only tunnel" },
    });
  }

  // Notifications: a real push (brief section 18).
  const push = report.sections.notifications as { on: boolean } | undefined;
  if (push?.on && online) {
    const sent = await ctx.admin
      .call("POST", "/admin/notifications/test")
      .then(() => undefined)
      .catch((e: Error) => e.message);
    add({
      id: "push",
      group: "Notifications",
      label: "Bark",
      status: sent ? "fail" : "ok",
      detail: sent ? `test push failed: ${sent}` : "sent a test push: check the iPhone",
    });
  } else if (!push?.on) {
    add({
      id: "push",
      group: "Notifications",
      label: "Bark",
      status: "warn",
      detail: "not set up: Poke can't reach you when the app is closed",
      fix: { label: "Set up notifications", command: "poke setup --only notifications" },
    });
  }

  // Updates and backups
  const root = repoRoot();
  const dirty = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: root,
    encoding: "utf8",
  });
  if (dirty.status === 0)
    add(
      dirty.stdout.trim()
        ? {
            id: "checkout",
            group: "Updates",
            label: "Checkout",
            status: "warn",
            detail: `local changes in ${root}: poke update won't run`,
          }
        : { id: "checkout", group: "Updates", label: "Checkout", status: "ok", detail: "clean" },
    );
  const keys = await serviceKeysSet(ctx);
  if (!keys.includes("github.token"))
    add({
      id: "github",
      group: "Updates",
      label: "GitHub token",
      status: "warn",
      detail: "not set: poke update can't reach the private repo",
      fix: { label: "Set it", command: "poke config github.token" },
    });
  add(backupCheck(ctx, now));
  return checks;
}

function backupCheck(ctx: Context, now: number): DoctorCheck {
  const dir = join(ctx.paths.home, "backups");
  const newest = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".tar.gz"))
        .map((f) => statSync(join(dir, f)).mtimeMs)
        .sort((a, b) => b - a)[0]
    : undefined;
  if (newest === undefined)
    return {
      id: "backup",
      group: "Updates",
      label: "Backup",
      status: "warn",
      detail: "no full backup yet",
      fix: { label: "Back up now", command: "poke backup" },
    };
  const days = Math.floor((now - newest) / DAY);
  return {
    id: "backup",
    group: "Updates",
    label: "Backup",
    status: days > 30 ? "warn" : "ok",
    detail: `last full backup ${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`}`,
    ...(days > 30 ? { fix: { label: "Back up now", command: "poke backup" } } : {}),
  };
}

async function serviceKeysSet(ctx: Context): Promise<string[]> {
  if (await ctx.online()) {
    const { keys } = await ctx.admin.call<{ keys: Array<{ key: string; set: boolean }> }>(
      "GET",
      "/admin/keys",
    );
    return keys.filter((k) => k.set).map((k) => k.key);
  }
  return (await ctx.localModels()).vault.system.keys();
}

async function setting(ctx: Context, key: string): Promise<string | undefined> {
  if (await ctx.online()) {
    const { settings } = await ctx.admin.call<{ settings: Record<string, unknown> }>(
      "GET",
      "/admin/settings",
    );
    return settings[key] as string | undefined;
  }
  return ctx.local().settings.get(key as never) as string | undefined;
}

function fromPreflight(c: PreflightCheck): DoctorCheck {
  return {
    id: `machine.${c.id}`,
    group: "Machine",
    label: c.label,
    status: c.status,
    detail: c.detail,
    ...(c.fix ? { fix: { label: c.fix.label, command: c.fix.command } } : {}),
  };
}

export async function doctorCommand(ctx: Context, opts: { json?: boolean; fix?: boolean }): Promise<void> {
  const spin = opts.json ? undefined : p.spinner();
  spin?.start("Checking Poke");
  const checks = await runChecks(ctx);
  spin?.stop("Checked");
  if (opts.json) {
    printJson({ checks: checks.map(({ fix, ...c }) => ({ ...c, ...(fix ? { fix: fix.label } : {}) })) });
    if (checks.some((c) => c.status === "fail")) process.exitCode = 1;
    return;
  }
  let group = "";
  const out: string[] = [];
  for (const c of checks) {
    if (c.group !== group) {
      group = c.group;
      out.push("", pc.bold(group));
    }
    const mark = c.status === "ok" ? ok : c.status === "warn" ? warn : bad;
    out.push(mark(`${c.label.padEnd(22)} ${dim(c.detail)}`));
  }
  console.log(out.join("\n"));

  const problems = checks.filter((c) => c.status !== "ok" && c.fix);
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  console.log(
    "\n" +
      (fails + warns === 0
        ? ok("Everything looks right")
        : `${fails ? pc.red(`${fails} problem${fails === 1 ? "" : "s"}`) : ""}${fails && warns ? ", " : ""}${warns ? pc.yellow(`${warns} warning${warns === 1 ? "" : "s"}`) : ""}`),
  );
  if (problems.length === 0) {
    if (fails) process.exitCode = 1;
    return;
  }
  if (!isInteractive() && !opts.fix) {
    for (const c of problems)
      console.log(dim(`  ${c.label}: ${"command" in c.fix! ? cmd(c.fix!.command) : c.fix!.label}`));
    if (fails) process.exitCode = 1;
    return;
  }
  for (const c of problems) {
    const fix = c.fix!;
    const go =
      opts.fix ||
      unwrap(
        await p.confirm({
          message: `${c.label}: ${fix.label}?${"command" in fix ? ` ${dim(fix.command)}` : ""}`,
          initialValue: c.status === "fail",
        }),
      );
    if (!go) continue;
    try {
      if ("command" in fix) {
        const result = spawnSync("bash", ["-lc", fix.command], { stdio: "inherit" });
        if (result.status !== 0) throw new Error(`${fix.command} exited with ${result.status}`);
      } else await fix.run();
      p.log.success(ok(`${fix.label}: done`));
    } catch (error) {
      p.log.error(bad(`${fix.label}: ${(error as Error).message}`));
    }
  }
}
