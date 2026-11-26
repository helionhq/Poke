import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CompactionInfo,
  ConversationRuntime,
  ConversationSession,
  RuntimeEvent,
  SessionSpec,
  TurnInput,
} from "@poke/domain";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./http/app.js";
import { resolvePaths } from "./infra/paths.js";
import { createKernel, type Kernel } from "./kernel.js";
import { servicesFromKernel } from "./services.js";
import { type AgentStack, openAgentStack, openModelStack } from "./stack.js";

class EchoSession implements ConversationSession {
  readonly ref = "echo-1";
  turns: TurnInput[] = [];
  constructor(readonly spec: SessionSpec) {}
  async *startTurn(input: TurnInput): AsyncIterable<RuntimeEvent> {
    this.turns.push(input);
    yield { type: "session", ref: this.ref };
    const first = input.text.split("\n")[0]!;
    if (first.startsWith("search ")) {
      const result = await this.spec.invoker.invoke(
        "search_thread",
        { query: first.slice(7) },
        { agent: { kind: "poke" }, callId: "t1", signal: new AbortController().signal },
      );
      yield { type: "text.done", text: JSON.stringify(result) };
    } else {
      yield { type: "text.done", text: `echo: ${first}` };
    }
    yield { type: "turn.done" };
  }
  async steer() {
    return false;
  }
  async cancel() {}
  async compact(): Promise<CompactionInfo> {
    return { preTokens: 1000, postTokens: 100 };
  }
  onEvent() {
    return () => {};
  }
  contextTokens() {
    return 1000;
  }
  async close() {}
}

const sessions: EchoSession[] = [];
const echo: ConversationRuntime = {
  kind: "claude-agent-sdk",
  capabilities: () => ({ steering: true, idleCompaction: "none", toolSearch: true, codemode: false }),
  async openSession(spec) {
    const session = new EchoSession(spec);
    sessions.push(session);
    return session;
  },
};

let home: string;
let kernel: Kernel;
let stack: AgentStack;
let publicApp: FastifyInstance;
let adminApp: FastifyInstance;
let token: string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "poke-stack-"));
  kernel = createKernel({ paths: resolvePaths(home) });
  stack = await openAgentStack(kernel, {
    runtimes: { "claude-agent-sdk": echo, "pi-ai": echo },
    claudeLive: false,
    validateLogins: false,
  });
  const services = servicesFromKernel(kernel, { version: "test", stack });
  publicApp = await buildApp(services, "public");
  adminApp = await buildApp(services, "admin");
  const { code } = kernel.devices.issuePairingCode();
  token = (
    await publicApp.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code, deviceName: "iPhone", platform: "ios" },
    })
  ).json().token;
});

