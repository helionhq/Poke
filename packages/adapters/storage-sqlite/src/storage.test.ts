import type { Message } from "@poke/domain";
import { describe, expect, it } from "vitest";
import { ftsQuery, openPokeDatabase } from "./index.js";

function msg(id: string, text: string, at: number, extra: Partial<Message> = {}): Message {
  return {
    id,
    scope: "main",
    role: "user",
    parts: [{ type: "text", text }],
    status: "complete",
    origin: { kind: "user" },
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}

describe("poke.db", () => {
  it("migrates, appends events with increasing seq and replays since", () => {
    const db = openPokeDatabase(":memory:");
    const a = db.events.append({ type: "vault.updated", name: "a" }, 1);
    const b = db.events.append({ type: "vault.deleted", name: "a" }, 2);
    expect(b.seq).toBe(a.seq + 1);
    expect(db.events.since(a.seq, 10).map((e) => e.event.type)).toEqual(["vault.deleted"]);
    expect(db.events.latestSeq()).toBe(b.seq);
    db.close();
  });

  it("pages the thread newest-first with a cursor and finds messages by client id", () => {
    const db = openPokeDatabase(":memory:");
    for (let i = 0; i < 5; i++)
      db.messages.save(msg(`msg_${i}`, `hello ${i}`, 1000 + i, { clientMessageId: `c${i}` }));
    const page1 = db.messages.page({ limit: 2 });
    expect(page1.messages.map((m) => m.id)).toEqual(["msg_3", "msg_4"]);
    const page2 = db.messages.page({ limit: 2, before: page1.before! });
    expect(page2.messages.map((m) => m.id)).toEqual(["msg_1", "msg_2"]);
    const page3 = db.messages.page({ limit: 2, before: page2.before! });
    expect(page3.messages.map((m) => m.id)).toEqual(["msg_0"]);
    expect(page3.before).toBeUndefined();
    expect(db.messages.byClientMessageId("c2")?.id).toBe("msg_2");
    expect(db.messages.around("msg_2", 1).map((m) => m.id)).toEqual(["msg_1", "msg_2", "msg_3"]);
    db.close();
  });

  it("searches with FTS5, including extra (draft) text, and keeps the index in sync on update", () => {
    const db = openPokeDatabase(":memory:");
    db.messages.save(msg("m1", "Priya recommended Marlow Room on Friday", 1));
    db.messages.save(msg("m2", "the flight to Lisbon", 2, { role: "poke" }), "Subject: Café plans");
    expect(db.messages.search({ query: "marlow", limit: 10 }).map((h) => h.message.id)).toEqual(["m1"]);
    expect(db.messages.search({ query: "cafe", limit: 10 }).map((h) => h.message.id)).toEqual(["m2"]);
    expect(db.messages.search({ query: "lisbon", limit: 10, roles: ["user"] })).toHaveLength(0);
    const hit = db.messages.search({ query: "Marlow", limit: 1 })[0]!;
    expect(hit.highlight).toContain("«Marlow»");
    db.messages.save(msg("m1", "changed text entirely", 1));
    expect(db.messages.search({ query: "marlow", limit: 10 })).toHaveLength(0);
    expect(db.messages.search({ query: "entirely", limit: 10 })).toHaveLength(1);
    db.close();
  });

  it("builds safe FTS queries from arbitrary input", () => {
    expect(ftsQuery('hello "world" OR ')).toBe('"hello"* "world"* "OR"*');
    expect(ftsQuery("   ")).toBe("");
  });

  it("tracks tasks, traces and usage", () => {
    const db = openPokeDatabase(":memory:");
    db.traces.save({
      id: "trc_1",
      scope: "main",
      messageId: "msg_1",
      taskIds: ["tsk_1", "tsk_2"],
      status: "running",
      toolCount: 0,
      apps: [],
      startedAt: 1,
    });
    expect(db.traces.byTask("tsk_2")?.id).toBe("trc_1");
    db.usage.record({
      day: "2026-11-26",
      role: "poke",
      provider: "p",
      model: "m",
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
    });
    db.usage.record({
      day: "2026-11-26",
      role: "poke",
      provider: "p",
      model: "m",
      input: 1,
      output: 1,
      cacheRead: 2,
      cacheWrite: 0,
      costUsd: 0,
      error: true,
    });
    expect(db.usage.since("2026-11-01")[0]).toMatchObject({
      requests: 2,
      input: 11,
      errors: 1,
      cacheRead: 2,
    });
    db.close();
  });
});
