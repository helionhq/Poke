import { mkdtempSync, rmSync } from "node:fs";
import { ExecutorClient } from "@poke/integrations-executor";
import { SdkMcpConnector } from "@poke/mcp-bridge";
import { FAKE_MCP_SERVER } from "@poke/mcp-bridge/testing";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentsService,
  ApprovalService,
  BlockService,
  type ConnectionStarter,
  IntegrationService,
  InteractionOrchestrator,
  LoginService,
  MemoryService,
  ModelService,
  SecretRedactor,
  SecretResolver,
  SideChatService,
  text,
  ToolGateway,
  type ApprovalInput,
  type ApprovalOutcome,
} from "@poke/application";
import {
  type CompactionInfo,
  type ConversationRuntime,
  type ConversationSession,
  DomainError,
  type ExecutorEvent,
  type ExecutorRuntime,
  type ExecutorSpec,
  type MemoryPort,
  type ModelCatalog,
  type ModelInfo,
  messageText,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type SessionSpec,
  silentLogger,
  type SystemSecretKey,
  type SystemSecrets,
  type Timers,
  type ToolCallContext,
  type TurnInput,
  type VaultEntry,
  type VaultPort,
  type VaultPutInput,
} from "@poke/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePaths } from "./infra/paths.js";
import { createKernel, type Kernel } from "./kernel.js";

// ── fakes ────────────────────────────────────────────────────────────────────────────────────

type Script = (input: TurnInput, session: FakeSession) => Promise<RuntimeEvent[]> | RuntimeEvent[];

class FakeSession implements ConversationSession {
  turns: TurnInput[] = [];
  steers: TurnInput[] = [];
  compacts: Array<{ trigger: string; instructions?: string }> = [];
  tokens: number | undefined;
  running = false;
  closed = false;
  listeners = new Set<(e: RuntimeEvent) => void>();
  constructor(
    readonly spec: SessionSpec,
    private readonly script: Script,
    readonly ref: string,
  ) {}
  async *startTurn(input: TurnInput): AsyncIterable<RuntimeEvent> {
    this.turns.push(input);
    this.running = true;
    try {
      yield { type: "session", ref: this.ref };
      for (const event of await this.script(input, this)) yield event;
      yield { type: "turn.done" };
    } finally {
      this.running = false;
    }
  }
  async steer(input: TurnInput) {
    if (!this.running) return false;
    this.steers.push(input);
    return true;
  }
  async cancel() {}
  async compact(trigger: "manual" | "idle", instructions?: string): Promise<CompactionInfo | undefined> {
    this.compacts.push({ trigger, ...(instructions ? { instructions } : {}) });
    const preTokens = this.tokens ?? 0;
    this.tokens = 12_000;
    return { preTokens, postTokens: 12_000, summary: "Arham is planning Lisbon." };
  }
  onEvent(listener: (e: RuntimeEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  contextTokens() {
    return this.tokens;
  }
  async close() {
    this.closed = true;
  }
}

class FakeRuntime implements ConversationRuntime {
  sessions: FakeSession[] = [];
  constructor(
    readonly kind: "claude-agent-sdk" | "pi-durable",
    private readonly caps: RuntimeCapabilities,
    public script: Script,
  ) {}
  capabilities() {
    return this.caps;
  }
  async openSession(spec: SessionSpec) {
    const session = new FakeSession(
      spec,
      (i, s) => this.script(i, s),
      spec.resumeRef ?? `${this.kind}-ref-${this.sessions.length + 1}`,
    );
    this.sessions.push(session);
    return session;
  }
}

class FakeExecutors implements ExecutorRuntime {
  started: ExecutorSpec[] = [];
  messages: Array<{ ref: string; text: string; mode: string }> = [];
  cancels: string[] = [];
  needs: Array<{ taskId: string; needId: string; value: unknown }> = [];
  listeners = new Set<(e: ExecutorEvent) => void>();
  async start(spec: ExecutorSpec) {
    this.started.push(spec);
    return { runtimeRef: `conv_${this.started.length}` };
  }
  async message(ref: string, text: string, mode: "steer" | "followup") {
    this.messages.push({ ref, text, mode });
  }
  async cancel(ref: string) {
    this.cancels.push(ref);
  }
  async resolveNeed(taskId: string, needId: string, value: unknown) {
    this.needs.push({ taskId, needId, value });
    return "delivered" as const;
  }
  onEvent(listener: (e: ExecutorEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: ExecutorEvent) {
    for (const l of this.listeners) l(event);
  }
  async resume() {}
  async close() {}
}

class FakeTimers implements Timers {
  pending: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  setTimeout(fn: () => void, ms: number) {
    const entry = { fn, ms, cancelled: false };
    this.pending.push(entry);
    return { cancel: () => void (entry.cancelled = true) };
  }
  live() {
    return this.pending.filter((p) => !p.cancelled);
  }
  fire() {
    const due = this.live();
    this.pending = [];
    for (const p of due) p.fn();
  }
}

/** Just enough vault for blocks: entries with their secret values kept apart. */
class MemoryVault implements Pick<VaultPort, "get" | "put" | "update" | "list" | "resolve" | "markUsed"> {
  entries = new Map<string, VaultEntry>();
  values = new Map<string, Record<string, string>>();
  get = (name: string) => this.entries.get(name);
  list = () => [...this.entries.values()];
  resolve = (name: string, field?: string) => {
    const values = this.values.get(name);
    return values ? (field ? values[field] : Object.values(values)[0]) : undefined;
  };
  markUsed = (name: string, by?: string) => {
    const entry = this.entries.get(name);
    if (entry && by && !entry.usedBy.includes(by)) entry.usedBy.push(by);
  };
  put = (input: VaultPutInput): VaultEntry => {
    const entry: VaultEntry = {
      name: input.name as VaultEntry["name"],
      kind: input.kind,
      fields: input.fields ?? {},
      secretFields: Object.keys(input.secrets),
      usedBy: [],
      ephemeral: input.ephemeral ?? false,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      createdAt: 1,
      updatedAt: 1,
    };
    this.entries.set(input.name, entry);
    this.values.set(input.name, { ...input.secrets });
    return entry;
  };
  update = (name: string, patch: Partial<Omit<VaultPutInput, "name">>): VaultEntry => {
    const entry = this.entries.get(name)!;
    Object.assign(entry.fields, patch.fields ?? {});
    this.values.set(name, { ...this.values.get(name), ...patch.secrets });
    entry.secretFields = Object.keys(this.values.get(name)!);
    return entry;
  };
}

class FakeMemory implements MemoryPort {
  on = false;
  exchanges: Array<{ user?: { text: string; at: number }; poke?: { text: string; at: number } }> = [];
  facts = new Map<string, string>();
  queries: Array<{ query: string; level: string | undefined }> = [];
  card: string | undefined = "- Likes figs\n- Lives in Lisbon";
  available = () => this.on;
  async addExchange(exchange: FakeMemory["exchanges"][number]) {
    this.exchanges.push(exchange);
  }
  async recall(query: string, level?: string) {
    this.queries.push({ query, level });
    return "He likes figs.";
  }
  async remember(fact: string) {
    const ref = `con_${this.facts.size + 1}`;
    this.facts.set(ref, fact);
    return { ref };
  }
  async forget(ref: string) {
    this.facts.delete(ref);
  }
  async peerCard() {
    return this.card;
  }
}

class MemorySecrets implements SystemSecrets {
  map = new Map<SystemSecretKey, string>();
  get = (k: SystemSecretKey) => this.map.get(k);
  set = (k: SystemSecretKey, v: string) => void this.map.set(k, v);
  delete = (k: SystemSecretKey) => void this.map.delete(k);
  has = (k: SystemSecretKey) => this.map.has(k);
  keys = () => [...this.map.keys()];
}

const model = (
  provider: string,
  id: string,
  reasoningLevels: string[],
  contextWindow = 1_000_000,
): ModelInfo => ({
  provider,
  id,
  name: id,
  contextWindow,
  reasoningLevels,
  input: ["text"],
});
const catalog = (models: ModelInfo[]): ModelCatalog => ({
  list: async (p) => models.filter((m) => m.provider === p),
  get: async (p, id) => models.find((m) => m.provider === p && m.id === id),
});
const catalogs = {
  anthropic: catalog([model("anthropic", "claude-opus-5-5", ["low", "medium", "high", "xhigh", "max"])]),
  "qwen-token-plan-individual": catalog([
    model("qwen-token-plan-individual", "qwen3.8-max", ["low", "medium", "xhigh"]),
    model("qwen-token-plan-individual", "glm-5.3", ["low", "high", "max"], 200_000),
  ]),
};

const reply = (text: string, contextTokens = 90_000, cacheLifetime: "1h" | "5m" = "1h"): RuntimeEvent[] => [
  { type: "text.delta", text: text.slice(0, 3) },
  { type: "text.delta", text: text.slice(3) },
  { type: "text.done", text },
  {
    type: "usage",
    usage: {
      provider: "anthropic",
      model: "claude-opus-5-5",
      input: 10,
      output: 5,
      cacheRead: 100,
      cacheWrite: 20,
      cacheLifetime,
    },
    contextTokens,
  },
];

async function until<T>(fn: () => T | undefined | false, ms = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── stack ────────────────────────────────────────────────────────────────────────────────────

let home: string;
let kernel: Kernel;
let now: number;
let timers: FakeTimers;
let claude: FakeRuntime;
let pi: FakeRuntime;
let executors: FakeExecutors;
let models: ModelService;
let agents: AgentsService;
let poke: InteractionOrchestrator;
let gateway: ToolGateway;
let blocks: BlockService;
let approvals: ApprovalService;
let vault: MemoryVault;
let secrets: MemorySecrets;
let live: Array<{ type: string } & Record<string, unknown>>;
/** Integration tests plug their IntegrationService in here. */
let connectStarter: ConnectionStarter["start"];
let fakeMemory: FakeMemory;
let memory: MemoryService;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "poke-agents-"));
  now = 1_800_000_000_000;
  const clock = { now: () => now };
  kernel = createKernel({ paths: resolvePaths(home), clock, dbPath: ":memory:" });
  kernel.settings.set("profile.name", "Arham");
  kernel.settings.set("profile.timezone", "Europe/Lisbon");
  timers = new FakeTimers();
  secrets = new MemorySecrets();
  const redactor = new SecretRedactor(() =>
    [...secrets.map.values()].map((value) => ({ name: "system", value })),
  );
  gateway = new ToolGateway(redactor, silentLogger);
  models = new ModelService(kernel.db, kernel.hub, catalogs, clock);
  executors = new FakeExecutors();
  fakeMemory = new FakeMemory();
  memory = new MemoryService({
    memory: fakeMemory,
    settings: kernel.settings,
    gateway,
    clock,
    log: silentLogger,
    redact: (value) => redactor.redact(value),
  });
  const persona = () => {
    const memoryCard = memory.card();
    return {
      userName: "Arham",
      timezone: "Europe/Lisbon",
      workspace: "/w",
      ...(memoryCard ? { memoryCard } : {}),
    };
  };
  agents = new AgentsService({
    repos: kernel.db,
    hub: kernel.hub,
    ids: kernel.ids,
    clock,
    log: silentLogger,
    runtime: executors,
    models,
    gateway,
    settings: kernel.settings,
    persona,
    workspace: "/w",
  });
  vault = new MemoryVault();
  approvals = new ApprovalService({
    repos: kernel.db,
    hub: kernel.hub,
    ids: kernel.ids,
    clock,
    log: silentLogger,
    agents,
    redact: (value) => value,
  });
  approvals.start();
  blocks = new BlockService({
    repos: kernel.db,
    hub: kernel.hub,
    ids: kernel.ids,
    clock,
    log: silentLogger,
    thread: kernel.thread,
    vault,
    agents,
    approvals,
    connections: { start: (input) => connectStarter(input) },
    memory,
  });
  blocks.start();
  memory.start();
  connectStarter = () =>
    Promise.reject(new DomainError("unavailable", "Apps can't be connected from here yet"));
  const caps = (idleCompaction: RuntimeCapabilities["idleCompaction"]): RuntimeCapabilities => ({
    steering: true,
    idleCompaction,
    toolSearch: true,
    codemode: false,
  });
  claude = new FakeRuntime("claude-agent-sdk", caps("command"), () => reply("hey! on it"));
  pi = new FakeRuntime("pi-durable", caps("api"), () => reply("hello from qwen"));
  poke = new InteractionOrchestrator({
    repos: kernel.db,
    hub: kernel.hub,
    ids: kernel.ids,
    clock,
    timers,
    log: silentLogger,
    thread: kernel.thread,
    attachments: kernel.attachments,
    settings: kernel.settings,
    models,
    runtimes: { "claude-agent-sdk": claude, "pi-ai": pi },
    gateway,
    agents,
    blocks,
    presence: kernel.presence,
    persona,
    workspace: "/w",
    skillsDir: "/s",
    memory,
  });
  poke.start();
  live = [];
  kernel.hub.subscribe((frame) => {
    if (frame.kind === "live") live.push(frame.event as never);
  });
});

