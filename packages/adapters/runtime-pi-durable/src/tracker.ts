import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationWatch, LiveState } from "@earendil-works/pi-durable";
import type { RuntimeErrorKind, UsageReport } from "@poke/domain";

interface AssistantContent {
  type: string;
  text?: string;
}
interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: { total?: number };
  };
}
interface ViewEntry {
  id: number;
  kind: string;
  data?: unknown;
  model?: Array<{ role: string } & Partial<AssistantMessage>>;
}

export type TrackerEvent =
  | { type: "delta"; text: string }
  /** A committed model response. `final` when it ends a run (no tool calls follow). */
  | { type: "assistant"; text: string; final: boolean; usage?: UsageReport; contextTokens?: number }
  | { type: "compacted"; reason: string; preTokens: number }
  | { type: "failed"; reason: string; detail?: string; kind: RuntimeErrorKind };

function textOf(message: Partial<AssistantMessage> | undefined): string {
  return (message?.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text!)
    .join("");
}

export function classifyError(detail: string | undefined): RuntimeErrorKind {
  const text = detail ?? "";
  if (/\b429\b|rate.?limit|too many requests|throttl/i.test(text)) return "rate_limited";
  if (/quota|insufficient|balance|exceed(ed)? .*limit|billing|arrearage/i.test(text)) return "quota";
  if (/\b401\b|\b403\b|unauthori[sz]ed|invalid.*(api.?key|token)|authentication|forbidden/i.test(text))
    return "auth";
  if (/context|too long|maximum.*tokens|prompt is too long/i.test(text)) return "context";
  return "provider";
}

/**
 * Follows one Durable conversation's committed view and reports what Poke cares about. Partial
 * answers arrive as deltas (committed every ~100 ms); finished responses, compactions and failed
 * runs arrive once each, even when several commits fold into one watch callback.
 */
export class ConversationTracker {
  #watch: ConversationWatch | undefined;
  #lastEntry = 0;
  #partial = "";
  #lastFailure: number | undefined;
  #contextTokens: number | undefined;
  #listeners = new Set<(event: TrackerEvent) => void>();

  constructor(
    readonly conversation: Conversation,
    private readonly fallbackModel: { provider: string; model: string },
  ) {}

  get contextTokens(): number | undefined {
    return this.#contextTokens;
  }

  on(listener: (event: TrackerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.#watch) return;
    const watch = await this.conversation.watch(BACKGROUND_CONTEXT, { min: 20, max: 200 });
    this.#watch = watch;
    const initial = watch.value as unknown as { entries: ViewEntry[]; docs: { "pi.live"?: LiveState } };
    for (const entry of initial.entries) {
      this.#lastEntry = Math.max(this.#lastEntry, entry.id);
      const message = entry.model?.[0];
      if (entry.kind === "pi.assistant" && message?.usage) this.#contextTokens = contextSize(message.usage);
    }
    this.#lastFailure = initial.docs["pi.live"]?.runFailure?.taskId as number | undefined;
    watch.start(async (call) => {
      if (call.kind !== "value") return;
      this.#onValue(call.value as unknown as { entries: ViewEntry[]; docs: { "pi.live"?: LiveState } });
    });
  }

  async stop(): Promise<void> {
    await this.#watch?.stop();
    this.#watch = undefined;
    this.#listeners.clear();
  }

  #emit(event: TrackerEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #onValue(value: { entries: ViewEntry[]; docs: { "pi.live"?: LiveState } }): void {
    for (const entry of value.entries) {
      if (entry.id <= this.#lastEntry) continue;
      this.#lastEntry = entry.id;
      this.#onEntry(entry);
    }
    const live = value.docs["pi.live"];
    const partial = textOf(live?.generation?.message as Partial<AssistantMessage> | undefined);
    if (partial && partial !== this.#partial) {
      if (partial.startsWith(this.#partial))
        this.#emit({ type: "delta", text: partial.slice(this.#partial.length) });
      else this.#emit({ type: "delta", text: partial });
      this.#partial = partial;
    }
    const failure = live?.runFailure;
    if (failure && (failure.taskId as number) !== this.#lastFailure) {
      this.#lastFailure = failure.taskId as number;
      const kind: RuntimeErrorKind =
        failure.reason === "aborted" ? "cancelled" : classifyError(failure.detail);
      this.#emit({
        type: "failed",
        reason: failure.reason,
        kind,
        ...(failure.detail ? { detail: failure.detail } : {}),
      });
    }
  }

  #onEntry(entry: ViewEntry): void {
    if (entry.kind === "pi.compaction") {
      this.#emit({
        type: "compacted",
        reason: (entry.data as { reason?: string } | undefined)?.reason ?? "threshold",
        preTokens: this.#contextTokens ?? 0,
      });
      return;
    }
    if (entry.kind !== "pi.assistant") return;
    const message = entry.model?.[0];
    this.#partial = "";
    if (!message) return;
    const stop = message.stopReason;
    // A retried request leaves its cut-off attempt as an aborted entry; the retry follows.
    if (stop === "aborted" || stop === "error") return;
    const usage = message.usage;
    let report: UsageReport | undefined;
    if (usage) {
      this.#contextTokens = contextSize(usage);
      report = {
        provider: message.provider ?? this.fallbackModel.provider,
        model: message.model ?? this.fallbackModel.model,
        input: usage.input ?? 0,
        output: usage.output ?? 0,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
        ...(usage.cost?.total ? { costUsd: usage.cost.total } : {}),
      };
    }
    this.#emit({
      type: "assistant",
      text: textOf(message),
      final: stop !== "toolUse",
      ...(report ? { usage: report } : {}),
      ...(this.#contextTokens !== undefined ? { contextTokens: this.#contextTokens } : {}),
    });
  }
}

function contextSize(usage: NonNullable<AssistantMessage["usage"]>): number {
  return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0);
}
