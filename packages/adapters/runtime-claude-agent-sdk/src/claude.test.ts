import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue, CORE_TOOLS } from "@poke/agent-core";
import { type RuntimeEvent, type SessionSpec, silentLogger } from "@poke/domain";
import { describe, expect, it } from "vitest";
import { claudeEnv } from "./env.js";
import { ClaudeConversationRuntime } from "./runtime.js";
import type { QueryFn, QueryLike } from "./session.js";
import { shapeOf } from "./tools.js";
import { z } from "zod";

type Script = (
  message: SDKUserMessage,
  out: (m: Record<string, unknown>) => void,
  options: Options,
) => void | Promise<void>;

/** A scripted stand-in for the Agent SDK's query(): replies to each user message it reads. */
function fakeQuery(script: Script) {
  const calls: Array<{ options: Options; received: SDKUserMessage[] }> = [];
  const fn: QueryFn = ({ prompt, options }) => {
    const call = { options, received: [] as SDKUserMessage[] };
    calls.push(call);
    const out = new AsyncQueue<SDKMessage>();
    let interrupted = false;
    void (async () => {
      try {
        for await (const message of prompt) {
          call.received.push(message);
          await script(
            message,
            (m) => out.push({ session_id: "ses_1", uuid: crypto.randomUUID(), ...m } as SDKMessage),
            options,
          );
        }
      } catch (error) {
        out.push({ type: "__throw", error } as never);
      }
      out.close();
    })();
    const query: QueryLike = {
      async *[Symbol.asyncIterator]() {
        for await (const message of out) {
          if ((message as { type: string }).type === "__throw")
            throw (message as unknown as { error: Error }).error;
          yield message;
        }
      },
      interrupt: async () => {
        interrupted = true;
      },
      close: () => out.close(),
    };
    void interrupted;
    return query;
  };
  return { fn, calls };
}

const text = (m: SDKUserMessage) => (typeof m.message.content === "string" ? m.message.content : "");
const usage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 200,
  cache_creation: { ephemeral_1h_input_tokens: 200 },
};

function reply(out: (m: Record<string, unknown>) => void, words: string[], id = "msg_1") {
  for (const word of words) {
    out({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: word } },
    });
  }
  out({
    type: "assistant",
    parent_tool_use_id: null,
    message: { id, role: "assistant", content: [{ type: "text", text: words.join("") }], usage },
  });
}
const result = (out: (m: Record<string, unknown>) => void) =>
  out({ type: "result", subtype: "success", is_error: false, usage, total_cost_usd: 0.01, result: "" });

function spec(overrides: Partial<SessionSpec> = {}): SessionSpec {
  return {
    key: "poke",
    profile: "poke",
    model: { role: "poke", provider: "anthropic", model: "claude-opus-5-5", reasoning: "high", updatedAt: 0 },
    systemPrompt: "You are Poke.",
    tools: Object.values(CORE_TOOLS).map((t) => t.spec),
    invoker: { invoke: async () => ({ output: [{ type: "text", text: "ok" }] }) },
    interceptor: {
      prepare: async (_n, args) => ({ args, release: () => {} }),
      redact: (t) => t.replaceAll("hunter2", "[redacted]"),
      observe: () => {},
    },
    budget: 272_000,
    persist: true,
    cwd: process.cwd(),
    skillsDir: process.cwd(),
    compactionInstructions: "Keep what matters.",
    idleMinTokens: 80_000,
    ...overrides,
  };
}

const runtime = (fn: QueryFn, token: string | null = "sk-ant-oat-test") =>
  new ClaudeConversationRuntime({
    token: () => token ?? undefined,
    configDir: "/var/lib/poke/claude",
    log: silentLogger,
    query: fn,
    baseEnv: {
      PATH: "/usr/bin",
      HOME: "/home/poke",
      ANTHROPIC_API_KEY: "sk-ant-api-should-not-pass",
      QWEN_API_KEY: "x",
    },
  });

