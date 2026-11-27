import { BarkNotifier } from "@poke/server";
import type { Context } from "../admin.js";
import { cmd, dim, ok, p, unwrap, warn } from "../ui.js";
import { compose, output, prepare } from "./memory.js";
import { registerSetupStep, skipOrRun } from "./setup.js";

const DEFAULT_BARK_URL = "https://bark.arham.im";

async function barkUrl(ctx: Context): Promise<string> {
  if (await ctx.online()) {
    const { settings } = await ctx.admin.call<{ settings: Record<string, unknown> }>(
      "GET",
      "/admin/settings",
    );
    return String(settings["bark.url"] ?? DEFAULT_BARK_URL);
  }
  return ctx.local().settings.get("bark.url") ?? DEFAULT_BARK_URL;
}

async function hasKey(ctx: Context): Promise<boolean> {
  if (await ctx.online()) {
    const list = await ctx.admin.call<{ keys: Array<{ key: string; set: boolean }> }>("GET", "/admin/keys");
    return list.keys.some((k) => k.key === "bark.deviceKey" && k.set);
  }
  return (await ctx.localModels()).vault.system.has("bark.deviceKey");
}

async function saveKey(ctx: Context, value: string): Promise<void> {
  if (await ctx.online()) await ctx.admin.call("PUT", "/admin/keys/bark.deviceKey", { value });
  else (await ctx.localModels()).vault.system.set("bark.deviceKey", value);
}

/** A test push: through the running server when it's up, straight to Bark otherwise. */
async function testPush(ctx: Context): Promise<void> {
  if (await ctx.online()) {
    await ctx.admin.call("POST", "/admin/notifications/test");
    return;
  }
  const url = await barkUrl(ctx);
  const system = (await ctx.localModels()).vault.system;
  await new BarkNotifier({ url: () => url, deviceKey: () => system.get("bark.deviceKey") }).send({
    title: "Poke",
    body: "Notifications from Poke work.",
    group: "poke",
  });
}

/**
 * The device key is the part of the Bark app's server URL after the server: in
 * `https://bark.arham.im/AbCdEf123/`, it's `AbCdEf123`. Accept either the key or the whole URL.
 */
export function deviceKeyFrom(input: string): string {
  const value = input.trim();
  try {
    const url = new URL(value);
    return url.pathname.split("/").filter(Boolean)[0] ?? "";
  } catch {
    return value;
  }
}

/** Section 21 step 8: bark-server in Docker, the Bark app pointed at it, a test push. */
export async function notificationsSetup(ctx: Context): Promise<string[]> {
  if (!output("docker", ["compose", "version", "--short"])) {
    p.log.warn(warn("Docker Compose isn't available. Run the preflight fixes, then try again."));
    return ["docker"];
  }
  const spin = p.spinner();
  spin.start("Starting bark-server");
  try {
    compose(await prepare(ctx), ["up", "-d", "--wait", "bark-server"]);
  } finally {
    spin.stop("bark-server is running");
  }
  const url = await barkUrl(ctx);
  p.note(
    [
      "1. Install Bark from the App Store on your iPhone.",
      `2. In Bark, open Servers, tap +, and add ${cmd(url)}`,
      "   (it's reachable once the Cloudflare Tunnel step routes it).",
      "3. Copy that server's URL from Bark and paste it here: the device key is read from it.",
    ].join("\n"),
    "Bark",
  );
  const pasted = unwrap(
    await p.password({
      message: "Bark server URL or device key",
      validate: (v) => (v && deviceKeyFrom(v) ? undefined : "Paste the URL Bark shows, or just the key"),
    }),
  );
  await saveKey(ctx, deviceKeyFrom(pasted));
  p.log.success(ok("bark.deviceKey saved"));
  try {
    await testPush(ctx);
    p.log.success(ok("Test push sent. It should be on your phone now."));
  } catch (error) {
    p.log.warn(
      warn(
        `The test push didn't go through (${(error as Error).message}). ${dim(
          "If the tunnel isn't set up yet, that's expected: it's the next step.",
        )}`,
      ),
    );
  }
  return [];
}

registerSetupStep(
  {
    id: "notifications",
    title: "Notifications (Bark)",
    later: "poke setup --only notifications",
    async run(ctx) {
      if (!(await skipOrRun("Notifications: Bark pushes to your iPhone", "poke setup --only notifications")))
        return (await hasKey(ctx)) ? [] : ["bark.deviceKey"];
      return notificationsSetup(ctx);
    },
  },
  "pair",
);
