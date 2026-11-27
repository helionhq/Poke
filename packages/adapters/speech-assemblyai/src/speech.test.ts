import { describe, expect, it, vi } from "vitest";
import { AssemblyAiStt, AssemblyAiTts, splitText, wav, type SocketLike } from "./index.js";

/** A socket the test drives: `server(msg)` delivers a JSON frame, `sent` records what we sent. */
function fakeSocket() {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  const sent: Array<string | Uint8Array> = [];
  let url = "";
  let headers: Record<string, string> = {};
  const socket: SocketLike & { readyState: number } = {
    readyState: 1,
    on(event: string, fn: (...args: unknown[]) => void) {
      (handlers[event] ??= []).push(fn);
      return socket;
    },
    send(data) {
      sent.push(data);
    },
    close() {
      socket.readyState = 3;
      for (const fn of handlers.close ?? []) fn(1000, Buffer.from(""));
    },
  } as SocketLike & { readyState: number };
  return {
    socket,
    sent,
    get url() {
      return url;
    },
    get headers() {
      return headers;
    },
    connect: (u: string, h: Record<string, string>) => {
      url = u;
      headers = h;
      return socket;
    },
    server(message: Record<string, unknown>) {
      for (const fn of handlers.message ?? []) fn(Buffer.from(JSON.stringify(message)), false);
    },
    json: () =>
      sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s) as { type: string }),
  };
}

describe("AssemblyAI streaming STT", () => {
  it("connects with the key in a header, reports partials and formatted turns", async () => {
    const fake = fakeSocket();
    const stt = new AssemblyAiStt({ apiKey: () => "k_secret", connect: fake.connect });
    const events = { onPartial: vi.fn(), onTurn: vi.fn(), onError: vi.fn(), onSpeechStarted: vi.fn() };
    const opening = stt.open(events, { mode: "call", keyterms: ["Arham", "Poke"] });
    expect(fake.url).toContain("wss://streaming.assemblyai.com/v3/ws?");
    expect(fake.url).toContain("speech_model=assemblyai-stt-3-7-realtime-agent");
    expect(fake.url).not.toContain("k_secret");
    expect(fake.headers).toEqual({ Authorization: "k_secret" });
    fake.server({ type: "Begin", id: "s1", expires_at: 1 });
    const session = await opening;
    expect(fake.json()[0]).toEqual({ type: "UpdateConfiguration", keyterms_prompt: ["Arham", "Poke"] });

    fake.server({ type: "SpeechStarted", timestamp: 10 });
    fake.server({ type: "Turn", transcript: "book a", end_of_turn: false, turn_is_formatted: false });
    fake.server({ type: "Turn", transcript: "book a table", end_of_turn: true, turn_is_formatted: false });
    fake.server({ type: "Turn", transcript: "Book a table.", end_of_turn: true, turn_is_formatted: true });
    expect(events.onSpeechStarted).toHaveBeenCalledTimes(1);
    expect(events.onPartial.mock.calls.map((c) => c[0])).toEqual(["book a", "book a table"]);
    expect(events.onTurn).toHaveBeenCalledWith("Book a table.");

    // Audio is coalesced into 50 ms chunks before it goes out.
    session.send(new Uint8Array(1000));
    expect(fake.sent.filter((s) => typeof s !== "string")).toHaveLength(0);
    session.send(new Uint8Array(1000));
    const audio = fake.sent.filter((s): s is Uint8Array => typeof s !== "string");
    expect(audio).toHaveLength(1);
    expect(audio[0]!.byteLength).toBe(2000);

    // Closing waits for Termination so the last final isn't lost.
    const closing = session.close();
    expect(fake.json().at(-1)).toEqual({ type: "Terminate" });
    fake.server({ type: "Termination", audio_duration_seconds: 1, session_duration_seconds: 1 });
    await closing;
  });

  it("dictation waits longer and fails the open on an error before Begin", async () => {
    const fake = fakeSocket();
    const stt = new AssemblyAiStt({ apiKey: () => "k", connect: fake.connect });
    const opening = stt.open({ onPartial() {}, onTurn() {}, onError() {} }, { mode: "dictation" });
    expect(fake.url).toContain("mode=max_accuracy");
    fake.server({ type: "Error", error_code: 3006, error: "bad params" });
    await expect(opening).rejects.toThrow("bad params");
  });

  it("refuses to open without a key", async () => {
    const stt = new AssemblyAiStt({ apiKey: () => undefined });
    expect(stt.configured()).toBe(false);
    await expect(stt.open({ onPartial() {}, onTurn() {}, onError() {} })).rejects.toThrow(/AssemblyAI key/);
  });
});

