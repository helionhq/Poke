import { spawnSync } from "node:child_process";
import { ensureDirs, ensureMasterKey } from "@poke/server";
import type { Context } from "../admin.js";
import { bad, cmd, dim, isInteractive, ok, p, pc, unwrap, warn } from "../ui.js";
import { pairPhone } from "./devices.js";
import { preflight } from "./preflight.js";

export interface SetupStep {
  id: string;
  title: string;
  /** Returns what's still missing (empty = complete). */
  run(ctx: Context): Promise<string[]>;
  /** The command to finish it later. */
  later: string;
}

const steps: SetupStep[] = [];

/** Later milestones register their wizard steps (logins, keys, models, Honcho, Bark, tunnel…). */
export function registerSetupStep(step: SetupStep, before?: string): void {
  const i = before ? steps.findIndex((s) => s.id === before) : -1;
  if (i >= 0) steps.splice(i, 0, step);
  else steps.push(step);
}

async function setSetting(ctx: Context, key: string, value: unknown): Promise<void> {
  if (await ctx.online()) await ctx.admin.call("PUT", "/admin/settings", { key, value });
  else ctx.local().settings.set(key, value);
}

async function getSetting<T>(ctx: Context, key: string): Promise<T | undefined> {
  if (await ctx.online()) {
    const { settings } = await ctx.admin.call<{ settings: Record<string, unknown> }>(
      "GET",
      "/admin/settings",
    );
    return settings[key] as T | undefined;
  }
  return ctx.local().settings.get(key as never) as T | undefined;
}

export async function skipOrRun(title: string, later: string): Promise<boolean> {
  const choice = unwrap(
    await p.select({
      message: title,
      options: [
        { value: "run", label: "Set it up now" },
        { value: "skip", label: "Skip", hint: `do it later with ${later}` },
      ],
    }),
  );
  return choice === "run";
}

registerSetupStep({
  id: "dirs",
  title: "Data folders and the vault master key",
  later: "poke setup",
  async run(ctx) {
    ensureDirs(ctx.paths);
    const { created } = ensureMasterKey(ctx.paths.masterKey);
    p.log.success(ok(`Data folders ready under ${ctx.paths.home}`));
    p.log.success(
      ok(created ? `Created the master key at ${ctx.paths.masterKey} (0600)` : "Master key already exists"),
    );
    return [];
  },
});

registerSetupStep({
  id: "profile",
  title: "Your profile",
  later: "poke config profile.name <name>",
  async run(ctx) {
    if (!(await skipOrRun("Profile: name, timezone, home city", "poke config profile.*"))) {
      return (await getSetting(ctx, "profile.timezone")) ? [] : ["profile"];
    }
    const name = unwrap(
      await p.text({
        message: "What should Poke call you?",
        initialValue: (await getSetting<string>(ctx, "profile.name")) ?? "",
        validate: (v) => (v?.trim() ? undefined : "Required"),
      }),
    );
    const guess = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tz = unwrap(
      await p.text({
        message: "Timezone (IANA)",
        initialValue: (await getSetting<string>(ctx, "profile.timezone")) ?? guess,
        validate: (v) => {
          try {
            new Intl.DateTimeFormat("en", { timeZone: v ?? "" });
            return undefined;
          } catch {
            return "Not a valid IANA timezone (e.g. Europe/Lisbon)";
          }
        },
      }),
    );
    const city = unwrap(
      await p.text({
        message: "Home city (optional)",
        initialValue: (await getSetting<string>(ctx, "profile.homeCity")) ?? "",
      }),
    );
    await setSetting(ctx, "profile.name", name.trim());
    await setSetting(ctx, "profile.timezone", tz.trim());
    if (city.trim()) await setSetting(ctx, "profile.homeCity", city.trim());
    p.log.success(ok("Profile saved"));
    return [];
  },
});

registerSetupStep({
  id: "pair",
  title: "Pair your iPhone",
  later: "poke config devices pair",
  async run(ctx) {
    if (!(await skipOrRun("Pair your iPhone with a QR code", "poke config devices pair"))) return ["phone"];
    await pairPhone(ctx);
    unwrap(await p.confirm({ message: "Scanned it? (the code stays valid for 10 minutes)" }));
    return [];
  },
});

export async function setupCommand(
  ctx: Context,
  opts: { preflightOnly?: boolean; yes?: boolean },
): Promise<void> {
  p.intro(pc.bold("Poke setup"));
  const online = await ctx.online();
  const checks = await preflight(ctx.paths.home, { serverRunning: online });
  const lines = checks.map((c) => {
    const icon = c.status === "ok" ? ok : c.status === "warn" ? warn : bad;
    return icon(`${c.label.padEnd(16)} ${dim(c.detail)}`);
  });
  p.note(lines.join("\n"), "Preflight");

  if (isInteractive() && !opts.preflightOnly) {
    for (const check of checks) {
      if (!check.fix || check.status === "ok") continue;
      const go = unwrap(
        await p.confirm({ message: `${check.fix.label}? ${dim(check.fix.command)}`, initialValue: false }),
      );
      if (go) {
        const result = spawnSync("bash", ["-lc", check.fix.command], { stdio: "inherit" });
        p.log.info(result.status === 0 ? ok(`${check.fix.label}: done`) : bad(`${check.fix.label} failed`));
      }
    }
  }
  if (opts.preflightOnly) {
    p.outro(checks.some((c) => c.status === "fail") ? "Some checks failed." : "Preflight passed.");
    process.exitCode = checks.some((c) => c.status === "fail") ? 1 : 0;
    return;
  }
  if (checks.some((c) => c.id === "node" && c.status === "fail")) {
    p.cancel("Node.js 22.19 or newer is required.");
    process.exit(1);
  }
  if (!isInteractive()) {
    p.log.warn("Not a terminal: running only the non-interactive steps (folders and master key).");
    await steps.find((s) => s.id === "dirs")!.run(ctx);
    p.outro("Run `poke setup` in a terminal for the rest.");
    return;
  }

  const missing: { step: SetupStep; items: string[] }[] = [];
  for (const step of steps) {
    p.log.step(pc.bold(step.title));
    try {
      const items = await step.run(ctx);
      if (items.length > 0) missing.push({ step, items });
    } catch (error) {
      p.log.error(bad(`${step.title}: ${(error as Error).message}`));
      missing.push({ step, items: ["failed"] });
    }
  }

  if (missing.length === 0) {
    p.outro(ok("Poke is set up. Say hi from your phone."));
    return;
  }
  p.note(
    missing.map((m) => `${warn(m.step.title)}  ${dim("→")} ${cmd(m.step.later)}`).join("\n"),
    "Still to do",
  );
  p.outro("Run any of these whenever you're ready; `poke setup` is safe to run again.");
}
