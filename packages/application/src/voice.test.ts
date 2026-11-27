import type {
  Logger,
  Message,
  SpeechToText,
  SttEvents,
  TextToSpeech,
  TtsStream,
  TtsStreamEvents,
} from "@poke/domain";
import { describe, expect, it, vi } from "vitest";
import type { AttachmentService } from "./attachments.js";
import type { EventHub, HubListener } from "./core/hub.js";
import type { ThreadService } from "./thread.js";
import { speakable, speakableHead, VoiceCall, type CallOutput } from "./voice.js";

const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  let stt!: SttEvents;
  let tts!: TtsStreamEvents;
  const sentAudio: Uint8Array[] = [];
  const ttsStream: TtsStream & { pushed: string[]; flushes: number; cancels: number } = {
    pushed: [],
    flushes: 0,
    cancels: 0,
    push(text) {
      ttsStream.pushed.push(text);
    },
    flush() {
      ttsStream.flushes++;
    },
    cancel() {
      ttsStream.cancels++;
    },
    close: async () => {},
  };
  const speech: SpeechToText = {
    configured: () => true,
    open: async (events) => {
      stt = events;
      return { send: (pcm) => sentAudio.push(pcm), forceEndpoint() {}, close: async () => {} };
    },
  };
  const voice: TextToSpeech = {
    configured: () => true,
    voices: async () => [],
    speak: async () => new Uint8Array(),
    open: async (events) => {
      tts = events;
      return ttsStream;
    },
    streamSampleRate: 24000,
  };
  const listeners = new Set<HubListener>();
  const hub = {
    subscribe(fn: HubListener) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  } as unknown as EventHub;
  const emitFrame = (frame: Parameters<HubListener>[0]) => listeners.forEach((fn) => fn(frame));
  const sends: Array<{ text: string; attachmentIds: string[]; origin?: unknown }> = [];
  const thread = { send: vi.fn((input) => sends.push(input)) } as unknown as ThreadService;
  const attachments = {
    store: vi.fn(async () => ({ id: "att_1" })),
  } as unknown as AttachmentService;
  const out: CallOutput[] = [];
  let n = 0;
  const call = new VoiceCall(
    {
      stt: speech,
      tts: voice,
      thread,
      hub,
      attachments,
      ids: { next: (p) => `${p}_${++n}` },
      clock: { now: () => 1000 + n },
      log,
      keyterms: ["Arham"],
    },
    (o) => out.push(o),
  );
  const reply = (status: Message["status"], text: string, type: "message.created" | "message.updated") =>
    emitFrame({
      kind: "event",
      stored: {
        seq: 1,
        at: 0,
        event: {
          type,
          message: {
            id: "msg_poke",
            scope: "main",
            role: "poke",
            parts: [{ type: "text", text }],
            status,
            origin: { kind: "agent" },
            createdAt: 0,
            updatedAt: 0,
          } as unknown as Message,
        },
      },
    } as Parameters<HubListener>[0]);
  const delta = (text: string) =>
    emitFrame({ kind: "live", event: { type: "message.delta", messageId: "msg_poke", scope: "main", text } });
  return {
    call,
    out,
    sends,
    sentAudio,
    ttsStream,
    attachments,
    reply,
    delta,
    stt: () => stt,
    tts: () => tts,
  };
}

describe("VoiceCall", () => {
  it("sends his turn as a voice message and speaks the streamed reply", async () => {
    const t = setup();
    await t.call.start();
    await tick();
    expect(t.out[0]).toEqual({ type: "ready", sampleRate: 24000 });

    t.call.audio(new Uint8Array(4));
    expect(t.sentAudio).toHaveLength(1);
    t.stt().onPartial("what time");
    t.stt().onTurn("What time is dinner?");
    await tick();
    expect(t.sends[0]).toMatchObject({
      text: "What time is dinner?",
      origin: { kind: "voice" },
      attachmentIds: [],
    });

    t.reply("streaming", "", "message.created");
    t.delta("Dinner is at **7:30**. ");
    t.delta("See [the menu](https://example.com).");
    await tick();
    // Whole words go out as they arrive; the last word waits for the end of the reply.
    expect(t.ttsStream.pushed).toEqual(["Dinner is at 7:30. ", "See "]);
    t.tts().onAudio(new Uint8Array([9]));
    expect(t.out.some((o) => o.type === "audio")).toBe(true);

    t.reply("complete", "Dinner is at **7:30**. See [the menu](https://example.com).", "message.updated");
    await tick();
    expect(t.ttsStream.pushed.at(-1)).toBe("the menu.");
    expect(t.ttsStream.flushes).toBe(1);
    expect(t.out).toContainEqual({ type: "poke", text: expect.stringContaining("Dinner"), final: true });
    t.tts().onFlushed?.();
    expect(t.out.at(-1)).toEqual({ type: "state", state: "listening" });
  });

  it("barge-in cancels speech, tells the phone to drop audio, and mutes the rest of that reply", async () => {
    const t = setup();
    await t.call.start();
    t.stt().onTurn("Tell me a story");
    await tick();
    t.reply("streaming", "", "message.created");
    t.delta("Once upon a time ");
    await tick();
    t.stt().onSpeechStarted?.();
    expect(t.ttsStream.cancels).toBe(1);
    expect(t.out).toContainEqual({ type: "interrupt" });
    t.delta("there was a dragon.");
    await tick();
    expect(t.ttsStream.pushed).toEqual(["Once upon a time "]);
    t.tts().onAudio(new Uint8Array([1]));
    expect(t.out.filter((o) => o.type === "audio")).toHaveLength(0);
  });

  it("attaches the newest camera frame to the next turn only", async () => {
    const t = setup();
    await t.call.start();
    t.call.frame(new Uint8Array([0xff, 0xd8]));
    t.stt().onTurn("What is this?");
    await tick();
    expect(t.sends[0]!.attachmentIds).toEqual(["att_1"]);
    t.stt().onTurn("And now?");
    await tick();
    expect(t.sends[1]!.attachmentIds).toEqual([]);
  });

  it("drops mic audio while muted and ends cleanly", async () => {
    const t = setup();
    await t.call.start();
    t.call.mute(true);
    t.call.audio(new Uint8Array(4));
    expect(t.sentAudio).toHaveLength(0);
    await t.call.end();
    expect(t.out.at(-1)).toEqual({ type: "ended" });
  });
});

describe("speakableHead", () => {
  it("holds a partial word and an unclosed link", () => {
    expect(speakableHead("Hello wor")).toEqual({ head: "Hello ", rest: "wor" });
    expect(speakableHead("See [the me")).toEqual({ head: "See ", rest: "[the me" });
    expect(speakableHead("See [it](https://x) now")).toEqual({ head: "See [it](https://x) ", rest: "now" });
  });
});

describe("speakable", () => {
  it("drops markdown and reads links by their label", () => {
    expect(speakable("**Bold** and `code` at https://x.y/z ok")).toBe("Bold and code at a link ok");
    expect(speakable("# Title")).toBe(" Title");
  });
});
