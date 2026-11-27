import type { CompactionTrigger, CacheLifetime } from "../context.js";
import type { ModelAssignment, ModelInfo } from "../models.js";

/** JSON Schema object for tool parameters (produced from zod in agent-core). */
export type JsonSchema = Record<string, unknown>;

export type ToolLoading = "always" | "deferred";
export type ToolCaller = "model" | "tools";

/** Framework-neutral tool definition. Each runtime adapter translates it once. */
export interface ToolSpec {
  name: string;
  /** One line that says when to use it, so tool search finds it by intent. */
  description: string;
  inputSchema: JsonSchema;
  loading: ToolLoading;
  /** Who may call it: the model, scripts (codemode / nested calls), or both. */
  callers: ToolCaller[];
  /** "safe" tools may re-run after a crash; side-effecting ones never do. */
  replay: "safe" | "unsafe";
  /** Tool-search namespace (e.g. an MCP server). */
  namespace?: string;
  searchHint?: string;
}

export type ToolOutputItem =
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface ToolResultData {
  output: ToolOutputItem[];
  isError?: boolean;
  /** For programs (codemode); never shown to the model. */
  structured?: unknown;
  /** For UIs (Trace details); redacted. */
  details?: Record<string, unknown>;
  /** The call can't finish yet: park the agent until the need is resolved. */
  park?: { needId: string; until?: number };
}

export type AgentRef =
  { kind: "poke" } | { kind: "executor"; taskId: string } | { kind: "sidechat"; sideChatId: string };

export interface ToolCallContext {
  agent: AgentRef;
  callId: string;
  signal: AbortSignal;
  /** When a parked call is woken: the need's resolution. */
  resume?: { needId: string; value: unknown };
  /** Live progress line for the Trace. */
  progress?(text: string): void;
  /** Running output (bash) for UIs. */
  output?(text: string): void;
  /** Bash/tool environment extras (secret env vars resolved by the gateway). */
  env?: Record<string, string>;
}

/** Executes a tool by name. Implemented by the application's ToolGateway. */
export interface ToolInvoker {
  invoke(name: string, args: unknown, ctx: ToolCallContext): Promise<ToolResultData>;
}

/**
 * Hooks runtimes give the gateway around their *own* built-in tools (Pi CodingTools, the Agent
 * SDK's Bash/Read/Write…), so vault placeholders and redaction apply to them too.
 */
export interface ToolInterceptor {
  /** Rewrite arguments just before execution (placeholders → values / env vars). Never persisted. */
  prepare(
    name: string,
    args: unknown,
    agent: AgentRef,
  ): Promise<{ args: unknown; env?: Record<string, string>; release(): void }>;
  /** Scrub any live secret from text before it reaches the model, a log or a UI. */
  redact(text: string): string;
  /** Observe a call for Traces, usage and logs. */
  observe(event: ToolObservation): void;
}

export type ToolObservation =
  | { type: "started"; agent: AgentRef; callId: string; name: string; args: unknown }
  | { type: "completed"; agent: AgentRef; callId: string; name: string; isError: boolean; excerpt?: string };

export interface TurnInput {
  text: string;
  images?: Array<{ mimeType: string; data: string }>;
  /** This turn's reasoning level (a voice turn); the session's own level when absent. */
  reasoning?: string;
}

export type RuntimeErrorKind =
  "rate_limited" | "auth" | "quota" | "context" | "provider" | "no_model" | "cancelled";

export interface UsageReport {
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd?: number;
  cacheLifetime?: CacheLifetime;
}

export type RuntimeEvent =
  | { type: "text.delta"; text: string }
  /** A text segment ended (another tool call or the end of the turn may follow). */
  | { type: "text.done"; text: string }
  | { type: "tool.started"; callId: string; name: string; args: unknown }
  | { type: "tool.completed"; callId: string; name: string; isError: boolean }
  | {
      type: "compacted";
      trigger: CompactionTrigger;
      preTokens: number;
      postTokens?: number;
      summary?: string;
    }
  | { type: "usage"; usage: UsageReport; contextTokens?: number }
  | { type: "session"; ref: string }
  | { type: "error"; kind: RuntimeErrorKind; message: string; retryAt?: number }
  | { type: "turn.done" };

export interface RuntimeCapabilities {
  steering: boolean;
  /** "native": the runtime compacts on idle itself; "command": Poke sends /compact; "api": root.compact(). */
  idleCompaction: "native" | "command" | "api" | "none";
  toolSearch: boolean;
  codemode: boolean;
}

