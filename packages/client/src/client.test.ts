import type { Block, Message, ServerFrame, Trace } from "@poke/contracts";
import { describe, expect, it, vi } from "vitest";
import { EventStream, type SocketLike } from "./events.js";
import { dayLabel, needsDivider, parseDeepLink, traceLine, traceSummary } from "./format.js";
import { PokeClient, PokeError } from "./http.js";
import { Outbox, type OutboxEntry } from "./outbox.js";
import { ThreadStore } from "./store.js";

const msg = (id: string, over: Partial<Message> = {}): Message => ({
  id,
  scope: "main",
  role: "poke",
  parts: [{ type: "text", text: `text ${id}` }],
  status: "complete",
  origin: { kind: "turn" },
  createdAt: Number(id.replace(/\D/g, "")) * 1000,
  updatedAt: 0,
  ...over,
});
const ev = (seq: number, event: Extract<ServerFrame, { t: "event" }>["event"]): ServerFrame => ({
  t: "event",
  seq,
  at: seq,
  event,
});

describe("ThreadStore", () => {
  it("orders messages, applies events once, and streams deltas until the reply completes", () => {
    const store = new ThreadStore();
    store.reset({
      messages: [msg("m2"), msg("m1", { role: "user" })],
      blocks: [],
      traces: [],
      latestSeq: 10,
    });
    expect(store.rows().map((r) => (r.kind === "message" ? r.message.id : ""))).toEqual(["m1", "m2"]);

    store.apply(ev(9, { type: "message.created", message: msg("m0") }));
    expect(store.rows()).toHaveLength(2); // seq 9 already applied

    const streaming = msg("m3", { status: "streaming", parts: [{ type: "text", text: "" }] });
    store.apply(ev(11, { type: "message.created", message: streaming }));
    store.apply({ t: "live", event: { type: "message.delta", messageId: "m3", scope: "main", text: "Hel" } });
    store.apply({ t: "live", event: { type: "message.delta", messageId: "m3", scope: "main", text: "lo" } });
    expect(store.text(store.message("m3")!)).toBe("Hello");
    expect(store.latestReplyId()).toBe("m2");

    store.apply(
      ev(12, { type: "message.updated", message: msg("m3", { parts: [{ type: "text", text: "Hello" }] }) }),
    );
    expect(store.text(store.message("m3")!)).toBe("Hello");
    expect(store.latestReplyId()).toBe("m3");
    expect(store.latestSeq).toBe(12);
  });

  it("ignores other scopes, keeps blocks and steps, and asks for a refetch on reset", () => {
    const store = new ThreadStore();
    const other: string[] = [];
    store.onOther = (e) => other.push(e.type);
    store.apply(ev(1, { type: "message.created", message: msg("m1", { scope: "sidechat:a" }) }));
    expect(store.rows()).toHaveLength(0);
    const block = {
      id: "b1",
      kind: "choices",
      v: 1,
      props: {},
      state: "pending",
      owner: { type: "poke" },
      messageId: "m1",
      scope: "main",
      createdAt: 0,
      updatedAt: 0,
    } as Block;
    store.apply(ev(2, { type: "block.created", block }));
    expect(store.waitingBlocks()).toHaveLength(1);
    store.apply(
      ev(3, {
        type: "step.started",
        step: {
          id: "s1",
          taskId: "t",
          traceId: "tr",
          tool: "x",
          label: "Searched",
          status: "running",
          startedAt: 1,
        },
      }),
    );
    store.apply(
      ev(4, {
        type: "step.completed",
        step: {
          id: "s1",
          taskId: "t",
          traceId: "tr",
          tool: "x",
          label: "Searched",
          status: "done",
          startedAt: 1,
        },
      }),
    );
    expect(store.steps("tr").map((s) => s.status)).toEqual(["done"]);
    store.apply(ev(5, { type: "routine.deleted", routineId: "r" }));
    expect(other).toEqual(["routine.deleted"]);
    expect(store.apply({ t: "hello", protocol: 1, latestSeq: 9000, serverTime: 0, reset: true })).toBe(
      "refetch",
    );
  });

  it("shows outbox entries until the server's copy arrives", () => {
    const store = new ThreadStore();
    const confirmed: string[] = [];
    store.onConfirmed = (id) => confirmed.push(id);
    const entry: OutboxEntry = {
      clientMessageId: "cm_1",
      text: "hi",
      attachmentIds: [],
      createdAt: 1,
      attempts: 0,
      state: "queued",
    };
    store.setPending([entry]);
    expect(store.rows().map((r) => r.kind)).toEqual(["pending"]);
    store.apply(
      ev(1, { type: "message.created", message: msg("m5", { role: "user", clientMessageId: "cm_1" }) }),
    );
    expect(store.rows().map((r) => r.kind)).toEqual(["message"]);
    expect(confirmed).toEqual(["cm_1"]);
  });
});

