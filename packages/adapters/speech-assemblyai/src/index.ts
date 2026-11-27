import type {
  SpeechToText,
  SttEvents,
  SttSession,
  TextToSpeech,
  TtsStream,
  TtsStreamEvents,
  TtsVoice,
} from "@poke/domain";
import WebSocket from "ws";
import { VOICES } from "./voices.js";

export { VOICES } from "./voices.js";

/**
 * AssemblyAI speech (docs read 2026-11): Streaming STT v3 over WebSocket and AssemblyAI-TTS-1
 * over WebSocket (call mode) and HTTP (read aloud). The key comes from the vault's system
 * namespace (`assemblyai.key`) and goes only in the Authorization header.
 */
export interface AssemblyAiOptions {
  apiKey(): string | undefined;
  /** Default `wss://streaming.assemblyai.com/v3/ws` (routes to the nearest region). */
  sttUrl?: string;
  /** Default `https://tts.us.assemblyai.com` (EU: `https://tts.eu.assemblyai.com`). */
  ttsBase?: string;
  /** Default `aai-kyla`. */
  defaultVoice?: () => string | undefined;
  fetch?: typeof globalThis.fetch;
  /** For tests: makes the socket. */
  connect?: (url: string, headers: Record<string, string>) => SocketLike;
}

/** What this adapter needs from a WebSocket (the `ws` package's shape). */
export interface SocketLike {
  on(event: "open", fn: () => void): unknown;
  on(event: "message", fn: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): unknown;
  on(event: "close", fn: (code: number, reason: Buffer) => void): unknown;
  on(event: "error", fn: (error: Error) => void): unknown;
  send(data: string | Uint8Array): void;
  close(code?: number): void;
  readonly readyState: number;
}

const OPEN = 1;
const STT_MIN_CHUNK = 640; // 20 ms at 16 kHz, 16-bit
const STT_CHUNK = 1600; // 50 ms, what the docs recommend
const GENERATE_MAX = 1900; // under the 2000 code-point limit per Generate
const SPEAK_MAX = 4500; // under the 5000 code-point limit per HTTP request
export const TTS_SAMPLE_RATE = 24_000;

/** Key handling and sockets shared by the two classes. */
abstract class AssemblyAiBase {
  constructor(protected readonly options: AssemblyAiOptions) {}

  configured(): boolean {
    return Boolean(this.options.apiKey());
  }

  protected key(): string {
    const key = this.options.apiKey();
    if (!key) throw new Error("Voice isn't set up: no AssemblyAI key");
    return key;
  }

  protected connect(url: string): SocketLike {
    const headers = { Authorization: this.key() };
    return this.options.connect?.(url, headers) ?? (new WebSocket(url, { headers }) as unknown as SocketLike);
  }

  protected voice(voice?: string): string {
    return voice || this.options.defaultVoice?.() || "aai-kyla";
  }
}

