import type {
  Block,
  LiveEvent,
  Message,
  PersistedEvent,
  ServerFrame,
  Step,
  Task,
  ThreadPage,
  Trace,
} from "@poke/contracts";
import type { OutboxEntry } from "./outbox.js";

export type Activity = "idle" | "thinking" | "working";

/** One row of the thread as the app draws it. */
export type ThreadRow =
  | { kind: "message"; message: Message; text: string; streaming: boolean }
  | { kind: "pending"; entry: OutboxEntry };

/**
 * The thread as the app sees it: messages, blocks, traces and steps by id, kept current from the
 * event stream. It is the same for the main thread and a side chat (filtered by scope).
 *
 * The store is plain data plus a version counter, for React's useSyncExternalStore.
 */
export class ThreadStore {
  readonly scope: string;
  #messages = new Map<string, Message>();
  #blocks = new Map<string, Block>();
  #traces = new Map<string, Trace>();
  #steps = new Map<string, Step[]>();
  #tasks = new Map<string, Task>();
  /** Streaming text not yet folded into a message.updated. */
  #deltas = new Map<string, string>();
  /** task.progress: the live line a running trace shows. */
  #liveLines = new Map<string, string>();
  #pending: readonly OutboxEntry[] = [];
  #activity: Activity = "idle";
  #seq = 0;
  #oldest: string | undefined;
  #hasOlder = true;
  #version = 0;
  #rows: ThreadRow[] | undefined;
  readonly #listeners = new Set<() => void>();
  /** Events this store doesn't keep (routines, skills, vault…): the app routes them elsewhere. */
  onOther?: (event: PersistedEvent) => void;
  /** Every live event (side chats listen for their own scope here). */
  onLive?: (event: LiveEvent) => void;
  /** A server message arrived with a clientMessageId: the outbox can drop it. */
  onConfirmed?: (clientMessageId: string) => void;

  constructor(scope = "main") {
    this.scope = scope;
  }

  // ── reading ──────────────────────────────────────────────────────────────────────────────