describe("Outbox", () => {
  const memory = () => {
    let saved: OutboxEntry[] = [];
    return { load: async () => saved, save: async (e: OutboxEntry[]) => void (saved = e), get: () => saved };
  };

  it("sends in order, keeps entries while offline and fails for good on a 4xx", async () => {
    const storage = memory();
    const sent: string[] = [];
    let online = false;
    const outbox = new Outbox(storage, async (e) => {
      if (!online) throw new PokeError("Can't reach Poke", 0, "offline");
      if (e.text === "bad") throw new PokeError("Too long", 400, "invalid");
      sent.push(e.text);
    });
    await outbox.enqueue({ text: "one" });
    await outbox.enqueue({ text: "bad" });
    await outbox.enqueue({ text: "two" });
    await outbox.flush();
    expect(sent).toEqual([]);
    expect(storage.get().map((e) => e.state)).toEqual(["queued", "queued", "queued"]);
    online = true;
    await outbox.flush();
    expect(sent).toEqual(["one", "two"]);
    expect(outbox.entries().map((e) => [e.text, e.state, e.error])).toEqual([["bad", "failed", "Too long"]]);
  });

  it("requeues entries that were mid-send when the app quit", async () => {
    const storage = memory();
    await storage.save([
      { clientMessageId: "cm_x", text: "x", attachmentIds: [], createdAt: 0, attempts: 1, state: "sending" },
    ]);
    const outbox = new Outbox(storage, async () => {});
    await outbox.load();
    expect(outbox.entries()[0]!.state).toBe("queued");
  });
});

describe("EventStream", () => {
  it("resumes from the last seq, authenticates by subprotocol and backs off", () => {
    const sockets: Array<SocketLike & { url: string; protocols: string[] }> = [];
    const timers: Array<() => void> = [];
    let seq = 0;
    const statuses: string[] = [];
    const stream = new EventStream({
      baseUrl: "https://poke.example.com",
      token: () => "tok",
      since: () => seq,
      onFrame: (f) => {
        if (f.t === "event") seq = f.seq;
      },
      onStatus: (s) => statuses.push(s),
      random: () => 1,
      socket: (url, protocols) => {
        const s = {
          url,
          protocols,
          readyState: 1,
          send: vi.fn(),
          close: vi.fn(),
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
        } as SocketLike & { url: string; protocols: string[] };
        sockets.push(s);
        return s;
      },
      timers: {
        setTimeout: ((fn: () => void) => (timers.push(fn), timers.length)) as unknown as typeof setTimeout,
        clearTimeout: (() => {}) as typeof clearTimeout,
        setInterval: (() => 1) as unknown as typeof setInterval,
        clearInterval: (() => {}) as typeof clearInterval,
      },
    });
    stream.start();
    expect(sockets[0]!.url).toBe("wss://poke.example.com/v1/events?since=0");
    expect(sockets[0]!.protocols).toEqual(["poke.v1", "poke.bearer.tok"]);
    sockets[0]!.onopen?.({});
    sockets[0]!.onmessage?.({
      data: JSON.stringify({ t: "event", seq: 7, at: 0, event: { type: "vault.deleted", name: "x" } }),
    });
    sockets[0]!.onclose?.({ code: 1006 });
    expect(statuses).toEqual(["connecting", "open", "waiting"]);
    timers.shift()!();
    expect(sockets[1]!.url).toBe("wss://poke.example.com/v1/events?since=7");
    sockets[1]!.onclose?.({ code: 4401 });
    expect(stream.status).toBe("unauthorized");
  });
});

describe("PokeClient", () => {
  it("sends the bearer and access headers and maps errors", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new PokeClient({
      baseUrl: "https://poke.example.com/",
      token: "tok",
      headers: { "CF-Access-Client-Id": "id" },
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ error: { code: "not_found", message: "Message not found" } }), {
          status: 404,
        });
      }) as unknown as typeof fetch,
    });
    await expect(client.message("m 1")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
      message: "Message not found",
    });
    expect(calls[0]!.url).toBe("https://poke.example.com/v1/messages/m%201");
    expect(calls[0]!.init.headers).toMatchObject({
      authorization: "Bearer tok",
      "CF-Access-Client-Id": "id",
    });
    expect(client.imageUrl("https://a.com/x.png")).toBe(
      "https://poke.example.com/v1/images?src=https%3A%2F%2Fa.com%2Fx.png",
    );
  });

  it("reports an unreachable server as offline", async () => {
    const client = new PokeClient({
      baseUrl: "https://p",
      fetch: (async () => {
        throw new TypeError("Network request failed");
      }) as unknown as typeof fetch,
    });
    const error = await client.health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PokeError);
    expect((error as PokeError).offline).toBe(true);
  });
});

describe("format", () => {
  it("labels days and places dividers", () => {
    const now = new Date(2026, 10, 27, 12).getTime();
    expect(dayLabel(now - 3600_000, now)).toBe("Today");
    expect(dayLabel(new Date(2026, 10, 26, 9).getTime(), now)).toBe("Yesterday");
    expect(needsDivider(undefined, { createdAt: now })).toBe(true);
    expect(needsDivider({ createdAt: now }, { createdAt: now + 60_000 })).toBe(false);
    expect(needsDivider({ createdAt: now }, { createdAt: now + 2 * 3600_000 })).toBe(true);
  });

  it("summarises traces", () => {
    const trace = {
      toolCount: 3,
      status: "done",
      apps: [
        { id: "a", name: "Calendar" },
        { id: "b", name: "Maps" },
        { id: "b", name: "Maps" },
      ],
      line: undefined,
    } as unknown as Trace;
    expect(traceSummary(trace)).toEqual({ title: "Used 3 tools", meta: "Calendar, Maps" });
    expect(traceLine(trace, [{ status: "running", label: "Searching Resy" } as never])).toBe(
      "Searching Resy",
    );
  });

  it("parses deep links", () => {
    expect(parseDeepLink("poke://thread?message=msg_1")).toEqual({ kind: "thread", messageId: "msg_1" });
    expect(parseDeepLink("poke://vault")).toEqual({ kind: "vault" });
    expect(parseDeepLink("poke://routines/rt_9")).toEqual({ kind: "routine", id: "rt_9" });
    expect(parseDeepLink("https://evil.example/thread")).toBeUndefined();
  });
});
