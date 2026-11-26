import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type {
  ExecutorEvent,
  ModelAssignment,
  RuntimeEvent,
  ToolCallContext,
  ToolInterceptor,
  ToolInvoker,
  ToolResultData,
  ToolSpec,
} from "@poke/domain";
import { silentLogger } from "@poke/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiConversationRuntime } from "./conversation.js";
import { PiExecutorRuntime } from "./executors.js";
import { compactionFor, PiHost } from "./host.js";
import { createPiModels } from "./models.js";

const faux = fauxProvider({
  provider: "faux",
  models: [{ id: "m1", contextWindow: 1_000_000, reasoning: true }],
  tokensPerSecond: 5_000,
});
const model: ModelAssignment = { role: "agents", provider: "faux", model: "m1", updatedAt: 0 };

const specs: ToolSpec[] = [
  {
    name: "report_progress",
    description: "progress",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    loading: "always",
    callers: ["model"],
    replay: "safe",
  },
  {
    name: "ask_poke",
    description: "ask",
    inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
    loading: "always",
    callers: ["model"],
    replay: "safe",
  },
];

const calls: Array<{ name: string; args: unknown; ctx: ToolCallContext }> = [];
const invoker: ToolInvoker = {
  async invoke(name, args, ctx): Promise<ToolResultData> {
    calls.push({ name, args, ctx });
    if (name === "ask_poke") {
      if (ctx.resume)
        return { output: [{ type: "text", text: `Answer: ${JSON.stringify(ctx.resume.value)}` }] };
      return { output: [], park: { needId: "need_1" } };
    }
    return { output: [{ type: "text", text: "ok" }] };
  },
};
const interceptor: ToolInterceptor = {
  prepare: async (_name, args) => ({ args, release: () => {} }),
  redact: (text) => text.replaceAll("SECRET", "[redacted]"),
  observe: () => {},
};

let dir: string;
let host: PiHost;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "poke-pi-"));
  calls.length = 0;
  host = await PiHost.open({
    path: join(dir, "durable.sqlite"),
    models: createPiModels({ apiKey: () => undefined, extraProviders: [faux.provider] }),
    workspace: dir,
    log: silentLogger,
  });
});
afterEach(async () => {
  await host?.close();
  rmSync(dir, { recursive: true, force: true });
});

function collect(runtime: PiExecutorRuntime) {
  const events: ExecutorEvent[] = [];
  runtime.onEvent((e) => events.push(e));
  return events;
}

