import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { memoryLayout, prepareTunnel, renderTemplate, repoRoot } from "@poke/server";
import type { Context } from "../admin.js";
import { cmd, dim, isInteractive, ok, p, unwrap, warn } from "../ui.js";
import { composeArgs, output } from "./memory.js";
import { readStdin } from "./models.js";
import { registerSetupStep, skipOrRun } from "./setup.js";

/**
 * `poke start` / `stop` / `restart [service]` and `poke logs [service] [-f]` (brief section 21):
 * the server is the systemd user unit poke.service, the rest are the Docker services.
 */

const COMPOSE_SERVICES = ["honcho-api", "honcho-deriver", "postgres", "redis", "bark-server", "cloudflared"];
const ALIASES: Record<string, string[]> = {
  server: ["poke"],
  honcho: ["honcho-api", "honcho-deriver"],
  memory: ["honcho-api", "honcho-deriver", "postgres", "redis"],
  bark: ["bark-server"],
  tunnel: ["cloudflared"],
};
export const SERVICE_NAMES = ["poke", ...COMPOSE_SERVICES, ...Object.keys(ALIASES)];

/** Which units a name means. Undefined: everything. */
export function resolveServices(name: string | undefined): { server: boolean; docker: string[] } | undefined {
  if (!name) return undefined;
  const names = ALIASES[name] ?? [name];
  if (!names.every((n) => n === "poke" || COMPOSE_SERVICES.includes(n)))
    throw new Error(`No service called ${name}. Services: ${SERVICE_NAMES.join(", ")}`);
  return { server: names.includes("poke"), docker: names.filter((n) => n !== "poke") };
}

function hasSystemd(): boolean {
  return (
    process.platform === "linux" &&
    spawnSync("systemctl", ["--user", "--version"], { stdio: "ignore" }).status === 0
  );
}

function systemctl(args: string[], quiet = false): boolean {
  return spawnSync("systemctl", ["--user", ...args], { stdio: quiet ? "ignore" : "inherit" }).status === 0;
}

/** poke.service is installed and systemd can drive it (Poke's machine). */
export function serverRunsUnderSystemd(): boolean {
  return hasSystemd() && serverUnitInstalled();
}

function serverUnitInstalled(): boolean {
  return existsSync(join(unitDir(), "poke.service"));
}

/** compose.env exists once memory or notifications were set up. */
function dockerLayout(ctx: Context) {
  const layout = memoryLayout(ctx.paths);
  return existsSync(layout.composeEnv) ? layout : undefined;
}

function docker(ctx: Context, args: string[]): boolean {
  const layout = dockerLayout(ctx);
  if (!layout) return true;
  return spawnSync("docker", composeArgs(layout, args), { stdio: "inherit" }).status === 0;
}

/** Containers Poke has created (so "start everything" doesn't create services never set up). */
function createdServices(ctx: Context): string[] {
  const layout = dockerLayout(ctx);
  if (!layout) return [];
  const out = output("docker", composeArgs(layout, ["ps", "-a", "--services"]));
  return out ? out.split("\n").filter(Boolean) : [];
}

export async function serviceCommand(
  ctx: Context,
  action: "start" | "stop" | "restart",
  name?: string,
): Promise<void> {
  const only = resolveServices(name);
  const server = only ? only.server : true;
  const containers = only ? only.docker : createdServices(ctx);
  const failed: string[] = [];

  if (action !== "start" && server) {
    if (hasSystemd() && serverUnitInstalled()) {
      if (!systemctl([action === "stop" ? "stop" : "restart", "poke.service"])) failed.push("poke");
    } else if (only?.server)
      throw new Error(`poke.service isn't installed. Run ${cmd("poke setup --only service")}.`);
  }
  if (containers.length > 0) {
    if (!dockerLayout(ctx)) {
      if (only)
        throw new Error("No Docker services are set up yet (poke setup: memory, notifications, tunnel).");
    } else {
      const verb =
        action === "start" ? ["up", "-d", "--no-build"] : action === "stop" ? ["stop"] : ["restart"];
      if (!docker(ctx, [...verb, ...containers])) failed.push(...containers);
    }
  }
  if (action === "start" && server) {
    if (hasSystemd() && serverUnitInstalled()) {
      if (!systemctl(["start", "poke.service"])) failed.push("poke");
    } else if (only?.server)
      throw new Error(`poke.service isn't installed. Run ${cmd("poke setup --only service")}.`);
  }
  if (failed.length > 0) throw new Error(`Couldn't ${action} ${failed.join(", ")}`);
  const what = name ?? "everything";
  console.log(ok(`${action === "stop" ? "Stopped" : action === "start" ? "Started" : "Restarted"} ${what}`));
}

