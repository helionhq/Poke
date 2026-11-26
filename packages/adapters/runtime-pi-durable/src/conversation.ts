import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Conversation, ConversationIdle } from "@earendil-works/pi-durable";
import type {
  CompactionInfo,
  ConversationRuntime,
  ConversationSession,
  RuntimeCapabilities,
  RuntimeEvent,
  SessionProfile,
  SessionSpec,
  TurnInput,
} from "@poke/domain";
import { agentFor } from "./executors.js";
import { errorText, PiHost } from "./host.js";
import { AsyncQueue } from "@poke/agent-core";
import { classifyError, ConversationTracker } from "./tracker.js";

/**
 * Poke and side chats on a pi-ai model. Poke's session lives on the shared Harness
 * (durable.sqlite) and survives restarts; a side chat gets its own in-memory Harness that is
 * thrown away when it closes.
 */
export class PiConversationRuntime implements ConversationRuntime {
  readonly kind = "pi-durable" as const;

  constructor(private readonly host: PiHost) {}

  capabilities(profile: SessionProfile): RuntimeCapabilities {
    return {
      steering: true,
      idleCompaction: profile === "poke" ? "api" : "none",
      toolSearch: profile === "sidechat",
      codemode: profile === "sidechat",
    };
  }

  async openSession(spec: SessionSpec): Promise<ConversationSession> {
    const host = spec.persist
      ? this.host
      : await PiHost.open({
          models: this.host.models,
          workspace: this.host.workspace,
          log: this.host.log,
          registry: this.host.registry,
        });
    const kind = spec.profile === "poke" ? "poke" : "sidechat";
    const agent = agentFor(host, kind, { ...spec, tools: spec.tools }, spec.reasoning);
    let conversation = spec.resumeRef ? await host.conversation(spec.resumeRef) : undefined;
    const fresh = conversation === undefined;
    if (conversation) {
      // Same session, maybe another Pi model or new tools. Pi sends only the prompt sections that
      // changed, so an unchanged prompt keeps the provider cache warm.
      await conversation.configure(agent, BACKGROUND_CONTEXT);
    } else {
      conversation = await host.harness.createConversation(
        { ownership: { kind: "ownerless" }, agent },
        BACKGROUND_CONTEXT,
      );
    }
    host.bind(Number(conversation.id), {
      agent:
        spec.profile === "poke"
          ? { kind: "poke" }
          : { kind: "sidechat", sideChatId: spec.key.replace(/^sidechat:/, "") },
      invoker: spec.invoker,
      interceptor: spec.interceptor,
    });
    const session = new PiSession(host, conversation, spec, fresh, !spec.persist);
    await session.start();
    if (spec.persist) host.harness.resume();
    return session;
  }
}

class PiSession implements ConversationSession {
  readonly #tracker: ConversationTracker;
  readonly #listeners = new Set<(event: RuntimeEvent) => void>();
  #turn: AsyncQueue<RuntimeEvent> | undefined;
  #needsDigest: boolean;
  #expectedManual = 0;
  #off: Array<() => void> = [];