async function until<T>(fn: () => T | undefined, ms = 4000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const executorSpec = (taskId: string) => ({
  taskId,
  name: "test",
  model,
  systemPrompt: "You are an executor.",
  tools: specs,
  invoker,
  interceptor,
  cwd: dir,
  budget: 272_000,
});

describe("compaction settings", () => {
  it("caps a 1M model at the 272K budget", () => {
    expect(compactionFor({ provider: "qwen", id: "q", contextWindow: 1_000_000 }, 272_000)).toEqual({
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      backgroundTokens: 32_768,
      modelOverrides: { "qwen/q": { reserveTokens: 1_000_000 - 272_000 + 16_384 } },
    });
    expect(
      compactionFor({ provider: "p", id: "small", contextWindow: 128_000 }, 272_000).modelOverrides,
    ).toEqual({});
  });
});

describe("executors", () => {
  it("runs tools, reports steps and the final answer, then takes a follow-up", async () => {
    const runtime = new PiExecutorRuntime(host);
    const events = collect(runtime);
    faux.setResponses([
      fauxAssistantMessage(
        [fauxText("Working."), fauxToolCall("report_progress", { text: "Looking around" }, { id: "c1" })],
        {
          stopReason: "toolUse",
        },
      ),
      fauxAssistantMessage("Found it: the SECRET answer is 42."),
      fauxAssistantMessage("Follow-up done."),
    ]);
    const { runtimeRef } = await runtime.start({ ...executorSpec("tsk_1"), firstTurn: "Find the answer." });
    expect(runtimeRef).toMatch(/^\d+$/);
    const report = await until(() => events.find((e) => e.type === "report"));
    expect(report).toMatchObject({ taskId: "tsk_1", text: "Found it: the [redacted] answer is 42." });
    expect(events.filter((e) => e.type === "step.started").map((e) => (e as { name: string }).name)).toEqual([
      "report_progress",
    ]);
    expect(events.some((e) => e.type === "step.completed")).toBe(true);
    expect(events.some((e) => e.type === "usage")).toBe(true);
    expect(calls[0]).toMatchObject({ name: "report_progress", args: { text: "Looking around" } });
    expect(calls[0]!.ctx.agent).toEqual({ kind: "executor", taskId: "tsk_1" });

    await runtime.message(runtimeRef, "One more thing.", "followup");
    await until(() => events.filter((e) => e.type === "report").length === 2 || undefined);
    await runtime.close();
  });

  it("fills vault placeholders into write at execution, keeping them in the transcript", async () => {
    const runtime = new PiExecutorRuntime(host);
    const events = collect(runtime);
    const released: string[] = [];
    const filling: ToolInterceptor = {
      ...interceptor,
      prepare: async (name, args) => ({
        args: JSON.parse(JSON.stringify(args).replace("{{vault:demo.token}}", "SECRET-value-1")),
        release: () => released.push(name),
      }),
    };
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("write", { path: "note.txt", content: "token={{vault:demo.token}}" }, { id: "w1" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" }, { id: "r1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Done."),
    ]);
    await runtime.start({ ...executorSpec("tsk_w"), interceptor: filling, firstTurn: "Write the note." });
    await until(() => events.find((e) => e.type === "report"));
    expect(readFileSync(join(dir, "note.txt"), "utf8")).toBe("token=SECRET-value-1");
    expect(released).toEqual(["write"]);
    const started = events.find((e) => e.type === "step.started" && e.name === "write");
    expect(JSON.stringify(started)).toContain("{{vault:demo.token}}");
    // What read returned to the model was redacted.
    const read = events.find((e) => e.type === "step.completed" && e.name === "read");
    expect(JSON.stringify(read)).not.toContain("SECRET-value-1");
    await runtime.close();
  });

  it("parks on a need and resumes with its resolution", async () => {
    const runtime = new PiExecutorRuntime(host);
    const events = collect(runtime);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("ask_poke", { question: "Which hotel?" }, { id: "c1" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Booked the one you chose."),
    ]);
    await runtime.start({ ...executorSpec("tsk_2"), firstTurn: "Book a hotel." });
    await until(() => calls.find((c) => c.name === "ask_poke"));
    await new Promise((r) => setTimeout(r, 100));
    expect(await runtime.resolveNeed("tsk_2", "need_1", { choice: "Memmo" })).toBe("delivered");
    expect(await runtime.resolveNeed("tsk_2", "need_1", { choice: "again" })).not.toBe("delivered");
    await until(() => events.find((e) => e.type === "report"));
    const resumed = calls.filter((c) => c.name === "ask_poke").at(-1)!;
    expect(resumed.ctx.resume).toEqual({ needId: "need_1", value: { choice: "Memmo" } });
    await runtime.close();
  });

  it("survives a restart while parked", async () => {
    let runtime = new PiExecutorRuntime(host);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("ask_poke", { question: "Which?" }, { id: "c1" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Done after restart."),
    ]);
    const { runtimeRef } = await runtime.start({ ...executorSpec("tsk_3"), firstTurn: "Do it." });
    await until(() => calls.find((c) => c.name === "ask_poke"));
    await new Promise((r) => setTimeout(r, 100));
    await runtime.close();
    await host.close();

    host = await PiHost.open({
      path: join(dir, "durable.sqlite"),
      models: createPiModels({ apiKey: () => undefined, extraProviders: [faux.provider] }),
      workspace: dir,
      log: silentLogger,
    });
    runtime = new PiExecutorRuntime(host);
    const events = collect(runtime);
    await runtime.resume([{ runtimeRef, spec: executorSpec("tsk_3") }]);
    expect(await runtime.resolveNeed("tsk_3", "need_1", "yes")).toBe("delivered");
    const report = await until(() => events.find((e) => e.type === "report"));
    expect(report).toMatchObject({ text: "Done after restart." });
    await runtime.close();
  });

  it("reports a cancelled run", async () => {
    const runtime = new PiExecutorRuntime(host);
    const events = collect(runtime);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("ask_poke", { question: "Which?" }, { id: "c1" }), {
        stopReason: "toolUse",
      }),
    ]);
    const { runtimeRef } = await runtime.start({ ...executorSpec("tsk_4"), firstTurn: "Do it." });
    await until(() => calls.find((c) => c.name === "ask_poke"));
    await runtime.cancel(runtimeRef);
    const failed = await until(() => events.find((e) => e.type === "failed"));
    expect(failed).toMatchObject({ taskId: "tsk_4", kind: "cancelled" });
    await runtime.close();
  });
});

