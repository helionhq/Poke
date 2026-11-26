import { PokeError } from "./http.js";

/** A message he sent that the server hasn't confirmed yet. */
export interface OutboxEntry {
  clientMessageId: string;
  text: string;
  attachmentIds: string[];
  replyTo?: string;
  createdAt: number;
  attempts: number;
  state: "queued" | "sending" | "failed";
  /** Why it failed for good (shown under the bubble with a retry). */
  error?: string;
}

export interface OutboxStorage {
  load(): Promise<OutboxEntry[]>;
  save(entries: OutboxEntry[]): Promise<void>;
}

export type OutboxSend = (entry: OutboxEntry) => Promise<void>;

/** A fresh id for idempotent sends (the server dedupes by it). */
export function newClientMessageId(random: () => number = Math.random): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return `cm_${c.randomUUID()}`;
  let id = "cm_";
  for (let i = 0; i < 24; i++) id += Math.floor(random() * 36).toString(36);
  return id;
}

/**
 * Messages written offline (or while the request was in flight) persist here and go out in order
 * once Poke is reachable. Sends are idempotent by clientMessageId, so a retry after a lost
 * response never posts twice.
 */
export class Outbox {
  #entries: OutboxEntry[] = [];
  #flushing: Promise<void> | undefined;
  readonly #listeners = new Set<() => void>();

  constructor(
    private readonly storage: OutboxStorage,
    private readonly send: OutboxSend,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    const loaded = await this.storage.load();
    // Anything that was mid-send when the app quit is simply queued again.
    this.#entries = loaded.map((e) => (e.state === "sending" ? { ...e, state: "queued" } : e));
    this.#emit();
  }

  entries(): readonly OutboxEntry[] {
    return this.#entries;
  }

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  async enqueue(input: {
    text: string;
    attachmentIds?: string[];
    replyTo?: string;
    clientMessageId?: string;
  }): Promise<OutboxEntry> {
    const entry: OutboxEntry = {
      clientMessageId: input.clientMessageId ?? newClientMessageId(),
      text: input.text,
      attachmentIds: input.attachmentIds ?? [],
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      createdAt: this.now(),
      attempts: 0,
      state: "queued",
    };
    this.#entries = [...this.#entries, entry];
    await this.#persist();
    void this.flush();
    return entry;
  }

  /** The server confirmed it (its message arrived with this clientMessageId). */
  async confirm(clientMessageId: string): Promise<void> {
    const before = this.#entries.length;
    this.#entries = this.#entries.filter((e) => e.clientMessageId !== clientMessageId);
    if (this.#entries.length !== before) await this.#persist();
  }

  async retry(clientMessageId: string): Promise<void> {
    this.#update(clientMessageId, { state: "queued" });
    await this.#persist();
    await this.flush();
  }

  async discard(clientMessageId: string): Promise<void> {
    await this.confirm(clientMessageId);
  }

  /** Sends queued entries in order; stops at the first one that can't reach Poke. */
  flush(): Promise<void> {
    this.#flushing ??= this.#flush().finally(() => {
      this.#flushing = undefined;
    });
    return this.#flushing;
  }

  async #flush(): Promise<void> {
    for (;;) {
      const next = this.#entries.find((e) => e.state === "queued");
      if (!next) return;
      this.#update(next.clientMessageId, { state: "sending", attempts: next.attempts + 1 });
      try {
        await this.send({ ...next, attempts: next.attempts + 1 });
        this.#entries = this.#entries.filter((e) => e.clientMessageId !== next.clientMessageId);
        await this.#persist();
      } catch (error) {
        const retryable =
          !(error instanceof PokeError) || error.offline || error.status >= 500 || error.status === 429;
        if (retryable) {
          this.#update(next.clientMessageId, { state: "queued" });
          await this.#persist();
          return;
        }
        this.#update(next.clientMessageId, { state: "failed", error: error.message });
        await this.#persist();
      }
    }
  }

  #update(id: string, patch: Partial<OutboxEntry>): void {
    this.#entries = this.#entries.map((e) => (e.clientMessageId === id ? { ...e, ...patch } : e));
    this.#emit();
  }

  async #persist(): Promise<void> {
    this.#emit();
    await this.storage.save(this.#entries);
  }

  #emit(): void {
    for (const fn of this.#listeners) fn();
  }
}
