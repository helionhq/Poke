import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type AgentChange, type Conversation, LiveDoc } from "@earendil-works/pi-durable";
import {
  DomainError,
  type ExecutorEvent,
  type ExecutorRuntime,
  type ExecutorSpec,
  type ModelAssignment,
} from "@poke/domain";
import { compactionFor, errorText, type PiHost } from "./host.js";
import { ConversationTracker } from "./tracker.js";

interface Tracked {
  taskId: string;
  conversation: Conversation;
  tracker: ConversationTracker;
  off: Array<() => void>;
}

export function agentFor(
  host: PiHost,
  kind: "executor" | "poke" | "sidechat",
  spec: {
    model: ModelAssignment;
    systemPrompt: string;
    tools: ExecutorSpec["tools"];
    cwd: string;
    budget: number;
  },
  reasoning?: string,
): AgentChange {
  const model = host.models.getModel(spec.model.provider, spec.model.model);
  if (!model) throw new DomainError("no_model", `${spec.model.provider}/${spec.model.model} isn't available`);
  const level = reasoning ?? spec.model.reasoning;
  return {
    model: { provider: spec.model.provider, modelId: spec.model.model },
    ...(level ? { thinkingLevel: level as ModelThinkingLevel } : {}),
    instructions: spec.systemPrompt,
    cwd: spec.cwd,
    extensions: host.extensionsFor(kind, spec.tools),
    compaction: compactionFor(
      { provider: spec.model.provider, id: model.id, contextWindow: model.contextWindow },
      spec.budget,
    ),
  };
}

/**
 * Executors as Pi Durable conversations on the shared Harness. Each task owns one ownerless
 * conversation (its runtimeRef); a follow-up message starts another run there, and every run's
 * final answer is a report to Poke. Executors never compact on idle: only the budget triggers it.
 */
export class PiExecutorRuntime implements ExecutorRuntime {
  readonly #listeners = new Set<(event: ExecutorEvent) => void>();
  readonly #tracked = new Map<string, Tracked>();

  constructor(private readonly host: PiHost) {}

  async start(spec: ExecutorSpec): Promise<{ runtimeRef: string }> {
    const conversation = await this.host.harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: agentFor(this.host, "executor", spec) },
      BACKGROUND_CONTEXT,
    );
    await this.#attach(spec, conversation);
    await conversation.submit(
      { type: "input", content: spec.firstTurn, requestId: `${spec.taskId}:start` },
      BACKGROUND_CONTEXT,
    );
    return { runtimeRef: String(conversation.id) };
  }

  async message(runtimeRef: string, text: string, mode: "steer" | "followup"): Promise<void> {
    const conversation = await this.#conversation(runtimeRef);
    await conversation.submit(
      {
        type: "input",
        content: text,
        whenBusy: mode === "steer" ? "steer" : "followUp",
        requestId: randomUUID(),
      },
      BACKGROUND_CONTEXT,
    );
  }

  async cancel(runtimeRef: string): Promise<void> {
    const conversation = await this.#conversation(runtimeRef);
    await conversation.abort(BACKGROUND_CONTEXT);
  }

  async resolveNeed(taskId: string, needId: string, value: unknown) {
    const tracked = this.#tracked.get(taskId);
    if (!tracked) return "not_found" as const;
    const result = await this.host.signalNeed(Number(tracked.conversation.id), needId, value);
    return result === "invalid" ? ("not_found" as const) : result;
  }

  onEvent(listener: (event: ExecutorEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async resume(tasks: Array<{ runtimeRef: string; spec: Omit<ExecutorSpec, "firstTurn"> }>): Promise<void> {
    for (const { runtimeRef, spec } of tasks) {
      const conversation = await this.host.conversation(runtimeRef);
      if (!conversation) {
        this.#emit({
          type: "failed",
          taskId: spec.taskId,
          error: "The agent's work was lost after a restart.",
        });
        continue;
      }
      // Pick up model or tool changes made while it was down (the prompt stays: cache hygiene).
      const { instructions: _instructions, ...agent } = agentFor(this.host, "executor", spec);
      await conversation.configure(agent, BACKGROUND_CONTEXT);
      await this.#attach(spec, conversation);
      await this.#reportIfFinished(spec.taskId, conversation);
    }
    this.host.harness.resume();
  }

  async close(): Promise<void> {
    for (const tracked of this.#tracked.values()) await this.#detach(tracked);
    this.#tracked.clear();
  }

  async #attach(spec: Omit<ExecutorSpec, "firstTurn">, conversation: Conversation): Promise<void> {
    const id = Number(conversation.id);
    this.host.bind(id, {
      agent: { kind: "executor", taskId: spec.taskId },
      invoker: spec.invoker,
      interceptor: spec.interceptor,
    });
    const tracker = new ConversationTracker(conversation, {
      provider: spec.model.provider,
      model: spec.model.model,
    });
    const taskId = spec.taskId;
    const off = [
      this.host.onTool(id, (event) => {
        if (event.type === "tool.started") {
          this.#emit({
            type: "step.started",
            taskId,
            callId: event.callId,
            name: event.name,
            args: event.args,
          });
        } else {
          this.#emit({
            type: "step.completed",
            taskId,
            callId: event.callId,
            name: event.name,
            isError: event.isError,
            ...(event.excerpt ? { excerpt: spec.interceptor.redact(event.excerpt) } : {}),
          });
        }
      }),
      tracker.on((event) => {
        switch (event.type) {
          case "assistant":
            if (event.usage) this.#emit({ type: "usage", taskId, usage: event.usage });
            if (event.final)
              this.#emit({ type: "report", taskId, text: spec.interceptor.redact(event.text) });
            break;
          case "failed":
            this.#emit({
              type: "failed",
              taskId,
              error: spec.interceptor.redact(event.detail ?? event.reason),
              kind: event.kind,
            });
            break;
          case "compacted":
            this.#emit({
              type: "compacted",
              taskId,
              trigger: "auto",
              preTokens: event.preTokens,
              model: spec.model.model,
            });
            break;
          case "delta":
            break;
        }
      }),
    ];
    await tracker.start();
    const previous = this.#tracked.get(taskId);
    if (previous) await this.#detach(previous);
    this.#tracked.set(taskId, { taskId, conversation, tracker, off });
  }

  async #reportIfFinished(taskId: string, conversation: Conversation): Promise<void> {
    const live = await this.host.harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT);
    if (live?.run !== undefined) return;
    const context = await conversation.context(BACKGROUND_CONTEXT);
    const last = context.entries.at(-1) as unknown as
      | {
          kind: string;
          model?: Array<{ stopReason?: string; content?: Array<{ type: string; text?: string }> }>;
        }
      | undefined;
    const message = last?.model?.[0];
    if (last?.kind === "pi.assistant" && message?.stopReason !== "toolUse") {
      const text = (message?.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      this.#emit({ type: "report", taskId, text });
    } else if (live?.runFailure) {
      this.#emit({ type: "failed", taskId, error: live.runFailure.detail ?? live.runFailure.reason });
    }
  }

  async #detach(tracked: Tracked): Promise<void> {
    for (const off of tracked.off) off();
    await tracked.tracker.stop();
    this.host.unbind(Number(tracked.conversation.id));
  }

  async #conversation(runtimeRef: string): Promise<Conversation> {
    const conversation = await this.host.conversation(runtimeRef);
    if (!conversation) throw new DomainError("not_found", "That agent's conversation no longer exists");
    return conversation;
  }

  #emit(event: ExecutorEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.host.log.warn({ error: errorText(error), event: event.type }, "executor listener failed");
      }
    }
  }
}
