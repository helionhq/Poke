import { CORE_TOOLS, interactionPrompt, type PersonaSlots, turnContext } from "@poke/agent-core";
import {
  type AgentActivity,
  type CacheLifetime,
  clampBudget,
  claudeIdleCompactionDelay,
  type Clock,
  COMPACTION_INSTRUCTIONS,
  type CompactionInfo,
  type CompactionRecord,
  type CompactionTrigger,
  type ConversationRuntime,
  type ConversationSession,
  DomainError,
  type IdGenerator,
  type Logger,
  type Message,
  messageText,
  type ModelAssignment,
  PROVIDERS,
  type ProviderKind,
  type Repositories,
  type RuntimeEvent,
  type SystemNoteReason,
  type Timers,
  type Trace,
  type TurnInput,
} from "@poke/domain";
import type { AgentOutcome, AgentsService } from "./agents.js";
import { recordUsage } from "./agents.js";
import type { AttachmentService } from "./attachments.js";
import type { EventHub } from "./core/hub.js";
import type { PresenceTracker } from "./core/presence.js";
import { buildDigest } from "./digest.js";
import type { ModelService } from "./models.js";
import type { SettingsService } from "./settings.js";
import type { ThreadService } from "./thread.js";
import { handler, json, text, type ToolGateway } from "./tools/gateway.js";

export interface InteractionDeps {
  repos: Repositories;
  hub: EventHub;
  ids: IdGenerator;
  clock: Clock;
  timers: Timers;
  log: Logger;
  thread: ThreadService;
  attachments: AttachmentService;
  settings: SettingsService;
  models: ModelService;
  /** Runtimes by provider kind: "claude-agent-sdk" for Anthropic, "pi-ai" for Qwen. */
  runtimes: Partial<Record<ProviderKind, ConversationRuntime>>;
  gateway: ToolGateway;
  agents: AgentsService;
  presence: PresenceTracker;
  persona: () => PersonaSlots;
  workspace: string;
  skillsDir: string;
}

type Input =
  | { kind: "user"; message: Message; location?: string; timezone?: string }
  | { kind: "system"; text: string; traceMessageId?: string };

interface TurnState {
  userMessageId?: string;
  /** For a report turn: the message holding the trace the reply should sit under. */
  targetMessageId?: string;
  reply?: Message;
  segments: string[];
  streamed: string;
  trace?: Trace;
  waited: boolean;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SESSION_KEY = "poke";

/**
 * Poke itself: one never-ending conversation over the thread. User messages, agent reports and
 * system inputs queue up; one turn runs at a time; a message that arrives mid-turn steers it.
 * Poke's session is resumed across restarts and rebuilt from a digest only when it can't be.
 */
export class InteractionOrchestrator {
  #session: ConversationSession | undefined;
  #sessionKey: string | undefined;
  #runtime: ConversationRuntime | undefined;
  #assignment: ModelAssignment | undefined;
  #offSession: (() => void) | undefined;
  readonly #queue: Input[] = [];
  #busy = false;
  #turn: TurnState | undefined;
  #activity: AgentActivity = "idle";
  #idle: { cancel(): void } | undefined;
  #cacheLifetime: CacheLifetime = "unknown";
  #closed = false;

  constructor(private readonly deps: InteractionDeps) {}

  start(): void {
    this.#registerTools();
    this.deps.thread.onUserMessage((message, context) =>
      this.#enqueue({
        kind: "user",
        message,
        ...(context?.location ? { location: context.location } : {}),
        ...(context?.timezone ? { timezone: context.timezone } : {}),
      }),
    );
    this.deps.agents.onOutcome((outcome) => this.#enqueue(this.#outcomeInput(outcome)));
    // Messages sent while Poke had no model get answered once one is set.
    this.deps.hub.subscribe((frame) => {
      if (frame.kind !== "event") return;
      const event = frame.stored.event;
      if (event.type === "models.updated" && event.roles.includes("poke")) this.#answerPending();
    });
    const record = this.deps.repos.sessions.get(SESSION_KEY);
    if (record?.cacheLifetime === "1h" || record?.cacheLifetime === "5m")
      this.#cacheLifetime = record.cacheLifetime;
  }

