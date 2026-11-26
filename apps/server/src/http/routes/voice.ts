import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { speakable, VoiceCall } from "@poke/application";
import {
  CallClientFrame,
  DictateClientFrame,
  type CallServerFrame,
  type DictateServerFrame,
  TtsRequest,
  VoiceInfo,
} from "@poke/contracts";
import { DomainError, messageText, type SttSession } from "@poke/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { requireStack, type Services } from "../../services.js";
import { route, type Surface } from "../route.js";

const DEFAULT_VOICE = "aai-kyla";
const INPUT_SAMPLE_RATE = 16_000;
/** Read-aloud clips kept on disk; the oldest go first. */
const TTS_CACHE_FILES = 300;
const VOICE_ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * Voice (brief section 17): dictation into the composer, read aloud, and call mode. AssemblyAI's
 * key stays on the server; the phone only ever talks to Poke.
 */
export function registerVoiceRoutes(app: FastifyInstance, s: Services, _surface: Surface): void {
  route(app, { method: "GET", url: "/v1/voice", auth: "device", response: VoiceInfo }, async () => {
    const { speech } = requireStack(s);
    return {
      configured: speech.stt.configured() && speech.tts.configured(),
      voice: s.settings.get("app.voice") ?? DEFAULT_VOICE,
      voices: await speech.tts.voices(),
      inputSampleRate: INPUT_SAMPLE_RATE,
      outputSampleRate: speech.tts.streamSampleRate,
    };
  });

  route(
    app,
    {
      method: "POST",
      url: "/v1/tts",
      auth: "device",
      body: TtsRequest,
      summary: "A message read aloud (WAV)",
    },
    async ({ body, reply }) => {
      const { speech } = requireStack(s);
      if (!speech.tts.configured()) throw new DomainError("unavailable", "Voice isn't set up on the server");
      const message = s.thread.get(body.messageId);
      if (!message || message.scope !== "main") throw new DomainError("not_found", "No such message");
      const text = speakable(messageText(message)).trim();
      if (!text) throw new DomainError("invalid", "That message has nothing to read");
      const voice = body.voice ?? s.settings.get("app.voice") ?? DEFAULT_VOICE;
      if (!VOICE_ID.test(voice)) throw new DomainError("invalid", "Unknown voice");
      const dir = join(s.paths.data, "tts");
      // The text is part of the key: an edited message is read again.
      const file = join(dir, `${message.id}-${voice}-${message.updatedAt}.wav`);
      let audio = await readFile(file).catch(() => undefined);
      if (!audio) {
        audio = Buffer.from(await speech.tts.speak(text, { voice }));
        await mkdir(dir, { recursive: true });
        await writeFile(file, audio);
        void pruneCache(dir).catch((error: unknown) => s.log.warn({ err: error }, "tts cache prune"));
      }
      return reply
        .header("content-type", "audio/wav")
        .header("cache-control", "private, max-age=86400")
        .send(audio);
    },
  );

  app.get("/v1/voice/dictate", { websocket: true, config: { auth: "device" } }, (socket, req) => {
    if (!fullDevice(socket, req)) return;
    void dictate(s, socket);
  });

  app.get("/v1/voice/call", { websocket: true, config: { auth: "device" } }, (socket, req) => {
    if (!fullDevice(socket, req)) return;
    void call(s, socket);
  });
}

function fullDevice(socket: WebSocket, req: FastifyRequest): boolean {
  const principal = req.principal;
  if (!principal || (principal.kind === "device" && principal.device.scope !== "full")) {
    socket.close(4401, "unauthorized");
    return false;
  }
  return true;
}

