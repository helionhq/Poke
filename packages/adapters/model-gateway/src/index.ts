import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  Tool,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import type { Embeddings, Logger } from "@poke/domain";

/** Aliases Honcho is configured with; the gateway serves whatever the Memory role is set to. */
export const CHAT_ALIAS = "poke-memory";
export const EMBED_ALIAS = "poke-embed";
export const GATEWAY_PORT = 7071;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface GatewayUsage {
  role: "memory.chat" | "memory.embeddings";
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  ms: number;
  error?: string;
}

export interface GatewayOptions {
  /** The internal gateway key Honcho sends as a bearer token (vault system `gateway.key`). */
  key(): string | undefined;
  /** The Memory chat model, resolved from `poke model`. Undefined: not set. */
  chat(): { model: Model<Api>; reasoning?: string } | undefined;
  stream(model: Model<Api>, context: Context, options: SimpleStreamOptions): AssistantMessageEventStream;
  /** The Memory embeddings model. Undefined or unconfigured: not set. */
  embeddings(): (Embeddings & { configured(): boolean; model?(): string | undefined }) | undefined;
  onUsage?(usage: GatewayUsage): void;
  log: Logger;
}

class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type = "invalid_request_error",
  ) {
    super(message);
  }
}

// ── OpenAI chat request → pi-ai context ──────────────────────────────────────────────────────

interface OpenAIToolCall {
  id: string;
  type?: "function";
  function: { name: string; arguments?: string };
}

interface OpenAIMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | null | Array<{ type: string; text?: string; image_url?: { url: string } | string }>;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatRequest {
  model?: string;
  messages: OpenAIMessage[];
  tools?: Array<{ type: "function"; function: { name: string; description?: string; parameters?: object } }>;
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  response_format?: {
    type: "text" | "json_object" | "json_schema";
    json_schema?: { schema?: unknown; name?: string };
  };
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
}

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function textOf(content: OpenAIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function userContent(content: OpenAIMessage["content"]): string | (TextContent | ImageContent)[] {
  if (!Array.isArray(content)) return content ?? "";
  const parts: (TextContent | ImageContent)[] = [];
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") parts.push({ type: "text", text: part.text });
    if (part.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      const match = /^data:([^;]+);base64,(.+)$/.exec(url ?? "");
      if (match) parts.push({ type: "image", mimeType: match[1]!, data: match[2]! });
    }
  }
  return parts;
}

function parseArguments(raw: string | undefined): ToolCall["arguments"] {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as ToolCall["arguments"])
      : {};
  } catch {
    return {};
  }
}

/**
 * Translates an OpenAI chat request for the Memory model. pi-ai has no response_format or
 * forced tool choice, so those become instructions; JSON replies are unwrapped from code fences.
 */
export function toPiContext(
  body: ChatRequest,
  model: Model<Api>,
  now = Date.now(),
): { context: Context; toolChoice: "auto" | "none"; json: boolean; maxTokens?: number } {
  if (!Array.isArray(body.messages) || body.messages.length === 0)
    throw new GatewayError(400, "messages must be a non-empty array");
  const system: string[] = [];
  const messages: Message[] = [];
  const toolNames = new Map<string, string>();
  for (const m of body.messages) {
    switch (m.role) {
      case "system":
      case "developer":
        system.push(textOf(m.content));
        break;
      case "user":
        messages.push({ role: "user", content: userContent(m.content), timestamp: now });
        break;
      case "assistant": {
        const content: AssistantMessage["content"] = [];
        const text = textOf(m.content);
        if (text) content.push({ type: "text", text });
        for (const call of m.tool_calls ?? []) {
          toolNames.set(call.id, call.function.name);
          content.push({
            type: "toolCall",
            id: call.id,
            name: call.function.name,
            arguments: parseArguments(call.function.arguments),
          });
        }
        messages.push({
          role: "assistant",
          content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: ZERO_USAGE,
          stopReason: m.tool_calls?.length ? "toolUse" : "stop",
          timestamp: now,
        });
        break;
      }
      case "tool":
        messages.push({
          role: "toolResult",
          toolCallId: m.tool_call_id ?? "",
          toolName: toolNames.get(m.tool_call_id ?? "") ?? m.name ?? "tool",
          content: [{ type: "text", text: textOf(m.content) }],
          isError: false,
          timestamp: now,
        });
        break;
      default:
        throw new GatewayError(400, `Unknown message role ${String((m as { role: unknown }).role)}`);
    }
  }
  const tools: Tool[] = (body.tools ?? []).map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    parameters: t.function.parameters ?? { type: "object", properties: {} },
  }));
  let toolChoice: "auto" | "none" = "auto";
  if (body.tool_choice === "none") toolChoice = "none";
  else if (body.tool_choice === "required") system.push("You must call one of the tools in this reply.");
  else if (typeof body.tool_choice === "object")
    system.push(`You must call the ${body.tool_choice.function.name} tool in this reply.`);
  const format = body.response_format?.type;
  const json = format === "json_object" || format === "json_schema";
  if (format === "json_object")
    system.push("Reply with a single JSON object only: no prose, no code fences.");
  if (format === "json_schema")
    system.push(
      `Reply with a single JSON object only (no prose, no code fences) that matches this JSON Schema:\n${JSON.stringify(body.response_format?.json_schema?.schema ?? {})}`,
    );
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  return {
    context: {
      ...(system.filter(Boolean).length ? { systemPrompt: system.filter(Boolean).join("\n\n") } : {}),
      messages,
      ...(tools.length ? { tools } : {}),
    },
    toolChoice,
    json,
    ...(maxTokens ? { maxTokens } : {}),
  };
}

