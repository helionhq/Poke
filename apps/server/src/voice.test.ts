import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationRuntime, SpeechToText, SttEvents, TextToSpeech, TtsStream } from "@poke/domain";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { buildApp } from "./http/app.js";
import { resolvePaths } from "./infra/paths.js";
import { createKernel, type Kernel } from "./kernel.js";
import { servicesFromKernel } from "./services.js";
import { type AgentStack, openAgentStack } from "./stack.js";

/** No model is set in these tests, so Poke never starts a turn. */
const idle: ConversationRuntime = {
  kind: "claude-agent-sdk",
  capabilities: () => ({ steering: true, idleCompaction: "none", toolSearch: true, codemode: false }),
  openSession: async () => {
    throw new Error("not used");
  },
};

let sttEvents: SttEvents | undefined;
const received: Uint8Array[] = [];
let speakCalls = 0;
const stt: SpeechToText = {
  configured: () => true,
  open: async (events) => {
    sttEvents = events;
    return {
      send: (pcm) => received.push(pcm),
      forceEndpoint() {},
      close: async () => {
        events.onTurn("last words");
      },
    };
  },
};
const tts: TextToSpeech = {
  configured: () => true,
  voices: async () => [{ id: "aai-kyla", name: "Kyla" }],
  speak: async () => {
    speakCalls++;
    return new Uint8Array([82, 73, 70, 70]);
  },
  open: async () => ({ push() {}, flush() {}, cancel() {}, close: async () => {} }) satisfies TtsStream,
  streamSampleRate: 24000,
};

let home: string;
let kernel: Kernel;
let stack: AgentStack;
let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  sttEvents = undefined;
  received.length = 0;
  speakCalls = 0;
  home = mkdtempSync(join(tmpdir(), "poke-voice-"));
  kernel = createKernel({ paths: resolvePaths(home) });
  stack = await openAgentStack(kernel, {
    runtimes: { "claude-agent-sdk": idle, "pi-ai": idle },
    claudeLive: false,
    validateLogins: false,
    modelGateway: false,
    browse: false,
    speech: { stt, tts },
  });
  app = await buildApp(servicesFromKernel(kernel, { version: "test", stack }), "public");
  const { code } = kernel.devices.issuePairingCode();
  token = (
    await app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code, deviceName: "iPhone", platform: "ios" },
    })
  ).json().token;
});

afterEach(async () => {
  await app.close();
  await stack.shutdown();
  kernel.close();
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

async function socket(path: string): Promise<{ ws: WebSocket; frames: Array<Record<string, unknown>> }> {
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const ws = new WebSocket(`${address.replace("http", "ws")}${path}`, { headers: auth() });
  const frames: Array<Record<string, unknown>> = [];
  ws.on("message", (raw, isBinary) => {
    if (!isBinary) frames.push(JSON.parse(raw.toString()) as Record<string, unknown>);
  });
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  return { ws, frames };
}

describe("voice", () => {
  it("reports the voice setup and reads a message aloud once, then from the cache", async () => {
    const info = await app.inject({ method: "GET", url: "/v1/voice", headers: auth() });
    expect(info.json()).toMatchObject({
      configured: true,
      voice: "aai-kyla",
      inputSampleRate: 16000,
      outputSampleRate: 24000,
    });

    const sent = await app.inject({
      method: "POST",
      url: "/v1/thread/messages",
      headers: auth(),
      payload: { text: "Read **this** please", clientMessageId: "voice-000001" },
    });
    const messageId = sent.json().message.id as string;
    for (let i = 0; i < 2; i++) {
      const clip = await app.inject({
        method: "POST",
        url: "/v1/tts",
        headers: auth(),
        payload: { messageId },
      });
      expect(clip.statusCode).toBe(200);
      expect(clip.headers["content-type"]).toBe("audio/wav");
      expect(clip.rawPayload.subarray(0, 4).toString()).toBe("RIFF");
    }
    expect(speakCalls).toBe(1);
    expect(readdirSync(join(kernel.paths.data, "tts"))).toHaveLength(1);

    const bad = await app.inject({
      method: "POST",
      url: "/v1/tts",
      headers: auth(),
      payload: { messageId, voice: "../../etc" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("dictation streams partials and finals, and stop waits for the last words", async () => {
    const { ws, frames } = await socket("/v1/voice/dictate");
    await until(() => frames.some((f) => f.type === "ready"));
    ws.send(new Uint8Array([1, 2, 3, 4]), { binary: true });
    await until(() => received.length === 1);
    sttEvents!.onPartial("hello wor");
    sttEvents!.onTurn("Hello world.");
    ws.send(JSON.stringify({ type: "stop" }));
    await until(() => frames.some((f) => f.type === "done"));
    expect(frames.map((f) => f.type)).toEqual(["ready", "partial", "final", "final", "done"]);
    expect(frames.at(-2)).toEqual({ type: "final", text: "last words" });
  });

  it("a call puts his turns in the thread as voice messages", async () => {
    const { ws, frames } = await socket("/v1/voice/call");
    await until(() => frames.some((f) => f.type === "ready"));
    expect(frames[0]).toEqual({ type: "ready", sampleRate: 24000 });
    ws.send(new Uint8Array([5, 6]), { binary: true });
    await until(() => received.length === 1);
    sttEvents!.onTurn("Remind me to call Mum.");
    const message = await until(() =>
      kernel.thread.page({ limit: 5 }).messages.find((m) => m.role === "user"),
    );
    expect(message.origin).toEqual({ kind: "voice" });
    await until(() => frames.some((f) => f.type === "user" && f.final === true));
    expect(frames).toContainEqual({ type: "user", text: "Remind me to call Mum.", final: true });
    ws.send(JSON.stringify({ type: "end" }));
    await until(() => frames.some((f) => f.type === "ended"));
  });

  it("lets the phone pick a voice but not other settings", async () => {
    const before = await app.inject({ method: "GET", url: "/v1/settings", headers: auth() });
    expect(before.json().settings).toMatchObject({ wallpaper: "haze", readAloudAuto: false });
    const patched = await app.inject({
      method: "PATCH",
      url: "/v1/settings",
      headers: auth(),
      payload: { voice: "aai-titus" },
    });
    expect(patched.json().settings.voice).toBe("aai-titus");
    expect((await app.inject({ method: "GET", url: "/v1/voice", headers: auth() })).json().voice).toBe(
      "aai-titus",
    );
    const sneaky = await app.inject({
      method: "PATCH",
      url: "/v1/settings",
      headers: auth(),
      payload: { "public.url": "https://evil.example" },
    });
    expect(sneaky.json().settings).not.toHaveProperty("public.url");
    expect(kernel.settings.get("public.url")).not.toBe("https://evil.example");
  });

  it("refuses a socket without a device token", async () => {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const ws = new WebSocket(`${address.replace("http", "ws")}/v1/voice/call`);
    const outcome = await new Promise<string>((resolve) => {
      ws.on("close", (code) => resolve(String(code)));
      ws.on("unexpected-response", (_req, res) => resolve(String(res.statusCode)));
      ws.on("error", () => resolve("error"));
    });
    expect(["401", "4401"]).toContain(outcome);
  });
});