async function drain(events: AsyncIterable<RuntimeEvent>) {
  const out: RuntimeEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("Claude runtime options", () => {
  it("runs Poke with no built-in tools, no setting files, its own compaction settings and a clean env", async () => {
    const fake = fakeQuery((m, out) => {
      out({ type: "system", subtype: "init", session_id: "ses_1", model: "claude-opus-5-5", tools: [] });
      reply(out, ["hi"]);
      result(out);
    });
    const session = await runtime(fake.fn).openSession(spec());
    await drain(session.startTurn({ text: "hey" }));
    const options = fake.calls[0]!.options;
    expect(options.tools).toEqual([]);
    expect(options.settingSources).toEqual([]);
    expect(options.settings).toEqual({ autoCompactEnabled: true, idleCompaction: false });
    expect(options.env).toMatchObject({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "272000" });
    const pre = options.hooks!.PreCompact![0]!.hooks[0]!;
    expect(
      await pre(
        { hook_event_name: "PreCompact", trigger: "auto", custom_instructions: null } as never,
        undefined,
        { signal: new AbortController().signal },
      ),
    ).toEqual({ systemMessage: "Keep what matters." });
    expect(options.model).toBe("claude-opus-5-5");
    expect(options.effort).toBe("high");
    expect(options.systemPrompt).toBe("You are Poke.");
    expect(options.persistSession).toBe(true);
    expect(options.resume).toBeUndefined();
    expect(options.includePartialMessages).toBe(true);
    expect(Object.keys(options.mcpServers ?? {})).toEqual(["poke"]);
    expect(options.env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test",
      CLAUDE_CONFIG_DIR: "/var/lib/poke/claude",
      PATH: "/usr/bin",
    });
    expect(options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(options.env).not.toHaveProperty("QWEN_API_KEY");
    expect(options.extraArgs ?? {}).not.toHaveProperty("bare");
    const allow = await options.canUseTool!("mcp__poke__send_to_agent", {}, {
      signal: new AbortController().signal,
    } as never);
    expect(allow?.behavior).toBe("allow");
    const deny = await options.canUseTool!("Bash", {}, { signal: new AbortController().signal } as never);
    expect(deny?.behavior).toBe("deny");
    await session.close();
  });

  it("gives side chats the six coding tools and never persists them", async () => {
    const fake = fakeQuery((_m, out) => {
      reply(out, ["ok"]);
      result(out);
    });
    const session = await runtime(fake.fn).openSession(
      spec({
        key: "sidechat:sc_1",
        profile: "sidechat",
        persist: false,
        model: { role: "sidechat", provider: "anthropic", model: "claude-sonnet-5-5", updatedAt: 0 },
      }),
    );
    await drain(session.startTurn({ text: "look at this" }));
    expect(fake.calls[0]!.options.tools).toEqual(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]);
    expect(fake.calls[0]!.options.persistSession).toBe(false);
    await session.close();
  });

  it("refuses roles and providers the subscription isn't for, and a missing login", async () => {
    const fake = fakeQuery(() => {});
    await expect(
      runtime(fake.fn).openSession(
        spec({ model: { role: "agents", provider: "anthropic", model: "claude-opus-5-5", updatedAt: 0 } }),
      ),
    ).rejects.toThrow(/only for Poke and side chats/);
    await expect(
      runtime(fake.fn).openSession(
        spec({
          model: { role: "poke", provider: "qwen-token-plan-individual", model: "qwen3.8-max", updatedAt: 0 },
        }),
      ),
    ).rejects.toThrow(/can't run/);
    await expect(runtime(fake.fn, null).openSession(spec())).rejects.toThrow(/poke login anthropic/);
  });

  it("builds a minimal env without provider keys even when asked to", () => {
    const env = claudeEnv({
      token: "t",
      configDir: "/c",
      base: { PATH: "/bin", ANTHROPIC_API_KEY: "k" },
      extra: { ANTHROPIC_BASE_URL: "x", FOO: "bar" },
    });
    expect(env).toEqual({
      PATH: "/bin",
      FOO: "bar",
      CLAUDE_CODE_OAUTH_TOKEN: "t",
      CLAUDE_CONFIG_DIR: "/c",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
  });
});

describe("Claude session events", () => {
  it("maps a streamed turn with a tool call to runtime events", async () => {
    const fake = fakeQuery((_m, out) => {
      out({ type: "system", subtype: "init", session_id: "ses_1", model: "claude-opus-5-5", tools: [] });
      reply(out, ["Let me ", "check."], "msg_a");
      out({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: "msg_a",
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_1", name: "mcp__poke__search_thread", input: { query: "lisbon" } },
          ],
          usage,
        },
      });
      out({
        type: "user",
        parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "found" }] },
      });
      reply(out, ["Your password is hunter2"], "msg_b");
      result(out);
    });
    const session = await runtime(fake.fn).openSession(spec());
    const events = await drain(session.startTurn({ text: "what did we say" }));
    expect(events.map((e) => e.type)).toEqual([
      "session",
      "text.delta",
      "text.delta",
      "text.done",
      "tool.started",
      "tool.completed",
      "text.delta",
      "text.done",
      "usage",
      "turn.done",
    ]);
    expect(events[4]).toEqual({
      type: "tool.started",
      callId: "tu_1",
      name: "search_thread",
      args: { query: "lisbon" },
    });
    expect(events[5]).toEqual({
      type: "tool.completed",
      callId: "tu_1",
      name: "search_thread",
      isError: false,
    });
    expect(events[7]).toEqual({ type: "text.done", text: "Your password is [redacted]" });
    expect(events[8]).toMatchObject({
      type: "usage",
      usage: { provider: "anthropic", cacheRead: 1000, cacheLifetime: "1h" },
      contextTokens: 1215,
    });
    expect(session.ref).toBe("ses_1");
    await session.close();
  });

  it("steers a running turn, and reports steering an idle one as not running", async () => {
    let release: (() => void) | undefined;
    const fake = fakeQuery(async (m, out) => {
      if (m.priority === "now") {
        out({ type: "user", isReplay: true, uuid: m.uuid, parent_tool_use_id: null, message: m.message });
        return;
      }
      await new Promise<void>((r) => (release = r));
      reply(out, ["done"]);
      result(out);
    });
    const session = await runtime(fake.fn).openSession(spec({ resumeRef: "ses_1" }));
    expect(await session.steer({ text: "idle" })).toBe(false);
    const turn = drain(session.startTurn({ text: "start" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(await session.steer({ text: "also this" })).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    release!();
    const events = await turn;
    expect(events.at(-1)).toEqual({ type: "turn.done" });
    expect(fake.calls[0]!.received.map(text)).toEqual(["start", "also this"]);
    await session.close();
  });

  it("compacts on request with Poke's instructions and returns what happened", async () => {
    const fake = fakeQuery((m, out) => {
      if (text(m).startsWith("/compact")) {
        out({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "manual", pre_tokens: 200_000, post_tokens: 30_000 },
        });
        result(out);
        return;
      }
      out({ type: "system", subtype: "init", session_id: "ses_1", model: "claude-opus-5-5", tools: [] });
      reply(out, ["ok"]);
      result(out);
    });
    const session = await runtime(fake.fn).openSession(spec());
    const outside: RuntimeEvent[] = [];
    session.onEvent((e) => outside.push(e));
    expect(await session.compact("idle")).toBeUndefined(); // nothing to compact before the first turn
    await drain(session.startTurn({ text: "hi" }));
    const info = await session.compact("idle", "Keep Lisbon plans.");
    expect(info).toEqual({ preTokens: 200_000, postTokens: 30_000 });
    expect(fake.calls[0]!.received.map(text).at(-1)).toBe("/compact Keep Lisbon plans.");
    expect(outside.some((e) => e.type === "compacted")).toBe(false);
    expect(outside.some((e) => e.type === "usage")).toBe(true);
    expect(session.contextTokens()).toBe(30_000);
    await session.close();
  });

  it("starts fresh with the digest when the session can't be resumed", async () => {
    const fake = fakeQuery((_m, out, options) => {
      if (options.resume) throw new Error("No conversation found with session ID: ses_old");
      out({ type: "system", subtype: "init", session_id: "ses_new", model: "claude-opus-5-5", tools: [] });
      reply(out, ["back"]);
      result(out);
    });
    const session = await runtime(fake.fn).openSession(
      spec({ resumeRef: "ses_old", digest: "<digest>we planned Lisbon</digest>" }),
    );
    const events = await drain(session.startTurn({ text: "hi again" }));
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.options.resume).toBeUndefined();
    expect(text(fake.calls[1]!.received[0]!)).toBe("<digest>we planned Lisbon</digest>\n\nhi again");
    expect(events.filter((e) => e.type === "session").at(-1)).toEqual({ type: "session", ref: "ses_new" });
    expect(events.at(-1)).toEqual({ type: "turn.done" });
    await session.close();
  });

  it("reports usage limits with when they reset", async () => {
    const fake = fakeQuery((_m, out) => {
      out({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: 1_900_000_000, rateLimitType: "five_hour" },
      });
      out({
        type: "assistant",
        parent_tool_use_id: null,
        error: "rate_limit",
        message: { id: "m", role: "assistant", content: [{ type: "text", text: "limit" }] },
      });
      out({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        usage,
        errors: ["rate limited"],
      });
    });
    const session = await runtime(fake.fn).openSession(spec());
    const events = await drain(session.startTurn({ text: "hi" }));
    expect(events.find((e) => e.type === "error")).toEqual({
      type: "error",
      kind: "rate_limited",
      message: "Claude usage limit reached",
      retryAt: 1_900_000_000_000,
    });
    expect(events.at(-1)).toEqual({ type: "turn.done" });
    await session.close();
  });
});