  constructor(
    private readonly host: PiHost,
    private readonly conversation: Conversation,
    private readonly spec: SessionSpec,
    fresh: boolean,
    private readonly ownsHost: boolean,
  ) {
    this.#needsDigest = fresh && Boolean(spec.digest);
    this.#tracker = new ConversationTracker(conversation, {
      provider: spec.model.provider,
      model: spec.model.model,
    });
  }

  get ref(): string {
    return String(this.conversation.id);
  }

  async start(): Promise<void> {
    const id = Number(this.conversation.id);
    this.#off.push(
      this.host.onTool(id, (event) => {
        if (event.type === "tool.started") {
          this.#emit({ type: "tool.started", callId: event.callId, name: event.name, args: event.args });
        } else {
          this.#emit({
            type: "tool.completed",
            callId: event.callId,
            name: event.name,
            isError: event.isError,
          });
        }
      }),
      this.#tracker.on((event) => {
        switch (event.type) {
          case "delta":
            this.#emit({ type: "text.delta", text: this.spec.interceptor.redact(event.text) });
            break;
          case "assistant":
            if (event.text) this.#emit({ type: "text.done", text: this.spec.interceptor.redact(event.text) });
            if (event.usage) {
              this.#emit({
                type: "usage",
                usage: event.usage,
                ...(event.contextTokens !== undefined ? { contextTokens: event.contextTokens } : {}),
              });
            }
            break;
          case "compacted":
            if (event.reason === "manual" && this.#expectedManual > 0) {
              this.#expectedManual--;
              break;
            }
            this.#emit({ type: "compacted", trigger: "auto", preTokens: event.preTokens });
            break;
          case "failed":
            // The turn's own submission reports how its run ended.
            break;
        }
      }),
    );
    await this.#tracker.start();
  }

  async *startTurn(input: TurnInput): AsyncIterable<RuntimeEvent> {
    const queue = new AsyncQueue<RuntimeEvent>();
    this.#turn = queue;
    try {
      let text = input.text;
      if (this.#needsDigest && this.spec.digest) {
        text = `${this.spec.digest}\n\n${text}`;
        this.#needsDigest = false;
      }
      const content = input.images?.length
        ? [
            { type: "text" as const, text },
            ...input.images.map((image) => ({
              type: "image" as const,
              data: image.data,
              mimeType: image.mimeType,
            })),
          ]
        : text;
      const submission = await this.conversation.submit(
        { type: "input", content, requestId: randomUUID() },
        BACKGROUND_CONTEXT,
      );
      void submission.wait(BACKGROUND_CONTEXT).then(
        (settled) => {
          if (settled.status !== "done") {
            const settlement = (settled as { settlement?: { reason?: string; detail?: string } }).settlement;
            const reason = settlement?.reason ?? "unanswered";
            queue.push({
              type: "error",
              kind:
                reason === "aborted"
                  ? "cancelled"
                  : reason === "no_model"
                    ? "no_model"
                    : classifyError(settlement?.detail),
              message: this.spec.interceptor.redact(settlement?.detail ?? reason),
            });
          }
          queue.push({ type: "turn.done" });
          queue.close();
        },
        (error: unknown) => {
          queue.push({ type: "error", kind: "provider", message: errorText(error) });
          queue.push({ type: "turn.done" });
          queue.close();
        },
      );
      yield { type: "session", ref: this.ref };
      for await (const event of queue) yield event;
    } finally {
      if (this.#turn === queue) this.#turn = undefined;
    }
  }

  async steer(input: TurnInput): Promise<boolean> {
    try {
      await this.conversation.submit(
        {
          type: "input",
          content: input.text,
          whenBusy: "steer",
          whenIdle: "reject",
          requestId: randomUUID(),
        },
        BACKGROUND_CONTEXT,
      );
      return true;
    } catch (error) {
      if (error instanceof ConversationIdle) return false;
      throw error;
    }
  }

  async cancel(): Promise<void> {
    await this.conversation.abort(BACKGROUND_CONTEXT);
  }

  async compact(_trigger: "manual" | "idle", instructions?: string): Promise<CompactionInfo | undefined> {
    const preTokens = this.#tracker.contextTokens ?? 0;
    this.#expectedManual++;
    const taskId = await this.conversation.compact(
      instructions ?? this.spec.compactionInstructions,
      BACKGROUND_CONTEXT,
    );
    const settled = await this.host.harness.waitForTask(taskId, BACKGROUND_CONTEXT);
    const outcome = settled.state.outcome as {
      status: string;
      result?: { entryId?: unknown; submissionId?: unknown };
    };
    if (
      outcome.status !== "completed" ||
      (outcome.result?.entryId === undefined && outcome.result?.submissionId === undefined)
    ) {
      this.#expectedManual = Math.max(0, this.#expectedManual - 1);
      return undefined;
    }
    return { preTokens };
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  contextTokens(): number | undefined {
    return this.#tracker.contextTokens;
  }

  async close(): Promise<void> {
    for (const off of this.#off) off();
    await this.#tracker.stop();
    this.host.unbind(Number(this.conversation.id));
    if (this.ownsHost) await this.host.close();
  }

  #emit(event: RuntimeEvent): void {
    if (this.#turn && !this.#turn.closed) {
      this.#turn.push(event);
      return;
    }
    for (const listener of this.#listeners) listener(event);
  }
}
