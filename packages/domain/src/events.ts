import type { Block } from "./block.js";
import type { CompactionRecord } from "./context.js";
import type { Routine } from "./routine.js";
import type { Skill } from "./skill.js";
import type { Step, Task, Trace } from "./task.js";
import type { Message } from "./thread.js";

export type AgentActivity = "idle" | "thinking" | "working";

/** Events that are persisted with a monotonically increasing seq and replayed on resume. */
export type PersistedEvent =
  | { type: "message.created"; message: Message }
  | { type: "message.updated"; message: Message }
  | { type: "block.created"; block: Block }
  | { type: "block.updated"; block: Block }
  | { type: "trace.created"; trace: Trace }
  | { type: "trace.updated"; trace: Trace }
  | { type: "task.started"; task: Task }
  | { type: "task.updated"; task: Task }
  | { type: "task.completed"; task: Task }
  | { type: "step.started"; step: Step }
  | { type: "step.completed"; step: Step }
  | { type: "routine.updated"; routine: Routine }
  | { type: "routine.deleted"; routineId: string }
  | { type: "skill.updated"; skill: Skill }
  | { type: "skill.deleted"; name: string }
  | { type: "vault.updated"; name: string }
  | { type: "vault.deleted"; name: string }
  | { type: "integration.updated"; integrationId: string }
  | { type: "context.compacted"; compaction: CompactionRecord }
  | { type: "settings.updated"; keys: string[] }
  | { type: "models.updated"; roles: string[] };

/** Live-only events: never persisted, no seq. Clients get a snapshot of in-flight state on connect. */
export type LiveEvent =
  | { type: "message.delta"; messageId: string; scope: string; text: string }
  | { type: "agent.activity"; scope: string; activity: AgentActivity }
  | { type: "task.progress"; taskId: string; traceId: string; text: string }
  | { type: "sidechat.message"; sideChatId: string; message: Message }
  | { type: "sidechat.closed"; sideChatId: string };

export type DomainEvent = PersistedEvent | LiveEvent;

export const PERSISTED_EVENT_TYPES: ReadonlySet<PersistedEvent["type"]> = new Set([
  "message.created",
  "message.updated",
  "block.created",
  "block.updated",
  "trace.created",
  "trace.updated",
  "task.started",
  "task.updated",
  "task.completed",
  "step.started",
  "step.completed",
  "routine.updated",
  "routine.deleted",
  "skill.updated",
  "skill.deleted",
  "vault.updated",
  "vault.deleted",
  "integration.updated",
  "context.compacted",
  "settings.updated",
  "models.updated",
]);

export function isPersisted(event: DomainEvent): event is PersistedEvent {
  return PERSISTED_EVENT_TYPES.has(event.type as PersistedEvent["type"]);
}

export interface StoredEvent {
  seq: number;
  at: number;
  event: PersistedEvent;
}