export async function logsCommand(
  ctx: Context,
  name: string | undefined,
  opts: { follow?: boolean },
): Promise<void> {
  const only = resolveServices(name);
  const follow = opts.follow ? ["-f"] : [];
  const children: Array<Promise<number>> = [];
  const run = (command: string, args: string[]) =>
    children.push(
      new Promise((resolve) => {
        const child = spawn(command, args, { stdio: "inherit" });
        child.on("exit", (code) => resolve(code ?? 1));
        child.on("error", () => resolve(1));
      }),
    );
  if (!only || only.server) {
    if (hasSystemd())
      run("journalctl", ["--user", "-u", "poke.service", "-n", "200", "-o", "cat", ...follow]);
    else {
      const log = join(ctx.paths.logs, "poke.log");
      if (existsSync(log)) console.log(readFileSync(log, "utf8").split("\n").slice(-200).join("\n"));
      else console.log(dim("No server logs here (poke.service runs under systemd on Poke's machine)."));
    }
  }
  const containers = only ? only.docker : createdServices(ctx);
  const layout = dockerLayout(ctx);
  if (containers.length > 0 && layout)
    run("docker", composeArgs(layout, ["logs", "--tail", "200", ...follow, ...containers]));
  const codes = await Promise.all(children);
  if (codes.some((c) => c !== 0 && c !== 130)) process.exitCode = 1;
}

// ── the systemd step ─────────────────────────────────────────────────────────────────────────

function unitDir(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user");
}

/** Renders poke.service and the nightly update timer into ~/.config/systemd/user. */
export function writeUnits(ctx: Context, root = repoRoot()): string[] {
  const dir = unitDir();
  mkdirSync(dir, { recursive: true });
  const values = { repo: root, home: ctx.paths.home, node: process.execPath };
  const written: string[] = [];
  for (const unit of ["poke.service", "poke-update.service", "poke-update.timer"]) {
    const template = readFileSync(join(root, "infra", "systemd", unit), "utf8");
    const rendered = template.includes("{{") ? renderTemplate(template, values) : template;
    writeFileSync(join(dir, unit), rendered);
    written.push(join(dir, unit));
  }
  return written;
}