/** Streaming STT v3: dictation and call mode. */
export class AssemblyAiStt extends AssemblyAiBase implements SpeechToText {
  async open(
    events: SttEvents,
    opts: { sampleRate?: number; mode?: "dictation" | "call"; keyterms?: string[] } = {},
  ): Promise<SttSession> {
    const call = opts.mode === "call";
    const params = new URLSearchParams({
      sample_rate: String(opts.sampleRate ?? 16_000),
      encoding: "pcm_s16le",
      // The voice-agent model ends turns sooner and handles interruptions; dictation waits longer.
      speech_model: call ? "assemblyai-stt-3-7-realtime-agent" : "assemblyai-stt-3-7-realtime",
      mode: call ? "balanced" : "max_accuracy",
    });
    const socket = this.connect(`${this.options.sttUrl ?? "wss://streaming.assemblyai.com/v3/ws"}?${params}`);
    return new Promise<SttSession>((resolve, reject) => {
      let begun = false;
      let closed = false;
      let pending: Uint8Array = new Uint8Array(0);
      let terminated: (() => void) | undefined;
      const session: SttSession = {
        send(pcm) {
          if (closed) return;
          pending = concat(pending, pcm);
          if (pending.byteLength < STT_CHUNK) return;
          if (socket.readyState === OPEN) socket.send(pending);
          pending = new Uint8Array(0);
        },
        forceEndpoint() {
          if (socket.readyState !== OPEN) return;
          if (pending.byteLength >= STT_MIN_CHUNK) socket.send(pending);
          pending = new Uint8Array(0);
          socket.send(JSON.stringify({ type: "ForceEndpoint" }));
        },
        close() {
          if (closed) return Promise.resolve();
          closed = true;
          if (socket.readyState !== OPEN) return Promise.resolve();
          if (pending.byteLength >= STT_MIN_CHUNK) socket.send(pending);
          pending = new Uint8Array(0);
          // Keep reading until Termination, or the last final is lost.
          return new Promise<void>((done) => {
            const timer = setTimeout(() => {
              socket.close(1000);
              done();
            }, 3000);
            terminated = () => {
              clearTimeout(timer);
              done();
            };
            socket.send(JSON.stringify({ type: "Terminate" }));
          });
        },
      };
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = parse(data);
        switch (message?.type) {
          case "Begin":
            begun = true;
            if (opts.keyterms?.length) {
              socket.send(
                JSON.stringify({ type: "UpdateConfiguration", keyterms_prompt: opts.keyterms.slice(0, 100) }),
              );
            }
            resolve(session);
            return;
          case "SpeechStarted":
            events.onSpeechStarted?.();
            return;
          case "Turn": {
            const text = typeof message.transcript === "string" ? message.transcript : "";
            if (message.end_of_turn === true && message.turn_is_formatted === true) {
              if (text.trim()) events.onTurn(text.trim());
            } else events.onPartial(text);
            return;
          }
          case "Termination":
            terminated?.();
            socket.close(1000);
            return;
          case "Error": {
            const error = new Error(String(message.error ?? "Speech recognition failed"));
            if (!begun) reject(error);
            else events.onError(error);
            return;
          }
          default:
            return;
        }
      });
      socket.on("error", (error) => {
        if (!begun) reject(error);
        else events.onError(error);
      });
      socket.on("close", (code, reason) => {
        closed = true;
        terminated?.();
        if (!begun) reject(new Error(`Speech recognition closed (${code} ${reason.toString()})`));
        else events.onClose?.();
      });
    });
  }
}

/** AssemblyAI-TTS-1: whole clips for read aloud, a stream for call mode. */
export class AssemblyAiTts extends AssemblyAiBase implements TextToSpeech {
  readonly streamSampleRate = TTS_SAMPLE_RATE;

  async voices(): Promise<TtsVoice[]> {
    // AssemblyAI has no voice-listing API (only a dashboard catalog): this is the documented set.
    return VOICES;
  }

