import { executorPrompt, type PersonaSlots, SILENT_TOOLS, toolLabel } from "@poke/agent-core";
import {
  type AppRef,
  type Clock,
  clampBudget,
  type CompactionRecord,
  DomainError,
  type ExecutorEvent,
  type ExecutorRuntime,
  type ExecutorSpec,
  type IdGenerator,
  type Logger,
  type PersistedEvent,
  type Repositories,
  type Step,
  type Task,
  type TaskNeed,
  type Trace,
  type UsageReport,
} from "@poke/domain";
import type { EventHub } from "./core/hub.js";
import type { ModelService } from "./models.js";
import type { SettingsService } from "./settings.js";
import type { ToolGateway } from "./tools/gateway.js";

export type QuestionNeed = Extract<TaskNeed, { kind: "question" }>;
/** A need as an executor raises it; the id comes from the tool call. */
export type NeedInput =
  | Omit<Extract<TaskNeed, { kind: "question" }>, "id">
  | Omit<Extract<TaskNeed, { kind: "secret" }>, "id">
  | Omit<Extract<TaskNeed, { kind: "connection" }>, "id">
  | Omit<Extract<TaskNeed, { kind: "approval" }>, "id">;

/** What Poke hears about its agents. Cancellations it asked for aren't reported back. */
export type AgentOutcome =
  | { kind: "report"; task: Task; text: string }
  | { kind: "failed"; task: Task; error: string }
  | { kind: "need"; task: Task; need: TaskNeed };

export interface AgentsDeps {
  repos: Repositories;
  hub: EventHub;
  ids: IdGenerator;
  clock: Clock;
  log: Logger;
  runtime: ExecutorRuntime;
  models: ModelService;
  gateway: ToolGateway;
  settings: SettingsService;
  persona: () => PersonaSlots;
  workspace: string;
}

const ACTIVE = new Set<Task["status"]>(["running", "waiting"]);

export function recordUsage(
  repos: Pick<Repositories, "usage">,
  now: number,
  role: string,
  usage: UsageReport,
  error = false,
): void {
  repos.usage.record({
    day: new Date(now).toISOString().slice(0, 10),
    role,
    provider: usage.provider,
    model: usage.model,
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    costUsd: usage.costUsd ?? 0,
    error,
  });
}

/**
 * Execution agents as tasks: starting, messaging and cancelling them, and turning their runtime
 * events into Tasks, Steps and the Trace above the Poke reply they serve.
 */
export class AgentsService {
  readonly #listeners = new Set<(outcome: AgentOutcome) => void>();
  /** `${taskId}:${callId}` → step id, so a completion finds its step. */
  readonly #steps = new Map<string, string>();

  constructor(private readonly deps: AgentsDeps) {
    deps.runtime.onEvent((event) => {
      try {
        this.#onEvent(event);
      } catch (error) {
        deps.log.error({ err: error, event: event.type }, "executor event failed");
      }
    });
  }