/** Dictation: mic audio in, the words so far out. Audio that arrives before the STT is up is kept. */
async function dictate(s: Services, socket: WebSocket): Promise<void> {
  const send = (frame: DictateServerFrame) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  };
  const early: Uint8Array[] = [];
  let session: SttSession | undefined;
  let stopping = false;
  const finish = async () => {
    if (stopping) return;
    stopping = true;
    await session?.close().catch(() => undefined);
    send({ type: "done" });
    socket.close(1000);
  };
  socket.on("message", (raw: Buffer, isBinary: boolean) => {
    if (isBinary) {
      if (session) session.send(new Uint8Array(raw));
      else if (early.length < 200) early.push(new Uint8Array(raw));
      return;
    }
    try {
      if (DictateClientFrame.safeParse(JSON.parse(raw.toString())).success) void finish();
    } catch {
      // not JSON: ignore
    }
  });
  socket.on("close", () => {
    stopping = true;
    void session?.close().catch(() => undefined);
  });
  try {
    const { speech } = requireStack(s);
    session = await speech.stt.open(
      {
        onPartial: (text) => send({ type: "partial", text }),
        onTurn: (text) => send({ type: "final", text }),
        onError: (error) => send({ type: "error", message: error.message }),
      },
      { mode: "dictation", sampleRate: INPUT_SAMPLE_RATE, keyterms: keyterms(s) },
    );
    if (stopping) {
      await session.close();
      return;
    }
    for (const pcm of early.splice(0)) session.send(pcm);
    send({ type: "ready" });
  } catch (error) {
    send({ type: "error", message: errorText(error) });
    socket.close(1011);
  }
}

/** Call mode: see VoiceCall. Binary frames are audio both ways; the rest is JSON. */
async function call(s: Services, socket: WebSocket): Promise<void> {
  const send = (out: CallServerFrame | { type: "audio"; pcm: Uint8Array }) => {
    if (socket.readyState !== socket.OPEN) return;
    if (out.type === "audio") socket.send(out.pcm, { binary: true });
    else socket.send(JSON.stringify(out));
  };
  let voiceCall: VoiceCall | undefined;
  const early: Uint8Array[] = [];
  socket.on("message", (raw: Buffer, isBinary: boolean) => {
    if (isBinary) {
      if (voiceCall) voiceCall.audio(new Uint8Array(raw));
      else if (early.length < 200) early.push(new Uint8Array(raw));
      return;
    }
    let frame;
    try {
      frame = CallClientFrame.safeParse(JSON.parse(raw.toString()));
    } catch {
      return;
    }
    if (!frame.success || !voiceCall) return;
    switch (frame.data.type) {
      case "mute":
        voiceCall.mute(frame.data.muted);
        break;
      case "frame":
        voiceCall.frame(new Uint8Array(Buffer.from(frame.data.jpeg, "base64")));
        break;
      case "camera":
        if (!frame.data.on) voiceCall.cameraOff();
        break;
      case "end":
        void voiceCall.end().finally(() => socket.close(1000));
        break;
    }
  });
  socket.on("close", () => void voiceCall?.end());
  try {
    const stack = requireStack(s);
    if (!stack.speech.stt.configured() || !stack.speech.tts.configured())
      throw new DomainError("unavailable", "Voice isn't set up on the server");
    const voice = s.settings.get("app.voice");
    const created = new VoiceCall(
      {
        stt: stack.speech.stt,
        tts: stack.speech.tts,
        thread: s.thread,
        hub: s.hub,
        attachments: s.attachments,
        ids: s.ids,
        clock: s.clock,
        log: s.log,
        keyterms: keyterms(s),
        ...(voice ? { voice } : {}),
      },
      send,
    );
    await created.start();
    if (socket.readyState !== socket.OPEN) {
      await created.end();
      return;
    }
    voiceCall = created;
    for (const pcm of early.splice(0)) created.audio(pcm);
  } catch (error) {
    send({ type: "error", message: errorText(error) });
    socket.close(1011);
  }
}

/** Names recognition should spell right: his and Poke's. */
function keyterms(s: Services): string[] {
  const name = s.settings.get("profile.name");
  return ["Poke", ...(name ? name.split(/\s+/).filter((w) => w.length > 1) : [])];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pruneCache(dir: string): Promise<void> {
  const names = await readdir(dir);
  if (names.length <= TTS_CACHE_FILES) return;
  const files = await Promise.all(
    names.map(async (name) => ({ name, at: (await stat(join(dir, name))).mtimeMs })),
  );
  files.sort((a, b) => a.at - b.at);
  for (const file of files.slice(0, files.length - TTS_CACHE_FILES))
    await rm(join(dir, file.name), { force: true });
}
