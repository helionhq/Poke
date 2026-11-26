import { z } from "zod";

/** Wire schemas mirror the domain entities 1:1 (JSON). application checks they stay assignable. */

export const Scope = z.union([z.literal("main"), z.templateLiteral(["sidechat:", z.string()])]);

export const TextPart = z.object({ type: z.literal("text"), text: z.string() });
export const AttachmentPart = z.object({
  type: z.literal("attachment"),
  attachmentId: z.string(),
  kind: z.enum(["image", "file", "audio", "scan"]),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
});
export const BlockPart = z.object({ type: z.literal("block"), blockId: z.string() });
export const TracePart = z.object({ type: z.literal("trace"), traceId: z.string() });
export const MessagePart = z.discriminatedUnion("type", [TextPart, AttachmentPart, BlockPart, TracePart]);

export const SystemNoteReason = z.enum([
  "no_model",
  "rate_limited",
  "login_expired",
  "provider_error",
  "compacted",
  "skill_installed",
  "info",
]);

export const MessageOrigin = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({ kind: z.literal("share") }),
  z.object({ kind: z.literal("voice") }),
  z.object({ kind: z.literal("turn") }),
  z.object({
    kind: z.literal("routine"),
    routineId: z.string(),
    runId: z.string(),
    late: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("system"), reason: SystemNoteReason }),
]);

export const Message = z.object({
  id: z.string(),
  scope: Scope,
  role: z.enum(["user", "poke", "system"]),
  parts: z.array(MessagePart),
  status: z.enum(["streaming", "complete", "failed"]),
  origin: MessageOrigin,
  clientMessageId: z.string().optional(),
  replyTo: z.object({ messageId: z.string(), excerpt: z.string() }).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Message = z.infer<typeof Message>;

export const BlockOwner = z.discriminatedUnion("type", [
  z.object({ type: z.literal("poke") }),
  z.object({ type: z.literal("task"), taskId: z.string(), needId: z.string() }),
  z.object({ type: z.literal("approval"), approvalId: z.string() }),
]);

export const Block = z.object({
  id: z.string(),
  kind: z.string(),
  v: z.number(),
  props: z.record(z.string(), z.unknown()),
  state: z.string(),
  resolution: z.record(z.string(), z.unknown()).optional(),
  fallback: z.string().optional(),
  owner: BlockOwner,
  messageId: z.string(),
  scope: Scope,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Block = z.infer<typeof Block>;

export const AppRef = z.object({ id: z.string(), name: z.string(), icon: z.string().optional() });
export type AppRef = z.infer<typeof AppRef>;

export const Trace = z.object({
  id: z.string(),
  scope: Scope,
  messageId: z.string(),
  taskIds: z.array(z.string()),
  status: z.enum(["running", "done", "failed"]),
  line: z.string().optional(),
  lineApp: AppRef.optional(),
  toolCount: z.number(),
  apps: z.array(AppRef),
  startedAt: z.number(),
  endedAt: z.number().optional(),
});
export type Trace = z.infer<typeof Trace>;

export const Step = z.object({
  id: z.string(),
  taskId: z.string(),
  traceId: z.string(),
  tool: z.string(),
  label: z.string(),
  app: AppRef.optional(),
  status: z.enum(["running", "done", "error"]),
  detail: z.string().optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
});
export type Step = z.infer<typeof Step>;

export const TaskNeed = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    kind: z.literal("secret"),
    service: z.string(),
    fields: z.record(z.string(), z.string()),
    secret: z.object({
      label: z.string(),
      type: z.enum(["password", "api_key", "code", "card", "text"]),
    }),
    vaultName: z.string(),
    reason: z.string(),
    ephemeral: z.boolean().optional(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("connection"),
    app: z.string(),
    appName: z.string().optional(),
    reason: z.string(),
    custom: z.object({ source: z.string(), toolCount: z.number().optional() }).optional(),
    caps: z.array(z.string()).optional(),
    connectionId: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("question"),
    question: z.string(),
    options: z.array(z.string()).optional(),
    reason: z.string().optional(),
  }),
  z.object({ id: z.string(), kind: z.literal("approval"), approvalId: z.string() }),
]);

export const Task = z.object({
  id: z.string(),
  name: z.string(),
  goal: z.string(),
  context: z.string(),
  skills: z.array(z.string()),
  status: z.enum(["running", "waiting", "completed", "failed", "cancelled"]),
  traceId: z.string(),
  parentMessageId: z.string().optional(),
  routineRunId: z.string().optional(),
  runtimeRef: z.string().optional(),
  result: z.string().optional(),
  error: z.string().optional(),
  need: TaskNeed.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  endedAt: z.number().optional(),
});
export type Task = z.infer<typeof Task>;

export const Schedule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: z.number() }),
  z.object({
    kind: z.literal("cron"),
    expr: z.string(),
    tz: z.string(),
    until: z.number().optional(),
    count: z.number().optional(),
  }),
  z.object({
    kind: z.literal("interval"),
    everyMs: z.number().positive(),
    startAt: z.number().optional(),
    until: z.number().optional(),
    count: z.number().optional(),
  }),
]);
export type Schedule = z.infer<typeof Schedule>;

