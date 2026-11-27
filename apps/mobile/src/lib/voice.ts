import type { PokeClient } from "@poke/client";
import type { CallServerFrame, DictateServerFrame } from "@poke/contracts";
import { Mic, prepareAudio, releaseAudio, Speaker } from "./audio";
import { dictationText } from "./pcm";

const NO_MIC = "Poke can't use the microphone. Allow it in the iPhone's Settings.";

interface Sock {
  readyState: number;
  binaryType: string;
  send(data: string | ArrayBuffer): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** React Native's WebSocket takes headers (Cloudflare Access) as a third argument. */
function openSocket(client: PokeClient, path: "/v1/voice/dictate" | "/v1/voice/call"): Sock {
  const target = client.socketTarget(path);
  const socket = new (
    WebSocket as unknown as new (url: string, protocols: string[], options: unknown) => Sock
  )(target.url, target.protocols, { headers: target.headers });
  socket.binaryType = "arraybuffer";
  return socket;
}

const OPEN = 1;

/**
 * Dictation into the composer: mic audio goes to the server, the words come back as he speaks.
 * Audio said before the socket opens is held and sent once it does.
 */
export class Dictation {
  #socket: Sock | undefined;
  #mic: Mic | undefined;
  #held: ArrayBuffer[] = [];
  #finals: string[] = [];
  #partial = "";
  #ended = false;
  #done: (() => void) | undefined;

  constructor(
    private readonly client: PokeClient,
    private readonly before: string,
    private readonly onText: (text: string) => void,
    private readonly onEnd: (error?: string) => void,
  ) {}

