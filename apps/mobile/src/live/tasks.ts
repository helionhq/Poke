import type { Step, Task } from "@poke/contracts";
import type { ActivityContent, LiveActivities } from "../../modules/poke-live-activity";

/** iOS allows a handful of activities per app; Poke rarely runs more than two tasks at once. */
const MAX_ACTIVITIES = 3;
/** How long a finished task stays on the Lock Screen. */
const DONE_LINGER_S = 15 * 60;

export interface TaskView {
  task: Task;
  steps: readonly Step[];
  liveLine?: string;
}

/** What the Live Activity shows for a task. */
export function activityContent({ task, steps, liveLine }: TaskView): ActivityContent {
  const base = { title: task.name, startedAt: task.createdAt };
  switch (task.status) {
    case "waiting":
      return { ...base, state: "waiting", line: needLine(task) };
    case "completed":
      return { ...base, state: "done", line: firstLine(task.result) ?? "Finished" };
    case "failed":
      return { ...base, state: "failed", line: firstLine(task.error) ?? "Couldn't finish" };
    case "cancelled":
      return { ...base, state: "failed", line: "Stopped" };
    default: {
      const current = [...steps].reverse().find((s) => s.status === "running") ?? steps.at(-1);
      return { ...base, state: "working", line: liveLine ?? current?.label ?? "Getting started" };
    }
  }
}

function needLine(task: Task): string {
  const need = task.need;
  if (!need) return "Waiting for you";
  switch (need.kind) {
    case "question":
      return need.question;
    case "secret":
      return `Needs your ${need.secret.label}`;
    case "connection":
      return `Needs ${need.appName ?? need.app} connected`;
    case "approval":
      return "Needs your approval";
  }
}

function firstLine(text: string | undefined): string | undefined {
  const line = text
    ?.split("\n")
    .map((l) => l.replace(/[*_`#>]/g, "").trim())
    .find(Boolean);
  return line ? (line.length > 140 ? `${line.slice(0, 139)}…` : line) : undefined;
}

const ended = (t: Task) => t.status === "completed" || t.status === "failed" || t.status === "cancelled";

/**
 * Keeps one Lock Screen activity per running task (brief section 18). Activities start only while
 * the app is in the foreground (ActivityKit's rule), are updated from WebSocket events while the
 * app runs, and end with the task's outcome. Updates are sent only when what's shown changes.
 */
export class TaskActivities {
  readonly #native: LiveActivities;
  /** taskId → activity id */
  readonly #active = new Map<string, string>();
  /** What each activity last showed, as JSON. */
  readonly #shown = new Map<string, string>();
  /** Tasks already given an activity (not restarted if he swipes it away). */
  readonly #seen = new Set<string>();
  readonly #pending = new Set<string>();

  constructor(native: LiveActivities) {
    this.#native = native;
    // Pick up activities from before a relaunch.
    try {
      for (const { id, taskId } of native.running()) {
        this.#active.set(taskId, id);
        this.#seen.add(taskId);
      }
    } catch {
      // Not available
    }
  }

  /** Call whenever the thread store changes. `foreground`: the app is active. */
  sync(views: readonly TaskView[], foreground: boolean): void {
    for (const view of views) {
      const { task } = view;
      const content = activityContent(view);
      const id = this.#active.get(task.id);
      if (id) {
        if (ended(task)) this.#end(task.id, id, content, task.status === "cancelled" ? 0 : DONE_LINGER_S);
        else this.#update(id, content);
      } else if (
        !ended(task) &&
        foreground &&
        !this.#seen.has(task.id) &&
        !this.#pending.has(task.id) &&
        this.#active.size + this.#pending.size < MAX_ACTIVITIES
      ) {
        this.#start(task.id, content);
      }
    }
  }

  /**
   * After a relaunch: end activities whose task the server no longer lists as running (it
   * finished while the app was closed). `running` are the ids from GET /v1/tasks.
   */
  reconcile(running: ReadonlySet<string>): void {
    for (const [taskId, id] of this.#active) {
      if (!running.has(taskId)) this.#end(taskId, id, undefined, 0);
    }
  }

  #start(taskId: string, content: ActivityContent): void {
    if (!this.#native.isEnabled()) return;
    this.#seen.add(taskId);
    this.#pending.add(taskId);
    this.#native
      .start(taskId, content)
      .then((id) => {
        this.#active.set(taskId, id);
        this.#shown.set(id, JSON.stringify(content));
      })
      .catch(() => {})
      .finally(() => this.#pending.delete(taskId));
  }

  #update(id: string, content: ActivityContent): void {
    const json = JSON.stringify(content);
    if (this.#shown.get(id) === json) return;
    this.#shown.set(id, json);
    void this.#native.update(id, content).catch(() => {});
  }

  #end(taskId: string, id: string, content: ActivityContent | undefined, linger: number): void {
    this.#active.delete(taskId);
    const last = content ??
      (JSON.parse(this.#shown.get(id) ?? "null") as ActivityContent | null) ?? {
        title: "Poke",
        line: "",
        state: "done",
        startedAt: Date.now(),
      };
    this.#shown.delete(id);
    void this.#native.end(id, last, linger).catch(() => {});
  }
}
