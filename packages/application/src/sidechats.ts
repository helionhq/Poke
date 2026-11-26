import { type PersonaSlots, sidechatPrompt } from "@poke/agent-core";
import {
  type AgentActivity,
  clampBudget,
  type Clock,
  COMPACTION_INSTRUCTIONS,
  type ConversationRuntime,
  type ConversationSession,
  DomainError,
  type IdGenerator,
  type Logger,
  type Message,
  messageText,
  PROVIDERS,
  type ProviderKind,
  type Repositories,
} from "@poke/domain";
import { recordUsage } from "./agents.js";
import type { EventHub } from "./core/hub.js";
import type { ModelService } from "./models.js";
import type { SettingsService } from "./settings.js";
import type { ThreadService } from "./thread.js";
import type { ToolGateway } from "./tools/gateway.js";

export interface SideChatDeps {
  repos: Pick<Repositories, "usage">;
  hub: EventHub;
  ids: IdGenerator;
  clock: Clock;
  log: Logger;
  thread: ThreadService;
  settings: SettingsService;
  models: ModelService;
  runtimes: Partial<Record<ProviderKind, ConversationRuntime>>;
  gateway: ToolGateway;
  persona: () => PersonaSlots;
  workspace: string;
  skillsDir: string;
}

export interface SideChatView {
  id: string;
  model: string;
  messages: Message[];
  activity: AgentActivity;
  createdAt: number;
}

interface SideChat {
  id: string;
  session?: ConversationSession;
  model: string;
  messages: Message[];
  busy: boolean;
  activity: AgentActivity;
  createdAt: number;
}

const MAX_OPEN = 5;

/**
 * Side chats: one agent with its own model and the executor's tools, next to the thread.
 * Nothing is saved: messages live in memory and the session is never persisted.
 */
export class SideChatService {
  readonly #chats = new Map<string, SideChat>();

  constructor(private readonly deps: SideChatDeps) {}

