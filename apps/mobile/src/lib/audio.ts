import {
  type AudioBufferQueueSourceNode,
  AudioContext,
  AudioManager,
  AudioRecorder,
  type AudioBufferSourceNode,
  decodeAudioData,
} from "react-native-audio-api";
import { floatToPcm16, level, pcm16ToFloat } from "./pcm";

/**
 * Native audio through react-native-audio-api (brief section 17): the mic as 16 kHz PCM16
 * chunks, streamed playback for calls, and whole clips for read aloud.
 */

export type AudioUse = "call" | "dictation" | "playback";

/**
 * Sets the AVAudioSession for what comes next. Calls use voiceChat (Apple's echo cancellation,
 * so Poke doesn't hear itself); dictation records; read aloud is spoken audio that ducks music.
 * Returns false when the microphone isn't allowed.
 */
export async function prepareAudio(use: AudioUse): Promise<boolean> {
  if (use !== "playback") {
    const permission = await AudioManager.requestRecordingPermissions();
    if (permission !== "Granted") return false;
  }
  AudioManager.setSystemOptions({
    ios:
      use === "playback"
        ? { category: "playback", mode: "spokenAudio", options: ["duckOthers"] }
        : {
            category: "playAndRecord",
            mode: use === "call" ? "voiceChat" : "default",
            options: ["defaultToSpeaker", "allowBluetoothHFP"],
          },
  });
  await AudioManager.setAudioSessionActivity(true);
  return true;
}

export async function releaseAudio(): Promise<void> {
  await AudioManager.setAudioSessionActivity(false).catch(() => {});
}

export const MIC_RATE = 16_000;

/** The microphone: mono PCM16 at 16 kHz in ~100 ms chunks, with a loudness for the waveform. */
export class Mic {
  #recorder: AudioRecorder;
  #running = false;

  constructor(
    private readonly onChunk: (pcm: Uint8Array, loudness: number) => void,
    options: { echoCancellation: boolean },
  ) {
    this.#recorder = new AudioRecorder({ iosVoiceProcessing: options.echoCancellation });
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#recorder.onAudioReady(
      { sampleRate: MIC_RATE, bufferLength: MIC_RATE / 10, channelCount: 1 },
      (event) => {
        const samples = event.buffer.getChannelData(0);
        // The device may deliver another rate; the recognizer is told 16 kHz.
        this.onChunk(floatToPcm16(samples, event.buffer.sampleRate, MIC_RATE), level(samples));
      },
    );
    const result = await this.#recorder.start();
    if (result.status !== "success") {
      this.#recorder.clearOnAudioReady();
      throw new Error(result.message);
    }
    this.#running = true;
  }

  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    this.#recorder.clearOnAudioReady();
    await this.#recorder.stop().catch(() => undefined);
  }
}

/** Streamed playback of mono PCM16 (Poke's voice in a call). `flush` drops what's queued. */
export class Speaker {
  #context: AudioContext;
  #queue: AudioBufferQueueSourceNode | undefined;
  #pending = 0;

  constructor(
    readonly sampleRate: number,
    private readonly onIdle?: () => void,
  ) {
    this.#context = new AudioContext({ sampleRate });
  }

  /** Seconds of audio queued and not yet played (roughly). */
  get queued(): number {
    return this.#pending;
  }

  play(pcm: Uint8Array): void {
    const samples = pcm16ToFloat(pcm);
    if (samples.length === 0) return;
    const buffer = this.#context.createBuffer(1, samples.length, this.sampleRate);
    buffer.copyToChannel(samples, 0);
    this.#node().enqueueBuffer(buffer);
    this.#pending += samples.length / this.sampleRate;
  }

  /** Barge-in: silence now. */
  flush(): void {
    this.#queue?.clearBuffers();
    this.#pending = 0;
  }

  async close(): Promise<void> {
    this.flush();
    try {
      this.#queue?.stop();
    } catch {
      // already stopped
    }
    await this.#context.close().catch(() => undefined);
  }

  #node(): AudioBufferQueueSourceNode {
    if (this.#queue) return this.#queue;
    const node = this.#context.createBufferQueueSource();
    node.connect(this.#context.destination);
    node.onbufferended = (event) => {
      if (event.isLastBufferInQueue) {
        this.#pending = 0;
        this.onIdle?.();
      }
    };
    node.start();
    this.#queue = node;
    return node;
  }
}

/** Plays one clip (WAV bytes); `stop` ends it early. `done` settles when it finishes either way. */
export async function playClip(wav: ArrayBuffer): Promise<{ stop(): void; done: Promise<void> }> {
  const context = new AudioContext();
  const buffer = await decodeAudioData(wav);
  const source: AudioBufferSourceNode = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  source.onended = () => {
    void context.close().catch(() => undefined);
    finish();
  };
  source.start();
  return {
    stop: () => {
      try {
        source.stop();
      } catch {
        finish();
      }
    },
    done,
  };
}
