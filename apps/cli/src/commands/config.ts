import {
  coerceSetting,
  isSettingKey,
  SERVICE_KEYS,
  type ServiceKey,
  SETTING_DESCRIPTIONS,
  SETTINGS,
  type SettingKey,
} from "@poke/contracts";
import type { Context } from "../admin.js";
import { cmd, dim, isInteractive, ok, p, pc, printJson, table, unwrap } from "../ui.js";
import { devicesCommand, devicesMenu } from "./devices.js";
import { readStdin } from "./models.js";

/** Secret config keys (system namespace of the vault) are registered by later milestones. */
export interface SecretKeyHandler {
  key: string;
  label: string;
  isSet(ctx: Context): Promise<boolean>;
  set(ctx: Context, value: string): Promise<void>;
  unset?(ctx: Context): Promise<void>;
  /** Validate before saving (e.g. Executor /mcp/whoami). Returns a note on success. */
  validate?(ctx: Context, value: string): Promise<string | undefined>;
}

const secretKeys = new Map<string, SecretKeyHandler>();
export function registerSecretKey(handler: SecretKeyHandler): void {
  secretKeys.set(handler.key, handler);
}

async function allSettings(ctx: Context): Promise<Record<string, unknown>> {
  if (await ctx.online()) {
    return (await ctx.admin.call<{ settings: Record<string, unknown> }>("GET", "/admin/settings")).settings;
  }
  return ctx.local().settings.all();
}

async function writeSetting(ctx: Context, key: SettingKey, value: unknown): Promise<void> {
  if (await ctx.online()) await ctx.admin.call("PUT", "/admin/settings", { key, value });
  else if (value === null) ctx.local().settings.unset(key);
  else ctx.local().settings.set(key, value);
}

export async function configCommand(
  ctx: Context,
  key: string | undefined,
  value: string | undefined,
  rest: string[],
  opts: { json?: boolean; list?: boolean; unset?: boolean; stdin?: boolean },
): Promise<void> {
  if (key === "devices") return devicesCommand(ctx, value, rest[0], opts);
  if (opts.list || (!key && !process.stdout.isTTY)) return listConfig(ctx, opts);
  if (!key) return configMenu(ctx);

  const secret = secretKeys.get(key);
  if (secret) {
    if (opts.unset) {
      await secret.unset?.(ctx);
      console.log(ok(`${key} removed`));
      return;
    }
    // Keys never come in as arguments: they'd stay in the shell history and show up in `ps`.
    if (value !== undefined)
      throw new Error(
        `Don't put ${key} on the command line. Run ${cmd(`poke config ${key}`)} to be asked for it, or pipe it in with --stdin.`,
      );
    let secretValue: string | undefined;
    if (opts.stdin) secretValue = await readStdin();
    else if (isInteractive() && !opts.json)
      secretValue = unwrap(
        await p.password({ message: secret.label, validate: (v) => (v ? undefined : "Required") }),
      );
    if (!secretValue) {
      const set = await secret.isSet(ctx);
      if (opts.json) printJson({ key, set });
      else console.log(`${key}: ${set ? pc.green("set") : pc.yellow("not set")}`);
      return;
    }
    return saveSecretKey(ctx, secret, secretValue);
  }

  if (!isSettingKey(key)) {
    throw new Error(`Unknown key "${key}". See ${cmd("poke config --list")}.`);
  }
  if (opts.unset) {
    await writeSetting(ctx, key, null);
    console.log(ok(`${key} reset`));
    return;
  }
  if (value === undefined) {
    const current = (await allSettings(ctx))[key];
    if (opts.json) printJson({ key, value: current ?? null });
    else console.log(current === undefined ? pc.yellow("not set") : String(current));
    return;
  }
  const parsed = coerceSetting(key, value);
  await writeSetting(ctx, key, parsed);
  console.log(ok(`${key} = ${String(parsed)}`));
}