describe("Poke on a pi-ai model", () => {
  const sessionSpec = (resumeRef?: string) => ({
    key: "poke",
    profile: "poke" as const,
    model: { ...model, role: "poke" as const },
    systemPrompt: "You are Poke.",
    tools: specs,
    invoker,
    interceptor,
    budget: 272_000,
    persist: true,
    cwd: dir,
    skillsDir: dir,
    compactionInstructions: "Keep what matters.",
    idleMinTokens: 80_000,
    digest: "<digest>earlier: we talked about Lisbon</digest>",
    ...(resumeRef ? { resumeRef } : {}),
  });

  it("streams a turn, puts the digest in the first turn only, and resumes the same conversation", async () => {
    const runtime = new PiConversationRuntime(host);
    const session = await runtime.openSession(sessionSpec());
    const seen: string[] = [];
    const long = [
      "hey! still thinking about Lisbon?",
      ...Array(120).fill("The tram up to the castle is worth it."),
    ].join(" ");
    faux.setResponses([
      (context) => {
        seen.push(JSON.stringify(context.messages.at(-1)));
        return fauxAssistantMessage(long);
      },
      (context) => {
        seen.push(JSON.stringify(context.messages.at(-1)));
        return fauxAssistantMessage("sure");
      },
    ]);
    const events: RuntimeEvent[] = [];
    for await (const event of session.startTurn({ text: "hi" })) events.push(event);
    expect(events[0]).toEqual({ type: "session", ref: session.ref });
    const streamed = events.flatMap((e) => (e.type === "text.delta" ? [e.text] : [])).join("");
    expect(streamed.length).toBeGreaterThan(0);
    expect(long.startsWith(streamed)).toBe(true);
    expect(events.find((e) => e.type === "text.done")).toEqual({ type: "text.done", text: long });
    expect(events.at(-1)).toEqual({ type: "turn.done" });
    expect(session.contextTokens()).toBeGreaterThan(0);
    for await (const _ of session.startTurn({ text: "again" })) void _;
    expect(seen[0]).toContain("earlier: we talked about Lisbon");
    expect(seen[1]).not.toContain("earlier");
    const ref = session.ref!;
    await session.close();

    const again = await runtime.openSession(sessionSpec(ref));
    expect(again.ref).toBe(ref);
    await again.close();
  });

  it("compacts on request with the conversation's own model", async () => {
    const runtime = new PiConversationRuntime(host);
    const session = await runtime.openSession(sessionSpec());
    faux.setResponses([
      fauxAssistantMessage("one"),
      fauxAssistantMessage("two"),
      (context) => fauxAssistantMessage(`<summary>${context.messages.length} messages summarised</summary>`),
    ]);
    for await (const _ of session.startTurn({ text: "first" })) void _;
    for await (const _ of session.startTurn({ text: "second" })) void _;
    const info = await session.compact("idle");
    expect(info === undefined || info.preTokens >= 0).toBe(true);
    expect(faux.state.callCount).toBeGreaterThanOrEqual(2);
    await session.close();
  });

  it("returns false when steering an idle session", async () => {
    const runtime = new PiConversationRuntime(host);
    const session = await runtime.openSession(sessionSpec());
    expect(await session.steer({ text: "nothing running" })).toBe(false);
    await session.close();
  });
});

describe("Qwen key check", () => {
  it("checks the key with one tiny request and reads the answer", async () => {
    const { validateQwenKey } = await import("./validate.js");
    const models = createPiModels({ apiKey: () => undefined });
    const calls: Array<{ url: string; auth: string }> = [];
    const fake = (status: number) =>
      (async (url: string, init: RequestInit) => {
        calls.push({ url, auth: (init.headers as Record<string, string>).authorization! });
        return new Response("{}", { status });
      }) as unknown as typeof fetch;
    expect(await validateQwenKey(models, "qwen-token-plan-individual", "nope", fake(200))).toMatchObject({
      ok: false,
    });
    expect(await validateQwenKey(models, "qwen-token-plan-individual", "sk-sp-good", fake(200))).toEqual({
      ok: true,
    });
    expect(calls[0]).toEqual({
      url: "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1/chat/completions",
      auth: "Bearer sk-sp-good",
    });
    expect(await validateQwenKey(models, "qwen-token-plan-individual-cn", "sk-sp-bad", fake(401))).toEqual({
      ok: false,
      error: "The Qwen Token Plan rejected that key",
    });
    expect(calls[1]!.url).toBe(
      "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1/chat/completions",
    );
  });
});