async function healthy(ctx: Context, timeoutMs = 30_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await ctx.admin.reachable()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export async function serviceSetup(ctx: Context): Promise<string[]> {
  if (!hasSystemd()) {
    p.log.warn(
      warn("systemd isn't available here. On Poke's machine (Ubuntu) this step installs poke.service."),
    );
    return ["poke.service"];
  }
  writeUnits(ctx);
  systemctl(["daemon-reload"], true);
  if (!systemctl(["enable", "poke.service", "poke-update.timer"], true)) {
    p.log.warn(warn("Couldn't enable poke.service."));
    return ["poke.service"];
  }
  const linger = output("loginctl", ["show-user", userInfo().username, "--property=Linger", "--value"]);
  if (linger !== "yes")
    p.log.warn(
      warn(
        `Poke stops when you log out until lingering is on: ${cmd(`sudo loginctl enable-linger ${userInfo().username}`)}`,
      ),
    );
  // The server may be running by hand (setup's own process); systemd takes over from here.
  if (!systemctl(["restart", "poke.service"])) return ["poke.service"];
  if (!(await healthy(ctx))) {
    p.log.warn(warn(`poke.service started but isn't answering yet. Check ${cmd("poke logs poke")}.`));
    return ["poke.service"];
  }
  p.log.success(ok("Poke runs as a service: it starts with the machine and restarts if it stops"));
  return [];
}

registerSetupStep(
  {
    id: "service",
    title: "Run Poke as a service (systemd)",
    later: "poke setup --only service",
    async run(ctx) {
      if (!(await skipOrRun("Install poke.service and start Poke", "poke setup --only service")))
        return serverUnitInstalled() ? [] : ["poke.service"];
      return serviceSetup(ctx);
    },
  },
  "pair",
);

// ── the tunnel step ──────────────────────────────────────────────────────────────────────────

/** A remotely managed tunnel's token is base64 JSON with the account (a), tunnel (t) and secret (s). */
export function looksLikeTunnelToken(token: string): boolean {
  try {
    const parsed = JSON.parse(Buffer.from(token.trim(), "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
    return typeof parsed.a === "string" && typeof parsed.t === "string" && typeof parsed.s === "string";
  } catch {
    return false;
  }
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

async function tunnelTokenSet(ctx: Context): Promise<boolean> {
  if (await ctx.online()) {
    const list = await ctx.admin.call<{ keys: Array<{ key: string; set: boolean }> }>("GET", "/admin/keys");
    return list.keys.some((k) => k.key === "cloudflare.tunnelToken" && k.set);
  }
  return (await ctx.localModels()).vault.system.has("cloudflare.tunnelToken");
}

async function saveTunnelToken(ctx: Context, token: string): Promise<boolean> {
  if (await ctx.online()) {
    await ctx.admin.call("PUT", "/admin/keys/cloudflare.tunnelToken", { value: token });
    return (await ctx.admin.call<{ ready: boolean }>("POST", "/admin/tunnel/prepare")).ready;
  }
  const system = (await ctx.localModels()).vault.system;
  system.set("cloudflare.tunnelToken", token);
  return prepareTunnel({ system, paths: ctx.paths });
}

async function reachableFromOutside(url: string, timeoutMs = 60_000): Promise<number | undefined> {
  const until = Date.now() + timeoutMs;
  let last: number | undefined;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${url.replace(/\/+$/, "")}/v1/health`, {
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      last = res.status;
      if (res.ok) return res.status;
    } catch {
      // DNS or the tunnel isn't up yet
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return last;
}

export async function tunnelSetup(ctx: Context, opts: { stdin?: boolean } = {}): Promise<string[]> {
  const publicUrl = (await setting(ctx, "public.url")) ?? "https://poke.arham.im";
  const barkUrl = (await setting(ctx, "bark.url")) ?? "https://bark.arham.im";
  const host = (u: string) => new URL(u).host;
  if (!opts.stdin)
    p.note(
      [
        "In the Cloudflare dashboard: Networking > Tunnels > Create a tunnel (Cloudflared).",
        "Copy the token from the install command (the long value after --token).",
        "",
        "Then add two routes (Routes > Add route > Published application):",
        `  ${host(publicUrl)}  to  http://localhost:7070`,
        `  ${host(barkUrl)}  to  http://localhost:8090`,
      ].join("\n"),
      "Cloudflare Tunnel",
    );
  let token = opts.stdin
    ? await readStdin()
    : unwrap(
        await p.password({
          message: "Tunnel token",
          validate: (v) => (looksLikeTunnelToken(v ?? "") ? undefined : "That isn't a tunnel token"),
        }),
      );
  token = token.trim();
  if (!looksLikeTunnelToken(token)) throw new Error("That isn't a Cloudflare Tunnel token");
  if (!(await saveTunnelToken(ctx, token))) throw new Error("Couldn't write the tunnel's settings");
  const layout = dockerLayout(ctx);
  if (!layout) {
    p.log.warn(
      warn(`Set up memory or notifications first: they create the Docker project the tunnel joins.`),
    );
    return ["tunnel"];
  }
  if (!docker(ctx, ["up", "-d", "cloudflared"])) {
    p.log.warn(warn(`cloudflared didn't start. Check ${cmd("poke logs tunnel")}.`));
    return ["tunnel"];
  }
  const spin = p.spinner();
  spin.start(`Checking ${host(publicUrl)} from outside`);
  const status = await reachableFromOutside(publicUrl);
  if (status === 200) {
    spin.stop(ok(`${host(publicUrl)} reaches Poke`));
    return [];
  }
  spin.stop(
    warn(
      status
        ? `${host(publicUrl)} answered ${status}. Check the route points at http://localhost:7070, and Poke is running.`
        : `${host(publicUrl)} didn't answer yet. Check the routes in the dashboard; DNS can take a minute.`,
    ),
  );
  return [];
}

registerSetupStep(
  {
    id: "tunnel",
    title: "Cloudflare Tunnel",
    later: "poke setup --only tunnel",
    async run(ctx) {
      const set = await tunnelTokenSet(ctx);
      if (!isInteractive()) return set ? [] : ["cloudflare.tunnelToken"];
      if (
        !(await skipOrRun(
          "Cloudflare Tunnel: reach Poke from your phone anywhere",
          "poke setup --only tunnel",
        ))
      )
        return set ? [] : ["cloudflare.tunnelToken"];
      return tunnelSetup(ctx);
    },
  },
  "pair",
);