  get text(): string {
    return dictationText(this.before, this.#finals, this.#partial);
  }

  async start(): Promise<void> {
    if (!(await prepareAudio("dictation"))) throw new Error(NO_MIC);
    const socket = openSocket(this.client, "/v1/voice/dictate");
    this.#socket = socket;
    socket.onopen = () => {
      for (const chunk of this.#held.splice(0)) socket.send(chunk);
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const frame = JSON.parse(event.data) as DictateServerFrame;
      if (frame.type === "partial") this.#partial = frame.text;
      else if (frame.type === "final") {
        this.#finals.push(frame.text);
        this.#partial = "";
      } else if (frame.type === "error") return this.#finish(frame.message);
      else if (frame.type === "done") return this.#finish();
      else return;
      this.onText(this.text);
    };
    socket.onclose = (event) => this.#finish(event.code === 1000 ? undefined : "Dictation stopped");
    socket.onerror = () => this.#finish("Can't reach Poke");
    this.#mic = new Mic(
      (pcm) => {
        const chunk = pcm.buffer as ArrayBuffer;
        if (socket.readyState === OPEN) socket.send(chunk);
        else if (this.#held.length < 100) this.#held.push(chunk);
      },
      { echoCancellation: false },
    );
    try {
      await this.#mic.start();
    } catch {
      this.#finish(NO_MIC);
      throw new Error(NO_MIC);
    }
  }

  /** Stop listening; resolves once the last words are in (or after 3 s). */
  async stop(): Promise<string> {
    await this.#mic?.stop();
    if (this.#ended) return this.text;
    const finished = new Promise<void>((resolve) => {
      this.#done = resolve;
      setTimeout(resolve, 3000);
    });
    if (this.#socket?.readyState === OPEN) this.#socket.send(JSON.stringify({ type: "stop" }));
    else this.#finish();
    await finished;
    this.#finish();
    return this.text;
  }

  #finish(error?: string): void {
    if (this.#ended) return;
    this.#ended = true;
    // What was still being heard counts.
    if (this.#partial.trim()) {
      this.#finals.push(this.#partial.trim());
      this.#partial = "";
    }
    void this.#mic?.stop();
    if (this.#socket && this.#socket.readyState <= OPEN) this.#socket.close(1000);
    void releaseAudio();
    this.onText(this.text);
    this.onEnd(error);
    this.#done?.();
  }
}

export type CallState = "connecting" | "listening" | "thinking" | "speaking" | "ended";

export interface CallView {
  state: CallState;
  /** What he said last (or is saying). */
  user: string;
  /** Poke's reply so far. */
  poke: string;
  error?: string;
  /** Mic loudness 0…1 for the waveform pill. */
  level: number;
  muted: boolean;
}

/**
 * A hands-free call (screen 07). Mic audio streams up with echo cancellation on; Poke's voice
 * streams down and plays as it arrives; when he talks over Poke the server says "interrupt" and
 * the queued audio is dropped at once.
 */
export class Call {
  #socket: Sock | undefined;
  #mic: Mic | undefined;
  #speaker: Speaker | undefined;
  #view: CallView = { state: "connecting", user: "", poke: "", level: 0, muted: false };
  #ended = false;

  constructor(
    private readonly client: PokeClient,
    private readonly onChange: (view: CallView) => void,
  ) {}

  get view(): CallView {
    return this.#view;
  }

  async start(): Promise<void> {
    if (!(await prepareAudio("call"))) return this.#fail(NO_MIC);
    const socket = openSocket(this.client, "/v1/voice/call");
    this.#socket = socket;
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        if (event.data instanceof ArrayBuffer && !this.#ended)
          this.#speaker?.play(new Uint8Array(event.data));
        return;
      }
      this.#onFrame(JSON.parse(event.data) as CallServerFrame);
    };
    socket.onclose = (event) => {
      if (!this.#ended) this.#fail(event.code === 1000 ? undefined : "The call dropped");
    };
    socket.onerror = () => {
      if (!this.#ended) this.#fail("Can't reach Poke");
    };
  }

  mute(muted: boolean): void {
    this.#set({ muted });
    this.#send({ type: "mute", muted });
  }

  /** A camera still (base64 JPEG); the server keeps the newest for his next turn. */
  frame(jpeg: string): void {
    this.#send({ type: "frame", jpeg });
  }

  cameraOff(): void {
    this.#send({ type: "camera", on: false });
  }

  async end(): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;
    this.#send({ type: "end" });
    await this.#mic?.stop();
    await this.#speaker?.close();
    setTimeout(() => this.#socket?.close(1000), 500);
    await releaseAudio();
    this.#set({ state: "ended", level: 0 });
  }

  #onFrame(frame: CallServerFrame): void {
    switch (frame.type) {
      case "ready":
        this.#speaker = new Speaker(frame.sampleRate);
        void this.#startMic();
        return;
      case "state":
        return this.#set({ state: frame.state });
      case "user":
        // A new utterance starts a new exchange on screen.
        return this.#set(frame.final ? { user: frame.text } : { user: frame.text, poke: "" });
      case "poke":
        return this.#set({ poke: frame.text });
      case "interrupt":
        this.#speaker?.flush();
        return;
      case "error":
        return this.#set({ error: frame.message });
      case "ended":
        void this.end();
        return;
    }
  }

  async #startMic(): Promise<void> {
    const socket = this.#socket;
    if (!socket) return;
    this.#mic = new Mic(
      (pcm, loudness) => {
        if (this.#view.muted || socket.readyState !== OPEN) return;
        socket.send(pcm.buffer as ArrayBuffer);
        if (Math.abs(loudness - this.#view.level) > 0.05) this.#set({ level: loudness });
      },
      { echoCancellation: true },
    );
    try {
      await this.#mic.start();
    } catch {
      this.#fail(NO_MIC);
    }
  }

  #send(frame: Record<string, unknown>): void {
    if (this.#socket?.readyState === OPEN) this.#socket.send(JSON.stringify(frame));
  }

  #fail(error?: string): void {
    this.#set(error ? { error } : {});
    void this.end();
  }

  #set(patch: Partial<CallView>): void {
    this.#view = { ...this.#view, ...patch };
    this.onChange(this.#view);
  }
}