afterEach(async () => {
  memory.close();
  await poke.close();
  kernel.close();
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
const say = (text: string) =>
  kernel.thread.send({ text, clientMessageId: `c${++n}`, attachmentIds: [] }).message;
const pokeMessages = () => kernel.db.messages.recent(50).filter((m) => m.role === "poke");
const notes = () =>
  kernel.db.messages
    .recent(50)
    .filter((m) => m.role === "system")
    .map(messageText);
const idle = () => until(() => !poke.busy);

const setPoke = (provider = "anthropic", id = "claude-opus-5-5") =>
  models.set({ role: "poke", provider, model: id, reasoning: provider === "anthropic" ? "high" : "low" });

// ── tests ────────────────────────────────────────────────────────────────────────────────────

describe("models and logins", () => {
  it("keeps the subscription to Poke and Side chat, and validates models and reasoning", async () => {
    await expect(
      models.set({ role: "agents", provider: "anthropic", model: "claude-opus-5-5" }),
    ).rejects.toThrow(/only for the Poke and Side chat/);
    await expect(models.set({ role: "poke", provider: "anthropic", model: "claude-nope" })).rejects.toThrow(
      /no model claude-nope. Try: claude-opus-5-5/,
    );
    await expect(
      models.set({ role: "poke", provider: "anthropic", model: "claude-opus-5-5", reasoning: "turbo" }),
    ).rejects.toThrow(/supports reasoning low, medium/);
    await expect(
      models.set({
        role: "agents",
        provider: "qwen-token-plan-individual",
        model: "qwen3.8-max",
        voiceReasoning: "low",
      }),
    ).rejects.toThrow(/Poke role only/);
    await expect(
      models.set({ role: "boss", provider: "anthropic", model: "claude-opus-5-5" }),
    ).rejects.toThrow(/Unknown role/);
    const set = await models.set({
      role: "agents",
      provider: "qwen-token-plan-individual",
      model: "qwen3.8-max",
      reasoning: "xhigh",
    });
    expect(set).toMatchObject({
      role: "agents",
      provider: "qwen-token-plan-individual",
      model: "qwen3.8-max",
      reasoning: "xhigh",
    });
    expect(kernel.hub.since(0, 100).some((e) => e.event.type === "models.updated")).toBe(true);
    models.unset("agents");
    expect(models.get("agents")).toBeUndefined();
  });

  it("validates a login before saving it", async () => {
    const logins = new LoginService(secrets, {
      qwen: async (key) => (key === "good-key-123" ? { ok: true } : { ok: false, error: "Qwen said 401" }),
    });
    await expect(logins.login("qwen", "bad-key-123")).rejects.toThrow(/401/);
    expect(secrets.has("qwen.apiKey")).toBe(false);
    await logins.login("qwen", "  good-key-123 ");
    expect(secrets.get("qwen.apiKey")).toBe("good-key-123");
    expect(logins.secretFor("qwen-token-plan-individual")).toBe("good-key-123");
    expect(logins.list().find((l) => l.id === "qwen")).toMatchObject({
      loggedIn: true,
      providers: ["qwen-token-plan-individual"],
    });
    expect(logins.logout("qwen")).toBe(true);
    await expect(logins.login("openai", "x-123456")).rejects.toThrow(/Unknown login/);
  });
});

describe("Poke turns", () => {
  it("posts one system note when no model is set, and answers once one is", async () => {
    say("hello?");
    say("anyone?");
    await until(() => notes().length > 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(notes()).toEqual(["Poke has no model yet. Run `poke model` on Poke's machine."]);
    await setPoke();
    await until(() => pokeMessages().length === 1);
    await idle();
    expect(claude.sessions[0]!.turns).toHaveLength(1);
    expect(claude.sessions[0]!.turns[0]!.text).toMatch(/^hello\?\n\nanyone\?\n\n<context>/);
  });

  it("streams a reply into one message, records usage and remembers the session", async () => {
    await setPoke();
    say("hi");
    await until(() => pokeMessages().find((m) => m.status === "complete"));
    const [message] = pokeMessages();
    expect(messageText(message!)).toBe("hey! on it");
    expect(live.filter((e) => e.type === "message.delta").map((e) => e.text)).toEqual(["hey", "! on it"]);
    expect(kernel.db.sessions.get("poke")).toMatchObject({
      runtime: "claude-agent-sdk",
      ref: "claude-agent-sdk-ref-1",
      contextTokens: 90_000,
      cacheLifetime: "1h",
    });
    expect(kernel.db.usage.since("2000-01-01")[0]).toMatchObject({
      role: "poke",
      provider: "anthropic",
      requests: 1,
    });
    const turn = claude.sessions[0]!.turns[0]!.text;
    expect(turn).toMatch(/^hi\n\n<context>\ntime: .*Europe\/Lisbon/);
    expect(claude.sessions[0]!.spec).toMatchObject({ profile: "poke", budget: 272_000, persist: true });
    expect(claude.sessions[0]!.spec.tools.map((t) => t.name).sort()).toEqual([
      "ask_choices",
      "cancel_agent",
      "list_agents",
      "propose_action",
      "recall",
      "remember",
      "request_connection",
      "request_secret",
      "search_thread",
      "send_to_agent",
      "show_card",
      "show_draft",
      "wait",
    ]);
  });

  it("steers a running turn with a new message instead of queueing it", async () => {
    await setPoke();
    let release!: () => void;
    claude.script = async () => {
      await new Promise<void>((r) => (release = r));
      return reply("done both");
    };
    say("first");
    await until(() => claude.sessions[0]?.running);
    say("and also this");
    await until(() => claude.sessions[0]!.steers.length === 1);
    release();
    await idle();
    expect(claude.sessions[0]!.turns).toHaveLength(1);
    expect(claude.sessions[0]!.steers[0]!.text).toMatch(/^and also this/);
  });

  it("resumes the stored session, and rebuilds from a digest after switching runtime", async () => {
    await setPoke();
    say("we're going to Lisbon in May");
    await idle();
    await until(() => pokeMessages().length === 1);
    expect(claude.sessions[0]!.spec.resumeRef).toBeUndefined();
    await setPoke("qwen-token-plan-individual", "glm-5.3");
    say("which neighbourhood?");
    await until(() => pi.sessions[0]?.turns.length === 1);
    await idle();
    expect(claude.sessions[0]!.closed).toBe(true);
    const spec = pi.sessions[0]!.spec;
    expect(spec.resumeRef).toBeUndefined();
    expect(spec.digest).toContain("Arham: we're going to Lisbon in May");
    expect(spec.digest).toContain("Poke: hey! on it");
    expect(spec.budget).toBe(200_000); // clamped to the model's window
    expect(kernel.db.sessions.get("poke")).toMatchObject({ runtime: "pi-durable" });
  });
});

describe("agents", () => {
  async function startAgentTurn() {
    await setPoke();
    await models.set({
      role: "agents",
      provider: "qwen-token-plan-individual",
      model: "qwen3.8-max",
      reasoning: "medium",
    });
    let result: unknown;
    claude.script = async (_input, session) => {
      result = await session.spec.invoker.invoke(
        "send_to_agent",
        {
          name: "lisbon-stays",
          goal: "Find three stays in Príncipe Real under €200",
          context: "May 12–15, two people",
        },
        { agent: { kind: "poke" }, callId: "c1", signal: new AbortController().signal },
      );
      return reply("On it — looking now.");
    };
    say("find us somewhere to stay in Lisbon");
    await until(() => result);
    await idle();
    return () => result as { output: Array<{ text: string }>; isError?: boolean };
  }

  it("starts an executor with a trace, records steps, and puts Poke's answer under the trace", async () => {
    const result = await startAgentTurn();
    expect(result().isError).toBeUndefined();
    const { agentId } = JSON.parse(result().output[0]!.text) as { agentId: string };
    const task = kernel.db.tasks.get(agentId)!;
    expect(task).toMatchObject({ name: "lisbon-stays", status: "running", runtimeRef: "conv_1" });
    const spec = executors.started[0]!;
    expect(spec.model).toMatchObject({ role: "agents", model: "qwen3.8-max" });
    expect(spec.firstTurn).toContain("<goal>\nFind three stays");
    expect(spec.firstTurn).toContain("<background>\nMay 12–15");
    expect(spec.tools.map((t) => t.name).sort()).toEqual(["ask_poke", "recall", "report_progress"]);
    expect(spec.systemPrompt).toContain("You are an execution agent working for Poke, Arham's assistant");

    const trace = kernel.db.traces.get(task.traceId)!;
    const holder = kernel.thread.get(trace.messageId)!;
    expect(holder.parts).toEqual([{ type: "trace", traceId: trace.id }]);

    executors.emit({
      type: "step.started",
      taskId: task.id,
      callId: "s1",
      name: "bash",
      args: { command: "curl airbnb" },
    });
    executors.emit({
      type: "step.completed",
      taskId: task.id,
      callId: "s1",
      name: "bash",
      isError: false,
      excerpt: "3 results",
    });
    executors.emit({
      type: "step.started",
      taskId: task.id,
      callId: "s2",
      name: "report_progress",
      args: { text: "x" },
    });
    const steps = kernel.db.steps.byTask(task.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      tool: "bash",
      status: "done",
      detail: "3 results",
      app: { id: "terminal" },
    });
    expect(kernel.db.traces.get(trace.id)).toMatchObject({
      toolCount: 1,
      status: "running",
      apps: [{ id: "terminal" }],
    });

    claude.script = (input) => {
      expect(input.text).toContain(`<agent_report agent="lisbon-stays" id="${task.id}">`);
      return reply("Found three: Memmo, Lumiares and Casa do Príncipe.");
    };
    executors.emit({ type: "report", taskId: task.id, text: "1. Memmo …" });
    await until(() => messageText(kernel.thread.get(trace.messageId)!).length > 0);
    await idle();
    const after = kernel.thread.get(trace.messageId)!;
    expect(after.parts[0]).toEqual({ type: "trace", traceId: trace.id });
    expect(messageText(after)).toBe("Found three: Memmo, Lumiares and Casa do Príncipe.");
    expect(after.status).toBe("complete");
    expect(kernel.db.tasks.get(task.id)).toMatchObject({ status: "completed", result: "1. Memmo …" });
    expect(kernel.db.traces.get(trace.id)).toMatchObject({ status: "done" });
  });

  it("tells Poke when there's no Agents model", async () => {
    await setPoke();
    let result: { output: Array<{ text: string }>; isError?: boolean } | undefined;
    claude.script = async (_i, session) => {
      result = (await session.spec.invoker.invoke(
        "send_to_agent",
        { name: "x", goal: "y" },
        { agent: { kind: "poke" }, callId: "c", signal: new AbortController().signal },
      )) as never;
      return reply("hmm");
    };
    say("do a thing");
    await idle();
    await until(() => result);
    expect(result!.isError).toBe(true);
    expect(result!.output[0]!.text).toMatch(/No Agents model is set/);
    expect(executors.started).toHaveLength(0);
  });

  it("parks on ask_poke and resumes when Poke answers by messaging the agent", async () => {
    const result = await startAgentTurn();
    const { agentId } = JSON.parse(result().output[0]!.text) as { agentId: string };
    const invoker = gateway.invoker("executor");
    claude.script = (input) => {
      expect(input.text).toContain("<agent_question");
      expect(input.text).toContain("Which dates exactly?");
      return [];
    };
    const parked = await invoker.invoke(
      "ask_poke",
      { kind: "question", question: "Which dates exactly?", options: ["12–15", "13–16"] },
      { agent: { kind: "executor", taskId: agentId }, callId: "q1", signal: new AbortController().signal },
    );
    expect(parked.park?.needId).toMatch(/^need_/);
    expect(kernel.db.tasks.get(agentId)).toMatchObject({
      status: "waiting",
      need: { kind: "question", question: "Which dates exactly?" },
    });
    await until(() => claude.sessions[0]!.turns.length === 2);
    await idle();

    claude.script = async (_i, session) => {
      await session.spec.invoker.invoke(
        "send_to_agent",
        { agentId, name: "lisbon-stays", goal: "12–15 May" },
        { agent: { kind: "poke" }, callId: "c9", signal: new AbortController().signal },
      );
      return [];
    };
    say("12–15");
    await until(() => executors.needs.length === 1);
    expect(executors.needs[0]).toEqual({
      taskId: agentId,
      needId: parked.park!.needId,
      value: { answer: "12–15 May" },
    });
    expect(kernel.db.tasks.get(agentId)).toMatchObject({ status: "running" });
    const resumed = await invoker.invoke(
      "ask_poke",
      { kind: "question", question: "Which dates exactly?" },
      {
        agent: { kind: "executor", taskId: agentId },
        callId: "q1",
        signal: new AbortController().signal,
        resume: { needId: parked.park!.needId, value: { answer: "12–15 May" } },
      },
    );
    expect(resumed.output[0]).toEqual({ type: "text", text: "Answer: 12–15 May" });
  });

  it("cancels quietly and redacts secrets from tool output", async () => {
    secrets.map.set("qwen.apiKey", "sk-live-abcdef123456");
    const result = await startAgentTurn();
    const { agentId } = JSON.parse(result().output[0]!.text) as { agentId: string };
    const cancelled = await gateway.invoke(
      "poke",
      "cancel_agent",
      { agentId: "lisbon-stays" },
      { agent: { kind: "poke" }, callId: "x", signal: new AbortController().signal },
    );
    expect(JSON.parse(cancelled.output[0]!.type === "text" ? cancelled.output[0]!.text : "")).toMatchObject({
      status: "cancelled",
    });
    expect(executors.cancels).toEqual(["conv_1"]);
    const turns = claude.sessions[0]!.turns.length;
    executors.emit({ type: "failed", taskId: agentId, error: "aborted", kind: "cancelled" });
    await new Promise((r) => setTimeout(r, 20));
    expect(claude.sessions[0]!.turns.length).toBe(turns);
    const listed = await gateway.invoke(
      "poke",
      "list_agents",
      { includeFinished: true },
      { agent: { kind: "poke" }, callId: "y", signal: new AbortController().signal },
    );
    expect(listed.output[0]).toMatchObject({ type: "text" });
    const leaked = await gateway.invoke(
      "poke",
      "search_thread",
      { query: "sk-live-abcdef123456" },
      { agent: { kind: "poke" }, callId: "z", signal: new AbortController().signal },
    );
    expect(JSON.stringify(leaked)).not.toContain("sk-live-abcdef123456");
  });

  const signal = () => new AbortController().signal;
  const secretArgs = {
    kind: "secret",
    service: "Resy",
    fields: { email: "dinners@fastmail.com" },
    secret: { label: "Password", type: "password" },
    vaultName: "resy.login",
    reason: "To book Lilia on Friday",
  };

  it("shows an agent's secret need as a block, puts the value only in the vault, and resumes the agent", async () => {
    const result = await startAgentTurn();
    const { agentId } = JSON.parse(result().output[0]!.text) as { agentId: string };
    await idle();
    const invoker = gateway.invoker("executor");
    const inputs: string[] = [];
    claude.script = (input) => {
      inputs.push(input.text);
      return reply("Lilia needs your Resy password to book.");
    };
    const ctx = { agent: { kind: "executor" as const, taskId: agentId }, callId: "s1", signal: signal() };
    const parked = await invoker.invoke("ask_poke", secretArgs, ctx);
    const needId = parked.park!.needId;
    await until(() => inputs.length === 1);
    await idle();
    expect(inputs[0]).toContain("<agent_needs_secret");
    expect(inputs[0]).toContain("Resy: Password");

    // The block sits under Poke's reply about it.
    const holder = pokeMessages().find((m) => m.parts.some((p) => p.type === "block"))!;
    expect(messageText(holder)).toBe("Lilia needs your Resy password to book.");
    const part = holder.parts.find((p) => p.type === "block")!;
    const block = blocks.get(part.type === "block" ? part.blockId : "");
    expect(block).toMatchObject({
      kind: "secret_request",
      state: "pending",
      owner: { type: "task", taskId: agentId, needId },
      props: {
        title: "Resy login",
        field: "Password",
        vaultName: "resy.login",
        known: [
          { label: "Service", value: "Resy" },
          { label: "Email", value: "dinners@fastmail.com" },
        ],
      },
    });

    const secret = "correct-horse-battery-staple";
    const acted = await blocks.act(block.id, {
      action: "save",
      payload: { value: secret },
      clientActionId: "act-00001",
    });
    const placeholder = "{{vault:resy.login.password}}";
    expect(acted.block).toMatchObject({
      state: "saved",
      fallback: "Resy login ✓ Saved to your Vault",
      resolution: { status: "saved", vaultName: "resy.login", placeholder },
    });
    expect(vault.values.get("resy.login")).toEqual({ password: secret });
    expect(vault.get("resy.login")).toMatchObject({
      kind: "login",
      fields: { service: "Resy", email: "dinners@fastmail.com" },
    });
    expect(executors.needs.at(-1)).toEqual({
      taskId: agentId,
      needId,
      value: { status: "saved", vaultName: "resy.login", placeholder },
    });
    expect(kernel.db.tasks.get(agentId)).toMatchObject({ status: "running" });

    // The value is nowhere but the vault: not in messages, blocks, the event log or the action log.
    const everywhere = JSON.stringify([
      kernel.db.messages.recent(100),
      kernel.db.blocks.byTask(agentId),
      kernel.db.events.since(0, 1000),
      kernel.db.blocks.findAction("act-00001"),
      live,
      inputs,
    ]);
    expect(everywhere).not.toContain(secret);

    // A retry gets the same answer without acting twice; a reused id for something else is refused.
    const again = await blocks.act(block.id, {
      action: "save",
      payload: { value: secret },
      clientActionId: "act-00001",
    });
    expect(again.duplicate).toBe(true);
    expect(executors.needs).toHaveLength(1);
    await expect(
      blocks.act(block.id, { action: "expire", clientActionId: "act-00001" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      blocks.act(block.id, { action: "save", payload: { value: "x" }, clientActionId: "act-00002" }),
    ).rejects.toMatchObject({ code: "conflict" });

    const resumed = await invoker.invoke("ask_poke", secretArgs, {
      ...ctx,
      resume: { needId, value: executors.needs[0]!.value },
    });
    expect(resumed.output[0]).toMatchObject({ type: "text" });
    expect(resumed.output[0]!.type === "text" && resumed.output[0]!.text).toContain(placeholder);
  });

  it("refuses an incomplete need, and expires a need's block when its agent is cancelled", async () => {
    const result = await startAgentTurn();
    const { agentId } = JSON.parse(result().output[0]!.text) as { agentId: string };
    await idle();
    const invoker = gateway.invoker("executor");
    const ctx = { agent: { kind: "executor" as const, taskId: agentId }, callId: "n1", signal: signal() };
    const bad = await invoker.invoke("ask_poke", { kind: "secret", service: "Resy" }, ctx);
    expect(bad.isError).toBe(true);

    claude.script = () => reply("It needs Notion to find the notes.");
    await invoker.invoke(
      "ask_poke",
      { kind: "connection", app: "notion", appName: "Notion", reason: "To find the design review notes" },
      { ...ctx, callId: "n2" },
    );
    await idle();
    const block = kernel.db.blocks.byTask(agentId)[0]!;
    expect(block).toMatchObject({
      kind: "connect_request",
      state: "pending",
      props: { kind: "app", app: "notion", title: "Connect Notion" },
    });
    // Without integrations there's nothing to sign in with yet.
    await expect(
      blocks.act(block.id, { action: "connect", clientActionId: "conn-0001" }),
    ).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(blocks.get(block.id).state).toBe("pending");

    await gateway.invoke(
      "poke",
      "cancel_agent",
      { agentId },
      { agent: { kind: "poke" }, callId: "x", signal: signal() },
    );
    await until(() => blocks.get(block.id).state === "expired");
    expect(blocks.get(block.id).fallback).toBe("Connect Notion: not connected");
  });

  it("shows a need's block on its own when Poke can't reply", async () => {
    const result = await startAgentTurn();
    const { agentId } = JSON.parse(result().output[0]!.text) as { agentId: string };
    await idle();
    models.unset("poke");
    await gateway.invoker("executor").invoke("ask_poke", secretArgs, {
      agent: { kind: "executor", taskId: agentId },
      callId: "s1",
      signal: signal(),
    });
    await idle();
    const block = kernel.db.blocks.byTask(agentId)[0]!;
    const holder = kernel.thread.get(block.messageId)!;
    expect(holder).toMatchObject({ role: "poke", status: "complete" });
    expect(holder.parts).toEqual([{ type: "block", blockId: block.id }]);
  });
});

describe("approvals", () => {
  const signal = () => new AbortController().signal;
  const runs: ApprovalOutcome[] = [];
  /** A stand-in for an Executor tool that Executor pauses for an OK. */
  function registerGated(
    name: string,
    input: (args: Record<string, unknown>) => Omit<ApprovalInput, "args" | "resume">,
  ) {
    gateway.register(
      {
        spec: {
          name,
          description: name,
          inputSchema: { type: "object" },
          loading: "always",
          callers: ["model"],
          replay: "unsafe",
        },
        parse: (args) => args as Record<string, unknown>,
        run: (args: Record<string, unknown>, ctx: ToolCallContext) =>
          approvals.gate(
            ctx,
            { ...input(args), args, resume: { executionId: `ex_${ctx.callId}`, source: "executor" } },
            (outcome) => {
              runs.push(outcome);
              return text(outcome.allowed ? "Done." : "Not done.");
            },
          ),
      },
      ["executor"],
    );
  }
  async function startAgent() {
    await setPoke();
    await models.set({
      role: "agents",
      provider: "qwen-token-plan-individual",
      model: "qwen3.8-max",
      reasoning: "medium",
    });
    let agentId = "";
    claude.script = async (_i, session) => {
      const out = await session.spec.invoker.invoke(
        "send_to_agent",
        { name: "ops", goal: "Sort out Maya's order" },
        { agent: { kind: "poke" }, callId: "c1", signal: signal() },
      );
      agentId = (
        JSON.parse(out.output[0]!.type === "text" ? out.output[0]!.text : "{}") as { agentId: string }
      ).agentId;
      return reply("On it.");
    };
    say("refund Maya");
    await until(() => agentId);
    await idle();
    return agentId;
  }
  const ctxFor = (taskId: string, callId: string) => ({
    agent: { kind: "executor" as const, taskId },
    callId,
    signal: signal(),
  });

  it("parks a gated call on an OK, resumes it, and remembers always-allow", async () => {
    runs.length = 0;
    registerGated("northwind_refund", (args) => ({
      integration: "northwind",
      tool: "refund_order",
      title: `Refund $${String(args.amount)}.00 to Maya Chen`,
      details: [{ label: "Order", value: String(args.order) }],
      reason: "Refunds can't be undone.",
      offer: {
        description: "Always allow refunds under $100",
        constraint: { "<": [{ var: "amount" }, 100] },
      },
    }));
    const agentId = await startAgent();
    const invoker = gateway.invoker("executor");
    const inputs: string[] = [];
    claude.script = (input) => {
      inputs.push(input.text);
      return reply("The refund for Maya needs your OK.");
    };
    const parked = await invoker.invoke(
      "northwind_refund",
      { order: "#4417", amount: 84 },
      ctxFor(agentId, "r1"),
    );
    const needId = parked.park!.needId;
    await until(() => inputs.length === 1);
    await idle();
    expect(inputs[0]).toContain("<agent_needs_ok");
    expect(inputs[0]).toContain("Refund $84.00 to Maya Chen");
    const block = kernel.db.blocks.byTask(agentId)[0]!;
    expect(block).toMatchObject({
      kind: "tool_approval",
      state: "pending",
      owner: { type: "approval", taskId: agentId },
      props: {
        app: "Northwind",
        tool: "refund_order",
        action: "Refund $84.00 to Maya Chen",
        always: "Always allow refunds under $100",
      },
    });
    expect(messageText(kernel.thread.get(block.messageId)!)).toBe("The refund for Maya needs your OK.");
    const approvalId = (block.owner as { approvalId: string }).approvalId;

    await blocks.act(block.id, { action: "allow", payload: { always: true }, clientActionId: "allow-0001" });
    expect(executors.needs.at(-1)).toMatchObject({
      taskId: agentId,
      needId,
      value: { allowed: true, approvalId },
    });
    expect(kernel.db.approvals.get(approvalId)).toMatchObject({
      status: "allowed",
      ruleId: expect.stringMatching(/^rul_/),
    });
    expect(approvals.rules()).toEqual([
      expect.objectContaining({
        integration: "northwind",
        tool: "refund_order",
        description: "Always allow refunds under $100",
      }),
    ]);
    const resumed = await invoker.invoke(
      "northwind_refund",
      { order: "#4417", amount: 84 },
      { ...ctxFor(agentId, "r1"), resume: { needId, value: executors.needs.at(-1)!.value } },
    );
    expect(resumed.output[0]).toMatchObject({ text: "Done." });

    // Under $100 now runs without asking; $250 still asks.
    const quick = await invoker.invoke(
      "northwind_refund",
      { order: "#4418", amount: 40 },
      ctxFor(agentId, "r2"),
    );
    expect(quick.park).toBeUndefined();
    expect(quick.output[0]).toMatchObject({ text: "Done." });
    expect(runs.at(-1)).toMatchObject({ allowed: true, ruleId: expect.stringMatching(/^rul_/) });
    const big = await invoker.invoke(
      "northwind_refund",
      { order: "#4419", amount: 250 },
      ctxFor(agentId, "r3"),
    );
    expect(big.park?.needId).toBeDefined();
    await until(() => kernel.db.blocks.byTask(agentId).length === 2);
    await idle();
  });

  it("shows a send as a draft, passes on the edited text, and expires the OK when the agent is cancelled", async () => {
    registerGated("gmail_send", (args) => ({
      integration: "gmail",
      tool: "send_email",
      title: `Send the email to ${String(args.to)}`,
      presentation: {
        kind: "draft",
        props: {
          kind: "Email",
          to: args.to,
          subject: args.subject,
          body: args.body,
          primary: { label: "Send" },
        },
      },
    }));
    const agentId = await startAgent();
    const invoker = gateway.invoker("executor");
    claude.script = () => reply("Here's the email to Maya.");
    const email = { to: "maya@northwind.co", subject: "Your refund", body: "Hi Maya, it's done." };
    const parked = await invoker.invoke("gmail_send", email, ctxFor(agentId, "m1"));
    await idle();
    const draft = kernel.db.blocks.byTask(agentId)[0]!;
    expect(draft).toMatchObject({ kind: "draft", state: "idle", props: { body: "Hi Maya, it's done." } });
    await blocks.act(draft.id, {
      action: "edit",
      payload: { body: "Hi Maya, your refund is on its way." },
      clientActionId: "edit-0001",
    });
    expect(executors.needs).toHaveLength(0);
    await blocks.act(draft.id, { action: "primary", clientActionId: "send-0001" });
    expect(executors.needs.at(-1)).toMatchObject({
      needId: parked.park!.needId,
      value: {
        allowed: true,
        final: { to: email.to, subject: email.subject, body: "Hi Maya, your refund is on its way." },
      },
    });

    const again = await invoker.invoke("gmail_send", email, ctxFor(agentId, "m2"));
    expect(again.park).toBeDefined();
    await idle();
    const second = kernel.db.blocks.byTask(agentId).find((b) => b.id !== draft.id)!;
    const approvalId = (second.owner as { approvalId: string }).approvalId;
    await gateway.invoke(
      "poke",
      "cancel_agent",
      { agentId },
      { agent: { kind: "poke" }, callId: "x", signal: signal() },
    );
    await until(() => blocks.get(second.id).state === "expired");
    expect(kernel.db.approvals.get(approvalId)).toMatchObject({ status: "expired" });
  });

  describe("integrations", () => {
    const fakeServer = (env: Record<string, string> = {}) => ({
      kind: "stdio" as const,
      command: process.execPath,
      args: [FAKE_MCP_SERVER],
      env,
    });
    const searches: string[] = [];
    function integrations() {
      const connector = new SdkMcpConnector();
      const service = new IntegrationService({
        repos: kernel.db,
        clock: { now: () => now },
        timers,
        log: silentLogger,
        gateway,
        approvals,
        executor: new ExecutorClient({
          connector,
          token: () => undefined,
          org: () => undefined,
          log: silentLogger,
          transport: fakeServer({ FAKE_MODE: "executor" }),
        }),
        search: {
          search: async ({ query }) => {
            searches.push(query);
            return { text: `[1] Result for ${query} (https://example.com)`, results: [] };
          },
          fetch: async ({ urls }) => ({ text: urls.join("\n"), pages: [] }),
        },
        vault: vault as unknown as VaultPort,
        mcp: connector,
        resolver: new SecretResolver(vault as unknown as VaultPort),
      });
      service.attachBlocks(blocks);
      connectStarter = (input) => service.start(input);
      return service;
    }
    const textOf = (result: { output: Array<{ type: string; text?: string }> }) =>
      result.output.map((o) => o.text ?? "").join("");

    it("runs Executor calls, parks a gated one on an OK, and resumes Executor with the answer", async () => {
      const service = integrations();
      try {
        const agentId = await startAgent();
        const invoker = gateway.invoker("executor");
        const plain = await invoker.invoke(
          "executor_call",
          { calls: { path: "tools.github.issues.list", input: { repo: "poke" } } },
          ctxFor(agentId, "e0"),
        );
        expect(textOf(plain)).toContain("echoed");

        claude.script = () => reply("Stripe wants your OK for Maya's refund.");
        const call = {
          calls: { path: "tools.stripe.refunds.create", input: { amount: 8400, charge: "ch_1" } },
          intent: "Refund $84.00 to Maya Chen",
        };
        const parked = await invoker.invoke("executor_call", call, ctxFor(agentId, "e1"));
        expect(parked.park?.needId).toBeDefined();
        const block = await until(() => kernel.db.blocks.byTask(agentId)[0]);
        await idle();
        expect(block).toMatchObject({
          kind: "tool_approval",
          props: {
            app: "Stripe",
            tool: "refunds.create",
            action: "Refund $84.00 to Maya Chen",
            always: "Always allow refunds.create in Stripe",
          },
        });
        expect(kernel.db.approvals.get((block.owner as { approvalId: string }).approvalId)).toMatchObject({
          integration: "stripe",
          resume: { executionId: "apr_11111111-1111-1111-1111-111111111111" },
        });

        await blocks.act(block.id, { action: "allow", payload: {}, clientActionId: "allow-ex01" });
        const need = executors.needs.at(-1)!;
        expect(need.needId).toBe(parked.park!.needId);
        // Pi wakes the parked call with the decision; the bridge accepts on Executor's side.
        const resumed = await invoker.invoke("executor_call", call, {
          ...ctxFor(agentId, "e1"),
          resume: { needId: need.needId, value: need.value },
        });
        expect(textOf(resumed)).toContain("refunded");

        // The model can't answer an approval itself.
        const sneaky = await invoker.invoke(
          "executor_resume",
          { requestId: "apr_11111111-1111-1111-1111-111111111111", action: "accept" },
          ctxFor(agentId, "e2"),
        );
        expect(sneaky.isError).toBe(true);
      } finally {
        await service.close();
      }
    });

    it("signs in to an app from a connect block and marks it connected", async () => {
      const service = integrations();
      try {
        await setPoke();
        say("connect gmail");
        await until(() => pokeMessages().length > 0);
        await idle();
        const message = pokeMessages().at(-1)!;
        const block = blocks.attach(message, {
          kind: "connect_request",
          props: { kind: "app", app: "gmail", title: "Connect Gmail", note: "To read the refund thread." },
          owner: { type: "poke" },
        });
        const started = await blocks.act(block.id, {
          action: "connect",
          payload: {},
          clientActionId: "connect-0001",
        });
        expect(started.result).toEqual({ url: "https://executor.sh/connect/abc" });
        expect(blocks.get(block.id).state).toBe("connecting");
        timers.fire();
        await until(() => blocks.get(block.id).state === "connected");
        expect(blocks.get(block.id).resolution).toMatchObject({ account: "maya@northwind.co" });
        expect(kernel.db.integrations.get("gmail")).toMatchObject({
          source: "executor",
          accounts: [{ id: "con_1", identity: "maya@northwind.co", status: "connected" }],
        });
      } finally {
        await service.close();
      }
    });

    it("adds a local MCP server with a vault placeholder, defers its tools, and removes them", async () => {
      const service = integrations();
      try {
        vault.put({ name: "fake", kind: "api_key", secrets: { token: "t0k-secret" } });
        const server = await service.addMcpServer({
          id: "fake",
          transport: fakeServer({ FAKE_TOKEN: "{{vault:fake.token}}" }),
        });
        expect(server).toMatchObject({ connected: true, toolCount: 2 });
        // Stored with the placeholder, never the value.
        expect(JSON.stringify(kernel.db.integrations.mcpServers())).not.toContain("t0k-secret");
        const spec = gateway.specs("executor").find((s) => s.name === "mcp__fake__echo");
        expect(spec).toMatchObject({ loading: "deferred", callers: ["model"], replay: "safe" });
        expect(gateway.specs("poke").some((s) => s.name === "mcp__fake__echo")).toBe(false);
        const out = await gateway.invoke(
          "executor",
          "mcp__fake__echo",
          { text: "hi" },
          ctxFor("tsk_1", "m1"),
        );
        expect(textOf(out)).toBe("echo: hi t0k-secret");
        expect(vault.get("fake")!.usedBy).toEqual(["mcp:fake"]);

        await service.removeMcpServer("fake");
        expect(gateway.has("mcp__fake__echo")).toBe(false);
      } finally {
        await service.close();
      }
    });

    it("lets an edited draft through once, only with the edited text, for the same agent and tool", async () => {
      runs.length = 0;
      registerGated("gmail_send_again", (args) => ({
        integration: "gmail",
        tool: "messages.send",
        title: `Send the email to ${String(args.to)}`,
      }));
      const agentId = await startAgent();
      claude.script = () => reply("Needs your OK.");
      const invoker = gateway.invoker("executor");
      approvals.allowEdited(agentId, "gmail", "messages.send", ["Hi Maya,\nyour refund is on its way."]);
      const other = await invoker.invoke(
        "gmail_send_again",
        { to: "maya@northwind.co", body: "Something else" },
        ctxFor(agentId, "d1"),
      );
      expect(other.park).toBeDefined();
      const edited = { to: "maya@northwind.co", body: "Hi Maya,\nyour refund is on its way." };
      const sent = await invoker.invoke("gmail_send_again", edited, ctxFor(agentId, "d2"));
      expect(sent.park).toBeUndefined();
      expect(runs.at(-1)).toMatchObject({ allowed: true });
      const twice = await invoker.invoke("gmail_send_again", edited, ctxFor(agentId, "d3"));
      expect(twice.park).toBeDefined();
      await idle();
    });

    it("gives every agent the web tools and lists the vault without values", async () => {
      const service = integrations();
      try {
        vault.put({
          name: "resy.login",
          kind: "login",
          fields: { email: "a@b.co" },
          secrets: { password: "pw" },
        });
        const listed = await gateway.invoke("executor", "vault_list", {}, ctxFor("tsk_1", "v1"));
        expect(textOf(listed)).toContain("{{vault:resy.login.password}}");
        expect(textOf(listed)).not.toContain('"pw"');
        const found = await gateway.invoke(
          "poke",
          "search_web",
          { query: "lisbon stays" },
          { agent: { kind: "poke" }, callId: "w1", signal: signal() },
        );
        expect(textOf(found)).toContain("Result for lisbon stays");
        expect(searches).toEqual(["lisbon stays"]);
      } finally {
        await service.close();
      }
    });
  });
});

describe("Poke's blocks", () => {
  const signal = () => new AbortController().signal;
  const call = (session: FakeSession, tool: string, args: unknown) =>
    session.spec.invoker.invoke(tool, args, { agent: { kind: "poke" }, callId: tool, signal: signal() });
  const blockOf = (kind: string) =>
    kernel.db.messages
      .recent(50)
      .flatMap((m) => m.parts)
      .flatMap((p) => (p.type === "block" ? [kernel.db.blocks.get(p.blockId)!] : []))
      .find((b) => b.kind === kind)!;

  it("sends a picked choice as Arham's next message", async () => {
    await setPoke();
    claude.script = async (_i, session) => {
      await call(session, "ask_choices", {
        options: [{ label: "Friday 8:15" }, { label: "Saturday 7:00", hint: "bar seats" }],
      });
      return reply("Which works?");
    };
    say("book dinner at Lilia");
    await idle();
    const block = blockOf("choices");
    expect(kernel.thread.get(block.messageId)).toMatchObject({ role: "poke", status: "complete" });

    const inputs: string[] = [];
    claude.script = (input) => {
      inputs.push(input.text);
      return reply("Booking Saturday.");
    };
    await blocks.act(block.id, { action: "pick", payload: { index: 1 }, clientActionId: "pick-0001" });
    await until(() => inputs.length === 1);
    await idle();
    expect(inputs[0]).toContain("Saturday 7:00");
    expect(blocks.get(block.id)).toMatchObject({
      state: "answered",
      resolution: { answer: "Saturday 7:00" },
    });
    const users = kernel.db.messages
      .recent(10)
      .filter((m) => m.role === "user")
      .map(messageText);
    expect(users).toContain("Saturday 7:00");
  });

  it("tells Poke what Arham did with an action, a draft and a card; refuses bad props", async () => {
    await setPoke();
    const results: Array<{ isError?: boolean; text: string }> = [];
    claude.script = async (_i, session) => {
      for (const [tool, args] of [
        [
          "propose_action",
          {
            kind: "Book a table",
            title: "Lilia",
            body: "Saturday at 7:00 PM · 2 people",
            confirm: "Book",
            change: "Change",
          },
        ],
        [
          "show_draft",
          {
            kind: "Email",
            to: "maya@northwind.co",
            subject: "Friday",
            body: "Hi Maya,",
            primary: { label: "Send from Gmail" },
          },
        ],
        [
          "show_card",
          {
            title: "Gift note",
            root: "s",
            nodes: {
              s: { type: "stack", children: ["f", "b"] },
              f: { type: "field", key: "note", label: "Note" },
              b: { type: "button", label: "Send", actionId: "send" },
            },
          },
        ],
        ["show_card", { title: "Broken", root: "a", nodes: { a: { type: "row", children: ["a"] } } }],
      ] as const) {
        const out = await call(session, tool, args);
        results.push({
          isError: out.isError,
          text: out.output[0]?.type === "text" ? out.output[0].text : "",
        });
      }
      return reply("Here's the plan.");
    };
    say("plan friday");
    await idle();
    expect(results.slice(0, 3).every((r) => !r.isError && r.text.startsWith("Shown (blk_"))).toBe(true);
    expect(results[3]).toMatchObject({ isError: true });
    expect(results[3]!.text).toContain("contains itself");
    const holder = pokeMessages().find((m) => messageText(m) === "Here's the plan.")!;
    expect(holder.parts.filter((p) => p.type === "block")).toHaveLength(3);

    const inputs: string[] = [];
    claude.script = (input) => {
      inputs.push(input.text);
      return reply("ok");
    };
    await blocks.act(blockOf("action").id, { action: "confirm", clientActionId: "conf-0001" });
    await until(() => inputs.length === 1);
    await idle();
    expect(inputs[0]).toMatch(
      /<block_action block="blk_\w+" kind="action" title="Lilia">\nconfirmed\n<\/block_action>/,
    );

    const draft = blockOf("draft");
    await blocks.act(draft.id, {
      action: "edit",
      payload: { body: "Hi Maya, see you Friday at 8." },
      clientActionId: "edit-0001",
    });
    expect(kernel.db.messages.search({ query: "Friday at 8", limit: 5 }).map((h) => h.message.id)).toContain(
      draft.messageId,
    );
    await blocks.act(draft.id, { action: "primary", clientActionId: "send-0001" });
    await until(() => inputs.length === 2);
    await idle();
    expect(inputs[1]).toContain('tapped "Send from Gmail"');
    expect(inputs[1]).toContain("Hi Maya, see you Friday at 8.");

    await blocks.act(blockOf("card").id, {
      action: "press",
      payload: { actionId: "send", values: { note: "Happy 30th!" } },
      clientActionId: "press-001",
    });
    await until(() => inputs.length === 3);
    await idle();
    expect(inputs[2]).toContain('pressed send\nvalues: {"note":"Happy 30th!"}');
  });
});

describe("context and compaction", () => {
  it("compacts an idle Claude session before the 1h cache expires, once", async () => {
    await setPoke();
    say("hi");
    await idle();
    await until(() => timers.live().length === 1);
    expect(timers.live()[0]!.ms).toBe(50 * 60 * 1000);
    claude.sessions[0]!.tokens = 150_000;
    timers.fire();
    await until(() => kernel.db.compactions.latest("poke"));
    expect(claude.sessions[0]!.compacts).toEqual([
      { trigger: "idle", instructions: expect.stringContaining("Write the summary for Poke") },
    ]);
    expect(kernel.db.compactions.latest("poke")).toMatchObject({
      trigger: "idle",
      preTokens: 150_000,
      postTokens: 12_000,
      runtime: "claude-agent-sdk",
      summary: "Arham is planning Lisbon.",
    });
    expect(kernel.hub.since(0, 500).some((e) => e.event.type === "context.compacted")).toBe(true);
    expect(timers.live()).toHaveLength(0);
    expect(await poke.context()).toMatchObject({
      tokens: 12_000,
      budget: 272_000,
      lastCompaction: { trigger: "idle" },
    });
  });

  it("skips idle compaction below the minimum, on a 5-minute cache, and when a message arrives first", async () => {
    await setPoke();
    say("hi");
    await idle();
    await until(() => timers.live().length === 1);
    claude.sessions[0]!.tokens = 50_000;
    timers.fire();
    await new Promise((r) => setTimeout(r, 10));
    expect(claude.sessions[0]!.compacts).toHaveLength(0);

    say("again");
    await idle();
    await until(() => timers.live().length === 1);
    claude.sessions[0]!.tokens = 150_000;
    say("one more"); // arrives before the timer: cancels it
    expect(timers.live()).toHaveLength(0);
    await idle();

    claude.script = () => reply("short cache", 150_000, "5m");
    say("on credits now");
    await idle();
    await new Promise((r) => setTimeout(r, 10));
    expect(timers.live()).toHaveLength(0);
    expect(claude.sessions[0]!.compacts).toHaveLength(0);
  });

  it("only compacts Poke on Qwen when idle compaction for Pi is on", async () => {
    await setPoke("qwen-token-plan-individual", "qwen3.8-max");
    say("hi");
    await idle();
    await new Promise((r) => setTimeout(r, 10));
    expect(timers.live()).toHaveLength(0);
    kernel.settings.set("context.idleCompactPi", true);
    say("hi again");
    await idle();
    await until(() => timers.live().length === 1);
    expect(timers.live()[0]!.ms).toBe(50 * 60 * 1000);
  });

  it("records compactions the runtime does by itself, and compacts on request", async () => {
    await setPoke();
    claude.script = () => [
      { type: "compacted", trigger: "auto", preTokens: 265_000, postTokens: 30_000 },
      ...reply("still here"),
    ];
    say("long day");
    await idle();
    await until(() => kernel.db.compactions.latest("poke"));
    expect(kernel.db.compactions.latest("poke")).toMatchObject({ trigger: "auto", preTokens: 265_000 });
    claude.sessions[0]!.tokens = 100_000;
    const manual = await poke.compactNow();
    expect(manual).toMatchObject({ trigger: "manual", preTokens: 100_000 });
  });
});

describe("memory", () => {
  const signal = () => new AbortController().signal;
  const textOf = (result: { output: Array<{ type: string; text?: string }> }) =>
    result.output.map((o) => o.text ?? "").join("");
  const executorCtx = {
    agent: { kind: "executor" as const, taskId: "tsk_1" },
    callId: "r1",
    signal: signal(),
  };

  it("writes his message and Poke's final reply only, with secrets taken out", async () => {
    fakeMemory.on = true;
    secrets.set("qwen.apiKey", "sk-sp-supersecret99");
    await setPoke();
    claude.script = () => reply("Noted, figs it is.");
    say("I love figs. Also my key is sk-sp-supersecret99");
    await idle();
    await memory.flush();
    expect(fakeMemory.exchanges).toHaveLength(1);
    const [exchange] = fakeMemory.exchanges;
    expect(exchange?.user?.text).toContain("I love figs.");
    expect(exchange?.user?.text).not.toContain("supersecret");
    expect(exchange?.poke?.text).toBe("Noted, figs it is.");

    // Nothing is written while memory isn't set up.
    fakeMemory.on = false;
    say("still there?");
    await idle();
    await memory.flush();
    expect(fakeMemory.exchanges).toHaveLength(1);
  });

  it("remembers a fact with a note, and Undo forgets it", async () => {
    fakeMemory.on = true;
    await setPoke();
    claude.script = async (_i, session) => {
      await session.spec.invoker.invoke(
        "remember",
        { fact: "Allergic to peanuts" },
        { agent: { kind: "poke" }, callId: "m1", signal: signal() },
      );
      return reply("Got it.");
    };
    say("remember I'm allergic to peanuts");
    await idle();
    expect([...fakeMemory.facts.values()]).toEqual(["Allergic to peanuts"]);
    const note = kernel.db.messages
      .recent(20)
      .flatMap((m) => m.parts)
      .flatMap((part) => (part.type === "block" ? [kernel.db.blocks.get(part.blockId)!] : []))
      .find((b) => b.kind === "memory_note")!;
    expect(note.props).toEqual({ text: "Allergic to peanuts", ref: "con_1" });
    expect(kernel.thread.get(note.messageId)).toMatchObject({ role: "poke" });

    const told: string[] = [];
    claude.script = (input) => {
      told.push(input.text);
      return reply("Forgotten.");
    };
    await blocks.act(note.id, { action: "undo", clientActionId: "undo-0001" });
    expect(fakeMemory.facts.size).toBe(0);
    await until(() => told.length === 1);
    await idle();
    expect(told[0]).toContain('undo: forget "Allergic to peanuts"');
    expect(blocks.get(note.id).state).toBe("undone");
  });

  it("answers recall for agents at the set depth, and puts the card in Poke's prompt", async () => {
    const off = await gateway.invoke("executor", "recall", { question: "food?" }, executorCtx);
    expect(off.isError).toBe(true);
    expect(textOf(off)).toContain("isn't set up");
    // Agents can only read memory.
    const remember = await gateway.invoke("executor", "remember", { fact: "x" }, executorCtx);
    expect(remember.isError).toBe(true);
    expect(fakeMemory.facts.size).toBe(0);

    fakeMemory.on = true;
    const quick = await gateway.invoke("executor", "recall", { question: "What food?" }, executorCtx);
    expect(textOf(quick)).toBe("He likes figs.");
    await gateway.invoke("sidechat", "recall", { question: "Where?", depth: "deep" }, executorCtx);
    expect(fakeMemory.queries).toEqual([
      { query: "What food?", level: "low" },
      { query: "Where?", level: "high" },
    ]);

    await memory.refreshCard();
    await setPoke();
    say("hi");
    await idle();
    expect(claude.sessions[0]!.spec.systemPrompt).toContain("- Likes figs\n- Lives in Lisbon");
  });
});

describe("side chats", () => {
  it("needs its own model, keeps nothing, and can send a summary to Poke", async () => {
    const chats = new SideChatService({
      repos: kernel.db,
      hub: kernel.hub,
      ids: kernel.ids,
      clock: { now: () => now },
      log: silentLogger,
      thread: kernel.thread,
      settings: kernel.settings,
      models,
      runtimes: { "claude-agent-sdk": claude, "pi-ai": pi },
      gateway,
      persona: () => ({ userName: "Arham", timezone: "Europe/Lisbon", workspace: "/w" }),
      workspace: "/w",
      skillsDir: "/s",
    });
    expect(() => chats.open()).toThrow(/No Side chat model/);
    await models.set({ role: "sidechat", provider: "qwen-token-plan-individual", model: "qwen3.8-max" });
    await setPoke();
    const chat = chats.open();
    pi.script = (input) =>
      input.text.startsWith("Summarise")
        ? reply("We compared two hotels; Memmo wins.")
        : reply("Memmo is nicer.");
    const answer = await chats.send(chat.id, { text: "memmo or lumiares?" });
    expect(messageText(answer!)).toBe("Memmo is nicer.");
    expect(pi.sessions[0]!.spec).toMatchObject({
      profile: "sidechat",
      persist: false,
      key: `sidechat:${chat.id}`,
    });
    expect(chats.get(chat.id).messages.map((m) => m.role)).toEqual(["user", "poke"]);
    expect(kernel.db.messages.recent(10)).toHaveLength(0);
    const posted = await chats.sendToPoke(chat.id);
    expect(messageText(posted)).toBe("From a side chat:\n\nWe compared two hotels; Memmo wins.");
    await until(() => claude.sessions[0]?.turns.length === 1);
    await idle();
    await chats.close(chat.id);
    expect(pi.sessions[0]!.closed).toBe(true);
    expect(() => chats.get(chat.id)).toThrow(/closed/);
  });
});
