import { describe, expect, it } from "vitest";
import {
  applyAction,
  BLOCK_KINDS,
  BlockActionError,
  canApply,
  CardProps,
  fallbackText,
  isTerminal,
  newBlock,
  searchText,
} from "./index.js";

const run = (
  block: ReturnType<typeof newBlock> & { resolution?: Record<string, unknown> },
  action: string,
  payload?: unknown,
  by: "user" | "system" = "user",
) => {
  const applied = applyAction(block, action, payload, by);
  return {
    ...block,
    props: applied.transition.props ?? block.props,
    state: applied.transition.state,
    ...(applied.transition.resolution ? { resolution: applied.transition.resolution } : {}),
    applied,
  };
};

describe("catalog", () => {
  it("has every kind from the brief", () => {
    expect(BLOCK_KINDS.sort()).toEqual([
      "action",
      "card",
      "choices",
      "connect_request",
      "draft",
      "memory_note",
      "secret_request",
      "tool_approval",
    ]);
  });

  it("rejects unknown kinds, bad props and unknown fields", () => {
    expect(() => newBlock("poll", {})).toThrow(BlockActionError);
    expect(() => newBlock("choices", { options: [] })).toThrow(/options/);
    expect(() =>
      newBlock("choices", { options: [{ label: "a" }, { label: "b" }, { label: "c" }, { label: "d" }] }),
    ).toThrow(/options/);
    expect(() => newBlock("choices", { options: [{ label: "a" }], script: "alert(1)" })).toThrow();
  });
});

