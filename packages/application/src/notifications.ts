import { isTerminal } from "@poke/blocks";
import {
  DomainError,
  type Logger,
  type Message,
  messageText,
  type Notifier,
  type Repositories,
} from "@poke/domain";
import type { EventHub } from "./core/hub.js";
import type { PresenceTracker } from "./core/presence.js";

const MAX_BODY = 180;
const REMEMBERED = 500;
/** Blocks that wait on him: these pushes break through Focus. */
const NEEDS_HIM = new Set([
  "tool_approval",
  "action",
  "draft",
  "secret_request",
  "connect_request",
  "choices",
]);

export interface NotificationsDeps {
  repos: Pick<Repositories, "blocks">;
  hub: EventHub;
  presence: Pick<PresenceTracker, "anyForeground">;
  notifier: Notifier;
  log: Logger;
  /** Secret values out of every push body. */
  redact(text: string): string;
}

/**
 * Bark pushes (section 18): one per finished Poke or system message in the main thread, only when
 * no app is in the foreground, deep-linking to the message. Bodies are redacted and short.
 */
export class NotificationService {
  readonly #sent = new Set<string>();
  #off?: () => void;

  constructor(private readonly deps: NotificationsDeps) {}

  start(): void {
    this.#off = this.deps.hub.subscribe((frame) => {
      if (frame.kind !== "event") return;
      const event = frame.stored.event;
      if (event.type === "message.created" || event.type === "message.updated")
        void this.#consider(event.message);
    });
  }

  close(): void {
    this.#off?.();
  }

  configured(): boolean {
    return this.deps.notifier.configured();
  }

  /** `poke doctor` / setup: a test push. */
  async test(): Promise<void> {
    if (!this.deps.notifier.configured())
      throw new DomainError("unavailable", "Bark isn't set up: run `poke config bark.deviceKey`");
    await this.deps.notifier.send({ title: "Poke", body: "Notifications from Poke work.", group: "poke" });
  }

  async #consider(message: Message): Promise<void> {
    if (message.scope !== "main" || message.role === "user" || message.status !== "complete") return;
    if (this.#sent.has(message.id) || !this.deps.notifier.configured()) return;
    if (this.deps.presence.anyForeground()) return;
    const blocks = message.parts.flatMap((part) =>
      part.type === "block" ? [this.deps.repos.blocks.get(part.blockId)].filter((b) => b !== undefined) : [],
    );
    const text =
      messageText(message).trim() ||
      blocks
        .map((b) => b.fallback ?? "")
        .join("\n")
        .trim();
    if (!text) return;
    this.#remember(message.id);
    const body = this.deps.redact(text).replace(/\s+/g, " ");
    const urgent = blocks.some((b) => NEEDS_HIM.has(b.kind) && !isTerminal(b));
    try {
      await this.deps.notifier.send({
        title: "Poke",
        body: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY - 1)}…` : body,
        url: `poke://thread?message=${message.id}`,
        group: "poke",
        level: urgent ? "timeSensitive" : "active",
      });
    } catch (error) {
      this.deps.log.warn({ error: String(error), message: message.id }, "couldn't send a push");
    }
  }

  #remember(id: string): void {
    this.#sent.add(id);
    if (this.#sent.size > REMEMBERED) this.#sent.delete(this.#sent.values().next().value!);
  }
}