describe("AssemblyAI TTS", () => {
  it("streams text in, audio out, and cancels on barge-in", async () => {
    const fake = fakeSocket();
    const tts = new AssemblyAiTts({
      apiKey: () => "k",
      connect: fake.connect,
      defaultVoice: () => "aai-titus",
    });
    const events = { onAudio: vi.fn(), onFlushed: vi.fn(), onError: vi.fn() };
    const opening = tts.open(events, {});
    expect(fake.url).toMatch(/^wss:\/\/tts\.us\.assemblyai\.com\/v1\/ws\?/);
    expect(fake.url).toContain("voice_id=aai-titus");
    expect(fake.url).toContain("sample_rate=24000");
    fake.server({ type: "Begin", id: "t1" });
    const stream = await opening;
    stream.push("Half past ");
    stream.push("seven works.");
    stream.flush();
    expect(fake.json()).toEqual([
      { type: "Generate", text: "Half past " },
      { type: "Generate", text: "seven works." },
      { type: "Flush" },
    ]);
    fake.server({ type: "Audio", audio: Buffer.from([1, 2, 3, 4]).toString("base64"), flush_id: 0 });
    fake.server({ type: "FlushDone", flush_id: 0, audio_duration_ms: 400 });
    expect(Array.from(events.onAudio.mock.calls[0]![0] as Uint8Array)).toEqual([1, 2, 3, 4]);
    expect(events.onFlushed).toHaveBeenCalledTimes(1);
    stream.cancel();
    expect(fake.json().at(-1)).toEqual({ type: "Cancel" });
  });

  it("speaks a whole clip over HTTP as WAV, in pieces under the limit", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      expect((init?.headers as Record<string, string>).Authorization).toBe("k");
      return new Response(new Uint8Array([0, 1, 0, 1]));
    });
    const tts = new AssemblyAiTts({ apiKey: () => "k", fetch: fetch as unknown as typeof globalThis.fetch });
    const long = "One sentence here. ".repeat(400);
    const clip = await tts.speak(long, { voice: "aai-sara" });
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.every((b) => [...String(b.text)].length <= 4500 && b.voice_id === "aai-sara")).toBe(true);
    expect(Buffer.from(clip.slice(0, 4)).toString()).toBe("RIFF");
    expect(clip.byteLength).toBe(44 + 4 * bodies.length);
  });

  it("lists the documented voices", async () => {
    const voices = await new AssemblyAiTts({ apiKey: () => "k" }).voices();
    expect(voices[0]).toMatchObject({ id: "aai-kyla" });
    expect(voices.length).toBe(34);
  });
});

describe("helpers", () => {
  it("splits at sentence ends and keeps spaces for streamed text", () => {
    expect(splitText("Short.", 10)).toEqual(["Short."]);
    const parts = splitText("First one. Second one. Third.", 15);
    expect(parts).toEqual(["First one.", "Second one.", "Third."]);
    expect(splitText("ab cd", 10, true)).toEqual(["ab cd"]);
    expect(splitText("  ", 10)).toEqual([]);
    expect(splitText("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
    expect(splitText("😀".repeat(12), 10)).toHaveLength(2);
  });

  it("writes a valid WAV header", () => {
    const out = wav(new Uint8Array(8), 24000);
    const view = new DataView(out.buffer);
    expect(view.getUint32(24, true)).toBe(24000);
    expect(view.getUint32(40, true)).toBe(8);
    expect(out.byteLength).toBe(52);
  });
});
