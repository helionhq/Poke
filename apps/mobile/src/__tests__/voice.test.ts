import { dictationText, floatToPcm16, level, pcm16ToFloat, resample } from "../lib/pcm";
import { Dictation } from "../lib/voice";

const chunks: Array<(pcm: Uint8Array, loudness: number) => void> = [];
jest.mock("../lib/audio", () => ({
  prepareAudio: jest.fn(async () => true),
  releaseAudio: jest.fn(async () => {}),
  Mic: class {
    constructor(onChunk: (pcm: Uint8Array, loudness: number) => void) {
      chunks.push(onChunk);
    }
    async start() {}
    async stop() {}
  },
  Speaker: class {},
}));

/** A WebSocket the test drives. */
class FakeSocket {
  static last: FakeSocket;
  readyState = 0;
  binaryType = "";
  sent: Array<string | ArrayBuffer> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.last = this;
  }
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  frame(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

describe("pcm", () => {
  it("round-trips samples through PCM16", () => {
    const pcm = floatToPcm16(new Float32Array([0, 0.5, -0.5, 1, -1]), 16000);
    expect(pcm.byteLength).toBe(10);
    const back = pcm16ToFloat(pcm);
    expect(back[1]).toBeCloseTo(0.5, 3);
    expect(back[2]).toBeCloseTo(-0.5, 3);
    expect(back[4]).toBe(-1);
  });

  it("resamples 48 kHz to 16 kHz", () => {
    expect(resample(new Float32Array(480), 48000, 16000)).toHaveLength(160);
    expect(floatToPcm16(new Float32Array(480), 48000, 16000).byteLength).toBe(320);
  });

  it("measures loudness", () => {
    expect(level(new Float32Array(10))).toBe(0);
    expect(level(new Float32Array(10).fill(0.1))).toBeCloseTo(0.4, 5);
  });

  it("joins dictation onto what was typed", () => {
    expect(dictationText("", ["Hello there."], "how are")).toBe("Hello there. how are");
    expect(dictationText("Note:", ["buy milk"], "")).toBe("Note: buy milk");
    expect(dictationText("Note: ", [], "")).toBe("Note: ");
  });
});

describe("Dictation", () => {
  const original = globalThis.WebSocket;
  beforeAll(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  });
  afterAll(() => {
    globalThis.WebSocket = original;
  });

  it("streams audio, shows partials, and keeps the last words on stop", async () => {
    const client = {
      socketTarget: (path: string) => ({
        url: `wss://poke.example${path}`,
        protocols: ["poke.v1", "poke.bearer.tok"],
        headers: {},
      }),
    };
    const texts: string[] = [];
    const ended = jest.fn();
    const d = new Dictation(client as never, "Remember", (t) => texts.push(t), ended);
    await d.start();
    const socket = FakeSocket.last;
    expect(socket.url).toBe("wss://poke.example/v1/voice/dictate");
    expect(socket.binaryType).toBe("arraybuffer");

    // Audio before the socket opens is held, then sent in order.
    chunks.at(-1)!(new Uint8Array([1, 2]), 0.2);
    expect(socket.sent).toHaveLength(0);
    socket.open();
    expect(socket.sent).toHaveLength(1);

    socket.frame({ type: "partial", text: "to call" });
    socket.frame({ type: "final", text: "to call Mum." });
    socket.frame({ type: "partial", text: "and the" });
    expect(texts.at(-1)).toBe("Remember to call Mum. and the");

    const stopping = d.stop();
    await Promise.resolve();
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: "stop" }));
    socket.frame({ type: "final", text: "and the dentist." });
    socket.frame({ type: "done" });
    expect(await stopping).toBe("Remember to call Mum. and the dentist.");
    expect(ended).toHaveBeenCalledWith(undefined);
  });
});