async function saveSecretKey(ctx: Context, secret: SecretKeyHandler, value: string): Promise<void> {
  const note = await secret.validate?.(ctx, value);
  await secret.set(ctx, value);
  console.log(ok(`${secret.key} saved${note ? dim(` · ${note}`) : ""}`));
}

async function listConfig(ctx: Context, opts: { json?: boolean }): Promise<void> {
  const settings = await allSettings(ctx);
  const secrets: Record<string, boolean> = {};
  for (const [k, h] of secretKeys) secrets[k] = await h.isSet(ctx);
  if (opts.json) {
    printJson({ settings, secrets });
    return;
  }
  const rows: string[][] = [["KEY", "VALUE", ""].map((h) => pc.dim(h))];
  for (const [k, set] of Object.entries(secrets))
    rows.push([k, set ? pc.green("set") : pc.yellow("not set"), dim(secretKeys.get(k)!.label)]);
  for (const k of Object.keys(SETTINGS) as SettingKey[]) {
    const v = settings[k];
    rows.push([k, v === undefined ? pc.dim("—") : String(v), dim(SETTING_DESCRIPTIONS[k])]);
  }
  console.log(table(rows));
}

async function configMenu(ctx: Context): Promise<void> {
  const section = unwrap(
    await p.select({
      message: "What do you want to configure?",
      options: [
        { value: "devices", label: "Devices", hint: "pair a phone, list, revoke" },
        {
          value: "keys",
          label: "Service keys",
          hint: "Executor, AssemblyAI, Keenable, GitHub, Bark, Cloudflare",
        },
        { value: "settings", label: "Settings", hint: "profile, context, updates…" },
      ],
    }),
  );
  if (section === "devices") return devicesMenu(ctx);
  if (section === "keys") {
    if (secretKeys.size === 0) {
      p.log.info("No service keys are available yet.");
      return;
    }
    const options = [];
    for (const [k, h] of secretKeys)
      options.push({ value: k, label: h.label, hint: (await h.isSet(ctx)) ? "set" : "not set" });
    const key = unwrap(await p.select({ message: "Which key?", options }));
    const value = unwrap(
      await p.password({
        message: `${secretKeys.get(key)!.label}`,
        validate: (v) => (v ? undefined : "Required"),
      }),
    );
    return saveSecretKey(ctx, secretKeys.get(key)!, value);
  }
  const settings = await allSettings(ctx);
  const key = unwrap(
    await p.select({
      message: "Which setting?",
      options: (Object.keys(SETTINGS) as SettingKey[]).map((k) => ({
        value: k,
        label: k,
        hint: settings[k] === undefined ? SETTING_DESCRIPTIONS[k] : String(settings[k]),
      })),
    }),
  );
  const value = unwrap(
    await p.text({
      message: `${key} ${dim(SETTING_DESCRIPTIONS[key])}`,
      initialValue: settings[key] === undefined ? "" : String(settings[key]),
    }),
  );
  return configCommand(ctx, key, value, [], {});
}

// ── service keys in the vault's system namespace (milestone 6) ─────────────────────────────

for (const [key, label] of Object.entries(SERVICE_KEYS) as Array<[ServiceKey, string]>) {
  registerSecretKey({
    key,
    label,
    async isSet(ctx) {
      if (await ctx.online()) {
        const list = await ctx.admin.call<{ keys: Array<{ key: string; set: boolean }> }>(
          "GET",
          "/admin/keys",
        );
        return list.keys.some((k) => k.key === key && k.set);
      }
      return (await ctx.localModels()).vault.system.has(key);
    },
    async set(ctx, value) {
      if (await ctx.online()) await ctx.admin.call("PUT", `/admin/keys/${key}`, { value });
      else (await ctx.localModels()).vault.system.set(key, value.trim());
    },
    async unset(ctx) {
      if (await ctx.online()) await ctx.admin.call("DELETE", `/admin/keys/${key}`);
      else (await ctx.localModels()).vault.system.delete(key);
    },
  });
}
