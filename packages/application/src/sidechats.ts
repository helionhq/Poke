import { type PersonaSlots, SILENT_TOOLS, sidechatPrompt, toolLabel } from "@poke/agent-core";
import {
  type AgentActivity,
  type Block,
  type BlockOwner,
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
  type Step,
  type Trace,
} from "@poke/domain";
import { recordUsage } from "./agents.js";
import type { BlockService } from "./blocks.js";
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
  /** Cards shown inside side chats: approvals, secret and connect requests. */
  blocks?: Pick<BlockService, "attach" | "expire" | "attachSideChats">;
}

export interface SideChatView {
  id: string;
  model: string;
  messages: Message[];
  activity: AgentActivity;
  createdAt: number;
  traces: TracedTurn[];
}

/** One reply's Trace and its steps. Like the rest of a side chat, it lives only in memory. */
export interface TracedTurn {
  trace: Trace;
  steps: Step[];
}

interface SideChat {
  id: string;
  session?: ConversationSession;
  model: string;
  messages: Message[];
  busy: boolean;
  activity: AgentActivity;
  createdAt: number;
  /** The reply being written, while a turn runs: cards go under it. */
  reply?: Message;
  traces: TracedTurn[];
}

interface Waiter {
  sideChatId: string;
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  blockId?: string;
}

const MAX_OPEN = 5;
/** How long a side chat tool waits for him: a secret, a connection or an OK. */
export const SIDECHAT_WAIT_MS = 15 * 60_000;

/**
 * Side chats: one agent with its own model and the executor's tools, next to the thread.
 * Nothing is saved: messages live in memory and the session is never persisted.
 */
export class SideChatService {
  readonly #chats = new Map<string, SideChat>();
  readonly #waiters = new Map<string, Waiter>();