/** A JSON reply without the ```json fence some models add anyway. */
export function unwrapJson(text: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/i.exec(text);
  return fenced ? fenced[1]!.trim() : text.trim();
}

// ── pi-ai answer → OpenAI response ───────────────────────────────────────────────────────────

function finishReason(message: AssistantMessage): "stop" | "length" | "tool_calls" {
  if (message.content.some((c) => c.type === "toolCall")) return "tool_calls";
  return message.stopReason === "length" ? "length" : "stop";
}

function usageOf(message: AssistantMessage) {
  const prompt = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: message.usage.output,
    total_tokens: prompt + message.usage.output,
  };
}

export function toOpenAIResponse(message: AssistantMessage, id: string, model: string, json: boolean) {
  const text = message.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
  const calls = message.content.filter((c): c is ToolCall => c.type === "toolCall");
  return {
    id,
    object: "chat.completion",
    created: Math.floor(message.timestamp / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text ? (json ? unwrapJson(text) : text) : null,
          ...(calls.length
            ? {
                tool_calls: calls.map((c) => ({
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
                })),
              }
            : {}),
        },
        finish_reason: finishReason(message),
      },
    ],
    usage: usageOf(message),
  };
}

// ── the server ───────────────────────────────────────────────────────────────────────────────

/**
 * The OpenAI-compatible façade Honcho's modules talk to (section 8): chat completions on the Memory
 * chat model through pi-ai, embeddings through Voyage, behind the internal gateway key. The
 * Claude subscription is never reachable here: only pi-ai providers resolve.
 */
export class ModelGateway {
  #server?: Server;

  constructor(private readonly options: GatewayOptions) {}

  async listen(host: string, port = GATEWAY_PORT): Promise<{ host: string; port: number }> {
    const server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.#server = server;
    const address = server.address();
    return { host, port: typeof address === "object" && address ? address.port : port };
  }

  /** host:port while listening. */
  address(): string | undefined {
    const address = this.#server?.address();
    return typeof address === "object" && address ? `${address.address}:${address.port}` : undefined;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      this.#authorize(req);
      const path = (req.url ?? "/").split("?")[0]!.replace(/\/+$/, "");
      if (req.method === "GET" && path === "/v1/models") return send(res, 200, this.#models());
      if (req.method === "POST" && path === "/v1/chat/completions")
        return await this.#chat(req, res, (await readJson(req)) as ChatRequest);
      if (req.method === "POST" && path === "/v1/embeddings")
        return await this.#embeddings(req, res, (await readJson(req)) as EmbeddingsRequest);
      throw new GatewayError(404, "Not found");
    } catch (error) {
      const status = error instanceof GatewayError ? error.status : 502;
      const type = error instanceof GatewayError ? error.type : "upstream_error";
      const message = error instanceof Error ? error.message : String(error);
      if (status >= 500) this.options.log.warn({ status, error: message }, "model gateway error");
      if (!res.headersSent) send(res, status, { error: { message, type } });
      else res.end();
    }
  }

