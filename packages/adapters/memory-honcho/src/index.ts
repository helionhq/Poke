import { Honcho, type Peer, type Session } from "@honcho-ai/sdk";
import type { Logger, MemoryPort } from "@poke/domain";

export const HONCHO_WORKSPACE = "poke";
export const USER_PEER = "arham";
export const POKE_PEER = "poke";
export const MAIN_SESSION = "main";
/** Honcho's API in the compose deployment (section 13), loopback only. */
export const HONCHO_URL = "http://127.0.0.1:8000";

export interface HonchoMemoryOptions {
  baseURL?: string;
  /** The admin JWT minted at deploy time (vault system `honcho.jwt`). */
  jwt(): string | undefined;
  /** Both Memory models are set and Honcho was deployed. */
  enabled(): boolean;
  log: Logger;
  timeoutMs?: number;
}

type Level = "minimal" | "low" | "medium" | "high" | "max";

interface Live {
  key: string;
  user: Peer;
  session: Session;
}

/**
 * Honcho is Poke's only memory (section 13): workspace `poke`, peers `arham` (observed) and `poke`
 * (not observed), one session `main`. Only the main thread's exchanges are written; executors and
 * side chats only read, through `recall`.
 */
export class HonchoMemory implements MemoryPort {
  #live?: Promise<Live>;

  constructor(private readonly options: HonchoMemoryOptions) {}

  available(): boolean {
    return this.options.enabled() && Boolean(this.options.jwt());
  }

  async addExchange(exchange: {
    user?: { text: string; at: number };
    poke?: { text: string; at: number };
  }): Promise<void> {
    const { user, session } = await this.#open();
    const poke = await this.#poke();
    const messages = [];
    if (exchange.user?.text.trim())
      messages.push(user.message(exchange.user.text, { createdAt: new Date(exchange.user.at) }));
    if (exchange.poke?.text.trim())
      messages.push(poke.message(exchange.poke.text, { createdAt: new Date(exchange.poke.at) }));
    if (messages.length) await session.addMessages(messages);
  }

  async recall(query: string, level: Level = "low"): Promise<string> {
    const { user } = await this.#open();
    const answer = await user.chat(query, { reasoningLevel: level });
    return answer?.trim() || "Nothing known about that yet.";
  }

  /** Explicit memory: a conclusion Arham asked Poke to keep (Honcho v3). Undo deletes it. */
  async remember(fact: string): Promise<{ ref: string }> {
    const { user } = await this.#open();
    const [created] = await user.conclusions.create({ content: fact, sessionId: MAIN_SESSION });
    if (!created) throw new Error("Honcho didn't save that");
    return { ref: created.id };
  }

  async forget(ref: string): Promise<void> {
    const { user } = await this.#open();
    await user.conclusions.delete(ref);
  }

  async peerCard(): Promise<string | undefined> {
    const { user } = await this.#open();
    const card = await user.getCard();
    return card?.length ? card.map((line) => `- ${line}`).join("\n") : undefined;
  }

  #poke(): Promise<Peer> {
    return this.#client().peer(POKE_PEER, { configuration: { observeMe: false } });
  }

  #client(): Honcho {
    const jwt = this.options.jwt();
    if (!jwt || !this.options.enabled()) throw new Error("Memory isn't set up");
    return new Honcho({
      apiKey: jwt,
      baseURL: this.options.baseURL ?? HONCHO_URL,
      workspaceId: HONCHO_WORKSPACE,
      timeout: this.options.timeoutMs ?? 60_000,
      maxRetries: 2,
    });
  }

  /** Peers and the session, created once per key; Honcho builds a representation of Arham only. */
  #open(): Promise<Live> {
    const key = `${this.options.baseURL ?? HONCHO_URL}\n${this.options.jwt() ?? ""}`;
    const current = this.#live;
    if (current) return current.then((live) => (live.key === key ? live : this.#reopen(key)));
    return this.#reopen(key);
  }

  #reopen(key: string): Promise<Live> {
    const opening = (async () => {
      const honcho = this.#client();
      const user = await honcho.peer(USER_PEER, { configuration: { observeMe: true } });
      const poke = await honcho.peer(POKE_PEER, { configuration: { observeMe: false } });
      const session = await honcho.session(MAIN_SESSION);
      await session.addPeers([
        [user, { observeMe: true, observeOthers: false }],
        [poke, { observeMe: false, observeOthers: false }],
      ]);
      return { key, user, session };
    })();
    opening.catch((error: unknown) => {
      if (this.#live === opening) this.#live = undefined;
      this.options.log.warn({ error: String(error) }, "couldn't open Honcho");
    });
    this.#live = opening;
    return opening;
  }
}