export const Routine = z.object({
  id: z.string(),
  title: z.string(),
  instructions: z.string(),
  schedule: Schedule,
  deliver: z.enum(["always", "only_if_notable"]),
  enabled: z.boolean(),
  model: z.string().optional(),
  runCount: z.number(),
  lastRunAt: z.number().optional(),
  nextRunAt: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Routine = z.infer<typeof Routine>;

export const RoutineRun = z.object({
  id: z.string(),
  routineId: z.string(),
  scheduledFor: z.number(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  status: z.enum(["running", "delivered", "quiet", "failed"]),
  late: z.boolean(),
  taskId: z.string().optional(),
  messageId: z.string().optional(),
  summary: z.string().optional(),
});

export const Skill = z.object({
  name: z.string(),
  description: z.string(),
  location: z.string(),
  enabled: z.boolean(),
  source: z.string().optional(),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  allowedTools: z.array(z.string()).optional(),
  warnings: z.array(z.string()),
  installedAt: z.number(),
  updatedAt: z.number(),
});
export type Skill = z.infer<typeof Skill>;

export const VaultEntry = z.object({
  name: z.string(),
  kind: z.enum(["login", "api_key", "card", "code", "note"]),
  fields: z.record(z.string(), z.string()),
  secretFields: z.array(z.string()),
  usedBy: z.array(z.string()),
  description: z.string().optional(),
  ephemeral: z.boolean(),
  expiresAt: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastUsedAt: z.number().optional(),
});
export type VaultEntry = z.infer<typeof VaultEntry>;

export const Attachment = z.object({
  id: z.string(),
  kind: z.enum(["image", "file", "audio", "scan"]),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  sha256: z.string(),
  path: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  durationMs: z.number().optional(),
  origin: z.enum(["user", "share", "poke"]),
  messageId: z.string().optional(),
  createdAt: z.number(),
});
export type Attachment = z.infer<typeof Attachment>;

export const CompactionRecord = z.object({
  id: z.string(),
  sessionKind: z.enum(["poke", "executor", "sidechat"]),
  sessionRef: z.string(),
  trigger: z.enum(["auto", "idle", "manual"]),
  preTokens: z.number(),
  postTokens: z.number().optional(),
  runtime: z.enum(["claude-agent-sdk", "pi-durable"]),
  model: z.string(),
  summary: z.string().optional(),
  createdAt: z.number(),
});

export const Device = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.enum(["ios", "web", "cli", "shortcut"]),
  scope: z.enum(["full", "share"]),
  createdAt: z.number(),
  lastSeenAt: z.number().optional(),
  revokedAt: z.number().optional(),
});
export type Device = z.infer<typeof Device>;
