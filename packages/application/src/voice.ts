import {
  type Logger,
  type Message,
  messageText,
  type SpeechToText,
  type SttSession,
  type TextToSpeech,
  type TtsStream,
} from "@poke/domain";
import type { AttachmentService } from "./attachments.js";
import type { EventHub } from "./core/hub.js";
import type { ThreadService } from "./thread.js";

/** What a call sends to the phone. `audio` is mono PCM16 at the TTS sample rate. */
export type CallOutput =
  | { type: "ready"; sampleRate: number }
  | { type: "state"; state: "listening" | "thinking" | "speaking" }
  | { type: "user"; text: string; final: boolean }
  | { type: "poke"; text: string; final: boolean }
  | { type: "audio"; pcm: Uint8Array }
  /** Barge-in: drop whatever audio is still queued on the phone. */
  | { type: "interrupt" }
  | { type: "error"; message: string }
  | { type: "ended" };

export interface VoiceCallDeps {
  stt: SpeechToText;
  tts: TextToSpeech;
  thread: ThreadService;
  hub: EventHub;
  attachments: AttachmentService;
  ids: { next(prefix: string): string };
  clock: { now(): number };
  log: Logger;
  /** His name and Poke's, so recognition spells them right. */
  keyterms: string[];
  voice?: string;
}

/** Keeps the TTS socket alive between replies (it closes after 120 s with no frames). */
const KEEPALIVE_MS = 60_000;

/**
 * One hands-free call (brief §17). His speech is transcribed with turn detection; each finished
 * turn goes into the thread as his message (origin "voice"), so Poke answers in a normal turn in
 * the voice style; the reply's text streams into TTS and its audio back to the phone. Talking
 * over Poke cuts the audio at once, and the new words steer the running turn. The thread keeps
 * the whole conversation as ordinary messages.
 */
export class VoiceCall {
  #stt: SttSession | undefined;
  #tts: TtsStream | undefined;
  #ttsOpening: Promise<TtsStream | undefined> | undefined;
  #off: (() => void) | undefined;
  #keepAlive: ReturnType<typeof setInterval> | undefined;
  #ended = false;
  #micMuted = false;
  #speaking = false;
  /** His turn is sent; the next Poke message to appear is the reply. */
  #awaiting = false;
  /** The reply being spoken, and how much of its text went to TTS. */
  #reply: { id: string; spoken: string; held: string; muted: boolean } | undefined;
  #frame: { data: Uint8Array; at: number } | undefined;
  #frameUsedAt = 0;

  constructor(
    private readonly deps: VoiceCallDeps,
    private readonly emit: (out: CallOutput) => void,
  ) {}

  async start(): Promise<void> {
    this.#stt = await this.deps.stt.open(
      {
        onSpeechStarted: () => this.#bargeIn(),
        onPartial: (text) => {
          if (text.trim()) {
            this.#bargeIn();
            this.emit({ type: "user", text, final: false });
          }
        },
        onTurn: (text) => void this.#onTurn(text),
        onError: (error) => this.#fail(error),
        onClose: () => {
          if (!this.#ended) this.#fail(new Error("Speech recognition stopped"));
        },
      },
      { mode: "call", keyterms: this.deps.keyterms },
    );
    this.#off = this.deps.hub.subscribe((frame) => {
      if (frame.kind === "live") {
        const event = frame.event;
        if (event.type === "message.delta" && event.messageId === this.#reply?.id) this.#speak(event.text);
        return;
      }
      const event = frame.stored.event;
      if (event.type !== "message.created" && event.type !== "message.updated") return;
      const message = event.message;
      if (message.scope !== "main" || message.role !== "poke") return;
      if (event.type === "message.created" && this.#awaiting) {
        this.#awaiting = false;
        this.#reply = { id: message.id, spoken: "", held: "", muted: false };
        this.emit({ type: "state", state: "speaking" });
      }
      if (message.id === this.#reply?.id && message.status !== "streaming") this.#finish(message);
    });
    void this.#ensureTts();
    this.emit({ type: "ready", sampleRate: this.deps.tts.streamSampleRate });
    this.emit({ type: "state", state: "listening" });
  }

