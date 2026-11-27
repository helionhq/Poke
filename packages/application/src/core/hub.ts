import type { Clock, LiveEvent, Logger, PersistedEvent, Repositories, StoredEvent } from "@poke/domain";

export type HubListener = (
  frame: { kind: "event"; stored: StoredEvent } | { kind: "live"; event: LiveEvent },
) => void;

/**
 * The event hub: persists domain events with their entity changes in one transaction, then fans
 * them out to subscribers (WebSocket clients, notification routing, the interaction agent…).
 */
export class EventHub {
  #listeners = new Set<HubListener>();

  constructor(
    private readonly repos: Pick<Repositories, "uow" | "events">,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  /** Run `fn` (entity writes) and append the events it returns, atomically; notify after commit. */
  commit<T>(fn: () => { result: T; events: PersistedEvent[] }): T {
    const stored: StoredEvent[] = [];
    const result = this.repos.uow.transaction(() => {
      const out = fn();
      const at = this.clock.now();
      for (const event of out.events) stored.push(this.repos.events.append(event, at));
      return out.result;
    });
    for (const event of stored) this.#emit({ kind: "event", stored: event });
    return result;
  }

  /** Shorthand when there is nothing to return. */
  publish(fn: () => PersistedEvent[]): void {
    this.commit(() => ({ result: undefined, events: fn() }));
  }

  live(event: LiveEvent): void {
    this.#emit({ kind: "live", event });
  }

  subscribe(listener: HubListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  latestSeq(): number {
    return this.repos.events.latestSeq();
  }

  since(seq: number, limit: number): StoredEvent[] {
    return this.repos.events.since(seq, limit);
  }

  #emit(frame: Parameters<HubListener>[0]): void {
    for (const listener of this.#listeners) {
      try {
        listener(frame);
      } catch (error) {
        this.log.error({ err: error }, "event listener failed");
      }
    }
  }
}
