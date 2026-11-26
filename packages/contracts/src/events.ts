import { z } from "zod";
import { Block, CompactionRecord, Message, Routine, Skill, Step, Task, Trace } from "./entities.js";

export const PersistedEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message.created"), message: Message }),
  z.object({ type: z.literal("message.updated"), message: Message }),
  z.object({ type: z.literal("block.created"), block: Block }),
  z.object({ type: z.literal("block.updated"), block: Block }),
  z.object({ type: z.literal("trace.created"), trace: Trace }),
  z.object({ type: z.literal("trace.updated"), trace: Trace }),
  z.object({ type: z.literal("task.started"), task: Task }),
  z.object({ type: z.literal("task.updated"), task: Task }),
  z.object({ type: z.literal("task.completed"), task: Task }),
  z.object({ type: z.literal("step.started"), step: Step }),
  z.object({ type: z.literal("step.completed"), step: Step }),
  z.object({ type: z.literal("routine.updated"), routine: Routine }),
  z.object({ type: z.literal("routine.deleted"), routineId: z.string() }),
  z.object({ type: z.literal("skill.updated"), skill: Skill }),
  z.object({ type: z.literal("skill.deleted"), name: z.string() }),
  z.object({ type: z.literal("vault.updated"), name: z.string() }),
  z.object({ type: z.literal("vault.deleted"), name: z.string() }),
  z.object({ type: z.literal("integration.updated"), integrationId: z.string() }),
  z.object({ type: z.literal("context.compacted"), compaction: CompactionRecord }),
  z.object({ type: z.literal("settings.updated"), keys: z.array(z.string()) }),
  z.object({ type: z.literal("models.updated"), roles: z.array(z.string()) }),
]);
export type PersistedEvent = z.infer<typeof PersistedEvent>;

export const AgentActivity = z.enum(["idle", "thinking", "working"]);

export const LiveEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message.delta"), messageId: z.string(), scope: z.string(), text: z.string() }),
  z.object({ type: z.literal("agent.activity"), scope: z.string(), activity: AgentActivity }),
  z.object({ type: z.literal("task.progress"), taskId: z.string(), traceId: z.string(), text: z.string() }),
  z.object({ type: z.literal("sidechat.message"), sideChatId: z.string(), message: Message }),
  z.object({ type: z.literal("sidechat.closed"), sideChatId: z.string() }),
]);
export type LiveEvent = z.infer<typeof LiveEvent>;

/** Server → client frames on /v1/events. */
export const ServerFrame = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    protocol: z.number(),
    latestSeq: z.number(),
    serverTime: z.number(),
    /** True when `since` was too old to replay; the client should refetch the thread. */
    reset: z.boolean(),
  }),
  z.object({ t: z.literal("event"), seq: z.number(), at: z.number(), event: PersistedEvent }),
  z.object({ t: z.literal("live"), event: LiveEvent }),
  /** Sent after replay: messages still streaming (with text so far) and agent activity. */
  z.object({
    t: z.literal("snapshot"),
    streaming: z.array(Message),
    activity: AgentActivity,
  }),
  z.object({ t: z.literal("pong"), at: z.number() }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

/** Client → server frames. Heartbeats carry app presence for notification routing. */
export const ClientFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("ping"), presence: z.enum(["foreground", "background"]) }),
  z.object({ t: z.literal("presence"), presence: z.enum(["foreground", "background"]) }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;
