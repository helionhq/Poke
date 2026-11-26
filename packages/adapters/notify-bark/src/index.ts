import type { Notification, Notifier } from "@poke/domain";

export interface BarkOptions {
  /** Poke's own bark-server (setting `bark.url`), reached from this machine. */
  url(): string | undefined;
  /** The Bark app's device key (vault system `bark.deviceKey`). */
  deviceKey(): string | undefined;
  /** Shown next to the push (iOS 15+): a public https image URL. */
  icon?: () => string | undefined;
  fetch?: typeof globalThis.fetch;
}

/** Bark's v2 push API (github.com/Finb/bark-server, docs/API_V2.md): `POST /push` with JSON. */
export class BarkNotifier implements Notifier {
  constructor(private readonly options: BarkOptions) {}

  configured(): boolean {
    return Boolean(this.options.url() && this.options.deviceKey());
  }

  async send(notification: Notification): Promise<void> {
    const url = this.options.url();
    const deviceKey = this.options.deviceKey();
    if (!url || !deviceKey) throw new Error("Bark isn't set up");
    const response = await (this.options.fetch ?? fetch)(`${url.replace(/\/+$/, "")}/push`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        device_key: deviceKey,
        title: notification.title,
        body: notification.body,
        ...(notification.url ? { url: notification.url } : {}),
        ...(notification.group ? { group: notification.group } : {}),
        ...(notification.level ? { level: notification.level } : {}),
        ...(notification.sound ? { sound: notification.sound } : {}),
        ...(this.options.icon?.() ? { icon: this.options.icon() } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(`Bark answered ${response.status}${detail ? `: ${detail}` : ""}`);
    }
  }
}
