import { silentLogger } from "@poke/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HonchoMemory } from "./index.js";

const calls: Array<{ method: string; path: string; body: unknown; auth: string | null }> = [];
const now = "2026-11-26T10:00:00Z";

function reply(method: string, path: string, body: Record<string, unknown> | unknown[] | undefined) {
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const b = (body ?? {}) as Record<string, unknown>;
  if (method === "DELETE") return new Response(null, { status: 204 });
  if (path.endsWith("/peers") && method === "POST" && !path.includes("/sessions/"))
    return json({
      id: b.id,
      workspace_id: "poke",
      metadata: {},
      configuration: b.configuration ?? {},
      created_at: now,
    });
  if (path.endsWith("/sessions") && method === "POST")
    return json({
      id: b.id,
      workspace_id: "poke",
      is_active: true,
      metadata: {},
      configuration: {},
      created_at: now,
    });
  if (path.endsWith("/workspaces") && method === "POST")
    return json({ id: b.id, metadata: {}, configuration: {}, created_at: now });
  if (/\/sessions\/main\/peers$/.test(path)) return json({});
  if (path.endsWith("/messages"))
    return json(
      ((b.messages as Array<Record<string, unknown>>) ?? []).map((m, i) => ({
        id: `m${i}`,
        content: m.content,
        peer_id: m.peer_id,
        session_id: "main",
        workspace_id: "poke",
        metadata: {},
        created_at: now,
        token_count: 1,
      })),
    );
  if (path.endsWith("/chat")) return json({ content: "He likes figs." });
  if (path.endsWith("/conclusions"))
    return json(
      ((b.conclusions as Array<Record<string, unknown>>) ?? []).map((c) => ({
        id: "con_1",
        content: c.content,
        observer_id: c.observer_id,
        observed_id: c.observed_id,
        session_id: c.session_id ?? null,
        created_at: now,
      })),
    );
  if (path.endsWith("/card")) return json({ peer_card: ["Likes figs", "Lives in Lisbon"] });
  return json({});
}

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path: url.pathname, body, auth: new Headers(init?.headers).get("authorization") });
    return reply(method, url.pathname, body);
  });
});
afterEach(() => vi.unstubAllGlobals());

const memory = (enabled = true, jwt: string | null = "jwt-1") =>
  new HonchoMemory({
    jwt: () => jwt ?? undefined,
    enabled: () => enabled,
    log: silentLogger,
    baseURL: "http://honcho.test",
  });

describe("honcho memory", () => {
  it("is unavailable until Memory is set up", async () => {
    expect(memory(false).available()).toBe(false);
    expect(memory(true, null).available()).toBe(false);
    await expect(memory(false).recall("x")).rejects.toThrow(/isn't set up/);
    expect(calls).toHaveLength(0);
  });

  it("writes an exchange to session main as arham and poke, observing only arham", async () => {
    const m = memory();
    expect(m.available()).toBe(true);
    await m.addExchange({ user: { text: "I love figs", at: 1 }, poke: { text: "Noted!", at: 2 } });
    expect(calls.every((c) => c.auth === "Bearer jwt-1")).toBe(true);
    const peers = calls.filter((c) => /\/peers$/.test(c.path) && !c.path.includes("/sessions/"));
    expect(peers.map((c) => c.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "arham", configuration: { observe_me: true } }),
        expect.objectContaining({ id: "poke", configuration: { observe_me: false } }),
      ]),
    );
    const messages = calls.find((c) => c.path.endsWith("/sessions/main/messages"));
    expect(messages?.path).toContain("/workspaces/poke/");
    expect((messages?.body as { messages: Array<{ peer_id: string; content: string }> }).messages).toEqual([
      expect.objectContaining({ peer_id: "arham", content: "I love figs" }),
      expect.objectContaining({ peer_id: "poke", content: "Noted!" }),
    ]);
  });

  it("recalls, remembers, forgets and reads the card", async () => {
    const m = memory();
    expect(await m.recall("What does he like?", "high")).toBe("He likes figs.");
    expect(calls.find((c) => c.path.endsWith("/peers/arham/chat"))?.body).toMatchObject({
      query: "What does he like?",
      reasoning_level: "high",
    });
    expect(await m.remember("Allergic to peanuts")).toEqual({ ref: "con_1" });
    expect(calls.find((c) => c.path.endsWith("/conclusions"))?.body).toMatchObject({
      conclusions: [
        expect.objectContaining({
          content: "Allergic to peanuts",
          observer_id: "arham",
          observed_id: "arham",
        }),
      ],
    });
    await m.forget("con_1");
    expect(calls.some((c) => c.method === "DELETE" && c.path.endsWith("/conclusions/con_1"))).toBe(true);
    expect(await m.peerCard()).toBe("- Likes figs\n- Lives in Lisbon");
  });
});