  /** In-flight state for clients that connect mid-turn. */
  streaming(): Message[] {
    const reply = this.#turn?.reply;
    return reply && reply.status === "streaming" ? [reply] : [];
  }

  /** A turn or compaction is running, or input is waiting for one. */
  get busy(): boolean {
    return this.#busy || this.#queue.length > 0;
  }

  activity(scope: string): AgentActivity {
    return scope === "main" ? this.#activity : "idle";
  }

  async context(): Promise<{ tokens?: number; budget: number; lastCompaction?: CompactionRecord }> {
    const info = await this.deps.models.info("poke");
    const budget = clampBudget(this.deps.settings.context().window, info?.contextWindow);
    const tokens = this.#session?.contextTokens() ?? this.deps.repos.sessions.get(SESSION_KEY)?.contextTokens;
    const lastCompaction = this.deps.repos.compactions.latest("poke");
    return {
      ...(tokens !== undefined ? { tokens } : {}),
      budget,
      ...(lastCompaction ? { lastCompaction } : {}),
    };
  }

  /** Settings → "Compact now". */
  async compactNow(): Promise<CompactionRecord | undefined> {
    if (this.#busy) throw new DomainError("conflict", "Poke is busy; try again in a moment");
    const assignment = this.deps.models.get("poke");
    if (!assignment) throw new DomainError("no_model", "Poke has no model yet");
    this.#busy = true;
    try {
      const session = await this.#ensureSession(assignment);
      const info = await session.compact("manual", COMPACTION_INSTRUCTIONS);
      return info ? this.#recordCompaction("manual", info) : undefined;
    } finally {
      this.#busy = false;
      void this.#drain();
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#idle?.cancel();
    this.#offSession?.();
    await this.#session?.close();
    this.#session = undefined;
  }

  #answerPending(): void {
    if (this.#busy || this.#queue.length > 0 || !this.deps.models.get("poke")) return;
    const pending: Message[] = [];
    for (const message of this.deps.repos.messages.recent(30).reverse()) {
      if (message.role === "poke") break;
      if (message.role === "user") pending.unshift(message);
    }
    for (const message of pending) this.#queue.push({ kind: "user", message });
    void this.#drain();
  }

  // ── queue ──────────────────────────────────────────────────────────────────────────────────

  #enqueue(input: Input): void {
    if (this.#closed) return;
    this.#idle?.cancel();
    this.#idle = undefined;
    if (this.#busy && this.#turn && input.kind === "user" && this.#session) {
      // Steer the running turn; if it ended in the meantime, the input runs next.
      const session = this.#session;
      void this.#turnInput([input]).then(async (turnInput) => {
        const steered = await session.steer(turnInput).catch(() => false);
        if (!steered) {
          this.#queue.push(input);
          void this.#drain();
        }
      });
      return;
    }
    this.#queue.push(input);
    void this.#drain();
  }

  async #drain(): Promise<void> {
    if (this.#busy || this.#closed || this.#queue.length === 0) return;
    this.#busy = true;
    const items = this.#queue.splice(0);
    try {
      await this.#runTurn(items);
    } catch (error) {
      this.deps.log.error({ err: error }, "poke turn failed");
      this.#note(`Poke couldn't reply: ${errorText(error)}`, "provider_error");
    } finally {
      this.#busy = false;
      this.#setActivity("idle");
    }
    if (this.#queue.length > 0) void this.#drain();
    else this.#scheduleIdle();
  }

  // ── turns ──────────────────────────────────────────────────────────────────────────────────

  async #runTurn(items: Input[]): Promise<void> {
    const assignment = this.deps.models.get("poke");
    if (!assignment) {
      this.#note("Poke has no model yet. Run `poke model` on Poke's machine.", "no_model");
      return;
    }
    let session: ConversationSession;
    try {
      session = await this.#ensureSession(assignment);
    } catch (error) {
      this.#sessionError(error, assignment);
      return;
    }
    const firstUser = items.find((i): i is Extract<Input, { kind: "user" }> => i.kind === "user");
    const target = items.find(
      (i): i is Extract<Input, { kind: "system" }> => i.kind === "system" && !!i.traceMessageId,
    );
    const turn: TurnState = {
      ...(firstUser ? { userMessageId: firstUser.message.id } : {}),
      ...(target?.traceMessageId && !hasText(this.deps.thread.get(target.traceMessageId))
        ? { targetMessageId: target.traceMessageId }
        : {}),
      segments: [],
      streamed: "",
      waited: false,
    };
    this.#turn = turn;
    this.#setActivity("thinking");
    const errors: Extract<RuntimeEvent, { type: "error" }>[] = [];
    try {
      const input = await this.#turnInput(items);
      for await (const event of session.startTurn(input)) {
        if (event.type === "error") errors.push(event);
        else this.#onTurnEvent(event, turn);
      }
    } finally {
      this.#finishReply(turn);
      this.#turn = undefined;
    }
    for (const error of errors) this.#runtimeError(error, assignment);
  }

