import { MEMORY_TOOLS } from "@poke/agent-core";
import { type Clock, DomainError, type Logger, type MemoryPort } from "@poke/domain";
import type { SettingsService } from "./settings.js";
import { handler, text, type ToolGateway } from "./tools/gateway.js";

const CARD_REFRESH_MS = 60 * 60_000;
/** The deriver needs a few exchanges before the card changes. */
const CARD_EVERY_EXCHANGES = 10;

export interface MemoryDeps {
  memory: MemoryPort;
  settings: Pick<SettingsService, "get">;
  gateway: ToolGateway;
  clock: Clock;
  log: Logger;
  /** Secret values out of anything written to Honcho. */
  redact(text: string): string;
}

/**
 * Honcho-backed memory (section 13). Writes come only from the main thread, through
 * `recordExchange`; agents and side chats only read, with `recall`. The peer card is cached for
 * the prompt and digest, so opening a session never waits on Honcho.
 */
export class MemoryService {
  #card?: string;
  #writes: Promise<void> = Promise.resolve();
  #sinceCard = 0;
  #cardAt = 0;
  #refreshing?: Promise<void>;
  #closed = false;

  constructor(private readonly deps: MemoryDeps) {}

  available(): boolean {
    return this.deps.memory.available();
  }

  /**
   * What's known about Arham, for the prompt and digest. Cached, so opening a session never
   * waits on Honcho; a stale card is refreshed in the background for next time.
   */
  card(): string | undefined {
    if (!this.available()) return undefined;
    if (this.deps.clock.now() - this.#cardAt > CARD_REFRESH_MS) void this.refreshCard();
    return this.#card;
  }

  start(): void {
    this.#registerTools();
    void this.refreshCard();
  }

  close(): void {
    this.#closed = true;
  }

  refreshCard(): Promise<void> {
    if (!this.available() || this.#closed) return Promise.resolve();
    this.#refreshing ??= (async () => {
      try {
        this.#card = await this.deps.memory.peerCard();
        this.#sinceCard = 0;
      } catch (error) {
        this.deps.log.warn({ error: String(error) }, "couldn't read what's known about him");
      } finally {
        // A failure waits as long as a success before trying again.
        this.#cardAt = this.deps.clock.now();
        this.#refreshing = undefined;
      }
    })();
    return this.#refreshing;
  }

  /**
   * One completed main-thread exchange. Writes run one after another, never block a turn, and
   * a failure is logged, not retried: the thread itself stays whole in poke.db.
   */
  recordExchange(exchange: {
    user?: { text: string; at: number };
    poke?: { text: string; at: number };
  }): void {
    if (!this.available()) return;
    const clean = (part?: { text: string; at: number }) => {
      const value = part ? this.deps.redact(part.text).trim() : "";
      return value && part ? { text: value, at: part.at } : undefined;
    };
    const user = clean(exchange.user);
    const poke = clean(exchange.poke);
    if (!user && !poke) return;
    this.#writes = this.#writes
      .then(() => this.deps.memory.addExchange({ ...(user ? { user } : {}), ...(poke ? { poke } : {}) }))
      .then(() => {
        if (++this.#sinceCard >= CARD_EVERY_EXCHANGES) void this.refreshCard();
      })
      .catch((error: unknown) => {
        this.deps.log.warn({ error: String(error) }, "couldn't add an exchange to memory");
      });
  }

  /** Waits for queued writes (tests, shutdown). */
  flush(): Promise<void> {
    return this.#writes;
  }

  async remember(fact: string): Promise<{ ref: string }> {
    if (!this.available()) throw new DomainError("unavailable", "Memory isn't set up yet");
    return this.deps.memory.remember(this.deps.redact(fact));
  }

  async forget(ref: string): Promise<void> {
    if (!this.available()) throw new DomainError("unavailable", "Memory isn't set up yet");
    await this.deps.memory.forget(ref);
  }

  /** The Search screen's "From your history" card, and the recall tool. */
  async recall(question: string, deep = false): Promise<string> {
    if (!this.available()) throw new DomainError("unavailable", "Memory isn't set up yet");
    const level = deep ? "high" : (this.deps.settings.get("memory.recallLevel") ?? "low");
    return this.deps.redact(await this.deps.memory.recall(question, level));
  }

  #registerTools(): void {
    this.deps.gateway.register(
      handler(MEMORY_TOOLS.recall, async (args) => {
        if (!this.available())
          return text(
            "Nothing is remembered yet (memory isn't set up). Use search_thread for the chat.",
            true,
          );
        return text(await this.recall(args.question, args.depth === "deep"));
      }),
      ["poke", "executor", "sidechat"],
    );
  }
}
