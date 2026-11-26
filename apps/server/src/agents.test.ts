import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentsService,
  InteractionOrchestrator,
  LoginService,
  ModelService,
  SecretRedactor,
  SideChatService,
  ToolGateway,
} from "@poke/application";
import {
  type CompactionInfo,
  type ConversationRuntime,
  type ConversationSession,
  type ExecutorEvent,
  type ExecutorRuntime,
  type ExecutorSpec,
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
  type TurnInput,
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
let secrets: MemorySecrets;
let live: Array<{ type: string } & Record<string, unknown>>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "poke-agents-"));
  now = 1_800_000_000_000;
  const clock = { now: () => now };
  kernel = createKernel({ paths: resolvePaths(home), clock, dbPath: ":memory:" });
  kernel.settings.set("profile.name", "Arham");
  kernel.settings.set("profile.timezone", "Europe/Lisbon");
  timers = new FakeTimers();
  secrets = new MemorySecrets();
  gateway = new ToolGateway(new SecretRedactor(() => [...secrets.map.values()]), silentLogger);
  models = new ModelService(kernel.db, kernel.hub, catalogs, clock);
  executors = new FakeExecutors();
  const persona = () => ({ userName: "Arham", timezone: "Europe/Lisbon", workspace: "/w" });
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
    presence: kernel.presence,
    persona,
    workspace: "/w",
    skillsDir: "/s",
  });
  poke.start();
  live = [];
  kernel.hub.subscribe((frame) => {
    if (frame.kind === "live") live.push(frame.event as never);
  });
});

afterEach(async () => {
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
      "cancel_agent",
      "list_agents",
      "search_thread",
      "send_to_agent",
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
    expect(spec.tools.map((t) => t.name).sort()).toEqual(["ask_poke", "report_progress"]);
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