  open(): SideChatView {
    const assignment = this.deps.models.get("sidechat");
    if (!assignment)
      throw new DomainError("no_model", "No Side chat model is set. Choose one with `poke model`.");
    if (this.#chats.size >= MAX_OPEN)
      throw new DomainError("conflict", "Close a side chat before opening another");
    const chat: SideChat = {
      id: this.deps.ids.next("sc"),
      model: `${assignment.provider}/${assignment.model}`,
      messages: [],
      busy: false,
      activity: "idle",
      createdAt: this.deps.clock.now(),
    };
    this.#chats.set(chat.id, chat);
    return view(chat);
  }

  get(id: string): SideChatView {
    return view(this.#require(id));
  }

  list(): SideChatView[] {
    return [...this.#chats.values()].map(view);
  }

  /**
   * Accept a message and reply in the background (the reply streams as live events). Returns the
   * user's message once it is in the chat. While a reply is running, the message steers it.
   */
  async post(id: string, input: { text: string }): Promise<Message> {
    const chat = this.#require(id);
    const userText = input.text.trim();
    if (!userText) throw new DomainError("invalid", "Say something first");
    const session = await this.#session(chat);
    if (chat.busy) {
      if (!(await session.steer({ text: userText })))
        throw new DomainError("conflict", "The side chat is still replying");
      return this.#push(chat, this.#message(chat, "user", userText));
    }
    chat.busy = true;
    const message = this.#push(chat, this.#message(chat, "user", userText));
    void this.#reply(chat, session, userText).catch((error: unknown) => {
      this.deps.log.warn({ err: error, sideChat: chat.id }, "side chat reply failed");
      this.#push(
        chat,
        this.#message(
          chat,
          "system",
          `Couldn't reply: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });
    return message;
  }

  /** Send a message and wait for the reply (events stream live while it runs). */
  async send(id: string, input: { text: string }): Promise<Message | undefined> {
    const chat = this.#require(id);
    const userText = input.text.trim();
    if (!userText) throw new DomainError("invalid", "Say something first");
    const session = await this.#session(chat);
    if (chat.busy) {
      this.#push(chat, this.#message(chat, "user", userText));
      if (await session.steer({ text: userText })) return undefined;
      throw new DomainError("conflict", "The side chat is still replying");
    }
    chat.busy = true;
    this.#push(chat, this.#message(chat, "user", userText));
    return this.#reply(chat, session, userText);
  }

  async #reply(chat: SideChat, session: ConversationSession, userText: string): Promise<Message | undefined> {
    chat.busy = true;
    this.#setActivity(chat, "thinking");
    let reply: Message | undefined;
    const segments: string[] = [];
    let failure: string | undefined;
    try {
      for await (const event of session.startTurn({ text: userText })) {
        switch (event.type) {
          case "text.delta":
            reply ??= this.#push(chat, { ...this.#message(chat, "poke", ""), status: "streaming" });
            this.deps.hub.live({
              type: "message.delta",
              messageId: reply.id,
              scope: `sidechat:${chat.id}`,
              text: event.text,
            });
            break;
          case "text.done":
            if (!event.text.trim()) break;
            reply ??= this.#push(chat, { ...this.#message(chat, "poke", ""), status: "streaming" });
            segments.push(event.text.trim());
            reply.parts = [{ type: "text", text: segments.join("\n\n") }];
            break;
          case "tool.started":
            this.#setActivity(chat, "working");
            break;
          case "usage":
            recordUsage(this.deps.repos, this.deps.clock.now(), "sidechat", event.usage);
            break;
          case "error":
            if (event.kind !== "cancelled") failure = event.message;
            break;
          default:
            break;
        }
      }
    } finally {
      chat.busy = false;
      this.#setActivity(chat, "idle");
    }
    if (reply) {
      reply.status = "complete";
      reply.updatedAt = this.deps.clock.now();
      this.deps.hub.live({ type: "sidechat.message", sideChatId: chat.id, message: reply });
    }
    if (failure) this.#push(chat, this.#message(chat, "system", `Couldn't reply: ${failure}`));
    return reply;
  }

  async cancel(id: string): Promise<void> {
    await this.#require(id).session?.cancel();
  }

  /** "Send to Poke": the side chat writes a short summary, which goes into the main thread. */
  async sendToPoke(id: string): Promise<Message> {
    const chat = this.#require(id);
    if (chat.messages.length === 0) throw new DomainError("invalid", "There's nothing to send yet");
    const reply = await this.send(id, {
      text: "Summarise this side chat for Poke in two to four sentences: what was asked, what you found or did, and anything still open. Plain text, no preamble.",
    });
    const summary = reply ? messageText(reply).trim() : "";
    if (!summary) throw new DomainError("unavailable", "The side chat didn't write a summary");
    const { message } = this.deps.thread.send({
      text: `From a side chat:\n\n${summary}`,
      clientMessageId: `sidechat:${chat.id}:${reply!.id}`,
      attachmentIds: [],
      origin: { kind: "share" },
    });
    return message;
  }

  async close(id: string): Promise<void> {
    const chat = this.#chats.get(id);
    if (!chat) return;
    this.#chats.delete(id);
    await chat.session?.cancel().catch(() => undefined);
    await chat.session?.close();
    this.deps.hub.live({ type: "sidechat.closed", sideChatId: id });
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.#chats.keys()]) await this.close(id);
  }

  async #session(chat: SideChat): Promise<ConversationSession> {
    if (chat.session) return chat.session;
    const assignment = this.deps.models.get("sidechat");
    if (!assignment)
      throw new DomainError("no_model", "No Side chat model is set. Choose one with `poke model`.");
    const provider = PROVIDERS.find((p) => p.id === assignment.provider);
    const runtime = provider ? this.deps.runtimes[provider.kind] : undefined;
    if (!runtime) throw new DomainError("unavailable", `No runtime can run ${assignment.provider} models`);
    const info = await this.deps.models.info("sidechat");
    const context = this.deps.settings.context();
    chat.session = await runtime.openSession({
      key: `sidechat:${chat.id}`,
      profile: "sidechat",
      model: assignment,
      systemPrompt: sidechatPrompt(this.deps.persona()),
      tools: this.deps.gateway.specs("sidechat"),
      invoker: this.deps.gateway.invoker("sidechat"),
      interceptor: this.deps.gateway.interceptor,
      budget: clampBudget(context.window, info?.contextWindow),
      persist: false,
      cwd: this.deps.workspace,
      skillsDir: this.deps.skillsDir,
      compactionInstructions: COMPACTION_INSTRUCTIONS,
      idleMinTokens: context.idleMinTokens,
    });
    return chat.session;
  }

  #message(chat: SideChat, role: Message["role"], value: string): Message {
    const now = this.deps.clock.now();
    return {
      id: this.deps.ids.next("msg"),
      scope: `sidechat:${chat.id}`,
      role,
      parts: value ? [{ type: "text", text: value }] : [],
      status: "complete",
      origin:
        role === "system"
          ? { kind: "system", reason: "provider_error" }
          : role === "user"
            ? { kind: "user" }
            : { kind: "turn" },
      createdAt: now,
      updatedAt: now,
    };
  }

  #push(chat: SideChat, message: Message): Message {
    chat.messages.push(message);
    if (message.status !== "streaming")
      this.deps.hub.live({ type: "sidechat.message", sideChatId: chat.id, message });
    return message;
  }

  #setActivity(chat: SideChat, activity: AgentActivity): void {
    if (chat.activity === activity) return;
    chat.activity = activity;
    this.deps.hub.live({ type: "agent.activity", scope: `sidechat:${chat.id}`, activity });
  }

  #require(id: string): SideChat {
    const chat = this.#chats.get(id);
    if (!chat) throw new DomainError("not_found", "That side chat is closed");
    return chat;
  }
}

function view(chat: SideChat): SideChatView {
  return {
    id: chat.id,
    model: chat.model,
    messages: [...chat.messages],
    activity: chat.activity,
    createdAt: chat.createdAt,
  };
}
