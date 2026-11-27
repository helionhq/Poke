import type { ServerFrame } from "@poke/contracts";

export type StreamStatus = "connecting" | "open" | "waiting" | "unauthorized" | "stopped";
export type Presence = "foreground" | "background";

/** The WebSocket shape the stream needs (browser, React Native and `ws` all fit). */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string, protocols: string[], headers: Record<string, string>) => SocketLike;

export interface EventStreamOptions {
  baseUrl: string;
  token: () => string | undefined;
  /** Extra headers (Cloudflare Access) where the platform's WebSocket supports them. */
  headers?: Record<string, string>;
  /** The last event seq this client has applied; the server replays after it. */
  since: () => number;
  onFrame: (frame: ServerFrame) => void;
  onStatus?: (status: StreamStatus) => void;
  socket?: SocketFactory;
  presence?: () => Presence;
  pingMs?: number;
  /** Backoff bounds for reconnects. */
  minDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  timers?: {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
  };
}

const OPEN = 1;

/**
 * WS /v1/events: resumes from the last seq after every reconnect, pings with app presence (the
 * server uses it to skip pushes while the app is open), and backs off with jitter when offline.
 */
export class EventStream {
  readonly #o: EventStreamOptions;
  #socket: SocketLike | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #ping: ReturnType<typeof setInterval> | undefined;
  #attempt = 0;
  #running = false;
  #status: StreamStatus = "stopped";

  constructor(options: EventStreamOptions) {
    this.#o = options;
  }

  get status(): StreamStatus {
    return this.#status;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#connect();
  }

  stop(): void {
    this.#running = false;
    this.#clearTimers();
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close(1000, "bye");
    this.#setStatus("stopped");
  }

  /** Reconnect right away (the app came to the foreground, the network came back). */
  reconnectNow(): void {
    if (!this.#running) return this.start();
    if (this.#socket && this.#socket.readyState === OPEN) return;
    this.#attempt = 0;
    this.#clearTimers();
    this.#connect();
  }

  setPresence(presence: Presence): void {
    this.#send({ t: "presence", presence });
  }

  #timers() {
    return this.#o.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
  }

  #setStatus(status: StreamStatus): void {
    if (status === this.#status) return;
    this.#status = status;
    this.#o.onStatus?.(status);
  }

  #connect(): void {
    const token = this.#o.token();
    if (!token) return this.#setStatus("unauthorized");
    this.#setStatus("connecting");
    const url = `${this.#o.baseUrl.replace(/^http/, "ws").replace(/\/+$/, "")}/v1/events?since=${this.#o.since()}`;
    const make: SocketFactory =
      this.#o.socket ??
      ((u, protocols, headers) =>
        // React Native's WebSocket takes headers as a third argument; browsers ignore it.
        new (WebSocket as unknown as new (u: string, p: string[], o: unknown) => SocketLike)(u, protocols, {
          headers,
        }));
    let socket: SocketLike;
    try {
      socket = make(url, ["poke.v1", `poke.bearer.${token}`], this.#o.headers ?? {});
    } catch {
      return this.#scheduleRetry();
    }
    this.#socket = socket;
    socket.onopen = () => {
      if (socket !== this.#socket) return;
      this.#attempt = 0;
      this.#setStatus("open");
      const t = this.#timers();
      this.#ping = t.setInterval(
        () => this.#send({ t: "ping", presence: this.#o.presence?.() ?? "foreground" }),
        this.#o.pingMs ?? 25_000,
      );
      this.#send({ t: "presence", presence: this.#o.presence?.() ?? "foreground" });
    };
    socket.onmessage = (ev) => {
      if (socket !== this.#socket || typeof ev.data !== "string") return;
      let frame: ServerFrame;
      try {
        frame = JSON.parse(ev.data) as ServerFrame;
      } catch {
        return;
      }
      this.#o.onFrame(frame);
    };
    socket.onerror = () => {
      // onclose follows; nothing to do here.
    };
    socket.onclose = (ev) => {
      if (socket !== this.#socket) return;
      this.#socket = undefined;
      this.#clearTimers();
      if (!this.#running) return;
      if (ev.code === 4401 || ev.code === 4403) {
        this.#running = false;
        return this.#setStatus("unauthorized");
      }
      this.#scheduleRetry();
    };
  }

  #scheduleRetry(): void {
    if (!this.#running) return;
    this.#setStatus("waiting");
    const min = this.#o.minDelayMs ?? 500;
    const max = this.#o.maxDelayMs ?? 30_000;
    const base = Math.min(max, min * 2 ** this.#attempt);
    const delay = Math.round(base * (0.5 + (this.#o.random ?? Math.random)() * 0.5));
    this.#attempt++;
    this.#retry = this.#timers().setTimeout(() => {
      this.#retry = undefined;
      this.#connect();
    }, delay);
  }

  #send(frame: { t: "ping" | "presence"; presence: Presence }): void {
    const socket = this.#socket;
    if (socket && socket.readyState === OPEN) socket.send(JSON.stringify(frame));
  }

  #clearTimers(): void {
    const t = this.#timers();
    if (this.#retry) t.clearTimeout(this.#retry);
    if (this.#ping) t.clearInterval(this.#ping);
    this.#retry = undefined;
    this.#ping = undefined;
  }
}