  onOutcome(listener: (outcome: AgentOutcome) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  list(includeFinished = false): Task[] {
    const { tasks } = this.deps.repos;
    const active = tasks.active();
    if (!includeFinished) return active.reverse();
    const seen = new Set(active.map((t) => t.id));
    return [...active.reverse(), ...tasks.recent(30).filter((t) => !seen.has(t.id))];
  }

  find(ref: string): Task | undefined {
    return this.deps.repos.tasks.get(ref) ?? this.deps.repos.tasks.byName(ref);
  }

  steps(taskId: string): Step[] {
    return this.deps.repos.steps.byTask(taskId);
  }

  /** A trace holds the executor work that serves one Poke reply; `messageId` is where it shows. */
  createTrace(messageId: string): Trace {
    const now = this.deps.clock.now();
    const trace: Trace = {
      id: this.deps.ids.next("trc"),
      scope: "main",
      messageId,
      taskIds: [],
      status: "running",
      toolCount: 0,
      apps: [],
      startedAt: now,
    };
    this.deps.hub.publish(() => {
      this.deps.repos.traces.save(trace);
      return [{ type: "trace.created", trace }];
    });
    return trace;
  }

  async start(
    input: { name: string; goal: string; context?: string; skills?: string[] },
    link: { traceId: string; parentMessageId?: string },
  ): Promise<Task> {
    const existing = this.deps.repos.tasks.byName(input.name);
    if (existing && ACTIVE.has(existing.status)) {
      throw new DomainError(
        "conflict",
        `An agent called ${input.name} is already working (${existing.id}). Message it with agentId instead.`,
      );
    }
    const spec = await this.#spec(""); // fails fast when no Agents model is set
    const now = this.deps.clock.now();
    const task: Task = {
      id: this.deps.ids.next("tsk"),
      name: input.name,
      goal: input.goal,
      context: input.context ?? "",
      skills: input.skills ?? [],
      status: "running",
      traceId: link.traceId,
      ...(link.parentMessageId ? { parentMessageId: link.parentMessageId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.#attachToTrace(task, link.traceId, [{ type: "task.started", task }]);
    try {
      const { runtimeRef } = await this.deps.runtime.start({
        ...spec,
        taskId: task.id,
        name: task.name,
        firstTurn: firstTurn(task),
      });
      task.runtimeRef = runtimeRef;
      task.updatedAt = this.deps.clock.now();
      this.#save(task, [{ type: "task.updated", task }]);
    } catch (error) {
      this.#finish(task, "failed", { error: errorText(error) });
      throw error;
    }
    return task;
  }

  /** Message an agent: steer it while it works, or start a follow-up run once it's done. */
  async message(ref: string, text: string, link: { traceId: string }): Promise<Task> {
    const task = this.#require(ref);
    if (!task.runtimeRef) throw new DomainError("unavailable", `${task.name} never started`);
    if (task.status === "waiting" && task.need?.kind === "question") {
      await this.answer(task, text, link);
      return task;
    }
    if (ACTIVE.has(task.status)) {
      await this.deps.runtime.message(task.runtimeRef, text, "steer");
      return task;
    }
    task.status = "running";
    task.traceId = link.traceId;
    task.updatedAt = this.deps.clock.now();
    delete task.endedAt;
    delete task.error;
    this.#attachToTrace(task, link.traceId, [{ type: "task.updated", task }]);
    await this.deps.runtime.message(task.runtimeRef, text, "followup");
    return task;
  }

  async cancel(ref: string): Promise<Task> {
    const task = this.#require(ref);
    if (!ACTIVE.has(task.status)) return task;
    this.#finish(task, "cancelled", {});
    if (task.runtimeRef)
      await this.deps.runtime.cancel(task.runtimeRef).catch((error: unknown) => {
        this.deps.log.warn({ err: error, task: task.id }, "cancel failed");
      });
    return task;
  }

  /** report_progress: one live line on the Trace. */
  progress(taskId: string, text: string): void {
    const task = this.deps.repos.tasks.get(taskId);
    if (!task) return;
    this.deps.hub.live({ type: "task.progress", taskId, traceId: task.traceId, text });
    const trace = this.deps.repos.traces.get(task.traceId);
    if (trace && trace.status === "running") {
      trace.line = text;
      delete trace.lineApp;
      this.deps.hub.publish(() => {
        this.deps.repos.traces.save(trace);
        return [{ type: "trace.updated", trace }];
      });
    }
  }

  /**
   * ask_poke: park the task on a need. Poke hears about it; a question is answered by messaging
   * the agent, a secret or connection by the block the server shows (resolveNeed).
   */
  ask(taskId: string, input: NeedInput, needId: string): TaskNeed {
    const task = this.#require(taskId);
    if (task.need?.id === needId) return task.need; // a replayed call
    const need = { ...input, id: needId } as TaskNeed;
    task.status = "waiting";
    task.need = need;
    task.updatedAt = this.deps.clock.now();
    this.#save(task, [{ type: "task.updated", task }]);
    this.#notify({ kind: "need", task, need });
    return need;
  }

  /** A block resolved a task's need: wake the parked tool with the value. */
  async resolveNeed(taskId: string, needId: string, value: unknown): Promise<void> {
    const task = this.deps.repos.tasks.get(taskId);
    if (!task || task.need?.id !== needId || !ACTIVE.has(task.status)) {
      throw new DomainError("unavailable", "That agent isn't waiting for this any more");
    }
    const result = await this.deps.runtime.resolveNeed(task.id, needId, value);
    if (result === "not_found") throw new DomainError("unavailable", `${task.name} isn't waiting any more`);
    task.status = "running";
    delete task.need;
    task.updatedAt = this.deps.clock.now();
    this.#save(task, [{ type: "task.updated", task }]);
  }

  async answer(task: Task, text: string, link?: { traceId: string }): Promise<void> {
    const need = task.need;
    if (!need) throw new DomainError("conflict", `${task.name} isn't waiting for anything`);
    const result = await this.deps.runtime.resolveNeed(task.id, need.id, { answer: text });
    if (result === "not_found") throw new DomainError("unavailable", `${task.name} isn't waiting any more`);
    task.status = "running";
    delete task.need;
    if (link && link.traceId !== task.traceId) task.traceId = link.traceId;
    task.updatedAt = this.deps.clock.now();
    if (link) this.#attachToTrace(task, link.traceId, [{ type: "task.updated", task }]);
    else this.#save(task, [{ type: "task.updated", task }]);
  }

  /** Re-attach to the agents a previous process left running. */
  async resume(): Promise<void> {
    const tasks = this.deps.repos.tasks.active().filter((t) => t.runtimeRef);
    if (tasks.length === 0) return;
    let spec: Omit<ExecutorSpec, "firstTurn" | "taskId" | "name">;
    try {
      spec = await this.#spec("");
    } catch (error) {
      for (const task of tasks)
        this.#finish(task, "failed", { error: `Couldn't resume after a restart: ${errorText(error)}` });
      return;
    }
    await this.deps.runtime.resume(
      tasks.map((task) => ({
        runtimeRef: task.runtimeRef!,
        spec: { ...spec, taskId: task.id, name: task.name },
      })),
    );
  }

  // ── runtime events ─────────────────────────────────────────────────────────────────────────

  #onEvent(event: ExecutorEvent): void {
    const task = this.deps.repos.tasks.get(event.taskId);
    if (!task) return;
    switch (event.type) {
      case "step.started":
        this.#stepStarted(task, event.callId, event.name, event.args);
        return;
      case "step.completed":
        this.#stepCompleted(task, event.callId, event.isError, event.excerpt);
        return;
      case "progress":
        this.progress(task.id, event.text);
        return;
      case "parked":
        return;
      case "report":
        if (task.status === "cancelled") return;
        this.#finish(task, "completed", { result: event.text });
        this.#notify({ kind: "report", task, text: event.text });
        return;
      case "failed":
        if (task.status === "cancelled" || event.kind === "cancelled") {
          if (ACTIVE.has(task.status)) this.#finish(task, "cancelled", {});
          return;
        }
        this.#finish(task, "failed", { error: event.error });
        this.#notify({ kind: "failed", task, error: event.error });
        return;
      case "compacted": {
        const record: CompactionRecord = {
          id: this.deps.ids.next("cmp"),
          sessionKind: "executor",
          sessionRef: task.id,
          trigger: event.trigger,
          preTokens: event.preTokens,
          runtime: "pi-durable",
          model: event.model,
          createdAt: this.deps.clock.now(),
        };
        this.deps.hub.publish(() => {
          this.deps.repos.compactions.save(record);
          return [{ type: "context.compacted", compaction: record }];
        });
        return;
      }
      case "usage":
        recordUsage(this.deps.repos, this.deps.clock.now(), "agents", event.usage);
        return;
    }
  }

  #stepStarted(task: Task, callId: string, name: string, args: unknown): void {
    if (SILENT_TOOLS.has(name) || name === "ask_poke") return;
    const key = `${task.id}:${callId}`;
    if (this.#steps.has(key)) return;
    const safeArgs = JSON.parse(this.deps.gateway.interceptor.redact(JSON.stringify(args ?? {}))) as unknown;
    const label = toolLabel(name, safeArgs);
    const step: Step = {
      id: this.deps.ids.next("stp"),
      taskId: task.id,
      traceId: task.traceId,
      tool: name,
      label: label.done,
      ...(label.app ? { app: label.app } : {}),
      status: "running",
      startedAt: this.deps.clock.now(),
    };
    this.#steps.set(key, step.id);
    const trace = this.deps.repos.traces.get(task.traceId);
    const events: PersistedEvent[] = [{ type: "step.started", step }];
    if (trace) {
      trace.toolCount += 1;
      trace.line = label.live;
      if (label.app) {
        trace.lineApp = label.app;
        if (!trace.apps.some((a) => a.id === label.app!.id)) trace.apps.push(label.app);
      } else delete trace.lineApp;
      if (trace.status !== "running") {
        trace.status = "running";
        delete trace.endedAt;
      }
      events.push({ type: "trace.updated", trace });
    }
    this.deps.hub.publish(() => {
      this.deps.repos.steps.save(step);
      if (trace) this.deps.repos.traces.save(trace);
      return events;
    });
  }

  #stepCompleted(task: Task, callId: string, isError: boolean, excerpt?: string): void {
    const key = `${task.id}:${callId}`;
    const stepId = this.#steps.get(key);
    if (!stepId) return;
    this.#steps.delete(key);
    const step = this.deps.repos.steps.get(stepId);
    if (!step) return;
    step.status = isError ? "error" : "done";
    step.endedAt = this.deps.clock.now();
    if (excerpt) step.detail = excerpt;
    this.deps.hub.publish(() => {
      this.deps.repos.steps.save(step);
      return [{ type: "step.completed", step }];
    });
  }

  // ── bookkeeping ────────────────────────────────────────────────────────────────────────────

  #attachToTrace(task: Task, traceId: string, events: PersistedEvent[]): void {
    const trace = this.deps.repos.traces.get(traceId);
    if (trace && !trace.taskIds.includes(task.id)) {
      trace.taskIds.push(task.id);
      trace.status = "running";
      delete trace.endedAt;
      events.push({ type: "trace.updated", trace });
    }
    this.deps.hub.publish(() => {
      this.deps.repos.tasks.save(task);
      if (trace) this.deps.repos.traces.save(trace);
      return events;
    });
  }

  #finish(
    task: Task,
    status: "completed" | "failed" | "cancelled",
    extra: { result?: string; error?: string },
  ): void {
    const now = this.deps.clock.now();
    task.status = status;
    task.updatedAt = now;
    task.endedAt = now;
    delete task.need;
    if (extra.result !== undefined) task.result = extra.result;
    if (extra.error !== undefined) task.error = extra.error;
    const events: PersistedEvent[] = [{ type: "task.completed", task }];
    const trace = this.deps.repos.traces.get(task.traceId);
    if (trace) {
      const tasks = trace.taskIds.map((id) => (id === task.id ? task : this.deps.repos.tasks.get(id)));
      if (tasks.every((t) => !t || !ACTIVE.has(t.status))) {
        trace.status = tasks.every((t) => t?.status === "failed") ? "failed" : "done";
        trace.endedAt = now;
        delete trace.line;
        delete trace.lineApp;
        events.push({ type: "trace.updated", trace });
      }
    }
    this.deps.hub.publish(() => {
      this.deps.repos.tasks.save(task);
      if (trace) this.deps.repos.traces.save(trace);
      return events;
    });
  }

