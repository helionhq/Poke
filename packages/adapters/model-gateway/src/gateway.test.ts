import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { silentLogger } from "@poke/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GatewayUsage, ModelGateway, toPiContext, unwrapJson } from "./index.js";

const faux = fauxProvider({ provider: "faux", models: [{ id: "m1", contextWindow: 100_000 }] });
const none: CredentialStore = {
  read: async (): Promise<Credential | undefined> => undefined,
  list: async (): Promise<readonly CredentialInfo[]> => [],
  modify: async () => undefined,
  delete: async () => {},
};
const models = createModels({
  credentials: none,
  authContext: { env: async () => undefined, fileExists: async () => false },
  identity: { attribution: null },
});
models.setProvider(faux.provider);
const model = models.getModel("faux", "m1")!;

const usage: GatewayUsage[] = [];
let chatSet = true;
const gateway = new ModelGateway({
  key: () => "gw-key",
  chat: () => (chatSet ? { model } : undefined),
  stream: (m, context, options) => models.streamSimple(m, context, options),
  embeddings: () => ({
    dimensions: 3,
    configured: () => true,
    model: () => "voyage-4",
    embed: async (input: string[], kind: "document" | "query") =>
      input.map((_, i) => [i, kind === "query" ? 1 : 0, 0.5]),
  }),
  onUsage: (u) => usage.push(u),
  log: silentLogger,
});
let base = "";
beforeAll(async () => {
  const { port } = await gateway.listen("127.0.0.1", 0);
  base = `http://127.0.0.1:${port}`;
});
afterAll(() => gateway.close());

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: "Bearer gw-key", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

interface Body {
  data: Array<{ id: string; embedding: number[] }>;
  choices: Array<{
    message: {
      content: string;
      tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
    };
    finish_reason: string;
  }>;
  error: { message: string };
}
const body = (res: Response) => res.json() as Promise<Body>;

describe("model gateway", () => {
  it("needs the gateway key", async () => {
    const res = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
    const ok = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer gw-key" } });
    expect((await body(ok)).data.map((m: { id: string }) => m.id)).toEqual(["poke-memory", "poke-embed"]);
  });

  it("round-trips tool calls and their ids", async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("save_fact", { fact: "likes figs" }, { id: "call_9" })], {
        stopReason: "toolUse",
      }),
      (context) => {
        const result = context.messages.find((m) => m.role === "toolResult");
        return fauxAssistantMessage(
          `saw ${result && "toolCallId" in result ? result.toolCallId : "nothing"}`,
        );
      },
    ]);
    const tools = [{ type: "function", function: { name: "save_fact", parameters: { type: "object" } } }];
    const first = await body(
      await post("/v1/chat/completions", {
        model: "poke-memory",
        messages: [
          { role: "system", content: "You derive facts." },
          { role: "user", content: "I love figs" },
        ],
        tools,
      }),
    );
    const call = first.choices[0]?.message.tool_calls[0];
    expect(first.choices[0]?.finish_reason).toBe("tool_calls");
    expect(call).toEqual({
      id: "call_9",
      type: "function",
      function: { name: "save_fact", arguments: '{"fact":"likes figs"}' },
    });
    const second = await body(
      await post("/v1/chat/completions", {
        messages: [
          { role: "user", content: "I love figs" },
          { role: "assistant", content: null, tool_calls: [call] },
          { role: "tool", tool_call_id: "call_9", content: "saved" },
        ],
        tools,
      }),
    );
    expect(second.choices[0]?.message.content).toBe("saw call_9");
    expect(usage.at(-1)).toMatchObject({ role: "memory.chat", provider: "faux", model: "m1" });
  });

  it("streams text as server-sent events, and unwraps JSON replies", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("Hello there")])]);
    const res = await post("/v1/chat/completions", {
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const raw = await res.text();
    const events = raw
      .split("\n\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice(6)));
    const text = events.map((e) => e.choices[0]?.delta?.content ?? "").join("");
    expect(text).toBe("Hello there");
    expect(events.some((e) => e.choices[0]?.finish_reason === "stop")).toBe(true);
    expect(events.at(-1).usage).toBeDefined();
    expect(raw.trim().endsWith("data: [DONE]")).toBe(true);

    faux.setResponses([fauxAssistantMessage('```json\n{"facts":["likes figs"]}\n```')]);
    const json = await body(
      await post("/v1/chat/completions", {
        messages: [{ role: "user", content: "extract" }],
        response_format: { type: "json_object" },
      }),
    );
    expect(JSON.parse(json.choices[0]?.message.content ?? "")).toEqual({ facts: ["likes figs"] });
  });

  it("embeds documents by default and queries on request", async () => {
    const docs = await body(await post("/v1/embeddings", { model: "poke-embed", input: ["a", "b"] }));
    expect(docs.data.map((d: { embedding: number[] }) => d.embedding)).toEqual([
      [0, 0, 0.5],
      [1, 0, 0.5],
    ]);
    const query = await body(await post("/v1/embeddings", { input: "a" }, { "x-poke-input-type": "query" }));
    expect(query.data[0]?.embedding[1]).toBe(1);
  });

  it("says plainly when the Memory model isn't set", async () => {
    chatSet = false;
    const res = await post("/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(503);
    expect((await body(res)).error.message).toContain("poke model");
    chatSet = true;
  });

  it("turns forced tool choice and schemas into instructions", () => {
    const { context, toolChoice, json } = toPiContext(
      {
        messages: [{ role: "user", content: "x" }],
        tool_choice: { type: "function", function: { name: "save" } },
        response_format: { type: "json_schema", json_schema: { schema: { type: "object" } } },
      },
      model,
    );
    expect(toolChoice).toBe("auto");
    expect(json).toBe(true);
    expect(context.systemPrompt).toContain("must call the save tool");
    expect(context.systemPrompt).toContain('{"type":"object"}');
    expect(unwrapJson('  {"a":1} ')).toBe('{"a":1}');
  });
});