describe("state machines", () => {
  it("choices: pick or write, once", () => {
    const block = newBlock("choices", {
      options: [{ label: "Friday 8:15" }, { label: "Saturday 7:00", hint: "bar seats" }],
    });
    expect(block.state).toBe("pending");
    expect(block.fallback).toBe("1. Friday 8:15\n2. Saturday 7:00 (bar seats)");
    const picked = run(block, "pick", { index: 1 });
    expect(picked).toMatchObject({ state: "answered", resolution: { answer: "Saturday 7:00", index: 1 } });
    expect(isTerminal(picked)).toBe(true);
    expect(() => run(picked, "pick", { index: 0 })).toThrow(/already answered/);
    expect(() => run(block, "pick", { index: 2 })).toThrow(/doesn't exist/);
    expect(run(block, "write", { text: "  Sunday brunch " }).resolution).toEqual({ answer: "Sunday brunch" });
  });

  it("draft: edits replace the body; the primary action needs one", () => {
    const block = newBlock("draft", {
      kind: "Email",
      to: "maya@northwind.co",
      subject: "Friday",
      body: "Hi Maya,",
      primary: { label: "Send from Gmail" },
    });
    const edited = run(block, "edit", { body: "Hi Maya, see you Friday." });
    expect(edited.props).toMatchObject({ body: "Hi Maya, see you Friday.", subject: "Friday" });
    expect(edited.state).toBe("idle");
    const sent = run(edited, "primary", {});
    expect(sent.state).toBe("sent");
    expect(sent.applied.fallback).toContain("Hi Maya, see you Friday.");
    const plain = newBlock("draft", { kind: "Text", body: "On my way" });
    expect(() => run(plain, "primary", {})).toThrow(/no action/);
    expect(searchText(block)).toContain("Friday");
  });

  it("action: confirm, change with a note, or cancel", () => {
    const block = newBlock("action", {
      kind: "Book a table",
      title: "Marlow Room",
      body: "Saturday, Nov 28 at 7:30 PM · 4 people",
      confirm: "Book",
      change: "Change",
      details: [{ label: "Deposit", value: "$40" }],
    });
    expect(run(block, "confirm").resolution).toEqual({ decision: "confirmed" });
    expect(run(block, "change", { note: "make it 8" }).resolution).toEqual({
      decision: "changed",
      note: "make it 8",
    });
    expect(run(block, "cancel").state).toBe("cancelled");
    expect(block.fallback).toContain("Deposit: $40");
  });

  it("secret_request: the value is sensitive and never in the resolution", () => {
    const block = newBlock("secret_request", {
      service: "Resy",
      title: "Resy login",
      note: "So I can book Lilia for you",
      field: "Password",
      secretType: "password",
      vaultName: "Resy.Login",
      known: [{ label: "Email", value: "dinners@fastmail.com" }],
    });
    expect(block.props.vaultName).toBe("resy.login");
    const saved = run(block, "save", { value: "hunter2-secret" });
    expect(saved.applied.sensitive).toBe(true);
    expect(saved.resolution).toEqual({ status: "saved", vaultName: "resy.login" });
    expect(JSON.stringify(saved.resolution) + saved.applied.fallback).not.toContain("hunter2");
    expect(saved.applied.fallback).toBe("Resy login ✓ Saved to your Vault");
    expect(() => run(block, "save", { value: "" })).toThrow("That value can't be saved");
    expect(() => run(block, "expire", {}, "user")).toThrow(/no action expire/);
    expect(run(block, "expire", {}, "system").state).toBe("expired");
    expect(() => newBlock("secret_request", { ...block.props, vaultName: "../etc" })).toThrow(/vaultName/);
  });

  it("connect_request: connect → connected (by the server), or not now", () => {
    const block = newBlock("connect_request", {
      kind: "app",
      app: "notion",
      title: "Connect Notion",
      note: "To find Monday's design review notes",
      caps: ["Search and read pages"],
    });
    const connecting = run(block, "connect");
    expect(connecting.state).toBe("connecting");
    expect(() => run(connecting, "connected", {}, "user")).toThrow();
    expect(run(connecting, "connected", { account: "arham@" }, "system")).toMatchObject({
      state: "connected",
      resolution: { status: "connected" },
    });
    expect(run(connecting, "failed", { error: "closed the page" }, "system").state).toBe("pending");
    expect(run(block, "dismiss").resolution).toEqual({ status: "dismissed" });
    expect(canApply(block, "expire")).toBe(true);
  });

  it("tool_approval: allow (optionally always) or deny", () => {
    const block = newBlock("tool_approval", {
      app: "Northwind Ops",
      tool: "refund_order",
      action: "Refund $84.00 to Maya Chen",
      reason: "Refunds can't be undone.",
      always: "Always allow refunds under $100",
    });
    expect(run(block, "allow", { always: true }).resolution).toEqual({ decision: "allowed", always: true });
    expect(run(block, "deny").applied.fallback).toBe("Northwind Ops refund_order ✗ Denied");
    const noAlways = newBlock("tool_approval", {
      app: "Gmail",
      tool: "send_email",
      action: "Send the email to Maya",
    });
    expect(run(noAlways, "allow", { always: true }).resolution).toEqual({ decision: "allowed" });
  });

  it("memory_note: undo once", () => {
    const block = newBlock("memory_note", { text: "Arham prefers aisle seats" });
    expect(block.state).toBe("saved");
    expect(run(block, "undo").state).toBe("undone");
    expect(fallbackText({ ...block, state: "undone" })).toBe("Forgot: Arham prefers aisle seats");
  });
});

describe("card", () => {
  const restaurants = {
    title: "Three places near the hotel",
    root: "list",
    nodes: {
      list: { type: "stack", children: ["h", "r1", "r2"] },
      h: { type: "heading", text: "Dinner Friday" },
      r1: { type: "row", children: ["img1", "t1", "b1"], align: "between" },
      img1: { type: "image", src: "https://images.example.org/lilia.jpg", alt: "Lilia's dining room" },
      t1: { type: "text", text: "**Lilia** · 4.7 · [menu](https://lilia.com/menu)" },
      b1: { type: "button", label: "Hold", actionId: "hold-lilia" },
      r2: { type: "row", children: ["t2", "b2"] },
      t2: { type: "text", text: "**Misi** · 4.6" },
      b2: { type: "button", label: "Hold", actionId: "hold-misi" },
    },
  };

  it("accepts a well-formed tree and flattens it for fallbacks", () => {
    const block = newBlock("card", restaurants);
    expect(block.fallback).toBe(
      "Three places near the hotel\nDinner Friday\n[image: Lilia's dining room]\nLilia · 4.7 · menu (https://lilia.com/menu)\nMisi · 4.6",
    );
  });

  it("refuses cycles, dangling and shared nodes, unreachable nodes, http images and deep trees", () => {
    const bad = (patch: Record<string, unknown>) => () =>
      newBlock("card", { ...restaurants, nodes: { ...restaurants.nodes, ...patch } });
    expect(bad({ r2: { type: "row", children: ["list"] } })).toThrow(/contains itself/);
    expect(bad({ r2: { type: "row", children: ["ghost"] } })).toThrow(/not defined/);
    expect(bad({ r2: { type: "row", children: ["t1"] } })).toThrow(/used twice/);
    expect(bad({ extra: { type: "divider" } })).toThrow(/isn't reachable/);
    expect(bad({ img1: { type: "image", src: "http://example.org/x.jpg", alt: "x" } })).toThrow(/https/);
    expect(bad({ img1: { type: "image", src: "javascript:alert(1)", alt: "x" } })).toThrow(/https/);
    expect(bad({ b2: { type: "button", label: "Hold", actionId: "hold-lilia" } })).toThrow(/own actionId/);
    const deep: Record<string, unknown> = { root: { type: "stack", children: ["n1"] } };
    for (let i = 1; i <= 7; i++) deep[`n${i}`] = { type: "stack", children: [`n${i + 1}`] };
    deep.n8 = { type: "divider" };
    expect(() => newBlock("card", { title: "deep", root: "root", nodes: deep })).toThrow(/deeper/);
    expect(() =>
      CardProps.parse({ title: "x", root: "a", nodes: { a: { type: "field", key: "note", label: "Note" } } }),
    ).toThrow(/need a button/);
  });

  it("press sends the action id and only the card's own field values", () => {
    const form = newBlock("card", {
      title: "Gift note",
      root: "s",
      nodes: {
        s: { type: "stack", children: ["f", "t", "b"] },
        f: { type: "field", key: "note", label: "Note" },
        t: { type: "toggle", key: "wrap", label: "Gift wrap" },
        b: { type: "button", label: "Send", actionId: "send" },
      },
      data: { note: "Happy birthday!", wrap: true },
    });
    const pressed = run(form, "press", {
      actionId: "send",
      values: { note: "Happy 30th!", wrap: false, sneaky: "x" } as never,
    });
    expect(pressed.resolution).toEqual({
      pressed: ["send"],
      last: { actionId: "send", values: { note: "Happy 30th!", wrap: false } },
    });
    expect(() => run(form, "press", { actionId: "nope" })).toThrow(/isn't on this card/);
  });
});
