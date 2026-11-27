import {
  type ContextSettings,
  DEFAULT_CONTEXT_SETTINGS,
  DomainError,
  type SettingsRepository,
} from "@poke/domain";
import {
  SETTINGS,
  SETTING_DEFAULTS,
  type SettingKey,
  type SettingValue,
  isSettingKey,
} from "@poke/contracts";
import type { EventHub } from "./core/hub.js";

export class SettingsService {
  constructor(
    private readonly repo: SettingsRepository,
    private readonly hub: EventHub,
  ) {}

  get<K extends SettingKey>(key: K): SettingValue<K> | undefined {
    const stored = this.repo.get<SettingValue<K>>(key);
    return stored ?? (SETTING_DEFAULTS[key] as SettingValue<K> | undefined);
  }

  isSet(key: SettingKey): boolean {
    return this.repo.get(key) !== undefined;
  }

  set(key: string, value: unknown): void {
    if (!isSettingKey(key)) throw new DomainError("invalid", `Unknown setting ${key}`);
    const parsed = SETTINGS[key].safeParse(value);
    if (!parsed.success) throw new DomainError("invalid", parsed.error.issues[0]?.message ?? "Invalid value");
    this.hub.publish(() => {
      this.repo.set(key, parsed.data);
      return [{ type: "settings.updated", keys: [key] }];
    });
  }

  unset(key: string): void {
    if (!isSettingKey(key)) throw new DomainError("invalid", `Unknown setting ${key}`);
    this.hub.publish(() => {
      this.repo.delete(key);
      return [{ type: "settings.updated", keys: [key] }];
    });
  }

  all(): Partial<Record<SettingKey, unknown>> {
    const out: Partial<Record<SettingKey, unknown>> = {};
    for (const key of Object.keys(SETTINGS) as SettingKey[]) {
      const value = this.get(key);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }

  context(): ContextSettings {
    return {
      window: this.get("context.window") ?? DEFAULT_CONTEXT_SETTINGS.window,
      idleMinTokens: this.get("context.idleMinTokens") ?? DEFAULT_CONTEXT_SETTINGS.idleMinTokens,
      idleCompactPi: this.get("context.idleCompactPi") ?? DEFAULT_CONTEXT_SETTINGS.idleCompactPi,
      idleAfterMs: (this.get("context.idleAfterMinutes") ?? 50) * 60_000,
      idleLeadMs: DEFAULT_CONTEXT_SETTINGS.idleLeadMs,
    };
  }

  timezone(): string {
    return this.get("profile.timezone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  }

  userName(): string {
    return this.get("profile.name") ?? "Arham";
  }
}