  constructor(private readonly deps: SideChatDeps) {
    deps.blocks?.attachSideChats(this);
  }

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
      traces: [],
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
    const asked = chat.messages.at(-1);
    let traced: TracedTurn | undefined;
    const steps = new Map<string, Step>();
    try {
      for await (const event of session.startTurn({ text: userText })) {
        switch (event.type) {
          case "text.delta":
            reply ??= this.#startReply(chat);
            this.deps.hub.live({
              type: "message.delta",
              messageId: reply.id,
              scope: `sidechat:${chat.id}`,
              text: event.text,
            });
            break;
          case "text.done":
            if (!event.text.trim()) break;
            reply ??= this.#startReply(chat);
            segments.push(event.text.trim());
            // Cards shown during the turn stay under the text.
            reply.parts = [
              { type: "text", text: segments.join("\n\n") },
              ...reply.parts.filter((part) => part.type !== "text"),
            ];
            break;
          case "tool.started": {
            this.#setActivity(chat, "working");
            if (SILENT_TOOLS.has(event.name) || event.name === "ask_poke") break;
            traced ??= this.#startTrace(chat, asked);
            const step = this.#step(traced, event.name, event.args);
            steps.set(event.callId, step);
            this.#publishTrace(chat, traced);
            break;
          }
          case "tool.completed": {
            const step = steps.get(event.callId);
            if (!step || !traced) break;
            step.status = event.isError ? "error" : "done";
            step.endedAt = this.deps.clock.now();
            this.#publishTrace(chat, traced);
            break;
          }
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
      delete chat.reply;
      this.#setActivity(chat, "idle");
      if (traced) this.#endTrace(chat, traced, failure !== undefined);
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
    const chat = this.#require(id);
    this.#stopWaiting(id);
    await chat.session?.cancel();
  }

  // ── cards: a side chat tool waiting on him ──────────────────────────────────────────────────

  /** Shows a card in the side chat, under the reply being written (or in a message of its own). */
  show(
    sideChatId: string,
    input: { kind: string; props: Record<string, unknown>; owner: BlockOwner },
  ): Block {
    const blocks = this.deps.blocks;
    if (!blocks) throw new DomainError("unavailable", "Side chats can't show cards here");
    const chat = this.#require(sideChatId);
    const target = chat.reply ?? this.#push(chat, this.#message(chat, "poke", ""));
    const block = blocks.attach(target, input);
    target.updatedAt = this.deps.clock.now();
    this.deps.hub.live({ type: "sidechat.message", sideChatId, message: target });
    return block;
  }

  /** A secret or a connection: shows its card and waits for him. Undefined if he never answered. */
  async ask(sideChatId: string, input: { kind: string; props: Record<string, unknown> }, needId: string) {
    const block = this.show(sideChatId, { ...input, owner: { type: "sidechat", sideChatId, needId } });
    return this.wait(sideChatId, needId, block.id);
  }

  /**
   * Waits for `settle(key)`: a card answered or an approval decided. After `ms`, or when the chat
   * is stopped or closed, it resolves undefined and the card expires.
   */
  wait(sideChatId: string, key: string, blockId?: string, ms = SIDECHAT_WAIT_MS): Promise<unknown> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.#finishWait(key, undefined, true), ms);
      timer.unref?.();
      this.#waiters.set(key, { sideChatId, resolve, timer, ...(blockId ? { blockId } : {}) });
    });
  }

  settle(key: string, value: unknown): void {
    this.#finishWait(key, value, false);
  }

  #finishWait(key: string, value: unknown, expire: boolean): void {
    const waiter = this.#waiters.get(key);
    if (!waiter) return;
    this.#waiters.delete(key);
    clearTimeout(waiter.timer);
    if (expire && waiter.blockId) this.deps.blocks?.expire(waiter.blockId);
    waiter.resolve(value);
  }

  #stopWaiting(sideChatId: string): void {
    for (const [key, waiter] of [...this.#waiters])
      if (waiter.sideChatId === sideChatId) this.#finishWait(key, undefined, true);
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
    this.#stopWaiting(id);
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

  #startReply(chat: SideChat): Message {
    chat.reply = this.#push(chat, { ...this.#message(chat, "poke", ""), status: "streaming" });
    return chat.reply;
  }

  // ── traces ─────────────────────────────────────────────────────────────────────────────────

  #startTrace(chat: SideChat, asked: Message | undefined): TracedTurn {
    const traced: TracedTurn = {
      trace: {
        id: this.deps.ids.next("trc"),
        scope: `sidechat:${chat.id}`,
        messageId: asked?.id ?? "",
        taskIds: [],
        status: "running",
        toolCount: 0,
        apps: [],
        startedAt: this.deps.clock.now(),
      },
      steps: [],
    };
    chat.traces.push(traced);
    return traced;
  }

  #step(traced: TracedTurn, name: string, args: unknown): Step {
    const safeArgs = JSON.parse(this.deps.gateway.interceptor.redact(JSON.stringify(args ?? {}))) as unknown;
    const label = toolLabel(name, safeArgs);
    const step: Step = {
      id: this.deps.ids.next("stp"),
      taskId: "",
      traceId: traced.trace.id,
      tool: name,
      label: label.done,
      ...(label.app ? { app: label.app } : {}),
      status: "running",
      startedAt: this.deps.clock.now(),
    };
    traced.steps.push(step);
    const trace = traced.trace;
    trace.toolCount += 1;
    trace.line = label.live;
    if (label.app) {
      trace.lineApp = label.app;
      if (!trace.apps.some((a) => a.id === label.app!.id)) trace.apps.push(label.app);
    } else delete trace.lineApp;
    return step;
  }

  #endTrace(chat: SideChat, traced: TracedTurn, failed: boolean): void {
    const now = this.deps.clock.now();
    const trace = traced.trace;
    trace.status = failed ? "failed" : "done";
    trace.endedAt = now;
    delete trace.line;
    delete trace.lineApp;
    for (const step of traced.steps)
      if (step.status === "running") {
        step.status = failed ? "error" : "done";
        step.endedAt = now;
      }
    this.#publishTrace(chat, traced);
  }

  #publishTrace(chat: SideChat, traced: TracedTurn): void {
    this.deps.hub.live({
      type: "sidechat.trace",
      sideChatId: chat.id,
      trace: { ...traced.trace, apps: [...traced.trace.apps] },
      steps: traced.steps.map((step) => ({ ...step })),
    });
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
    traces: chat.traces.map((t) => ({ trace: { ...t.trace }, steps: t.steps.map((s) => ({ ...s })) })),
  };
}