  async speak(text: string, opts: { voice?: string; signal?: AbortSignal } = {}): Promise<Uint8Array> {
    const key = this.key();
    const base = this.options.ttsBase ?? "https://tts.us.assemblyai.com";
    const pieces: Uint8Array[] = [];
    for (const chunk of splitText(text, SPEAK_MAX)) {
      const response = await (this.options.fetch ?? fetch)(`${base}/v1/speech`, {
        method: "POST",
        headers: { Authorization: key, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: chunk,
          voice_id: this.voice(opts.voice),
          sample_rate: TTS_SAMPLE_RATE,
          encoding: "pcm_s16le",
          container: "raw",
          stream: false,
        }),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Text to speech failed (${response.status}): ${detail.slice(0, 200)}`);
      }
      pieces.push(new Uint8Array(await response.arrayBuffer()));
    }
    return wav(concat(...pieces), TTS_SAMPLE_RATE);
  }

  open(events: TtsStreamEvents, opts: { voice?: string } = {}): Promise<TtsStream> {
    const base = (this.options.ttsBase ?? "https://tts.us.assemblyai.com").replace(/^http/, "ws");
    const params = new URLSearchParams({
      voice_id: this.voice(opts.voice),
      sample_rate: String(TTS_SAMPLE_RATE),
      encoding: "pcm_s16le",
      word_boundaries: "false",
    });
    const socket = this.connect(`${base}/v1/ws?${params}`);
    return new Promise<TtsStream>((resolve, reject) => {
      let begun = false;
      let terminated: (() => void) | undefined;
      const send = (message: unknown) => {
        if (socket.readyState === OPEN) socket.send(JSON.stringify(message));
      };
      const stream: TtsStream = {
        push(text) {
          for (const piece of splitText(text, GENERATE_MAX, true)) send({ type: "Generate", text: piece });
        },
        flush() {
          send({ type: "Flush" });
        },
        cancel() {
          send({ type: "Cancel" });
        },
        close() {
          if (socket.readyState !== OPEN) return Promise.resolve();
          return new Promise<void>((done) => {
            const timer = setTimeout(() => {
              socket.close(1000);
              done();
            }, 3000);
            terminated = () => {
              clearTimeout(timer);
              done();
            };
            send({ type: "Terminate" });
          });
        },
      };
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = parse(data);
        switch (message?.type) {
          case "Begin":
            begun = true;
            resolve(stream);
            return;
          case "Audio":
            if (typeof message.audio === "string" && message.audio)
              events.onAudio(new Uint8Array(Buffer.from(message.audio, "base64")));
            return;
          case "FlushDone":
            events.onFlushed?.();
            return;
          case "Termination":
            terminated?.();
            socket.close(1000);
            return;
          case "Error": {
            const error = new Error(String(message.error ?? "Text to speech failed"));
            if (!begun) reject(error);
            else events.onError(error);
            return;
          }
          default:
            return;
        }
      });
      socket.on("error", (error) => {
        if (!begun) reject(error);
        else events.onError(error);
      });
      socket.on("close", (code, reason) => {
        terminated?.();
        if (!begun) reject(new Error(`Text to speech closed (${code} ${reason.toString()})`));
        else events.onClose?.();
      });
    });
  }
}

function parse(data: Buffer | ArrayBuffer | Buffer[]): Record<string, unknown> | undefined {
  try {
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString("utf8")
      : Buffer.from(data as ArrayBuffer).toString("utf8");
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/**
 * Splits text into pieces of at most `max` code points, at sentence or word ends when it can.
 * `keepSpaces` keeps every character (streamed fragments are joined with no separator).
 */
export function splitText(text: string, max: number, keepSpaces = false): string[] {
  const out: string[] = [];
  let rest = [...text]; // code points, as the limits count them
  while (rest.length > 0) {
    let end = rest.length;
    if (rest.length > max) {
      // The last sentence end in the window, else the last space, else a hard cut.
      end = max;
      const half = Math.floor(max / 2);
      const sentence = lastIndex(rest, max, (ch, next) => /[.!?]/.test(ch) && next === " ");
      const space = lastIndex(rest, max, (ch) => ch === " ");
      if (sentence >= half) end = sentence + 2;
      else if (space >= half) end = space + 1;
    }
    const piece = rest.slice(0, end).join("");
    rest = rest.slice(end);
    const kept = keepSpaces ? piece : piece.trim();
    if (kept) out.push(kept);
  }
  return out;
}

function lastIndex(chars: string[], max: number, test: (ch: string, next?: string) => boolean): number {
  for (let i = Math.min(max, chars.length) - 2; i >= 0; i--) if (test(chars[i]!, chars[i + 1])) return i;
  return -1;
}

/** A 44-byte RIFF header in front of mono PCM16. */
export function wav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);
  const ascii = (at: number, s: string) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}
