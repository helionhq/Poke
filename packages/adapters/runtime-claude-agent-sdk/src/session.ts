import { randomUUID } from "node:crypto";
import type {
  CanUseTool,
  HookCallback,
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type CompactionInfo,
  type ConversationSession,
  detectCacheLifetime,
  DomainError,
  type CacheLifetime,
  type Logger,
  type RuntimeErrorKind,
  type RuntimeEvent,
  type SessionSpec,
  type TurnInput,
} from "@poke/domain";
import { CLAUDE_PROVIDER } from "./catalog.js";
import { claudeEnv } from "./env.js";
import { AsyncQueue } from "@poke/agent-core";
import { fromMcpName, MCP_SERVER, pokeMcpServer } from "./tools.js";

/** What Poke needs from a running query (the SDK's Query, or a fake in tests). */
export interface QueryLike extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
  close(): void;
  /** Mid-session settings (streaming input only): used to change effort for one turn. */
  applyFlagSettings?(settings: { effortLevel?: Options["effort"] | null }): Promise<void>;
}
export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryLike;

/** Built-in Claude Code tools a side chat may use. Poke's own session gets none. */
export const SIDECHAT_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"] as const;

/** How long a turn stays open after a result while a steered message may still start a run. */
const STEER_GRACE_MS = 5_000;

export interface ClaudeSessionOptions {
  query: QueryFn;
  token: string;
  configDir: string;
  log: Logger;
  executable?: string;
  baseEnv?: NodeJS.ProcessEnv;
}

interface Turn {
  queue: AsyncQueue<RuntimeEvent>;
  /** A /compact Poke issued itself: its events go to listeners, its result to compact(). */
  compact?: { info?: CompactionInfo; failed?: boolean; done: (info: CompactionInfo | undefined) => void };
  input?: SDKUserMessage;
  retried: boolean;
  controller: AbortController;
  pendingSteers: Set<string>;
  grace?: ReturnType<typeof setTimeout>;
  sawResult: boolean;
}

const ERROR_KINDS: Record<string, RuntimeErrorKind> = {
  authentication_failed: "auth",
  oauth_org_not_allowed: "auth",
  account_on_hold: "auth",
  verification_required: "auth",
  billing_error: "quota",
  rate_limit: "rate_limited",
  model_not_found: "no_model",
};

/**
 * Poke (or a side chat) on the Claude subscription: one long-lived Agent SDK query fed by an
 * input queue. A turn runs from a user message to its `result`; a steered message joins the
 * running turn. Claude Code persists Poke's session itself (`resume` with the session id).
 */
export class ClaudeSession implements ConversationSession {
  #ref: string | undefined;
  #needsDigest: boolean;
  #query: QueryLike | undefined;
  /** A one-turn reasoning override in force (voice); undefined means the session's own level. */
  #effort: string | undefined;
  #input: AsyncQueue<SDKUserMessage> | undefined;
  #initSeen = false;
  #turn: Turn | undefined;
  #contextTokens: number | undefined;
  #cacheLifetime: CacheLifetime = "unknown";
  #lastSummary: string | undefined;
  #seenUsage = new Set<string>();
  #toolNames = new Map<string, string>();
  #releases = new Map<string, () => void>();
  #listeners = new Set<(event: RuntimeEvent) => void>();
  #closed = false;

  constructor(
    private readonly spec: SessionSpec,
    private readonly options: ClaudeSessionOptions,
  ) {
    this.#ref = spec.resumeRef;
    this.#needsDigest = !spec.resumeRef && Boolean(spec.digest);
  }

  get ref(): string | undefined {
    return this.#ref;
  }

  get cacheLifetime(): CacheLifetime {
    return this.#cacheLifetime;
  }