describe("tool shapes", () => {
  it("turns Poke's JSON Schemas back into zod shapes for the SDK", () => {
    const send = CORE_TOOLS.sendToAgent;
    const shape = shapeOf(send.spec);
    expect(z.object(shape).safeParse({ name: "Hotels", goal: "Find a hotel" }).success).toBe(true);
    expect(z.object(shape).safeParse({ goal: "no name" }).success).toBe(false);
  });
});

describe("model catalog", () => {
  it("uses the SDK's list when it can, and the curated one otherwise", async () => {
    const { ClaudeModelCatalog, fromSdkModels, validateClaudeToken } = await import("./catalog.js");
    const live = new ClaudeModelCatalog(async () => [
      {
        value: "default",
        displayName: "Default",
        resolvedModel: "claude-opus-5-5",
        supportedEffortLevels: ["low", "high"],
      },
      { value: "claude-sonnet-5-5", displayName: "Sonnet 5.5" },
      { value: "opus[1m]", displayName: "Opus 1M" },
    ]);
    expect((await live.list("anthropic")).map((m) => [m.id, m.reasoningLevels.join(",")])).toEqual([
      ["claude-opus-5-5", "low,high"],
      ["claude-sonnet-5-5", "low,medium,high,xhigh,max"],
    ]);
    const offline = new ClaudeModelCatalog(async () => {
      throw new Error("not logged in");
    });
    expect((await offline.list("anthropic")).map((m) => m.id)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ]);
    expect(await offline.list("qwen-token-plan-individual")).toEqual([]);
    expect(fromSdkModels([{ value: "claude-future-9", displayName: "Future" }])[0]).toMatchObject({
      contextWindow: 200_000,
    });
    expect(validateClaudeToken("sk-ant-oat01-abcdefghijklmnopqrstuvwxyz012345").ok).toBe(true);
    expect(validateClaudeToken("sk-ant-api03-abcdefghijklmnopqrstuvwxyz").ok).toBe(false);
  });
});
