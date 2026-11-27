import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EMBEDDING_DIMENSIONS } from "@poke/domain";
import type { MemoryStatus } from "@poke/contracts";
import { finishMemory, HONCHO_REPO, HONCHO_VERSION, type MemoryLayout, prepareMemory } from "@poke/server";
import type { Context } from "../admin.js";
import { cmd, dim, ok, p, warn } from "../ui.js";
import { modelsApi } from "./models.js";
import { registerSetupStep, skipOrRun } from "./setup.js";

// ── one API over the admin socket or the local stack ─────────────────────────────────────────

/** Renders compose.env and honcho.env; every compose service needs them. */
export async function prepare(ctx: Context): Promise<MemoryLayout> {
  if (await ctx.online())
    return (await ctx.admin.call<{ layout: MemoryLayout }>("POST", "/admin/memory/prepare")).layout;
  return prepareMemory({ system: (await ctx.localModels()).vault.system, paths: ctx.paths });
}

async function finish(ctx: Context): Promise<void> {
  if (await ctx.online()) await ctx.admin.call<MemoryStatus>("POST", "/admin/memory/finish");
  else finishMemory((await ctx.localModels()).vault.system, Date.now());
}

async function deployed(ctx: Context): Promise<boolean> {
  if (await ctx.online()) return (await ctx.admin.call<MemoryStatus>("GET", "/admin/memory")).deployed;
  return (await ctx.localModels()).vault.system.has("honcho.jwt");
}

// ── docker and git ───────────────────────────────────────────────────────────────────────────

function run(command: string, args: string[], quiet = false): boolean {
  const result = spawnSync(command, args, { stdio: quiet ? "ignore" : "inherit" });
  return result.status === 0;
}

export function output(command: string, args: string[]): string | undefined {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** The pinned Honcho release, cloned once and moved to the pin when it changes. */
function checkout(dir: string): void {
  if (!existsSync(dir)) {
    if (!run("git", ["clone", "--quiet", "--depth", "1", "--branch", HONCHO_VERSION, HONCHO_REPO, dir]))
      throw new Error("Couldn't download Honcho");
    return;
  }
  if (output("git", ["-C", dir, "describe", "--tags", "--exact-match"]) === HONCHO_VERSION) return;
  if (
    !run("git", ["-C", dir, "fetch", "--quiet", "--depth", "1", "origin", "tag", HONCHO_VERSION]) ||
    !run("git", ["-C", dir, "checkout", "--quiet", HONCHO_VERSION])
  )
    throw new Error(`Couldn't move Honcho to ${HONCHO_VERSION}`);
}

/** `docker compose` for Poke's project; cloudflared joins once its token file exists. */
export function composeArgs(
  layout: Pick<MemoryLayout, "composeFile" | "composeEnv">,
  args: string[],
): string[] {
  const tunnel = existsSync(join(dirname(layout.composeEnv), "cloudflared.env"))
    ? ["--profile", "tunnel"]
    : [];
  return [
    "compose",
    "-p",
    "poke",
    "-f",
    layout.composeFile,
    "--env-file",
    layout.composeEnv,
    ...tunnel,
    ...args,
  ];
}

export function compose(layout: Pick<MemoryLayout, "composeFile" | "composeEnv">, args: string[]): void {
  if (!run("docker", composeArgs(layout, args))) throw new Error(`docker compose ${args[0]} failed`);
}

// ── the setup step ───────────────────────────────────────────────────────────────────────────

/**
 * Section 13: Honcho at the pinned tag, its database and cache, every model call pointed at
 * Poke's gateway. The vector column is sized once, on the empty database, before the API starts.
 */
export async function memorySetup(ctx: Context): Promise<string[]> {
  const roles = await modelsApi(ctx).then((api) => api.roles());
  const chat = roles.find((r) => r.role === "memory.chat")?.assignment;
  const embeddings = roles.find((r) => r.role === "memory.embeddings")?.assignment;
  if (!chat || !embeddings) {
    p.log.warn(warn(`Pick the Memory models first: ${cmd("poke model")} (chat and embeddings).`));
    return ["memory models"];
  }
  if (!output("docker", ["compose", "version", "--short"])) {
    p.log.warn(warn("Docker Compose isn't available. Run the preflight fixes, then try again."));
    return ["docker"];
  }
  const spin = p.spinner();
  spin.start(`Getting Honcho ${HONCHO_VERSION}`);
  const layout = await prepare(ctx);
  try {
    checkout(layout.honchoDir);
  } finally {
    spin.stop(`Honcho ${HONCHO_VERSION}`);
  }
  p.log.info(dim("Building Honcho and starting its database (a few minutes the first time)…"));
  compose(layout, ["build", "honcho-api"]);
  compose(layout, ["up", "-d", "--wait", "postgres", "redis"]);

  const sized = `${embeddings.model} ${EMBEDDING_DIMENSIONS}`;
  if (!existsSync(layout.embeddingsMarker)) {
    const python = ["run", "--rm", "--no-deps", "--entrypoint", "/app/.venv/bin/python", "honcho-api"];
    compose(layout, [...python, "scripts/provision_db.py"]);
    compose(layout, [...python, "scripts/configure_embeddings.py", "--yes"]);
    writeFileSync(layout.embeddingsMarker, `${sized}\n`);
  } else {
    const was = readFileSync(layout.embeddingsMarker, "utf8").trim();
    if (was !== sized)
      p.log.warn(
        warn(
          `Memory was set up with ${was.split(" ")[0]}; the embedding model is now ${embeddings.model}. Search over older memories gets worse until Honcho is reset.`,
        ),
      );
  }
  compose(layout, ["up", "-d", "--wait", "honcho-api", "honcho-deriver"]);
  await finish(ctx);
  p.log.success(ok(`Memory is on: ${chat.model} thinks, ${embeddings.model} indexes`));
  return [];
}

registerSetupStep(
  {
    id: "memory",
    title: "Memory (Honcho)",
    later: "poke setup --only memory",
    async run(ctx) {
      if (!(await skipOrRun(`Memory: run Honcho ${HONCHO_VERSION} in Docker`, "poke setup --only memory")))
        return (await deployed(ctx)) ? [] : ["memory"];
      return memorySetup(ctx);
    },
  },
  "pair",
);