  async *startTurn(input: TurnInput): AsyncIterable<RuntimeEvent> {
    if (this.#closed) throw new DomainError("unavailable", "This conversation is closed");
    if (this.#turn) throw new DomainError("conflict", "A turn is already running");
    let text = input.text;
    if (this.#needsDigest && this.spec.digest) {
      text = `${this.spec.digest}\n\n${text}`;
      this.#needsDigest = false;
    }
    await this.#useEffort(input.reasoning);
    const message = this.#userMessage(text, input.images);
    const turn = this.#newTurn(message);
    if (this.#ref) turn.queue.push({ type: "session", ref: this.#ref });
    this.#send(message);
    for await (const event of turn.queue) yield event;
  }

  async steer(input: TurnInput): Promise<boolean> {
    const turn = this.#turn;
    if (!turn || turn.compact || turn.queue.closed) return false;
    const message = this.#userMessage(input.text, input.images, "now");
    turn.pendingSteers.add(message.uuid!);
    this.#send(message);
    return true;
  }

  async cancel(): Promise<void> {
    this.#turn?.controller.abort();
    await this.#query?.interrupt().catch(() => undefined);
  }

  async compact(trigger: "manual" | "idle", instructions?: string): Promise<CompactionInfo | undefined> {
    if (this.#turn) throw new DomainError("conflict", "Can't compact while Poke is replying");
    if (!this.#ref) return undefined; // nothing to compact yet
    const text = `/compact ${instructions ?? this.spec.compactionInstructions}`.trim();
    return new Promise<CompactionInfo | undefined>((resolve) => {
      const turn = this.#newTurn(this.#userMessage(text));
      turn.compact = { done: resolve };
      this.options.log.debug({ trigger }, "claude compaction requested");
      this.#send(turn.input!);
      void (async () => {
        for await (const _ of turn.queue) void _;
      })();
    });
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  contextTokens(): number | undefined {
    return this.#contextTokens;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#finishTurn();
    this.#input?.close();
    this.#query?.close();
    this.#query = undefined;
    for (const release of this.#releases.values()) release();
    this.#releases.clear();
  }

  /**
   * A voice turn runs at the voice reasoning level and the next turn goes back. A new query
   * starts at the wanted level; a live one is switched with `applyFlagSettings`.
   */
  async #useEffort(override: string | undefined): Promise<void> {
    if (override === this.#effort) return;
    this.#effort = override;
    const wanted = override ?? this.spec.reasoning ?? this.spec.model.reasoning;
    if (!this.#query?.applyFlagSettings) return;
    await this.#query
      .applyFlagSettings({ effortLevel: (wanted ?? null) as Options["effort"] | null })
      .catch((error: unknown) => this.options.log.warn({ err: error }, "couldn't change claude effort"));
  }

  // ── query lifecycle ────────────────────────────────────────────────────────────────────────

  #send(message: SDKUserMessage): void {
    if (!this.#query) this.#start();
    this.#input!.push(message);
  }

  #start(): void {
    const input = new AsyncQueue<SDKUserMessage>();
    this.#input = input;
    this.#initSeen = false;
    const query = this.options.query({ prompt: input, options: this.#sdkOptions() });
    this.#query = query;
    void this.#pump(query);
  }

  async #pump(query: QueryLike): Promise<void> {
    let failure: unknown;
    try {
      for await (const message of query) this.#onMessage(message);
    } catch (error) {
      failure = error;
    }
    if (this.#query !== query) return;
    this.#query = undefined;
    this.#input?.close();
    const turn = this.#turn;
    if (this.#closed || !turn) return;
    // A session that can't be resumed (deleted, moved, another machine): start fresh with the
    // digest and run the same turn again, once.
    if (!this.#initSeen && this.#ref && !turn.retried && turn.input && !turn.compact) {
      this.options.log.warn(
        { error: String(failure ?? "ended") },
        "claude session didn't resume; starting fresh",
      );
      this.#ref = undefined;
      turn.retried = true;
      const original = turn.input.message.content;
      const text = typeof original === "string" ? original : "";
      const retry = this.#userMessage(this.spec.digest ? `${this.spec.digest}\n\n${text}` : text);
      turn.input = retry;
      this.#send(retry);
      return;
    }
    const message = failure instanceof Error ? failure.message : "Claude Code stopped unexpectedly";
    this.#emit({ type: "error", kind: "provider", message });
    this.#finishTurn();
  }

  #sdkOptions(): Options {
    const spec = this.spec;
    const agent =
      spec.profile === "poke"
        ? ({ kind: "poke" } as const)
        : ({ kind: "sidechat", sideChatId: spec.key.replace(/^sidechat:/, "") } as const);
    const builtins: string[] = spec.profile === "sidechat" ? [...SIDECHAT_TOOLS] : [];
    const effort = this.#effort ?? spec.reasoning ?? spec.model.reasoning;
    const canUseTool: CanUseTool = async (name, input) =>
      name.startsWith(`mcp__${MCP_SERVER}__`) || builtins.includes(name)
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: `${name} isn't available here.` };
    const preToolUse: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreToolUse" || !builtins.includes(input.tool_name)) return {};
      const prepared = await spec.interceptor.prepare(input.tool_name, input.tool_input, agent);
      this.#releases.set(input.tool_use_id, prepared.release);
      if (JSON.stringify(prepared.args) === JSON.stringify(input.tool_input)) return {};
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: prepared.args as Record<string, unknown>,
        },
      };
    };
    const postToolUse: HookCallback = async (input) => {
      if (input.hook_event_name !== "PostToolUse") return {};
      this.#releases.get(input.tool_use_id)?.();
      this.#releases.delete(input.tool_use_id);
      if (!builtins.includes(input.tool_name)) return {};
      const raw = JSON.stringify(input.tool_response ?? null);
      const redacted = spec.interceptor.redact(raw);
      if (redacted === raw) return {};
      return {
        hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: JSON.parse(redacted) },
      };
    };
    // The CLI joins each PreCompact hook's output into the summary instructions (verified for
    // command hooks in CLI 2.1.332; for SDK callbacks confirm on the first live run). Manual and
    // idle compactions also pass them in the /compact command itself.
    const preCompact: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreCompact" || input.custom_instructions) return {};
      return { systemMessage: spec.compactionInstructions };
    };
    const postCompact: HookCallback = async (input) => {
      if (input.hook_event_name === "PostCompact")
        this.#lastSummary = spec.interceptor.redact(input.compact_summary);
      return {};
    };
    return {
      model: spec.model.model,
      ...(effort ? { effort: effort as Options["effort"] } : {}),
      systemPrompt: spec.systemPrompt,
      tools: builtins,
      mcpServers: {
        [MCP_SERVER]: pokeMcpServer(spec.tools, {
          agent,
          invoker: spec.invoker,
          interceptor: spec.interceptor,
          signal: () => this.#turn?.controller.signal ?? new AbortController().signal,
        }),
      },
      canUseTool,
      // Poke's own settings only: never a user, project or local CLAUDE.md / settings file.
      settingSources: [],
      settings: {
        autoCompactEnabled: true,
        // Poke runs idle compaction itself, timed to the prompt cache (section 5.4); the built-in
        // one isn't known to fire inside a long-lived streaming-input session.
        idleCompaction: false,
      },
      includePartialMessages: true,
      persistSession: spec.persist,
      ...(this.#ref ? { resume: this.#ref } : {}),
      cwd: spec.cwd,
      env: claudeEnv({
        token: this.options.token,
        configDir: this.options.configDir,
        ...(this.options.baseEnv ? { base: this.options.baseEnv } : {}),
        // The budget as a plain number (the "272k" form needs a newer CLI), at least 100000.
        extra: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(Math.max(100_000, spec.budget)) },
      }),
      hooks: {
        PreToolUse: [{ hooks: [preToolUse] }],
        PostToolUse: [{ hooks: [postToolUse] }],
        PreCompact: [{ hooks: [preCompact] }],
        PostCompact: [{ hooks: [postCompact] }],
      },
      ...(this.options.executable ? { pathToClaudeCodeExecutable: this.options.executable } : {}),
    };
  }

  // ── messages → events ──────────────────────────────────────────────────────────────────────

  #onMessage(message: SDKMessage): void {
    const turn = this.#turn;
    switch (message.type) {
      case "system":
        this.#onSystem(message as SDKMessage & { type: "system"; subtype: string });
        return;
      case "stream_event": {
        if (message.parent_tool_use_id !== null) return;
        this.#activity();
        const event = message.event;
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          this.#emit({ type: "text.delta", text: this.spec.interceptor.redact(event.delta.text) });
        }
        return;
      }
      case "assistant": {
        if (message.parent_tool_use_id !== null) return;
        this.#activity();
        if (message.error) {
          this.#emit({
            type: "error",
            kind: ERROR_KINDS[message.error] ?? "provider",
            message: this.spec.interceptor.redact(textOf(message.message.content) || message.error),
          });
        }
        const text = textOf(message.message.content);
        if (text && !message.error)
          this.#emit({ type: "text.done", text: this.spec.interceptor.redact(text) });
        for (const block of message.message.content) {
          if (block.type === "tool_use") {
            const name = fromMcpName(block.name);
            this.#toolNames.set(block.id, name);
            this.#emit({ type: "tool.started", callId: block.id, name, args: block.input });
          }
        }
        const usage = message.message.usage as UsageLike | undefined;
        if (usage && !this.#seenUsage.has(message.message.id)) {
          this.#seenUsage.add(message.message.id);
          this.#contextTokens = contextSize(usage);
          const lifetime = detectCacheLifetime(usage.cache_creation ?? {});
          if (lifetime !== "unknown") this.#cacheLifetime = lifetime;
        }
        return;
      }
      case "user": {
        const replay = (message as { isReplay?: boolean }).isReplay === true;
        if (replay) {
          if (message.uuid) turn?.pendingSteers.delete(message.uuid);
          return;
        }
        if (message.parent_tool_use_id !== null) return;
        const content = message.message.content;
        if (typeof content === "string") return;
        for (const block of content) {
          if (block.type === "tool_result") {
            this.#emit({
              type: "tool.completed",
              callId: block.tool_use_id,
              name: this.#toolNames.get(block.tool_use_id) ?? "tool",
              isError: block.is_error === true,
            });
            this.#toolNames.delete(block.tool_use_id);
          }
        }
        return;
      }
      case "result": {
        const usage = message.usage as UsageLike;
        this.#emit({
          type: "usage",
          usage: {
            provider: CLAUDE_PROVIDER,
            model: this.spec.model.model,
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            cacheRead: usage.cache_read_input_tokens ?? 0,
            cacheWrite: usage.cache_creation_input_tokens ?? 0,
            ...(message.total_cost_usd ? { costUsd: message.total_cost_usd } : {}),
            cacheLifetime: this.#cacheLifetime,
          },
          ...(this.#contextTokens !== undefined ? { contextTokens: this.#contextTokens } : {}),
        });
        if (message.subtype !== "success" && !turn?.controller.signal.aborted) {
          const errors = (message as { errors?: string[] }).errors ?? [];
          this.#emit({
            type: "error",
            kind: "provider",
            message: this.spec.interceptor.redact(errors.join("; ") || message.subtype),
          });
        } else if (turn?.controller.signal.aborted) {
          this.#emit({ type: "error", kind: "cancelled", message: "Stopped" });
        }
        if (!turn) return;
        turn.sawResult = true;
        if (turn.pendingSteers.size === 0) this.#finishTurn();
        else turn.grace = setTimeout(() => this.#finishTurn(), STEER_GRACE_MS);
        return;
      }
      case "rate_limit_event": {
        const info = message.rate_limit_info;
        if (info.status !== "rejected") return;
        const resetsAt = info.resetsAt
          ? info.resetsAt < 1e12
            ? info.resetsAt * 1000
            : info.resetsAt
          : undefined;
        this.#emit({
          type: "error",
          kind: "rate_limited",
          message: "Claude usage limit reached",
          ...(resetsAt ? { retryAt: resetsAt } : {}),
        });
        return;
      }
      default:
        return;
    }
  }

  #onSystem(message: { subtype: string } & Record<string, unknown>): void {
    const turn = this.#turn;
    if (message.subtype === "init") {
      this.#initSeen = true;
      const ref = message.session_id as string;
      if (ref && ref !== this.#ref) {
        this.#ref = ref;
        this.#emit({ type: "session", ref });
      }
      return;
    }
    if (message.subtype === "compact_boundary") {
      const meta = message.compact_metadata as {
        trigger: "manual" | "auto";
        pre_tokens: number;
        post_tokens?: number;
      };
      if (meta.post_tokens !== undefined) this.#contextTokens = meta.post_tokens;
      // The summary arrives through PostCompact, which runs just before or after the boundary.
      queueMicrotask(() => {
        const info: CompactionInfo = {
          preTokens: meta.pre_tokens,
          ...(meta.post_tokens !== undefined ? { postTokens: meta.post_tokens } : {}),
          ...(this.#lastSummary ? { summary: this.#lastSummary } : {}),
        };
        this.#lastSummary = undefined;
        if (turn?.compact) {
          turn.compact.info = info;
          return;
        }
        this.#emit({ type: "compacted", trigger: "auto", ...info });
      });
      return;
    }
    if (message.subtype === "status" && message.compact_result === "failed" && turn?.compact) {
      turn.compact.failed = true;
      this.options.log.warn({ error: String(message.compact_error ?? "") }, "claude compaction failed");
    }
  }

  // ── turns ──────────────────────────────────────────────────────────────────────────────────

  #newTurn(input: SDKUserMessage): Turn {
    const turn: Turn = {
      queue: new AsyncQueue<RuntimeEvent>(),
      input,
      retried: false,
      controller: new AbortController(),
      pendingSteers: new Set(),
      sawResult: false,
    };
    this.#turn = turn;
    return turn;
  }

  /** New model output after a result means a steered message started its own run. */
  #activity(): void {
    const turn = this.#turn;
    if (turn?.grace) {
      clearTimeout(turn.grace);
      turn.grace = undefined;
      turn.pendingSteers.clear();
    }
  }

  #finishTurn(): void {
    const turn = this.#turn;
    if (!turn) return;
    if (turn.grace) clearTimeout(turn.grace);
    this.#turn = undefined;
    if (turn.compact) {
      // Let a compact_boundary queued in a microtask land first.
      queueMicrotask(() => turn.compact!.done(turn.compact!.failed ? undefined : turn.compact!.info));
    } else {
      turn.queue.push({ type: "turn.done" });
    }
    turn.queue.close();
  }

  #emit(event: RuntimeEvent): void {
    const turn = this.#turn;
    if (turn && !turn.compact && !turn.queue.closed) {
      turn.queue.push(event);
      return;
    }
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.options.log.warn({ error: String(error) }, "claude session listener failed");
      }
    }
  }

  #userMessage(text: string, images?: TurnInput["images"], priority?: "now" | "next"): SDKUserMessage {
    const content = images?.length
      ? [
          { type: "text" as const, text },
          ...images.map((image) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: image.mimeType as "image/png", data: image.data },
          })),
        ]
      : text;
    return {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: this.#ref ?? "",
      ...(priority ? { priority } : {}),
    } as SDKUserMessage;
  }
}

interface UsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
}

function contextSize(usage: UsageLike): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.output_tokens ?? 0)
  );
}

function textOf(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text!)
    .join("");
}
