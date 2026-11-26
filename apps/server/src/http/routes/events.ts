import { ClientFrame, PROTOCOL_VERSION, type ServerFrame } from "@poke/contracts";
import type { StoredEvent } from "@poke/domain";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { Services } from "../../services.js";

/** A client that is further behind than this refetches the thread instead of replaying. */
export const MAX_REPLAY = 5_000;
const BATCH = 500;

/**
 * WS /v1/events?since=<seq>: resumable stream of domain events. Order of operations on connect:
 * subscribe into a buffer, replay persisted events after `since`, flush the buffer (skipping what
 * the replay covered), send a snapshot of in-flight state, then stream live.
 */
export function registerEventsSocket(app: FastifyInstance, s: Services): void {
  app.get("/v1/events", { websocket: true, config: { auth: "device" } }, (socket, req) => {
    const principal = req.principal;
    if (!principal || (principal.kind === "device" && principal.device.scope !== "full")) {
      socket.close(4401, "unauthorized");
      return;
    }
    const deviceId = principal.kind === "device" ? principal.device.id : "admin";
    const connectionId = s.ids.next("run");
    const since = Math.max(0, Number((req.query as { since?: string }).since ?? 0) || 0);

    const send = (frame: ServerFrame) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
    };

    let replaying = true;
    let lastSeq = since;
    const buffered: StoredEvent[] = [];
    const unsubscribe = s.hub.subscribe((frame) => {
      if (frame.kind === "live") {
        if (!replaying) send({ t: "live", event: frame.event });
        return;
      }
      if (replaying) buffered.push(frame.stored);
      else if (frame.stored.seq > lastSeq) {
        lastSeq = frame.stored.seq;
        send({ t: "event", seq: frame.stored.seq, at: frame.stored.at, event: frame.stored.event });
      }
    });

    const latestSeq = s.hub.latestSeq();
    const reset = latestSeq - since > MAX_REPLAY || since > latestSeq;
    send({ t: "hello", protocol: PROTOCOL_VERSION, latestSeq, serverTime: Date.now(), reset });
    if (reset) {
      lastSeq = latestSeq;
    } else {
      for (;;) {
        const batch = s.hub.since(lastSeq, BATCH);
        for (const stored of batch) {
          send({ t: "event", seq: stored.seq, at: stored.at, event: stored.event });
          lastSeq = stored.seq;
        }
        if (batch.length < BATCH) break;
      }
    }
    for (const stored of buffered) {
      if (stored.seq > lastSeq) {
        send({ t: "event", seq: stored.seq, at: stored.at, event: stored.event });
        lastSeq = stored.seq;
      }
    }
    replaying = false;
    send({ t: "snapshot", streaming: s.live.streaming(), activity: s.live.activity("main") });
    s.presence.update(connectionId, deviceId, "foreground");

    socket.on("message", (raw: WebSocket.RawData) => handleClientFrame(raw));
    socket.on("close", () => {
      unsubscribe();
      s.presence.remove(connectionId);
    });

    function handleClientFrame(raw: WebSocket.RawData): void {
      let parsed;
      try {
        parsed = ClientFrame.safeParse(JSON.parse(raw.toString()));
      } catch {
        return;
      }
      if (!parsed.success) return;
      s.presence.update(connectionId, deviceId, parsed.data.presence);
      if (parsed.data.t === "ping") send({ t: "pong", at: Date.now() });
    }
  });
}