  get version(): number {
    return this.#version;
  }
  get latestSeq(): number {
    return this.#seq;
  }
  get activity(): Activity {
    return this.#activity;
  }
  get hasOlder(): boolean {
    return this.#hasOlder;
  }
  get oldestCursor(): string | undefined {
    return this.#oldest;
  }

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  message(id: string): Message | undefined {
    return this.#messages.get(id);
  }
  block(id: string): Block | undefined {
    return this.#blocks.get(id);
  }
  trace(id: string): Trace | undefined {
    return this.#traces.get(id);
  }
  steps(traceId: string): readonly Step[] {
    return this.#steps.get(traceId) ?? [];
  }
  liveLine(traceId: string): string | undefined {
    return this.#liveLines.get(traceId);
  }
  tasks(): Task[] {
    return [...this.#tasks.values()];
  }

  /** Text of a message, including streamed text not yet folded in. */
  text(message: Message): string {
    const own = message.parts
      .filter((p): p is Extract<Message["parts"][number], { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("\n\n");
    const delta = this.#deltas.get(message.id);
    return delta && message.status === "streaming" ? own + delta : own;
  }

  /** Messages oldest first, then what's still in the outbox. */
  rows(): ThreadRow[] {
    if (this.#rows) return this.#rows;
    const sorted = [...this.#messages.values()].sort(
      (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
    );
    const confirmed = new Set(sorted.map((m) => m.clientMessageId).filter(Boolean));
    this.#rows = [
      ...sorted.map((message) => ({
        kind: "message" as const,
        message,
        text: this.text(message),
        streaming: message.status === "streaming",
      })),
      ...this.#pending
        .filter((e) => !confirmed.has(e.clientMessageId))
        .map((entry) => ({ kind: "pending" as const, entry })),
    ];
    return this.#rows;
  }

  /** Everything the store holds, oldest first (the app's offline cache saves this). */
  snapshot(): { seq: number; messages: Message[]; blocks: Block[]; traces: Trace[] } {
    return {
      seq: this.#seq,
      messages: this.rows().flatMap((r) => (r.kind === "message" ? [r.message] : [])),
      blocks: [...this.#blocks.values()],
      traces: [...this.#traces.values()],
    };
  }

  /** Restores the cached thread on launch; the event stream then replays from its seq. */
  restore(cached: {
    seq: number;
    messages: Message[];
    blocks: Block[];
    traces: Trace[];
    before?: string;
  }): void {
    this.addPage(cached);
    this.#seq = cached.seq;
  }

  /** The latest complete reply from Poke (MessageActions sit under it only). */
  latestReplyId(): string | undefined {
    const rows = this.rows();
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!;
      if (row.kind !== "message") continue;
      if (row.message.role === "user") return undefined;
      if (row.message.role === "poke" && !row.streaming) return row.message.id;
    }
    return undefined;
  }

  /** A block that's waiting on him (drives the time-sensitive dot, Live Activity). */
  waitingBlocks(): Block[] {
    const live = new Set(["pending", "filled", "idle", "editing", "connecting", "active"]);
    return [...this.#blocks.values()].filter(
      (b) => live.has(b.state) && b.kind !== "memory_note" && b.kind !== "card",
    );
  }

  // ── writing ──────────────────────────────────────────────────────────────────────────────

  /** Replace everything with a fresh page (first load, or after `hello.reset`). */
  reset(page: ThreadPage): void {
    this.#messages.clear();
    this.#blocks.clear();
    this.#traces.clear();
    this.#steps.clear();
    this.#deltas.clear();
    this.#liveLines.clear();
    this.#hasOlder = true;
    this.#oldest = undefined;
    this.addPage(page);
    this.#seq = page.latestSeq;
  }

  /** An older page (scrolling up) or the cached thread on launch. */
  addPage(page: Pick<ThreadPage, "messages" | "blocks" | "traces" | "before">): void {
    this.#put(page);
    this.#oldest = page.before;
    this.#hasOlder = page.before !== undefined;
    this.#changed();
  }

  /**
   * Messages from a lookup (`around` a deep-linked message). Scrolling up still continues from
   * the oldest history page, so the cursor stays as it is.
   */
  addLookup(page: Pick<ThreadPage, "messages" | "blocks" | "traces">): void {
    this.#put(page);
    this.#changed();
  }

  #put(page: Pick<ThreadPage, "messages" | "blocks" | "traces">): void {
    for (const m of page.messages) if (m.scope === this.scope) this.#putMessage(m);
    for (const b of page.blocks) this.#blocks.set(b.id, b);
    for (const t of page.traces) this.#traces.set(t.id, t);
  }

  /** Steps for a trace the app opened (GET /v1/traces/:id). */
  setSteps(traceId: string, steps: Step[], tasks: Task[] = []): void {
    this.#steps.set(
      traceId,
      [...steps].sort((a, b) => a.startedAt - b.startedAt),
    );
    for (const t of tasks) this.#tasks.set(t.id, t);
    this.#changed();
  }

  setPending(entries: readonly OutboxEntry[]): void {
    this.#pending = entries;
    this.#changed();
  }

  /** Optimistic local update (a block action the server already accepted). */
  putBlock(block: Block): void {
    this.#blocks.set(block.id, block);
    this.#changed();
  }

  /** One frame from /v1/events. Returns "refetch" when the client fell too far behind. */
  apply(frame: ServerFrame): "refetch" | undefined {
    switch (frame.t) {
      case "hello":
        if (frame.reset) return "refetch";
        return undefined;
      case "event":
        if (frame.seq <= this.#seq) return undefined;
        this.#seq = frame.seq;
        this.#event(frame.event);
        break;
      case "live":
        this.#live(frame.event);
        break;
      case "snapshot":
        // The snapshot carries the text so far, so earlier deltas are already in it.
        for (const m of frame.streaming)
          if (m.scope === this.scope) {
            this.#deltas.delete(m.id);
            this.#putMessage(m);
          }
        if (this.scope === "main") this.#activity = frame.activity;
        break;
      case "pong":
        return undefined;
    }
    this.#changed();
    return undefined;
  }

  #event(event: PersistedEvent): void {
    switch (event.type) {
      case "message.created":
      case "message.updated": {
        if (event.message.scope !== this.scope) return;
        const before = this.#messages.get(event.message.id);
        this.#putMessage(event.message);
        // New text means a finished segment now holds what was streamed so far. An update that
        // only adds a card mid-segment leaves the text as it was, and the deltas still count.
        if (event.message.status !== "streaming" || !before || textOf(before) !== textOf(event.message))
          this.#deltas.delete(event.message.id);
        return;
      }
      case "block.created":
      case "block.updated":
        if (event.block.scope === this.scope) this.#blocks.set(event.block.id, event.block);
        // A side chat's cards: its screen keeps them.
        else this.onOther?.(event);
        return;
      case "trace.created":
      case "trace.updated":
        if (event.trace.scope !== this.scope) return;
        this.#traces.set(event.trace.id, event.trace);
        if (event.trace.status !== "running") this.#liveLines.delete(event.trace.id);
        return;
      case "step.started":
      case "step.completed": {
        const list = (this.#steps.get(event.step.traceId) ?? []).filter((s) => s.id !== event.step.id);
        this.#steps.set(
          event.step.traceId,
          [...list, event.step].sort((a, b) => a.startedAt - b.startedAt),
        );
        return;
      }
      case "task.started":
      case "task.updated":
      case "task.completed":
        this.#tasks.set(event.task.id, event.task);
        return;
      default:
        this.onOther?.(event);
    }
  }

  #live(event: LiveEvent): void {
    this.onLive?.(event);
    switch (event.type) {
      case "message.delta":
        if (event.scope !== this.scope) return;
        this.#deltas.set(event.messageId, (this.#deltas.get(event.messageId) ?? "") + event.text);
        return;
      case "agent.activity":
        if (event.scope === this.scope) this.#activity = event.activity;
        return;
      case "task.progress":
        this.#liveLines.set(event.traceId, event.text);
        return;
      default:
        return;
    }
  }

  #putMessage(message: Message): void {
    this.#messages.set(message.id, message);
    if (message.clientMessageId) this.onConfirmed?.(message.clientMessageId);
  }

  #changed(): void {
    this.#version++;
    this.#rows = undefined;
    for (const fn of this.#listeners) fn();
  }
}

function textOf(message: Message): string {
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n");
}