afterEach(async () => {
  await publicApp.close();
  await adminApp.close();
  await stack.shutdown();
  kernel.close();
  sessions.length = 0;
  rmSync(home, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${token}` });
async function until<T>(fn: () => T | undefined | false, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("agent stack over HTTP", () => {
  it("logs in, sets a model, and Poke answers the thread", async () => {
    const login = await adminApp.inject({
      method: "POST",
      url: "/admin/logins/anthropic",
      payload: { secret: "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().login).toMatchObject({ id: "anthropic", loggedIn: true });
    // admin routes don't exist on the public surface
    expect(
      (await publicApp.inject({ method: "GET", url: "/admin/logins", headers: auth() })).statusCode,
    ).toBe(404);

    const roles = (await adminApp.inject({ method: "GET", url: "/admin/models" })).json().roles as Array<{
      role: string;
      providers: Array<{ id: string; loggedIn: boolean }>;
    }>;
    expect(roles.find((r) => r.role === "agents")!.providers.map((p) => p.id)).toEqual([
      "qwen-token-plan-individual",
      "qwen-token-plan-individual-cn",
    ]);
    expect(roles.find((r) => r.role === "poke")!.providers.find((p) => p.id === "anthropic")!.loggedIn).toBe(
      true,
    );

    const list = await adminApp.inject({ method: "GET", url: "/admin/models/providers/anthropic" });
    expect(list.json().models.map((m: { id: string }) => m.id)).toContain("claude-opus-5-5");
    const qwen = await adminApp.inject({
      method: "GET",
      url: "/admin/models/providers/qwen-token-plan-individual",
    });
    expect(qwen.json().models.length).toBeGreaterThan(0);

    const refused = await adminApp.inject({
      method: "PUT",
      url: "/admin/models/agents",
      payload: { provider: "anthropic", model: "claude-opus-5-5" },
    });
    expect(refused.statusCode).toBe(403);
    const set = await adminApp.inject({
      method: "PUT",
      url: "/admin/models/poke",
      payload: { provider: "anthropic", model: "claude-opus-5-5", reasoning: "high", voiceReasoning: "low" },
    });
    expect(set.statusCode).toBe(200);

    const sent = await publicApp.inject({
      method: "POST",
      url: "/v1/thread/messages",
      headers: auth(),
      payload: { text: "hello there", clientMessageId: "client-m1", attachmentIds: [] },
    });
    expect(sent.statusCode).toBe(200);
    await until(() =>
      kernel.db.messages.recent(10).find((m) => m.role === "poke" && m.status === "complete"),
    );
    const reply = kernel.db.messages.recent(10).find((m) => m.role === "poke")!;
    expect(reply.parts).toEqual([{ type: "text", text: "echo: hello there" }]);
    expect(sessions[0]!.spec).toMatchObject({
      profile: "poke",
      budget: 272_000,
      cwd: kernel.paths.workspace,
    });

    const context = await publicApp.inject({ method: "GET", url: "/v1/context", headers: auth() });
    expect(context.json()).toMatchObject({ tokens: 1000, budget: 272_000 });
    const models = await publicApp.inject({ method: "GET", url: "/v1/models", headers: auth() });
    expect(models.json().roles.find((r: { role: string }) => r.role === "poke").assignment).toMatchObject({
      model: "claude-opus-5-5",
      reasoning: "high",
      voiceReasoning: "low",
    });
    expect((await publicApp.inject({ method: "GET", url: "/v1/tasks", headers: auth() })).json()).toEqual({
      tasks: [],
    });

    const removed = await adminApp.inject({ method: "DELETE", url: "/admin/logins/anthropic" });
    expect(removed.json()).toEqual({ removed: true });
  });

  it("redacts login secrets from tool results", async () => {
    await adminApp.inject({
      method: "POST",
      url: "/admin/logins/qwen",
      payload: { secret: "sk-sp-supersecretvalue99" },
    });
    await adminApp.inject({
      method: "PUT",
      url: "/admin/models/poke",
      payload: {
        provider: "qwen-token-plan-individual",
        model: (await stack.models.models("qwen-token-plan-individual"))[0]!.id,
      },
    });
    kernel.thread.send({
      text: "my key is sk-sp-supersecretvalue99 oops",
      clientMessageId: "x1",
      attachmentIds: [],
    });
    await until(() => kernel.db.messages.recent(10).filter((m) => m.role === "poke").length === 1);
    kernel.thread.send({ text: "search oops", clientMessageId: "x2", attachmentIds: [] });
    await until(
      () =>
        kernel.db.messages.recent(10).filter((m) => m.role === "poke" && m.status === "complete").length ===
        2,
    );
    const leak = kernel.db.messages
      .recent(10)
      .filter((m) => m.role === "poke")
      .at(-1)!;
    const text = JSON.stringify(leak.parts);
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("supersecretvalue99");
  });

  it("runs side chats in memory", async () => {
    expect(
      (await publicApp.inject({ method: "POST", url: "/v1/sidechats", headers: auth() })).statusCode,
    ).toBe(409);
    await stack.logins.login("anthropic", "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz");
    await stack.models.set({ role: "sidechat", provider: "anthropic", model: "claude-sonnet-5-5" });
    const opened = (await publicApp.inject({ method: "POST", url: "/v1/sidechats", headers: auth() })).json()
      .sideChat as { id: string };
    const posted = await publicApp.inject({
      method: "POST",
      url: `/v1/sidechats/${opened.id}/messages`,
      headers: auth(),
      payload: { text: "quick q" },
    });
    expect(posted.json().message).toMatchObject({ role: "user", scope: `sidechat:${opened.id}` });
    await until(() => stack.sidechats.get(opened.id).messages.length === 2);
    const chat = (
      await publicApp.inject({ method: "GET", url: `/v1/sidechats/${opened.id}`, headers: auth() })
    ).json().sideChat;
    expect(chat.messages.map((m: { parts: Array<{ text: string }> }) => m.parts[0]!.text)).toEqual([
      "quick q",
      "echo: quick q",
    ]);
    expect(sessions[0]!.spec).toMatchObject({ profile: "sidechat", persist: false });
    expect(kernel.db.messages.recent(10)).toHaveLength(0);
    expect(
      (await publicApp.inject({ method: "DELETE", url: `/v1/sidechats/${opened.id}`, headers: auth() }))
        .statusCode,
    ).toBe(200);
    expect(
      (await publicApp.inject({ method: "GET", url: `/v1/sidechats/${opened.id}`, headers: auth() }))
        .statusCode,
    ).toBe(404);
  });

  it("keeps logins in the vault across restarts, never in poke.db", async () => {
    await stack.logins.login("qwen", "sk-sp-keepme123456");
    await stack.shutdown();
    const again = await openModelStack(kernel, { validateLogins: false });
    expect(again.logins.secretFor("qwen-token-plan-individual-cn")).toBeUndefined();
    expect(again.logins.secretFor("qwen-token-plan-individual")).toBe("sk-sp-keepme123456");
    expect(again.secrets()).toContain("sk-sp-keepme123456");
    again.close();
    stack = await openAgentStack(kernel, {
      runtimes: { "claude-agent-sdk": echo, "pi-ai": echo },
      claudeLive: false,
      validateLogins: false,
    });
    const settings = JSON.stringify(kernel.settings.all());
    expect(settings).not.toContain("keepme");
  });

  it("acts on blocks: a secret goes to the real vault and is redacted from then on", async () => {
    const now = Date.now();
    const message = {
      id: kernel.ids.next("msg"),
      scope: "main" as const,
      role: "poke" as const,
      parts: [],
      status: "complete" as const,
      origin: { kind: "turn" as const },
      createdAt: now,
      updatedAt: now,
    };
    kernel.thread.saveMessage(message, "created");
    const block = stack.blocks.attach(message, {
      kind: "secret_request",
      props: {
        service: "OpenWeather",
        title: "OpenWeather API key",
        note: "For the morning weather",
        field: "API key",
        secretType: "api_key",
        vaultName: "openweather",
      },
      owner: { type: "poke" },
    });
    const get = await publicApp.inject({ method: "GET", url: `/v1/blocks/${block.id}`, headers: auth() });
    expect(get.json().block).toMatchObject({ kind: "secret_request", state: "pending" });
    expect(
      (await publicApp.inject({ method: "GET", url: "/v1/blocks/blk_nope", headers: auth() })).statusCode,
    ).toBe(404);

    const url = `/v1/blocks/${block.id}/actions`;
    const short = await publicApp.inject({
      method: "POST",
      url,
      headers: auth(),
      payload: { action: "save", payload: { value: "x" }, clientActionId: "short" },
    });
    expect(short.statusCode).toBe(400);
    const empty = await publicApp.inject({
      method: "POST",
      url,
      headers: auth(),
      payload: { action: "save", payload: { value: "" }, clientActionId: "save-empty-1" },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.message).toBe("That value can't be saved");

    const key = "owm-7f3a9c2e5b1d4f6a8c0e";
    const saved = await publicApp.inject({
      method: "POST",
      url,
      headers: auth(),
      payload: { action: "save", payload: { value: key }, clientActionId: "save-0001" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(key);
    expect(saved.json()).toMatchObject({
      duplicate: false,
      block: { state: "saved", resolution: { placeholder: "{{vault:openweather.api_key}}" } },
    });
    expect(stack.vault.resolve("openweather", "api_key")).toBe(key);
    // From now on tool output is redacted against it.
    await until(() => stack.secrets().includes(key));
    const retry = await publicApp.inject({
      method: "POST",
      url,
      headers: auth(),
      payload: { action: "save", payload: { value: key }, clientActionId: "save-0001" },
    });
    expect(retry.json()).toMatchObject({ duplicate: true, block: { state: "saved" } });
    const twice = await publicApp.inject({
      method: "POST",
      url,
      headers: auth(),
      payload: { action: "save", payload: { value: key }, clientActionId: "save-0002" },
    });
    expect(twice.statusCode).toBe(409);
  });
});