  /** Mic audio from the phone (16 kHz mono PCM16). */
  audio(pcm: Uint8Array): void {
    if (!this.#ended && !this.#micMuted) this.#stt?.send(pcm);
  }

  mute(muted: boolean): void {
    this.#micMuted = muted;
  }

  /** A camera frame (JPEG); the newest goes with his next turn. */
  frame(data: Uint8Array): void {
    this.#frame = { data, at: this.deps.clock.now() };
  }

  cameraOff(): void {
    this.#frame = undefined;
  }

  async end(): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;
    this.#off?.();
    if (this.#keepAlive) clearInterval(this.#keepAlive);
    await Promise.allSettled([this.#stt?.close(), this.#tts?.close()]);
    this.emit({ type: "ended" });
  }

  // ── his side ───────────────────────────────────────────────────────────────────────────────

  async #onTurn(text: string): Promise<void> {
    if (this.#ended) return;
    this.emit({ type: "user", text, final: true });
    const attachmentIds: string[] = [];
    const frame = this.#frame;
    if (frame && frame.at > this.#frameUsedAt) {
      try {
        const attachment = await this.deps.attachments.store({
          name: `camera-${frame.at}.jpg`,
          mime: "image/jpeg",
          data: frame.data,
          origin: "user",
          kindHint: "image",
        });
        attachmentIds.push(attachment.id);
        this.#frameUsedAt = frame.at;
      } catch (error) {
        this.deps.log.warn({ err: error }, "couldn't keep the camera frame");
      }
    }
    // A turn spoken over Poke steers his running turn; its new text is spoken again.
    if (this.#reply) this.#reply.muted = false;
    this.#awaiting = true;
    this.emit({ type: "state", state: "thinking" });
    try {
      this.deps.thread.send({
        text,
        clientMessageId: `voice_${this.deps.ids.next("msg")}`,
        attachmentIds,
        origin: { kind: "voice" },
      });
    } catch (error) {
      this.#fail(error);
    }
  }

  /** He started talking while Poke speaks: stop the audio now. */
  #bargeIn(): void {
    if (!this.#speaking) return;
    this.#speaking = false;
    this.#tts?.cancel();
    if (this.#reply) this.#reply.muted = true;
    this.emit({ type: "interrupt" });
    this.emit({ type: "state", state: "listening" });
  }

  // ── Poke's side ────────────────────────────────────────────────────────────────────────────

  #speak(delta: string): void {
    const reply = this.#reply;
    if (!reply || this.#ended) return;
    reply.spoken += delta;
    this.emit({ type: "poke", text: reply.spoken, final: false });
    if (reply.muted) return;
    // Whole words only, and never half a link, so markdown split across deltas reads right.
    const ready = speakableHead(reply.held + delta);
    reply.held = ready.rest;
    const text = speakable(ready.head);
    if (!text) return;
    this.#speaking = true;
    void this.#ensureTts().then((tts) => tts?.push(text));
  }

  /** The reply is done: speak whatever didn't stream, then flush the tail. */
  #finish(message: Message): void {
    const reply = this.#reply;
    if (!reply) return;
    const full = messageText(message);
    this.emit({ type: "poke", text: full, final: true });
    if (!reply.muted && full.trim()) {
      const unsent = full.startsWith(reply.spoken)
        ? full.slice(reply.spoken.length)
        : reply.spoken
          ? ""
          : full;
      const rest = reply.held + unsent;
      void this.#ensureTts().then((tts) => {
        const text = speakable(rest);
        if (text.trim()) {
          this.#speaking = true;
          tts?.push(text);
        }
        tts?.flush();
      });
    }
    this.#reply = undefined;
  }

  #ensureTts(): Promise<TtsStream | undefined> {
    if (this.#tts) return Promise.resolve(this.#tts);
    this.#ttsOpening ??= this.deps.tts
      .open(
        {
          onAudio: (pcm) => {
            if (this.#speaking) this.emit({ type: "audio", pcm });
          },
          onFlushed: () => {
            this.#speaking = false;
            if (!this.#awaiting) this.emit({ type: "state", state: "listening" });
          },
          onError: (error) => this.deps.log.warn({ err: error }, "tts error in a call"),
          onClose: () => {
            this.#tts = undefined;
          },
        },
        { ...(this.deps.voice ? { voice: this.deps.voice } : {}) },
      )
      .then(
        (tts) => {
          this.#tts = tts;
          this.#keepAlive ??= setInterval(() => this.#tts?.push(""), KEEPALIVE_MS);
          return tts;
        },
        (error: unknown) => {
          this.#fail(error);
          return undefined;
        },
      )
      .finally(() => {
        this.#ttsOpening = undefined;
      });
    return this.#ttsOpening;
  }

  #fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.deps.log.warn({ err: error }, "voice call problem");
    this.emit({ type: "error", message });
  }
}

/** Splits streamed text into what can be spoken now and what waits for more. */
export function speakableHead(text: string): { head: string; rest: string } {
  // Spans a cut must not fall inside: whole links, and an unclosed one at the end.
  const spans: Array<[number, number]> = [];
  for (const m of text.matchAll(/\[[^\]]*\]\([^)]*\)/g)) spans.push([m.index, m.index + m[0].length]);
  const lastEnd = spans.at(-1)?.[1] ?? 0;
  const open = text.indexOf("[", lastEnd);
  if (open >= 0) spans.push([open, text.length]);
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== " " && text[i] !== "\n") continue;
    if (spans.some(([a, b]) => i >= a && i < b)) continue;
    return { head: text.slice(0, i + 1), rest: text.slice(i + 1) };
  }
  return { head: "", rest: text };
}

/** What TTS should read: markdown marks out, links as their label, bare URLs as "a link". */
export function speakable(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/[*_`#>]/g, "");
}