  #authorize(req: IncomingMessage): void {
    const key = this.options.key();
    if (!key) throw new GatewayError(503, "The model gateway has no key yet", "unavailable");
    const header = req.headers.authorization ?? "";
    const given = Buffer.from(header.replace(/^Bearer\s+/i, ""));
    const expected = Buffer.from(key);
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      throw new GatewayError(401, "Invalid gateway key", "authentication_error");
  }

  #models() {
    const data = [];
    if (this.options.chat()) data.push({ id: CHAT_ALIAS, object: "model", owned_by: "poke" });
    if (this.options.embeddings()?.configured())
      data.push({ id: EMBED_ALIAS, object: "model", owned_by: "poke" });
    return { object: "list", data };
  }

  async #chat(req: IncomingMessage, res: ServerResponse, body: ChatRequest): Promise<void> {
    const chat = this.options.chat();
    if (!chat)
      throw new GatewayError(503, "The Memory chat model isn't set. Run `poke model`.", "unavailable");
    const { context, toolChoice, json, maxTokens } = toPiContext(body, chat.model);
    const id = `chatcmpl-${randomBytes(12).toString("hex")}`;
    const alias = body.model ?? CHAT_ALIAS;
    const controller = new AbortController();
    req.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const started = Date.now();
    const stream = this.options.stream(chat.model, context, {
      signal: controller.signal,
      toolChoice,
      ...(maxTokens ? { maxTokens } : {}),
      ...(chat.reasoning ? { reasoning: chat.reasoning as SimpleStreamOptions["reasoning"] } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    });
    const record = (message: AssistantMessage | undefined, error?: string) =>
      this.options.onUsage?.({
        role: "memory.chat",
        provider: chat.model.provider,
        model: chat.model.id,
        input: message?.usage.input ?? 0,
        output: message?.usage.output ?? 0,
        cacheRead: message?.usage.cacheRead ?? 0,
        cacheWrite: message?.usage.cacheWrite ?? 0,
        ms: Date.now() - started,
        ...(error ? { error } : {}),
      });

    if (!body.stream) {
      const message = await stream.result();
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        record(message, message.errorMessage ?? message.stopReason);
        throw new GatewayError(502, message.errorMessage ?? "The Memory model failed", "upstream_error");
      }
      record(message);
      return send(res, 200, toOpenAIResponse(message, id, alias, json));
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra = {}) =>
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: alias, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`,
      );
    chunk({ role: "assistant", content: "" });
    let toolIndex = 0;
    // JSON replies are sent whole at the end, so a fence can be removed.
    let jsonText = "";
    for await (const event of stream) {
      if (event.type === "text_delta") {
        if (json) jsonText += event.delta;
        else chunk({ content: event.delta });
      } else if (event.type === "toolcall_end") {
        chunk({
          tool_calls: [
            {
              index: toolIndex++,
              id: event.toolCall.id,
              type: "function",
              function: {
                name: event.toolCall.name,
                arguments: JSON.stringify(event.toolCall.arguments ?? {}),
              },
            },
          ],
        });
      } else if (event.type === "done") {
        if (json && jsonText) chunk({ content: unwrapJson(jsonText) });
        record(event.message);
        chunk({}, finishReason(event.message));
        if (body.stream_options?.include_usage)
          res.write(
            `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: alias, choices: [], usage: usageOf(event.message) })}\n\n`,
          );
      } else if (event.type === "error") {
        record(event.error, event.error.errorMessage ?? event.reason);
        res.write(
          `data: ${JSON.stringify({ error: { message: event.error.errorMessage ?? "The Memory model failed", type: "upstream_error" } })}\n\n`,
        );
      }
    }
    res.end("data: [DONE]\n\n");
  }

  async #embeddings(req: IncomingMessage, res: ServerResponse, body: EmbeddingsRequest): Promise<void> {
    const embeddings = this.options.embeddings();
    if (!embeddings?.configured())
      throw new GatewayError(503, "The Memory embeddings model isn't set. Run `poke model`.", "unavailable");
    const inputs = typeof body.input === "string" ? [body.input] : body.input;
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.some((i) => typeof i !== "string"))
      throw new GatewayError(400, "input must be a string or an array of strings");
    // Documents by default; a query when Poke's header or the model suffix says so.
    const header = String(req.headers["x-poke-input-type"] ?? "").toLowerCase();
    const kind = header === "query" || /[:/-]query$/i.test(body.model ?? "") ? "query" : "document";
    const started = Date.now();
    let vectors: number[][];
    try {
      vectors = await embeddings.embed(inputs, kind);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#recordEmbeddings(embeddings, Date.now() - started, 0, message);
      throw new GatewayError(502, message, "upstream_error");
    }
    const tokens = (embeddings as { takeTokens?(): number }).takeTokens?.() ?? 0;
    this.#recordEmbeddings(embeddings, Date.now() - started, tokens);
    const base64 = body.encoding_format === "base64";
    send(res, 200, {
      object: "list",
      data: vectors.map((embedding, index) => ({
        object: "embedding",
        index,
        embedding: base64 ? Buffer.from(new Float32Array(embedding).buffer).toString("base64") : embedding,
      })),
      model: body.model ?? EMBED_ALIAS,
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    });
  }

  #recordEmbeddings(
    embeddings: { model?(): string | undefined },
    ms: number,
    tokens: number,
    error?: string,
  ) {
    this.options.onUsage?.({
      role: "memory.embeddings",
      provider: "voyage",
      model: embeddings.model?.() ?? "voyage",
      input: tokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      ms,
      ...(error ? { error } : {}),
    });
  }
}

interface EmbeddingsRequest {
  input: string | string[];
  model?: string;
  encoding_format?: "float" | "base64";
  dimensions?: number;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new GatewayError(413, "Request too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new GatewayError(400, "Body isn't valid JSON");
  }
}
