import type {
  ApprovalRepository,
  ApprovalRequest,
  ApprovalRule,
  Attachment,
  AttachmentRepository,
  Block,
  BlockRepository,
  BlockActionRecord,
  CompactionRecord,
  CompactionRepository,
  Device,
  DeviceRepository,
  EventRepository,
  Integration,
  IntegrationRepository,
  McpServerConfig,
  Message,
  MessageRepository,
  MessageSearchHit,
  ModelAssignment,
  ModelAssignmentRepository,
  PairingCode,
  PersistedEvent,
  Repositories,
  Role,
  Routine,
  RoutineRepository,
  RoutineRun,
  SessionRecord,
  SessionRepository,
  SettingsRepository,
  Skill,
  SkillRepository,
  Step,
  StepRepository,
  StoredEvent,
  Task,
  TaskRepository,
  Trace,
  TraceRepository,
  UsageRepository,
  UsageRow,
} from "@poke/domain";
import { json, opt, optJson, parse, type Row, type SqliteDb } from "./db.js";

const n = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v));
const s = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
const bool = (v: unknown): boolean => Number(v) === 1;
const nul = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

function setOpt<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

export class SqliteEvents implements EventRepository {
  constructor(private readonly db: SqliteDb) {}
  append(event: PersistedEvent, at: number): StoredEvent {
    const { lastInsertRowid } = this.db.run(
      "INSERT INTO events (type, at, payload) VALUES (?, ?, ?)",
      event.type,
      at,
      json(event),
    );
    return { seq: lastInsertRowid, at, event };
  }
  since(seq: number, limit: number): StoredEvent[] {
    return this.db
      .all("SELECT seq, at, payload FROM events WHERE seq > ? ORDER BY seq LIMIT ?", seq, limit)
      .map((row) => ({
        seq: Number(row.seq),
        at: Number(row.at),
        event: parse<PersistedEvent>(row.payload),
      }));
  }
  latestSeq(): number {
    return Number(this.db.get("SELECT COALESCE(MAX(seq), 0) AS seq FROM events")?.seq ?? 0);
  }
}

