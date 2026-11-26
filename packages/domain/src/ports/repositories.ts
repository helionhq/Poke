import type { Block } from "../block.js";
import type { CompactionRecord } from "../context.js";
import type { Device, PairingCode } from "../device.js";
import type { PersistedEvent, StoredEvent } from "../events.js";
import type { ApprovalRequest, ApprovalRule, Integration, McpServerConfig } from "../integration.js";
import type { Attachment, LibraryFilter } from "../library.js";
import type { ModelAssignment, Role } from "../models.js";
import type { Routine, RoutineRun } from "../routine.js";
import type { Skill } from "../skill.js";
import type { Step, Task, Trace } from "../task.js";
import type { Message } from "../thread.js";

/**
 * Repositories are synchronous: poke.db is an embedded SQLite database owned by one process, and
 * synchronous calls make "save entity + append event" a single transaction.
 */
export interface UnitOfWork {
  transaction<T>(fn: () => T): T;
}

export interface EventRepository {
  append(event: PersistedEvent, at: number): StoredEvent;
  since(seq: number, limit: number): StoredEvent[];
  latestSeq(): number;
}

export interface MessagePage {
  messages: Message[];
  /** Cursor for older messages (createdAt of the oldest returned), undefined at the start. */
  before?: string;
}

export interface MessageSearchHit {
  message: Message;
  /** Text with matches wrapped in «…». */
  highlight: string;
  rank: number;
}

export interface MessageRepository {
  /** extraSearchText: text from blocks in the message (draft bodies) so Search finds it. */
  save(message: Message, extraSearchText?: string): void;
  get(id: string): Message | undefined;
  byClientMessageId(clientMessageId: string): Message | undefined;
  page(opts: { before?: string; limit: number }): MessagePage;
  around(id: string, radius: number): Message[];
  /** Messages created after a point in time (for digests). */
  recent(limit: number): Message[];
  count(): number;
  first(): Message | undefined;
  search(opts: {
    query: string;
    before?: number;
    after?: number;
    limit: number;
    roles?: string[];
  }): MessageSearchHit[];
}

export interface BlockRepository {
  save(block: Block): void;
  get(id: string): Block | undefined;
  byMessage(messageId: string): Block[];
  pending(): Block[];
}

export interface TaskRepository {
  save(task: Task): void;
  get(id: string): Task | undefined;
  byName(name: string): Task | undefined;
  active(): Task[];
  recent(limit: number): Task[];
}

export interface StepRepository {
  save(step: Step): void;
  get(id: string): Step | undefined;
  byTrace(traceId: string): Step[];
  byTask(taskId: string): Step[];
}

export interface TraceRepository {
  save(trace: Trace): void;
  get(id: string): Trace | undefined;
  byTask(taskId: string): Trace | undefined;
}

export interface RoutineRepository {
  save(routine: Routine): void;
  get(id: string): Routine | undefined;
  list(): Routine[];
  delete(id: string): boolean;
  due(now: number): Routine[];
  saveRun(run: RoutineRun): void;
  runs(routineId: string, limit: number): RoutineRun[];
  getRun(id: string): RoutineRun | undefined;
}

export interface SkillRepository {
  save(skill: Skill): void;
  get(name: string): Skill | undefined;
  list(): Skill[];
  delete(name: string): boolean;
}

export interface DeviceRepository {
  save(device: Device): void;
  get(id: string): Device | undefined;
  byTokenHash(hash: string): Device | undefined;
  list(): Device[];
  savePairingCode(code: PairingCode): void;
  pairingCode(codeHash: string): PairingCode | undefined;
  /** All live (unused, unexpired) codes, for rate limiting. */
  livePairingCodes(now: number): PairingCode[];
}

export interface AttachmentRepository {
  save(attachment: Attachment): void;
  get(id: string): Attachment | undefined;
  list(opts: { filter: LibraryFilter; query?: string; before?: number; limit: number }): Attachment[];
  attachToMessage(ids: string[], messageId: string): void;
}

export interface SettingsRepository {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  all(): Record<string, unknown>;
}

export interface ModelAssignmentRepository {
  get(role: Role): ModelAssignment | undefined;
  set(assignment: ModelAssignment): void;
  unset(role: Role): void;
  all(): ModelAssignment[];
}

export interface CompactionRepository {
  save(record: CompactionRecord): void;
  latest(sessionKind: CompactionRecord["sessionKind"], sessionRef?: string): CompactionRecord | undefined;
  list(limit: number): CompactionRecord[];
}

export interface UsageRow {
  day: string;
  role: string;
  provider: string;
  model: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  errors: number;
  latencyMs: number;
}

export interface UsageRepository {
  record(
    row: Omit<UsageRow, "requests" | "errors" | "latencyMs"> & { error?: boolean; latencyMs?: number },
  ): void;
  since(day: string): UsageRow[];
}

export interface ApprovalRepository {
  save(request: ApprovalRequest): void;
  get(id: string): ApprovalRequest | undefined;
  pending(): ApprovalRequest[];
  saveRule(rule: ApprovalRule): void;
  rules(): ApprovalRule[];
  deleteRule(id: string): boolean;
  logDecision(entry: {
    approvalId: string;
    decision: string;
    argsHash: string;
    ruleId?: string;
    at: number;
  }): void;
}

export interface IntegrationRepository {
  save(integration: Integration): void;
  get(id: string): Integration | undefined;
  list(): Integration[];
  delete(id: string): boolean;
  saveMcpServer(server: McpServerConfig): void;
  mcpServers(): McpServerConfig[];
  deleteMcpServer(id: string): boolean;
}

/** Runtime session refs (Agent SDK session id, Pi conversation id) — a rebuildable cache. */
export interface SessionRecord {
  key: string;
  runtime: "claude-agent-sdk" | "pi-durable";
  ref: string;
  model: string;
  contextTokens?: number;
  cacheLifetime?: string;
  lastActivityAt: number;
  updatedAt: number;
}

export interface SessionRepository {
  get(key: string): SessionRecord | undefined;
  save(record: SessionRecord): void;
  delete(key: string): void;
}

export interface Repositories {
  uow: UnitOfWork;
  events: EventRepository;
  messages: MessageRepository;
  blocks: BlockRepository;
  tasks: TaskRepository;
  steps: StepRepository;
  traces: TraceRepository;
  routines: RoutineRepository;
  skills: SkillRepository;
  devices: DeviceRepository;
  attachments: AttachmentRepository;
  settings: SettingsRepository;
  models: ModelAssignmentRepository;
  compactions: CompactionRepository;
  usage: UsageRepository;
  approvals: ApprovalRepository;
  integrations: IntegrationRepository;
  sessions: SessionRepository;
}