export type SessionProfile = "poke" | "sidechat";

export interface SessionSpec {
  /** "poke" for the main thread, `sidechat:<id>` for a side chat. */
  key: string;
  profile: SessionProfile;
  model: ModelAssignment;
  /** Reasoning override for this session (voice turns use voiceReasoning). */
  reasoning?: string;
  systemPrompt: string;
  tools: ToolSpec[];
  invoker: ToolInvoker;
  interceptor: ToolInterceptor;
  /** Runtime session id/conversation id to resume, when there is one. */
  resumeRef?: string;
  /** First-turn context when nothing can be resumed. */
  digest?: string;
  /** Context budget in tokens (already clamped). */
  budget: number;
  /** Side chats are never persisted. */
  persist: boolean;
  cwd: string;
  skillsDir: string;
  compactionInstructions: string;
  idleMinTokens: number;
}

export interface ConversationSession {
  readonly ref: string | undefined;
  /** Run one turn; events stream until turn.done (or an error). */
  startTurn(input: TurnInput): AsyncIterable<RuntimeEvent>;
  /** Add input to the running turn. Returns false if nothing is running. */
  steer(input: TurnInput): Promise<boolean>;
  cancel(): Promise<void>;
  /** Force a compaction now (manual or idle). Resolves with what was compacted, if anything. */
  compact(trigger: "manual" | "idle", instructions?: string): Promise<CompactionInfo | undefined>;
  /** Events that happen outside a turn (background compactions, usage of compaction calls). */
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
  contextTokens(): number | undefined;
  close(): Promise<void>;
}

export interface CompactionInfo {
  preTokens: number;
  postTokens?: number;
  summary?: string;
}

export interface ConversationRuntime {
  readonly kind: "claude-agent-sdk" | "pi-durable";
  capabilities(profile: SessionProfile): RuntimeCapabilities;
  openSession(spec: SessionSpec): Promise<ConversationSession>;
}

/** Executors: Pi Durable conversations owned by Poke's harness. */
export interface ExecutorSpec {
  taskId: string;
  name: string;
  model: ModelAssignment;
  systemPrompt: string;
  /** First user turn: goal + context + preloaded skill bodies. */
  firstTurn: string;
  tools: ToolSpec[];
  invoker: ToolInvoker;
  interceptor: ToolInterceptor;
  cwd: string;
  budget: number;
}

export type ExecutorEvent =
  | { type: "step.started"; taskId: string; callId: string; name: string; args: unknown }
  | {
      type: "step.completed";
      taskId: string;
      callId: string;
      name: string;
      isError: boolean;
      excerpt?: string;
    }
  | { type: "progress"; taskId: string; text: string }
  | { type: "parked"; taskId: string; needId: string }
  | { type: "report"; taskId: string; text: string }
  | { type: "failed"; taskId: string; error: string; kind?: RuntimeErrorKind }
  | { type: "compacted"; taskId: string; trigger: CompactionTrigger; preTokens: number; model: string }
  | { type: "usage"; taskId: string; usage: UsageReport };

export interface ExecutorRuntime {
  start(spec: ExecutorSpec): Promise<{ runtimeRef: string }>;
  /** Send more input to a running or finished executor. */
  message(runtimeRef: string, text: string, mode: "steer" | "followup"): Promise<void>;
  cancel(runtimeRef: string): Promise<void>;
  /** Wake a parked tool call with the need's resolution. */
  resolveNeed(
    taskId: string,
    needId: string,
    value: unknown,
  ): Promise<"delivered" | "duplicate" | "closed" | "not_found">;
  onEvent(listener: (event: ExecutorEvent) => void): () => void;
  /** Re-attach to work left by a previous process (executors survive restarts). */
  resume(tasks: Array<{ runtimeRef: string; spec: Omit<ExecutorSpec, "firstTurn"> }>): Promise<void>;
  close(): Promise<void>;
}

export interface ModelCatalog {
  /** Models a provider offers, from pi-ai's registry or the Agent SDK. */
  list(provider: string): Promise<ModelInfo[]>;
  get(provider: string, model: string): Promise<ModelInfo | undefined>;
}

/** One-shot completions for the Utility role (digests, titles, trace labels). */
export interface UtilityModel {
  complete(prompt: string, opts?: { system?: string; maxTokens?: number }): Promise<string>;
}