function messageFromRow(row: Row): Message {
  const message: Message = {
    id: String(row.id),
    scope: String(row.scope) as Message["scope"],
    role: String(row.role) as Message["role"],
    status: String(row.status) as Message["status"],
    parts: parse(row.parts),
    origin: parse(row.origin),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
  setOpt(message, "clientMessageId", s(row.client_message_id));
  setOpt(message, "replyTo", optJson(row.reply_to));
  return message;
}

/** Turn free text into a safe FTS5 query: each word becomes a quoted prefix term. */
export function ftsQuery(input: string): string {
  const words = input
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}@._'-]+/u)
    .map((word) => word.replace(/"/g, ""))
    .filter((word) => word.length > 0);
  return words.map((word) => `"${word}"*`).join(" ");
}

export class SqliteMessages implements MessageRepository {
  constructor(private readonly db: SqliteDb) {}

  save(message: Message, extraSearchText?: string): void {
    const text = message.parts
      .map((part) => (part.type === "text" ? part.text : part.type === "attachment" ? part.name : ""))
      .filter(Boolean)
      .join(" ");
    const searchText = [text, extraSearchText ?? ""].filter(Boolean).join("\n");
    this.db.run(
      `INSERT INTO messages (id, scope, role, status, parts, origin, client_message_id, reply_to, search_text, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, parts = excluded.parts, origin = excluded.origin,
         reply_to = excluded.reply_to, search_text = excluded.search_text, updated_at = excluded.updated_at`,
      message.id,
      message.scope,
      message.role,
      message.status,
      json(message.parts),
      json(message.origin),
      nul(message.clientMessageId),
      message.replyTo ? json(message.replyTo) : null,
      searchText,
      message.createdAt,
      message.updatedAt,
    );
  }

  get(id: string): Message | undefined {
    const row = this.db.get("SELECT * FROM messages WHERE id = ?", id);
    return row ? messageFromRow(row) : undefined;
  }

  byClientMessageId(clientMessageId: string): Message | undefined {
    const row = this.db.get("SELECT * FROM messages WHERE client_message_id = ?", clientMessageId);
    return row ? messageFromRow(row) : undefined;
  }

  page(opts: { before?: string; limit: number }) {
    let rows: Row[];
    if (opts.before) {
      const [at, id] = decodeCursor(opts.before);
      rows = this.db.all(
        `SELECT * FROM messages WHERE scope = 'main' AND (created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC LIMIT ?`,
        at,
        at,
        id,
        opts.limit + 1,
      );
    } else {
      rows = this.db.all(
        "SELECT * FROM messages WHERE scope = 'main' ORDER BY created_at DESC, id DESC LIMIT ?",
        opts.limit + 1,
      );
    }
    const more = rows.length > opts.limit;
    const messages = rows.slice(0, opts.limit).map(messageFromRow).reverse();
    const oldest = messages[0];
    return more && oldest ? { messages, before: encodeCursor(oldest) } : { messages };
  }

  around(id: string, radius: number): Message[] {
    const anchor = this.get(id);
    if (!anchor) return [];
    const before = this.db
      .all(
        `SELECT * FROM messages WHERE scope = 'main' AND (created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC LIMIT ?`,
        anchor.createdAt,
        anchor.createdAt,
        anchor.id,
        radius,
      )
      .map(messageFromRow)
      .reverse();
    const after = this.db
      .all(
        `SELECT * FROM messages WHERE scope = 'main' AND (created_at > ? OR (created_at = ? AND id > ?))
         ORDER BY created_at, id LIMIT ?`,
        anchor.createdAt,
        anchor.createdAt,
        anchor.id,
        radius,
      )
      .map(messageFromRow);
    return [...before, anchor, ...after];
  }

  recent(limit: number): Message[] {
    return this.db
      .all("SELECT * FROM messages WHERE scope = 'main' ORDER BY created_at DESC, id DESC LIMIT ?", limit)
      .map(messageFromRow)
      .reverse();
  }

  count(): number {
    return Number(this.db.get("SELECT COUNT(*) AS c FROM messages WHERE scope = 'main'")?.c ?? 0);
  }

  first(): Message | undefined {
    const row = this.db.get("SELECT * FROM messages WHERE scope = 'main' ORDER BY created_at, id LIMIT 1");
    return row ? messageFromRow(row) : undefined;
  }

  search(opts: { query: string; before?: number; after?: number; limit: number; roles?: string[] }) {
    const match = ftsQuery(opts.query);
    if (!match) return [];
    const clauses = ["messages_fts MATCH ?", "m.scope = 'main'"];
    const params: (string | number)[] = [match];
    if (opts.before !== undefined) {
      clauses.push("m.created_at < ?");
      params.push(opts.before);
    }
    if (opts.after !== undefined) {
      clauses.push("m.created_at > ?");
      params.push(opts.after);
    }
    if (opts.roles && opts.roles.length > 0) {
      clauses.push(`m.role IN (${opts.roles.map(() => "?").join(",")})`);
      params.push(...opts.roles);
    }
    const rows = this.db.all(
      `SELECT m.*, highlight(messages_fts, 0, '«', '»') AS hl, bm25(messages_fts) AS rank
       FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
       WHERE ${clauses.join(" AND ")}
       ORDER BY m.created_at DESC LIMIT ?`,
      ...params,
      opts.limit,
    );
    return rows.map((row): MessageSearchHit => ({
      message: messageFromRow(row),
      highlight: String(row.hl ?? ""),
      rank: Number(row.rank ?? 0),
    }));
  }
}

function encodeCursor(message: Pick<Message, "createdAt" | "id">): string {
  return `${message.createdAt}:${message.id}`;
}
function decodeCursor(cursor: string): [number, string] {
  const i = cursor.indexOf(":");
  return [Number(cursor.slice(0, i)), cursor.slice(i + 1)];
}

function blockFromRow(row: Row): Block {
  const block: Block = {
    id: String(row.id),
    kind: String(row.kind),
    v: Number(row.v),
    props: parse(row.props),
    state: String(row.state),
    owner: parse(row.owner),
    messageId: String(row.message_id),
    scope: String(row.scope) as Block["scope"],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
  setOpt(block, "resolution", optJson(row.resolution));
  if (row.fallback !== null && row.fallback !== undefined) block.fallback = String(row.fallback);
  return block;
}

export class SqliteBlocks implements BlockRepository {
  constructor(private readonly db: SqliteDb) {}
  save(block: Block): void {
    this.db.run(
      `INSERT INTO blocks (id, kind, v, props, state, resolution, owner, message_id, scope, created_at, updated_at, fallback, task_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET props = excluded.props, state = excluded.state, resolution = excluded.resolution,
         owner = excluded.owner, message_id = excluded.message_id, updated_at = excluded.updated_at,
         fallback = excluded.fallback, task_id = excluded.task_id`,
      block.id,
      block.kind,
      block.v,
      json(block.props),
      block.state,
      block.resolution ? json(block.resolution) : null,
      json(block.owner),
      block.messageId,
      block.scope,
      block.createdAt,
      block.updatedAt,
      block.fallback ?? null,
      block.owner.type === "task"
        ? block.owner.taskId
        : block.owner.type === "approval"
          ? (block.owner.taskId ?? null)
          : null,
    );
  }
  get(id: string): Block | undefined {
    const row = this.db.get("SELECT * FROM blocks WHERE id = ?", id);
    return row ? blockFromRow(row) : undefined;
  }
  byMessage(messageId: string): Block[] {
    return this.db
      .all("SELECT * FROM blocks WHERE message_id = ? ORDER BY created_at", messageId)
      .map(blockFromRow);
  }
  pending(): Block[] {
    return this.db
      .all(
        "SELECT * FROM blocks WHERE state IN ('pending', 'editing', 'connecting', 'filled') ORDER BY created_at",
      )
      .map(blockFromRow);
  }
  byTask(taskId: string): Block[] {
    return this.db
      .all("SELECT * FROM blocks WHERE task_id = ? ORDER BY created_at", taskId)
      .map(blockFromRow);
  }
  recordAction(record: BlockActionRecord): void {
    this.db.run(
      "INSERT OR IGNORE INTO block_actions (client_action_id, block_id, action, result, created_at) VALUES (?, ?, ?, ?, ?)",
      record.clientActionId,
      record.blockId,
      record.action,
      record.result ? json(record.result) : null,
      record.createdAt,
    );
  }
  findAction(clientActionId: string): BlockActionRecord | undefined {
    const row = this.db.get("SELECT * FROM block_actions WHERE client_action_id = ?", clientActionId);
    if (!row) return undefined;
    const record: BlockActionRecord = {
      clientActionId: String(row.client_action_id),
      blockId: String(row.block_id),
      action: String(row.action),
      createdAt: Number(row.created_at),
    };
    setOpt(record, "result", optJson(row.result));
    return record;
  }
}

function taskFromRow(row: Row): Task {
  const task: Task = {
    id: String(row.id),
    name: String(row.name),
    goal: String(row.goal),
    context: String(row.context),
    skills: parse(row.skills),
    status: String(row.status) as Task["status"],
    traceId: String(row.trace_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
  setOpt(task, "parentMessageId", s(row.parent_message_id));
  setOpt(task, "routineRunId", s(row.routine_run_id));
  setOpt(task, "runtimeRef", s(row.runtime_ref));
  setOpt(task, "result", s(row.result));
  setOpt(task, "error", s(row.error));
  setOpt(task, "need", optJson(row.need));
  setOpt(task, "endedAt", n(row.ended_at));
  return task;
}

export class SqliteTasks implements TaskRepository {
  constructor(private readonly db: SqliteDb) {}
  save(task: Task): void {
    this.db.run(
      `INSERT INTO tasks (id, name, goal, context, skills, status, trace_id, parent_message_id, routine_run_id, runtime_ref,
         result, error, need, created_at, updated_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, runtime_ref = excluded.runtime_ref, result = excluded.result,
         error = excluded.error, need = excluded.need, updated_at = excluded.updated_at, ended_at = excluded.ended_at,
         context = excluded.context`,
      task.id,
      task.name,
      task.goal,
      task.context,
      json(task.skills),
      task.status,
      task.traceId,
      nul(task.parentMessageId),
      nul(task.routineRunId),
      nul(task.runtimeRef),
      nul(task.result),
      nul(task.error),
      task.need ? json(task.need) : null,
      task.createdAt,
      task.updatedAt,
      nul(task.endedAt),
    );
  }
  get(id: string): Task | undefined {
    const row = this.db.get("SELECT * FROM tasks WHERE id = ?", id);
    return row ? taskFromRow(row) : undefined;
  }
  byName(name: string): Task | undefined {
    const row = this.db.get("SELECT * FROM tasks WHERE name = ? ORDER BY created_at DESC LIMIT 1", name);
    return row ? taskFromRow(row) : undefined;
  }
  active(): Task[] {
    return this.db
      .all("SELECT * FROM tasks WHERE status IN ('running', 'waiting') ORDER BY created_at")
      .map(taskFromRow);
  }
  recent(limit: number): Task[] {
    return this.db.all("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?", limit).map(taskFromRow);
  }
}

function stepFromRow(row: Row): Step {
  const step: Step = {
    id: String(row.id),
    taskId: String(row.task_id),
    traceId: String(row.trace_id),
    tool: String(row.tool),
    label: String(row.label),
    status: String(row.status) as Step["status"],
    startedAt: Number(row.started_at),
  };
  setOpt(step, "app", optJson(row.app));
  setOpt(step, "detail", s(row.detail));
  setOpt(step, "endedAt", n(row.ended_at));
  return step;
}

export class SqliteSteps implements StepRepository {
  constructor(private readonly db: SqliteDb) {}
  save(step: Step): void {
    this.db.run(
      `INSERT INTO steps (id, task_id, trace_id, tool, label, app, status, detail, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET label = excluded.label, app = excluded.app, status = excluded.status,
         detail = excluded.detail, ended_at = excluded.ended_at`,
      step.id,
      step.taskId,
      step.traceId,
      step.tool,
      step.label,
      step.app ? json(step.app) : null,
      step.status,
      nul(step.detail),
      step.startedAt,
      nul(step.endedAt),
    );
  }
  get(id: string): Step | undefined {
    const row = this.db.get("SELECT * FROM steps WHERE id = ?", id);
    return row ? stepFromRow(row) : undefined;
  }
  byTrace(traceId: string): Step[] {
    return this.db
      .all("SELECT * FROM steps WHERE trace_id = ? ORDER BY started_at", traceId)
      .map(stepFromRow);
  }
  byTask(taskId: string): Step[] {
    return this.db.all("SELECT * FROM steps WHERE task_id = ? ORDER BY started_at", taskId).map(stepFromRow);
  }
}

function traceFromRow(row: Row): Trace {
  const trace: Trace = {
    id: String(row.id),
    scope: String(row.scope) as Trace["scope"],
    messageId: String(row.message_id),
    taskIds: parse(row.task_ids),
    status: String(row.status) as Trace["status"],
    toolCount: Number(row.tool_count),
    apps: parse(row.apps),
    startedAt: Number(row.started_at),
  };
  setOpt(trace, "line", s(row.line));
  setOpt(trace, "lineApp", optJson(row.line_app));
  setOpt(trace, "endedAt", n(row.ended_at));
  return trace;
}

export class SqliteTraces implements TraceRepository {
  constructor(private readonly db: SqliteDb) {}
  save(trace: Trace): void {
    this.db.run(
      `INSERT INTO traces (id, scope, message_id, task_ids, status, line, line_app, tool_count, apps, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET task_ids = excluded.task_ids, status = excluded.status, line = excluded.line,
         line_app = excluded.line_app, tool_count = excluded.tool_count, apps = excluded.apps,
         message_id = excluded.message_id, ended_at = excluded.ended_at`,
      trace.id,
      trace.scope,
      trace.messageId,
      json(trace.taskIds),
      trace.status,
      nul(trace.line),
      trace.lineApp ? json(trace.lineApp) : null,
      trace.toolCount,
      json(trace.apps),
      trace.startedAt,
      nul(trace.endedAt),
    );
  }
  get(id: string): Trace | undefined {
    const row = this.db.get("SELECT * FROM traces WHERE id = ?", id);
    return row ? traceFromRow(row) : undefined;
  }
  byTask(taskId: string): Trace | undefined {
    const row = this.db.get(
      "SELECT t.* FROM traces t, json_each(t.task_ids) j WHERE j.value = ? ORDER BY t.started_at DESC LIMIT 1",
      taskId,
    );
    return row ? traceFromRow(row) : undefined;
  }
}

function routineFromRow(row: Row): Routine {
  const routine: Routine = {
    id: String(row.id),
    title: String(row.title),
    instructions: String(row.instructions),
    schedule: parse(row.schedule),
    deliver: String(row.deliver) as Routine["deliver"],
    enabled: bool(row.enabled),
    runCount: Number(row.run_count),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
  setOpt(routine, "model", s(row.model));
  setOpt(routine, "lastRunAt", n(row.last_run_at));
  setOpt(routine, "nextRunAt", n(row.next_run_at));
  return routine;
}

function runFromRow(row: Row): RoutineRun {
  const run: RoutineRun = {
    id: String(row.id),
    routineId: String(row.routine_id),
    scheduledFor: Number(row.scheduled_for),
    startedAt: Number(row.started_at),
    status: String(row.status) as RoutineRun["status"],
    late: bool(row.late),
  };
  setOpt(run, "endedAt", n(row.ended_at));
  setOpt(run, "taskId", s(row.task_id));
  setOpt(run, "messageId", s(row.message_id));
  setOpt(run, "summary", s(row.summary));
  return run;
}

export class SqliteRoutines implements RoutineRepository {
  constructor(private readonly db: SqliteDb) {}
  save(routine: Routine): void {
    this.db.run(
      `INSERT INTO routines (id, title, instructions, schedule, deliver, enabled, model, run_count, last_run_at, next_run_at,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, instructions = excluded.instructions,
         schedule = excluded.schedule, deliver = excluded.deliver, enabled = excluded.enabled, model = excluded.model,
         run_count = excluded.run_count, last_run_at = excluded.last_run_at, next_run_at = excluded.next_run_at,
         updated_at = excluded.updated_at`,
      routine.id,
      routine.title,
      routine.instructions,
      json(routine.schedule),
      routine.deliver,
      routine.enabled ? 1 : 0,
      nul(routine.model),
      routine.runCount,
      nul(routine.lastRunAt),
      nul(routine.nextRunAt),
      routine.createdAt,
      routine.updatedAt,
    );
  }
  get(id: string): Routine | undefined {
    const row = this.db.get("SELECT * FROM routines WHERE id = ?", id);
    return row ? routineFromRow(row) : undefined;
  }
  list(): Routine[] {
    return this.db.all("SELECT * FROM routines ORDER BY created_at").map(routineFromRow);
  }
  delete(id: string): boolean {
    return this.db.run("DELETE FROM routines WHERE id = ?", id).changes > 0;
  }
  due(now: number): Routine[] {
    return this.db
      .all(
        "SELECT * FROM routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at",
        now,
      )
      .map(routineFromRow);
  }
  saveRun(run: RoutineRun): void {
    this.db.run(
      `INSERT INTO routine_runs (id, routine_id, scheduled_for, started_at, ended_at, status, late, task_id, message_id, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at, status = excluded.status, task_id = excluded.task_id,
         message_id = excluded.message_id, summary = excluded.summary`,
      run.id,
      run.routineId,
      run.scheduledFor,
      run.startedAt,
      nul(run.endedAt),
      run.status,
      run.late ? 1 : 0,
      nul(run.taskId),
      nul(run.messageId),
      nul(run.summary),
    );
  }
  runs(routineId: string, limit: number): RoutineRun[] {
    return this.db
      .all(
        "SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY started_at DESC LIMIT ?",
        routineId,
        limit,
      )
      .map(runFromRow);
  }
  getRun(id: string): RoutineRun | undefined {
    const row = this.db.get("SELECT * FROM routine_runs WHERE id = ?", id);
    return row ? runFromRow(row) : undefined;
  }
}

function skillFromRow(row: Row): Skill {
  const skill: Skill = {
    name: String(row.name),
    description: String(row.description),
    location: String(row.location),
    enabled: bool(row.enabled),
    warnings: parse(row.warnings),
    installedAt: Number(row.installed_at),
    updatedAt: Number(row.updated_at),
  };
  setOpt(skill, "source", s(row.source));
  setOpt(skill, "license", s(row.license));
  setOpt(skill, "compatibility", s(row.compatibility));
  setOpt(skill, "metadata", optJson(row.metadata));
  setOpt(skill, "allowedTools", optJson(row.allowed_tools));
  return skill;
}

export class SqliteSkills implements SkillRepository {
  constructor(private readonly db: SqliteDb) {}
  save(skill: Skill): void {
    this.db.run(
      `INSERT INTO skills (name, description, location, enabled, source, license, compatibility, metadata, allowed_tools,
         warnings, installed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET description = excluded.description, location = excluded.location,
         enabled = excluded.enabled, source = excluded.source, license = excluded.license,
         compatibility = excluded.compatibility, metadata = excluded.metadata, allowed_tools = excluded.allowed_tools,
         warnings = excluded.warnings, updated_at = excluded.updated_at`,
      skill.name,
      skill.description,
      skill.location,
      skill.enabled ? 1 : 0,
      nul(skill.source),
      nul(skill.license),
      nul(skill.compatibility),
      skill.metadata ? json(skill.metadata) : null,
      skill.allowedTools ? json(skill.allowedTools) : null,
      json(skill.warnings),
      skill.installedAt,
      skill.updatedAt,
    );
  }
  get(name: string): Skill | undefined {
    const row = this.db.get("SELECT * FROM skills WHERE name = ?", name);
    return row ? skillFromRow(row) : undefined;
  }
  list(): Skill[] {
    return this.db.all("SELECT * FROM skills ORDER BY name").map(skillFromRow);
  }
  delete(name: string): boolean {
    return this.db.run("DELETE FROM skills WHERE name = ?", name).changes > 0;
  }
}

function deviceFromRow(row: Row): Device {
  const device: Device = {
    id: String(row.id),
    name: String(row.name),
    platform: String(row.platform) as Device["platform"],
    scope: String(row.scope) as Device["scope"],
    tokenHash: String(row.token_hash),
    createdAt: Number(row.created_at),
  };
  setOpt(device, "lastSeenAt", n(row.last_seen_at));
  setOpt(device, "revokedAt", n(row.revoked_at));
  setOpt(device, "vaultKey", s(row.vault_key));
  return device;
}

function codeFromRow(row: Row): PairingCode {
  const code: PairingCode = {
    codeHash: String(row.code_hash),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    attempts: Number(row.attempts),
  };
  setOpt(code, "usedAt", n(row.used_at));
  return code;
}

export class SqliteDevices implements DeviceRepository {
  constructor(private readonly db: SqliteDb) {}
  save(device: Device): void {
    this.db.run(
      `INSERT INTO devices (id, name, platform, scope, token_hash, created_at, last_seen_at, revoked_at, vault_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, last_seen_at = excluded.last_seen_at,
         revoked_at = excluded.revoked_at, vault_key = excluded.vault_key`,
      device.id,
      device.name,
      device.platform,
      device.scope,
      device.tokenHash,
      device.createdAt,
      nul(device.lastSeenAt),
      nul(device.revokedAt),
      nul(device.vaultKey),
    );
  }
  get(id: string): Device | undefined {
    const row = this.db.get("SELECT * FROM devices WHERE id = ?", id);
    return row ? deviceFromRow(row) : undefined;
  }
  byTokenHash(hash: string): Device | undefined {
    const row = this.db.get("SELECT * FROM devices WHERE token_hash = ?", hash);
    return row ? deviceFromRow(row) : undefined;
  }
  list(): Device[] {
    return this.db.all("SELECT * FROM devices ORDER BY created_at").map(deviceFromRow);
  }
  savePairingCode(code: PairingCode): void {
    this.db.run(
      `INSERT INTO pairing_codes (code_hash, created_at, expires_at, used_at, attempts) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(code_hash) DO UPDATE SET used_at = excluded.used_at, attempts = excluded.attempts`,
      code.codeHash,
      code.createdAt,
      code.expiresAt,
      nul(code.usedAt),
      code.attempts,
    );
  }
  pairingCode(codeHash: string): PairingCode | undefined {
    const row = this.db.get("SELECT * FROM pairing_codes WHERE code_hash = ?", codeHash);
    return row ? codeFromRow(row) : undefined;
  }
  livePairingCodes(now: number): PairingCode[] {
    return this.db
      .all("SELECT * FROM pairing_codes WHERE used_at IS NULL AND expires_at > ?", now)
      .map(codeFromRow);
  }
}

function attachmentFromRow(row: Row): Attachment {
  const attachment: Attachment = {
    id: String(row.id),
    kind: String(row.kind) as Attachment["kind"],
    name: String(row.name),
    mime: String(row.mime),
    size: Number(row.size),
    sha256: String(row.sha256),
    path: String(row.path),
    origin: String(row.origin) as Attachment["origin"],
    createdAt: Number(row.created_at),
  };
  setOpt(attachment, "width", n(row.width));
  setOpt(attachment, "height", n(row.height));
  setOpt(attachment, "durationMs", n(row.duration_ms));
  setOpt(attachment, "messageId", s(row.message_id));
  return attachment;
}

export class SqliteAttachments implements AttachmentRepository {
  constructor(private readonly db: SqliteDb) {}
  save(a: Attachment): void {
    this.db.run(
      `INSERT INTO attachments (id, kind, name, mime, size, sha256, path, width, height, duration_ms, origin, message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET message_id = excluded.message_id, name = excluded.name`,
      a.id,
      a.kind,
      a.name,
      a.mime,
      a.size,
      a.sha256,
      a.path,
      nul(a.width),
      nul(a.height),
      nul(a.durationMs),
      a.origin,
      nul(a.messageId),
      a.createdAt,
    );
  }
  get(id: string): Attachment | undefined {
    const row = this.db.get("SELECT * FROM attachments WHERE id = ?", id);
    return row ? attachmentFromRow(row) : undefined;
  }
  list(opts: {
    filter: "all" | "photos" | "files" | "from_poke";
    query?: string;
    before?: number;
    limit: number;
  }) {
    const clauses: string[] = ["1 = 1"];
    const params: (string | number)[] = [];
    if (opts.filter === "photos") clauses.push("kind = 'image'");
    if (opts.filter === "files") clauses.push("kind IN ('file', 'scan', 'audio')");
    if (opts.filter === "from_poke") clauses.push("origin = 'poke'");
    if (opts.query) {
      clauses.push("name LIKE ?");
      params.push(`%${opts.query}%`);
    }
    if (opts.before !== undefined) {
      clauses.push("created_at < ?");
      params.push(opts.before);
    }
    return this.db
      .all(
        `SELECT * FROM attachments WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
        ...params,
        opts.limit,
      )
      .map(attachmentFromRow);
  }
  attachToMessage(ids: string[], messageId: string): void {
    for (const id of ids) this.db.run("UPDATE attachments SET message_id = ? WHERE id = ?", messageId, id);
  }
}

export class SqliteSettings implements SettingsRepository {
  constructor(private readonly db: SqliteDb) {}
  get<T>(key: string): T | undefined {
    const row = this.db.get("SELECT value FROM settings WHERE key = ?", key);
    return row ? parse<T>(row.value) : undefined;
  }
  set(key: string, value: unknown): void {
    this.db.run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      json(value),
    );
  }
  delete(key: string): void {
    this.db.run("DELETE FROM settings WHERE key = ?", key);
  }
  all(): Record<string, unknown> {
    return Object.fromEntries(
      this.db
        .all("SELECT key, value FROM settings ORDER BY key")
        .map((row) => [String(row.key), parse(row.value)]),
    );
  }
}

function assignmentFromRow(row: Row): ModelAssignment {
  const assignment: ModelAssignment = {
    role: String(row.role) as Role,
    provider: String(row.provider),
    model: String(row.model),
    updatedAt: Number(row.updated_at),
  };
  setOpt(assignment, "reasoning", s(row.reasoning));
  setOpt(assignment, "voiceReasoning", s(row.voice_reasoning));
  setOpt(assignment, "dimensions", n(row.dimensions));
  return assignment;
}

export class SqliteModelAssignments implements ModelAssignmentRepository {
  constructor(private readonly db: SqliteDb) {}
  get(role: Role): ModelAssignment | undefined {
    const row = this.db.get("SELECT * FROM model_assignments WHERE role = ?", role);
    return row ? assignmentFromRow(row) : undefined;
  }
  set(a: ModelAssignment): void {
    this.db.run(
      `INSERT INTO model_assignments (role, provider, model, reasoning, voice_reasoning, dimensions, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(role) DO UPDATE SET provider = excluded.provider, model = excluded.model, reasoning = excluded.reasoning,
         voice_reasoning = excluded.voice_reasoning, dimensions = excluded.dimensions, updated_at = excluded.updated_at`,
      a.role,
      a.provider,
      a.model,
      nul(a.reasoning),
      nul(a.voiceReasoning),
      nul(a.dimensions),
      a.updatedAt,
    );
  }
  unset(role: Role): void {
    this.db.run("DELETE FROM model_assignments WHERE role = ?", role);
  }
  all(): ModelAssignment[] {
    return this.db.all("SELECT * FROM model_assignments ORDER BY role").map(assignmentFromRow);
  }
}

function compactionFromRow(row: Row): CompactionRecord {
  const record: CompactionRecord = {
    id: String(row.id),
    sessionKind: String(row.session_kind) as CompactionRecord["sessionKind"],
    sessionRef: String(row.session_ref),
    trigger: String(row.trigger) as CompactionRecord["trigger"],
    preTokens: Number(row.pre_tokens),
    runtime: String(row.runtime) as CompactionRecord["runtime"],
    model: String(row.model),
    createdAt: Number(row.created_at),
  };
  setOpt(record, "postTokens", n(row.post_tokens));
  setOpt(record, "summary", s(row.summary));
  return record;
}

export class SqliteCompactions implements CompactionRepository {
  constructor(private readonly db: SqliteDb) {}
  save(r: CompactionRecord): void {
    this.db.run(
      `INSERT INTO compactions (id, session_kind, session_ref, trigger, pre_tokens, post_tokens, runtime, model, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET post_tokens = excluded.post_tokens, summary = excluded.summary`,
      r.id,
      r.sessionKind,
      r.sessionRef,
      r.trigger,
      r.preTokens,
      nul(r.postTokens),
      r.runtime,
      r.model,
      nul(r.summary),
      r.createdAt,
    );
  }
  latest(sessionKind: CompactionRecord["sessionKind"], sessionRef?: string): CompactionRecord | undefined {
    const row =
      sessionRef === undefined
        ? this.db.get(
            "SELECT * FROM compactions WHERE session_kind = ? ORDER BY created_at DESC LIMIT 1",
            sessionKind,
          )
        : this.db.get(
            "SELECT * FROM compactions WHERE session_kind = ? AND session_ref = ? ORDER BY created_at DESC LIMIT 1",
            sessionKind,
            sessionRef,
          );
    return row ? compactionFromRow(row) : undefined;
  }
  list(limit: number): CompactionRecord[] {
    return this.db
      .all("SELECT * FROM compactions ORDER BY created_at DESC LIMIT ?", limit)
      .map(compactionFromRow);
  }
}

export class SqliteUsage implements UsageRepository {
  constructor(private readonly db: SqliteDb) {}
  record(
    row: Omit<UsageRow, "requests" | "errors" | "latencyMs"> & { error?: boolean; latencyMs?: number },
  ): void {
    this.db.run(
      `INSERT INTO usage (day, role, provider, model, requests, input, output, cache_read, cache_write, cost_usd, errors, latency_ms)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day, role, provider, model) DO UPDATE SET requests = requests + 1, input = input + excluded.input,
         output = output + excluded.output, cache_read = cache_read + excluded.cache_read,
         cache_write = cache_write + excluded.cache_write, cost_usd = cost_usd + excluded.cost_usd,
         errors = errors + excluded.errors, latency_ms = latency_ms + excluded.latency_ms`,
      row.day,
      row.role,
      row.provider,
      row.model,
      row.input,
      row.output,
      row.cacheRead,
      row.cacheWrite,
      row.costUsd,
      row.error ? 1 : 0,
      Math.round(row.latencyMs ?? 0),
    );
  }
  since(day: string): UsageRow[] {
    return this.db.all("SELECT * FROM usage WHERE day >= ? ORDER BY day, role", day).map((row) => ({
      day: String(row.day),
      role: String(row.role),
      provider: String(row.provider),
      model: String(row.model),
      requests: Number(row.requests),
      input: Number(row.input),
      output: Number(row.output),
      cacheRead: Number(row.cache_read),
      cacheWrite: Number(row.cache_write),
      costUsd: Number(row.cost_usd),
      errors: Number(row.errors),
      latencyMs: Number(row.latency_ms),
    }));
  }
}

function approvalFromRow(row: Row): ApprovalRequest {
  const request: ApprovalRequest = {
    id: String(row.id),
    integration: String(row.integration),
    tool: String(row.tool),
    title: String(row.title),
    details: parse(row.details),
    args: parse(row.args),
    argsHash: String(row.args_hash),
    resume: parse(row.resume),
    requester: parse(row.requester),
    status: String(row.status) as ApprovalRequest["status"],
    createdAt: Number(row.created_at),
  };
  setOpt(request, "reason", s(row.reason));
  setOpt(request, "ruleId", s(row.rule_id));
  setOpt(request, "decidedAt", n(row.decided_at));
  setOpt(request, "presentation", optJson(row.presentation));
  setOpt(request, "offer", optJson(row.offer));
  return request;
}

export class SqliteApprovals implements ApprovalRepository {
  constructor(private readonly db: SqliteDb) {}
  save(r: ApprovalRequest): void {
    this.db.run(
      `INSERT INTO approvals (id, integration, tool, title, details, reason, args, args_hash, resume, requester, status, rule_id,
         created_at, decided_at, presentation, offer)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, rule_id = excluded.rule_id, decided_at = excluded.decided_at`,
      r.id,
      r.integration,
      r.tool,
      r.title,
      json(r.details),
      nul(r.reason),
      json(r.args),
      r.argsHash,
      json(r.resume),
      json(r.requester),
      r.status,
      nul(r.ruleId),
      r.createdAt,
      nul(r.decidedAt),
      r.presentation ? json(r.presentation) : null,
      r.offer ? json(r.offer) : null,
    );
  }
  get(id: string): ApprovalRequest | undefined {
    const row = this.db.get("SELECT * FROM approvals WHERE id = ?", id);
    return row ? approvalFromRow(row) : undefined;
  }
  pending(): ApprovalRequest[] {
    return this.db
      .all("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at")
      .map(approvalFromRow);
  }
  saveRule(rule: ApprovalRule): void {
    this.db.run(
      `INSERT INTO approval_rules (id, integration, tool, constraint_logic, description, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET constraint_logic = excluded.constraint_logic, description = excluded.description`,
      rule.id,
      rule.integration,
      rule.tool,
      rule.constraint === undefined ? null : json(rule.constraint),
      rule.description,
      rule.createdAt,
    );
  }
  rules(): ApprovalRule[] {
    return this.db.all("SELECT * FROM approval_rules ORDER BY created_at").map((row) => {
      const rule: ApprovalRule = {
        id: String(row.id),
        integration: String(row.integration),
        tool: String(row.tool),
        description: String(row.description),
        createdAt: Number(row.created_at),
      };
      const constraint = optJson<unknown>(row.constraint_logic);
      if (constraint !== undefined && constraint !== null) rule.constraint = constraint;
      return rule;
    });
  }
  deleteRule(id: string): boolean {
    return this.db.run("DELETE FROM approval_rules WHERE id = ?", id).changes > 0;
  }
  logDecision(entry: {
    approvalId: string;
    decision: string;
    argsHash: string;
    ruleId?: string;
    at: number;
  }): void {
    this.db.run(
      "INSERT INTO approval_log (approval_id, decision, args_hash, rule_id, at) VALUES (?, ?, ?, ?, ?)",
      entry.approvalId,
      entry.decision,
      entry.argsHash,
      nul(entry.ruleId),
      entry.at,
    );
  }
}

export class SqliteIntegrations implements IntegrationRepository {
  constructor(private readonly db: SqliteDb) {}
  save(integration: Integration): void {
    this.db.run(
      "INSERT INTO integrations (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
      integration.id,
      json(integration),
      Date.now(),
    );
  }
  get(id: string): Integration | undefined {
    const row = this.db.get("SELECT data FROM integrations WHERE id = ?", id);
    return row ? parse<Integration>(row.data) : undefined;
  }
  list(): Integration[] {
    return this.db
      .all("SELECT data FROM integrations ORDER BY id")
      .map((row) => parse<Integration>(row.data));
  }
  delete(id: string): boolean {
    return this.db.run("DELETE FROM integrations WHERE id = ?", id).changes > 0;
  }
  saveMcpServer(server: McpServerConfig): void {
    this.db.run(
      "INSERT INTO mcp_servers (id, data, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
      server.id,
      json(server),
      server.createdAt,
    );
  }
  mcpServers(): McpServerConfig[] {
    return this.db
      .all("SELECT data FROM mcp_servers ORDER BY created_at")
      .map((row) => parse<McpServerConfig>(row.data));
  }
  deleteMcpServer(id: string): boolean {
    return this.db.run("DELETE FROM mcp_servers WHERE id = ?", id).changes > 0;
  }
}

export class SqliteSessions implements SessionRepository {
  constructor(private readonly db: SqliteDb) {}
  get(key: string): SessionRecord | undefined {
    const row = this.db.get("SELECT * FROM sessions WHERE key = ?", key);
    if (!row) return undefined;
    const record: SessionRecord = {
      key: String(row.key),
      runtime: String(row.runtime) as SessionRecord["runtime"],
      ref: String(row.ref),
      model: String(row.model),
      lastActivityAt: Number(row.last_activity_at),
      updatedAt: Number(row.updated_at),
    };
    setOpt(record, "contextTokens", n(row.context_tokens));
    setOpt(record, "cacheLifetime", opt<string>(row.cache_lifetime));
    return record;
  }
  save(r: SessionRecord): void {
    this.db.run(
      `INSERT INTO sessions (key, runtime, ref, model, context_tokens, cache_lifetime, last_activity_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET runtime = excluded.runtime, ref = excluded.ref, model = excluded.model,
         context_tokens = excluded.context_tokens, cache_lifetime = excluded.cache_lifetime,
         last_activity_at = excluded.last_activity_at, updated_at = excluded.updated_at`,
      r.key,
      r.runtime,
      r.ref,
      r.model,
      nul(r.contextTokens),
      nul(r.cacheLifetime),
      r.lastActivityAt,
      r.updatedAt,
    );
  }
  delete(key: string): void {
    this.db.run("DELETE FROM sessions WHERE key = ?", key);
  }
}

export function createRepositories(db: SqliteDb): Repositories {
  return {
    uow: { transaction: (fn) => db.transaction(fn) },
    events: new SqliteEvents(db),
    messages: new SqliteMessages(db),
    blocks: new SqliteBlocks(db),
    tasks: new SqliteTasks(db),
    steps: new SqliteSteps(db),
    traces: new SqliteTraces(db),
    routines: new SqliteRoutines(db),
    skills: new SqliteSkills(db),
    devices: new SqliteDevices(db),
    attachments: new SqliteAttachments(db),
    settings: new SqliteSettings(db),
    models: new SqliteModelAssignments(db),
    compactions: new SqliteCompactions(db),
    usage: new SqliteUsage(db),
    approvals: new SqliteApprovals(db),
    integrations: new SqliteIntegrations(db),
    sessions: new SqliteSessions(db),
  };
}