  #save(task: Task, events: PersistedEvent[]): void {
    this.deps.hub.publish(() => {
      this.deps.repos.tasks.save(task);
      return events;
    });
  }

  #require(ref: string): Task {
    const task = this.find(ref);
    if (!task) throw new DomainError("not_found", `No agent called ${ref}`);
    return task;
  }

  #notify(outcome: AgentOutcome): void {
    for (const listener of this.#listeners) {
      try {
        listener(outcome);
      } catch (error) {
        this.deps.log.error({ err: error }, "agent outcome listener failed");
      }
    }
  }

  async #spec(
    taskId: string,
  ): Promise<Omit<ExecutorSpec, "firstTurn" | "taskId" | "name"> & { taskId: string; name: string }> {
    const model = this.deps.models.get("agents");
    if (!model) {
      const who = this.deps.persona().userName;
      throw new DomainError(
        "no_model",
        `No Agents model is set, so agents can't run. ${who} can pick one with \`poke model\` on Poke's machine.`,
      );
    }
    const info = await this.deps.models.info("agents");
    return {
      taskId,
      name: "",
      model,
      systemPrompt: executorPrompt(this.deps.persona()),
      tools: this.deps.gateway.specs("executor"),
      invoker: this.deps.gateway.invoker("executor"),
      interceptor: this.deps.gateway.interceptor,
      cwd: this.deps.workspace,
      budget: clampBudget(this.deps.settings.context().window, info?.contextWindow),
    };
  }
}

function firstTurn(task: Task): string {
  const parts = [`<goal>\n${task.goal}\n</goal>`];
  if (task.context.trim()) parts.push(`<background>\n${task.context.trim()}\n</background>`);
  if (task.skills.length) parts.push(`Load these skills first: ${task.skills.join(", ")}.`);
  return parts.join("\n\n");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { AppRef };