  #onTurnEvent(event: RuntimeEvent, turn: TurnState): void {
    switch (event.type) {
      case "session":
        this.#saveSession({ ref: event.ref });
        return;
      case "text.delta": {
        const reply = this.#ensureReply(turn);
        turn.streamed += event.text;
        this.deps.hub.live({ type: "message.delta", messageId: reply.id, scope: "main", text: event.text });
        return;
      }
      case "text.done": {
        if (!event.text.trim()) return;
        const reply = this.#ensureReply(turn);
        turn.segments.push(event.text.trim());
        turn.streamed = "";
        setText(reply, turn.segments.join("\n\n"));
        reply.updatedAt = this.deps.clock.now();
        this.deps.thread.saveMessage(reply, "updated");
        return;
      }
      case "tool.started":
        this.#setActivity(event.name === "send_to_agent" ? "working" : "thinking");
        return;
      case "tool.completed":
        return;
      default:
        this.#onSessionEvent(event);
    }
  }

  /** Events that also arrive outside a turn: usage, compactions, a session id. */
  #onSessionEvent(event: RuntimeEvent): void {
    const assignment = this.#assignment;
    switch (event.type) {
      case "usage":
        recordUsage(this.deps.repos, this.deps.clock.now(), "poke", event.usage);
        if (event.usage.cacheLifetime && event.usage.cacheLifetime !== "unknown")
          this.#cacheLifetime = event.usage.cacheLifetime;
        this.#saveSession({
          ...(event.contextTokens !== undefined ? { contextTokens: event.contextTokens } : {}),
          cacheLifetime: this.#cacheLifetime,
        });
        return;
      case "compacted":
        this.#recordCompaction(event.trigger, event);
        return;
      case "session":
        this.#saveSession({ ref: event.ref });
        return;
      case "text.done":
        // A steered message that started its own run after the turn closed.
        if (event.text.trim()) {
          const now = this.deps.clock.now();
          this.deps.thread.saveMessage(
            {
              id: this.deps.ids.next("msg"),
              scope: "main",
              role: "poke",
              parts: [{ type: "text", text: event.text.trim() }],
              status: "complete",
              origin: { kind: "turn" },
              createdAt: now,
              updatedAt: now,
            },
            "created",
          );
        }
        return;
      case "error":
        if (assignment) this.#runtimeError(event, assignment);
        return;
      default:
        return;
    }
  }

  #ensureReply(turn: TurnState): Message {
    if (turn.reply) return turn.reply;
    const now = this.deps.clock.now();
    const target = turn.targetMessageId ? this.deps.thread.get(turn.targetMessageId) : undefined;
    if (target) {
      target.status = "streaming";
      target.updatedAt = now;
      turn.reply = target;
      this.deps.thread.saveMessage(target, "updated");
      return target;
    }
    const reply: Message = {
      id: this.deps.ids.next("msg"),
      scope: "main",
      role: "poke",
      parts: [],
      status: "streaming",
      origin: { kind: "turn" },
      createdAt: now,
      updatedAt: now,
    };
    turn.reply = reply;
    this.deps.thread.saveMessage(reply, "created");
    return reply;
  }

  #finishReply(turn: TurnState): void {
    const reply = turn.reply;
    if (!reply) return;
    if (turn.streamed.trim() && turn.segments.length === 0) {
      // The runtime streamed text but never closed the segment (an interrupted turn).
      turn.segments.push(turn.streamed.trim());
      setText(reply, turn.segments.join("\n\n"));
    }
    reply.status = hasText(reply) || reply.parts.length > 0 ? "complete" : "failed";
    reply.updatedAt = this.deps.clock.now();
    this.deps.thread.saveMessage(reply, "updated");
  }

  async #turnInput(items: Input[]): Promise<TurnInput> {
    const chunks: string[] = [];
    const images: NonNullable<TurnInput["images"]> = [];
    let location: string | undefined;
    for (const item of items) {
      if (item.kind === "system") {
        chunks.push(item.text);
        continue;
      }
      if (item.location) location = item.location;
      const message = item.message;
      const lines: string[] = [];
      if (message.replyTo) lines.push(`(replying to: "${message.replyTo.excerpt}")`);
      if (message.origin.kind === "share") lines.push("(shared from another app)");
      for (const part of message.parts) {
        if (part.type !== "attachment") continue;
        if (part.kind === "image" && part.size <= MAX_IMAGE_BYTES) {
          try {
            const attachment = this.deps.attachments.get(part.attachmentId);
            const data = await this.deps.attachments.read(attachment);
            images.push({ mimeType: part.mime, data: Buffer.from(data).toString("base64") });
            lines.push(`[image: ${part.name}]`);
            continue;
          } catch (error) {
            this.deps.log.warn(
              { err: error, attachment: part.attachmentId },
              "couldn't read an image attachment",
            );
          }
        }
        lines.push(
          `[${part.kind}: ${part.name}, saved at ${this.deps.attachments.absolutePath(this.deps.attachments.get(part.attachmentId))}]`,
        );
      }
      const body = messageText(message).trim();
      if (body) lines.push(body);
      chunks.push(lines.join("\n"));
    }
    const persona = this.deps.persona();
    const active = this.deps.agents
      .list()
      .map((t) => `${t.name} (${t.status === "waiting" ? "waiting for an answer" : "working"})`);
    chunks.push(
      turnContext({
        now: this.deps.clock.now(),
        timezone: persona.timezone,
        presence: this.deps.presence.anyForeground() ? "open" : "in the background",
        ...(location ? { location } : {}),
        ...(active.length ? { activeTasks: active } : {}),
      }),
    );
    return { text: chunks.join("\n\n"), ...(images.length ? { images } : {}) };
  }

  #outcomeInput(outcome: AgentOutcome): Input {
    const { task } = outcome;
    const trace = this.deps.repos.traces.get(task.traceId);
    const attrs = `agent="${task.name}" id="${task.id}"`;
    switch (outcome.kind) {
      case "report":
        return {
          kind: "system",
          text: `<agent_report ${attrs}>\n${outcome.text.trim() || "(no output)"}\n</agent_report>`,
          ...(trace ? { traceMessageId: trace.messageId } : {}),
        };
      case "failed":
        return {
          kind: "system",
          text: `<agent_failed ${attrs}>\n${outcome.error}\n</agent_failed>`,
          ...(trace ? { traceMessageId: trace.messageId } : {}),
        };
      case "question": {
        const options = outcome.need.options?.length ? `\noptions: ${outcome.need.options.join(" | ")}` : "";
        const reason = outcome.need.reason ? `\nwhy: ${outcome.need.reason}` : "";
        return {
          kind: "system",
          text: `<agent_question ${attrs}>\n${outcome.need.question}${options}${reason}\n</agent_question>\nIt waits until you answer with send_to_agent (agentId "${task.id}"). If only ${this.deps.persona().userName} can answer, ask first.`,
        };
      }
    }
  }

  // ── session ────────────────────────────────────────────────────────────────────────────────

  async #ensureSession(assignment: ModelAssignment): Promise<ConversationSession> {
    const key = `${assignment.provider}/${assignment.model}/${assignment.reasoning ?? ""}`;
    if (this.#session && this.#sessionKey === key) return this.#session;
    const provider = PROVIDERS.find((p) => p.id === assignment.provider);
    const runtime = provider ? this.deps.runtimes[provider.kind] : undefined;
    if (!runtime) throw new DomainError("unavailable", `No runtime can run ${assignment.provider} models`);
    if (this.#session) {
      this.#offSession?.();
      await this.#session.close();
      this.#session = undefined;
    }
    const record = this.deps.repos.sessions.get(SESSION_KEY);
    const resumeRef = record && record.runtime === runtime.kind ? record.ref : undefined;
    const info = await this.deps.models.info("poke");
    const context = this.deps.settings.context();
    const persona = this.deps.persona();
    const digest = buildDigest(this.deps.repos, {
      userName: persona.userName,
      timezone: persona.timezone,
      ...(persona.memoryCard ? { memoryCard: persona.memoryCard } : {}),
    });
    const session = await runtime.openSession({
      key: SESSION_KEY,
      profile: "poke",
      model: assignment,
      systemPrompt: interactionPrompt(persona),
      tools: this.deps.gateway.specs("poke"),
      invoker: this.deps.gateway.invoker("poke"),
      interceptor: this.deps.gateway.interceptor,
      ...(resumeRef ? { resumeRef } : {}),
      ...(digest ? { digest } : {}),
      budget: clampBudget(context.window, info?.contextWindow),
      persist: true,
      cwd: this.deps.workspace,
      skillsDir: this.deps.skillsDir,
      compactionInstructions: COMPACTION_INSTRUCTIONS,
      idleMinTokens: context.idleMinTokens,
    });
    if (record && record.runtime !== runtime.kind) this.#cacheLifetime = "unknown";
    this.#session = session;
    this.#sessionKey = key;
    this.#runtime = runtime;
    this.#assignment = assignment;
    this.#offSession = session.onEvent((event) => this.#onSessionEvent(event));
    if (session.ref) this.#saveSession({ ref: session.ref });
    return session;
  }

  #saveSession(update: { ref?: string; contextTokens?: number; cacheLifetime?: string }): void {
    const runtime = this.#runtime;
    const assignment = this.#assignment;
    if (!runtime || !assignment) return;
    const previous = this.deps.repos.sessions.get(SESSION_KEY);
    const ref =
      update.ref ?? (previous?.runtime === runtime.kind ? previous.ref : undefined) ?? this.#session?.ref;
    if (!ref) return;
    const now = this.deps.clock.now();
    const contextTokens = update.contextTokens ?? previous?.contextTokens;
    const cacheLifetime = update.cacheLifetime ?? previous?.cacheLifetime;
    this.deps.repos.sessions.save({
      key: SESSION_KEY,
      runtime: runtime.kind,
      ref,
      model: `${assignment.provider}/${assignment.model}`,
      ...(contextTokens !== undefined ? { contextTokens } : {}),
      ...(cacheLifetime !== undefined ? { cacheLifetime } : {}),
      lastActivityAt: now,
      updatedAt: now,
    });
  }

  #recordCompaction(trigger: CompactionTrigger, info: CompactionInfo): CompactionRecord | undefined {
    const runtime = this.#runtime;
    const assignment = this.#assignment;
    if (!runtime || !assignment) return undefined;
    const record: CompactionRecord = {
      id: this.deps.ids.next("cmp"),
      sessionKind: "poke",
      sessionRef: this.#session?.ref ?? "",
      trigger,
      preTokens: info.preTokens,
      ...(info.postTokens !== undefined ? { postTokens: info.postTokens } : {}),
      runtime: runtime.kind,
      model: `${assignment.provider}/${assignment.model}`,
      ...(info.summary ? { summary: this.deps.gateway.interceptor.redact(info.summary) } : {}),
      createdAt: this.deps.clock.now(),
    };
    this.deps.hub.publish(() => {
      this.deps.repos.compactions.save(record);
      return [{ type: "context.compacted", compaction: record }];
    });
    const tokens = info.postTokens ?? this.#session?.contextTokens();
    if (tokens !== undefined) this.#saveSession({ contextTokens: tokens });
    return record;
  }

  // ── idle compaction (section 5.4) ──────────────────────────────────────────────────────────

  #scheduleIdle(): void {
    this.#idle?.cancel();
    this.#idle = undefined;
    const runtime = this.#runtime;
    if (!runtime || !this.#session || this.#closed) return;
    const context = this.deps.settings.context();
    const mode = runtime.capabilities("poke").idleCompaction;
    let delay: number | undefined;
    if (mode === "command") delay = claudeIdleCompactionDelay(this.#cacheLifetime, context.idleLeadMs);
    else if (mode === "api" && context.idleCompactPi) delay = context.idleAfterMs;
    if (delay === undefined) return;
    this.#idle = this.deps.timers.setTimeout(() => void this.#idleCompact(), delay);
  }

  async #idleCompact(): Promise<void> {
    this.#idle = undefined;
    const session = this.#session;
    if (!session || this.#busy || this.#queue.length > 0 || this.#closed) return;
    const tokens = session.contextTokens() ?? 0;
    if (tokens <= this.deps.settings.context().idleMinTokens) return;
    this.#busy = true;
    try {
      const info = await session.compact("idle", COMPACTION_INSTRUCTIONS);
      if (info) this.#recordCompaction("idle", info);
    } catch (error) {
      this.deps.log.warn({ err: error }, "idle compaction failed");
    } finally {
      this.#busy = false;
    }
    // Once per idle period: the next turn schedules the next one.
    void this.#drain();
  }

  // ── tools ──────────────────────────────────────────────────────────────────────────────────

  #registerTools(): void {
    const { gateway, agents, repos } = this.deps;
    gateway.register(
      handler(CORE_TOOLS.sendToAgent, async (args) => {
        const trace = this.#traceForTurn();
        if (args.agentId) {
          const task = await agents.message(args.agentId, args.goal, { traceId: trace.id });
          return json({ agentId: task.id, name: task.name, status: "messaged" });
        }
        const task = await agents.start(
          {
            name: args.name,
            goal: args.goal,
            ...(args.context ? { context: args.context } : {}),
            ...(args.skills ? { skills: args.skills } : {}),
          },
          {
            traceId: trace.id,
            ...(this.#turn?.userMessageId ? { parentMessageId: this.#turn.userMessageId } : {}),
          },
        );
        return json({ agentId: task.id, name: task.name, status: "started" });
      }),
      ["poke"],
    );
    gateway.register(
      handler(CORE_TOOLS.listAgents, (args) =>
        json(
          agents.list(args.includeFinished ?? false).map((t) => ({
            agentId: t.id,
            name: t.name,
            status: t.status,
            goal: t.goal,
            ...(t.need?.kind === "question" ? { waitingFor: t.need.question } : {}),
            ...(t.error ? { error: t.error } : {}),
          })),
        ),
      ),
      ["poke"],
    );
    gateway.register(
      handler(CORE_TOOLS.cancelAgent, async (args) => {
        const task = await agents.cancel(args.agentId);
        return json({ agentId: task.id, name: task.name, status: task.status });
      }),
      ["poke"],
    );
    gateway.register(
      handler(CORE_TOOLS.wait, () => {
        if (this.#turn) this.#turn.waited = true;
        return text("Nothing will be sent.");
      }),
      ["poke"],
    );
    gateway.register(
      handler(CORE_TOOLS.searchThread, (args) => {
        const hits = repos.messages.search({
          query: args.query,
          ...(args.before ? { before: Date.parse(args.before) } : {}),
          ...(args.after ? { after: Date.parse(args.after) } : {}),
          limit: args.limit ?? 10,
        });
        if (hits.length === 0) return text("Nothing in the thread matches.");
        const persona = this.deps.persona();
        const when = new Intl.DateTimeFormat("en-GB", {
          timeZone: persona.timezone,
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        return text(
          hits
            .map((hit) => {
              const who =
                hit.message.role === "user"
                  ? persona.userName
                  : hit.message.role === "poke"
                    ? "Poke"
                    : "System";
              return `[${when.format(hit.message.createdAt)}] ${who} (${hit.message.id}): ${hit.highlight}`;
            })
            .join("\n"),
        );
      }),
      ["poke"],
    );
    gateway.register(
      handler(CORE_TOOLS.reportProgress, (args, ctx) => {
        if (ctx.agent.kind === "executor") agents.progress(ctx.agent.taskId, args.text);
        return text("ok");
      }),
      ["executor"],
    );
    gateway.register(
      handler(CORE_TOOLS.askPoke, (args, ctx) => {
        if (ctx.agent.kind !== "executor") return text("Only agents can ask Poke.", true);
        if (ctx.resume) {
          const value = ctx.resume.value as { answer?: string; expired?: boolean } | undefined;
          if (value?.expired)
            return text("No answer came in time. Carry on without it, or report what's blocked.");
          return text(`Answer: ${value?.answer ?? ""}`);
        }
        const needId = `need_${ctx.agent.taskId}_${ctx.callId}`.replace(/[^A-Za-z0-9_]/g, "_");
        agents.ask(ctx.agent.taskId, args, needId);
        return { output: [], park: { needId } };
      }),
      ["executor"],
    );
  }

  /** The trace for the current turn's agent work, shown in its own message under the reply. */
  #traceForTurn(): Trace {
    const turn = this.#turn;
    if (turn?.trace) return turn.trace;
    const now = this.deps.clock.now();
    const messageId = this.deps.ids.next("msg");
    const trace = this.deps.agents.createTrace(messageId);
    this.deps.thread.saveMessage(
      {
        id: messageId,
        scope: "main",
        role: "poke",
        parts: [{ type: "trace", traceId: trace.id }],
        status: "complete",
        origin: { kind: "turn" },
        createdAt: now,
        updatedAt: now,
      },
      "created",
    );
    if (turn) turn.trace = trace;
    return trace;
  }

  // ── notes and errors ───────────────────────────────────────────────────────────────────────

  #setActivity(activity: AgentActivity): void {
    if (this.#activity === activity) return;
    this.#activity = activity;
    this.deps.hub.live({ type: "agent.activity", scope: "main", activity });
  }

  /** A short system note in the thread, not repeated while nothing but user messages came after it. */
  #note(text: string, reason: SystemNoteReason): void {
    const last = this.deps.repos.messages
      .recent(20)
      .reverse()
      .find((m) => m.role !== "user");
    if (last?.role === "system" && messageText(last) === text) return;
    this.deps.thread.systemNote(text, reason);
  }

  #sessionError(error: unknown, assignment: ModelAssignment): void {
    const provider = PROVIDERS.find((p) => p.id === assignment.provider);
    if (error instanceof DomainError && error.code === "unauthorized") {
      this.#note(
        `Poke can't reach ${provider?.name ?? assignment.provider}: it isn't signed in. Run \`poke login ${provider?.loginId ?? ""}\` on Poke's machine.`,
        "login_expired",
      );
      return;
    }
    if (error instanceof DomainError && error.code === "no_model") {
      this.#note(
        `Poke's model ${assignment.model} isn't available. Pick another with \`poke model\`.`,
        "no_model",
      );
      return;
    }
    this.deps.log.error({ err: error }, "couldn't open Poke's session");
    this.#note(`Poke couldn't start: ${errorText(error)}`, "provider_error");
  }

  #runtimeError(error: Extract<RuntimeEvent, { type: "error" }>, assignment: ModelAssignment): void {
    const provider = PROVIDERS.find((p) => p.id === assignment.provider);
    const name = provider?.name ?? assignment.provider;
    switch (error.kind) {
      case "cancelled":
        return;
      case "rate_limited": {
        const when = error.retryAt
          ? ` It resets ${new Intl.DateTimeFormat("en-GB", { timeZone: this.deps.persona().timezone, weekday: "short", hour: "2-digit", minute: "2-digit" }).format(error.retryAt)}.`
          : "";
        this.#note(
          `${name} hit its usage limit.${when} Switch the Poke model with \`poke model\` to keep going.`,
          "rate_limited",
        );
        return;
      }
      case "auth":
        this.#note(
          `${name} refused Poke's login. Run \`poke login ${provider?.loginId ?? ""}\` on Poke's machine.`,
          "login_expired",
        );
        return;
      case "quota":
        this.#note(`${name} is out of quota. Switch the Poke model with \`poke model\`.`, "provider_error");
        return;
      case "no_model":
        this.#note(
          `${name} doesn't offer ${assignment.model} any more. Pick another with \`poke model\`.`,
          "no_model",
        );
        return;
      default:
        this.#note(`Poke couldn't reply (${name}): ${error.message}`, "provider_error");
    }
  }
}

function hasText(message: Message | undefined): boolean {
  return !!message && messageText(message).trim().length > 0;
}

function setText(message: Message, value: string): void {
  const index = message.parts.findIndex((p) => p.type === "text");
  if (index === -1) message.parts.push({ type: "text", text: value });
  else message.parts[index] = { type: "text", text: value };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
