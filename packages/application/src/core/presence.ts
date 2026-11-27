import type { Clock, Presence } from "@poke/domain";

const STALE_MS = 75_000;

/** Tracks connected clients and whether any app is in the foreground (for Bark routing). */
export class PresenceTracker {
  #clients = new Map<string, { deviceId: string; presence: Presence; seenAt: number }>();

  constructor(private readonly clock: Clock) {}

  update(connectionId: string, deviceId: string, presence: Presence): void {
    this.#clients.set(connectionId, { deviceId, presence, seenAt: this.clock.now() });
  }

  remove(connectionId: string): void {
    this.#clients.delete(connectionId);
  }

  /** True when some client is connected and foregrounded (heartbeat not stale). */
  anyForeground(): boolean {
    const now = this.clock.now();
    for (const client of this.#clients.values()) {
      if (client.presence === "foreground" && now - client.seenAt < STALE_MS) return true;
    }
    return false;
  }

  connected(): number {
    return this.#clients.size;
  }
}
