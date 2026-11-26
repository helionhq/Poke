import { z } from "zod";

/**
 * Non-secret settings, flat dotted keys (what `poke config <key> <value>` edits). Secrets
 * (provider keys, tokens) live in the vault's system namespace, never here.
 */
export const SETTINGS = {
  "profile.name": z.string().min(1).max(80),
  "profile.timezone": z.string().min(1),
  "profile.homeCity": z.string().min(1).max(120),
  "context.window": z.number().int().min(100_000).max(2_000_000),
  "context.idleMinTokens": z.number().int().min(0),
  "context.idleCompactPi": z.boolean(),
  "context.idleAfterMinutes": z
    .number()
    .int()
    .min(5)
    .max(24 * 60),
  "update.auto": z.boolean(),
  "update.ref": z.string().min(1),
  "app.wallpaper": z.enum(["haze", "dunes", "coast"]),
  "app.voice": z.string().min(1),
  "app.readAloudAuto": z.boolean(),
  "executor.org": z.string().min(1),
  "public.url": z.url(),
  "bark.url": z.url(),
  "access.clientId": z.string().min(1),
  "browse.host": z.string().min(1),
  "memory.recallLevel": z.enum(["minimal", "low", "medium", "high", "max"]),
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]>;

export const SETTING_DEFAULTS: { [K in SettingKey]?: SettingValue<K> } = {
  "context.window": 272_000,
  "context.idleMinTokens": 80_000,
  "context.idleCompactPi": false,
  "context.idleAfterMinutes": 50,
  "update.auto": false,
  "update.ref": "main",
  "app.wallpaper": "haze",
  "app.readAloudAuto": false,
  "public.url": "https://poke.arham.im",
  "bark.url": "https://bark.arham.im",
  "memory.recallLevel": "low",
};

export const SETTING_DESCRIPTIONS: Record<SettingKey, string> = {
  "profile.name": "Your name, as Poke uses it",
  "profile.timezone": "IANA timezone (e.g. Europe/Lisbon); routines use it",
  "profile.homeCity": "Home city (optional)",
  "context.window": "Context budget per session in tokens (clamped to the model)",
  "context.idleMinTokens": "Idle compaction only above this many tokens",
  "context.idleCompactPi": "Idle compaction for Poke on Qwen (off by default)",
  "context.idleAfterMinutes": "Idle delay for Pi idle compaction",
  "update.auto": "Nightly `poke update` timer",
  "update.ref": "Branch, tag or sha `poke update` follows",
  "app.wallpaper": "Thread wallpaper: haze, dunes or coast",
  "app.voice": "Read-aloud / call voice id",
  "app.readAloudAuto": "Read Poke's replies aloud automatically",
  "executor.org": "Executor organization slug",
  "public.url": "Public URL of the Poke server (Cloudflare Tunnel)",
  "bark.url": "Public URL of bark-server",
  "access.clientId": "Cloudflare Access service-token client id (optional)",
  "browse.host": "Tailscale IP the browse relay binds to",
  "memory.recallLevel": "Default Honcho dialectic reasoning level",
};

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

/** Parse a CLI string into the setting's type. */
export function coerceSetting(key: SettingKey, raw: string): unknown {
  const schema = SETTINGS[key];
  const candidates: unknown[] = [raw];
  if (raw === "true" || raw === "on") candidates.unshift(true);
  if (raw === "false" || raw === "off") candidates.unshift(false);
  if (/^-?\d+(\.\d+)?$/.test(raw)) candidates.unshift(Number(raw));
  let firstError: string | undefined;
  for (const candidate of candidates) {
    const result = schema.safeParse(candidate);
    if (result.success) return result.data;
    firstError ??= result.error.issues[0]?.message;
  }
  throw new Error(`${key}: ${firstError ?? "invalid value"}`);
}

export const AppSettings = z.object({
  wallpaper: z.enum(["haze", "dunes", "coast"]),
  voice: z.string().optional(),
  readAloudAuto: z.boolean(),
  timezone: z.string().optional(),
  name: z.string().optional(),
});
export type AppSettings = z.infer<typeof AppSettings>;
