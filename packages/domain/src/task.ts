import type { MessageId, StepId, TaskId, TraceId } from "./ids.js";

export type TaskStatus = "running" | "waiting" | "completed" | "failed" | "cancelled";

/** An execution agent run. Executors never talk to Arham; their report goes to Poke. */
export interface Task {
  id: TaskId;
  /** Short handle Poke uses to address it ("lisbon-stays"). */
  name: string;
  goal: string;
  context: string;
  skills: string[];
  status: TaskStatus;
  /** The trace that shows this task's steps in the thread. */
  traceId: TraceId;
  /** The user/routine message that led to it. */
  parentMessageId?: MessageId;
  routineRunId?: string;
  /** Runtime conversation id (Pi Durable). */
  runtimeRef?: string;
  /** The final report to Poke (redacted). */
  result?: string;
  error?: string;
  /** Current pending need, while status = waiting. */
  need?: TaskNeed;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
}

export type TaskNeed =
  | {
      id: string;
      kind: "secret";
      service: string;
      /** Non-secret context to prefill (email, phone, username). */
      fields: Record<string, string>;
      secret: { label: string; type: "password" | "api_key" | "code" | "card" | "text" };
      vaultName: string;
      reason: string;
      ephemeral?: boolean;
    }
  | {
      id: string;
      kind: "connection";
      app: string;
      appName?: string;
      reason: string;
      custom?: { source: string; toolCount?: number };
      caps?: string[];
      connectionId?: string;
    }
  | { id: string; kind: "question"; question: string; options?: string[]; reason?: string }
  | { id: string; kind: "approval"; approvalId: string };

export type StepStatus = "running" | "done" | "error";

/** One tool call, summarised for the Trace. */
export interface Step {
  id: StepId;
  taskId: TaskId;
  traceId: TraceId;
  tool: string;
  /** Human label ("Searched the web", "Searching Airbnb for stays in Príncipe Real"). */
  label: string;
  app?: AppRef;
  status: StepStatus;
  /** Short redacted detail (args summary / output excerpt). */
  detail?: string;
  startedAt: number;
  endedAt?: number;
}

export interface AppRef {
  id: string;
  name: string;
  /** Logo URL (server-proxied) or a bundled icon key ("web", "terminal", "browser"). */
  icon?: string;
}

export type TraceStatus = "running" | "done" | "failed";

/**
 * The executor tool calls that serve one Poke reply, grouped. While running it shows one live
 * line; when done "Used 3 tools · Google Calendar, Maps, Resy ›". Never a plan or to-do list.
 */
export interface Trace {
  id: TraceId;
  scope: "main" | `sidechat:${string}`;
  /** The thread item that holds the trace part. */
  messageId: MessageId;
  taskIds: TaskId[];
  status: TraceStatus;
  /** Current live line while running. */
  line?: string;
  lineApp?: AppRef;
  toolCount: number;
  apps: AppRef[];
  startedAt: number;
  endedAt?: number;
}

export function traceSummary(trace: Pick<Trace, "status" | "toolCount" | "apps" | "line">): string {
  if (trace.status === "running") return trace.line ?? "Working";
  const tools = `Used ${trace.toolCount} tool${trace.toolCount === 1 ? "" : "s"}`;
  const apps = trace.apps.map((app) => app.name);
  return apps.length > 0 ? `${tools} · ${apps.join(", ")}` : tools;
}
