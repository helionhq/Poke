import type { RoutineId } from "./ids.js";

export type Schedule =
  | { kind: "once"; at: number }
  | { kind: "cron"; expr: string; tz: string; until?: number; count?: number }
  | { kind: "interval"; everyMs: number; startAt?: number; until?: number; count?: number };

export type RoutineDelivery = "always" | "only_if_notable";

export interface RoutineRun {
  id: string;
  routineId: RoutineId;
  scheduledFor: number;
  startedAt: number;
  endedAt?: number;
  status: "running" | "delivered" | "quiet" | "failed";
  late: boolean;
  taskId?: string;
  messageId?: string;
  summary?: string;
}

/** The only proactive mechanism: an automation with a friendly name. Never called a "trigger". */
export interface Routine {
  id: RoutineId;
  title: string;
  /** What to do, in natural language. */
  instructions: string;
  schedule: Schedule;
  deliver: RoutineDelivery;
  enabled: boolean;
  /** Optional per-routine Agents model override ("provider/model"). */
  model?: string;
  runCount: number;
  lastRunAt?: number;
  nextRunAt?: number;
  createdAt: number;
  updatedAt: number;
}
