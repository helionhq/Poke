import { describe, expect, it } from "vitest";
import {
  claudeIdleCompactionDelay,
  clampBudget,
  detectCacheLifetime,
  isPersisted,
  isValidSkillName,
  messageText,
  parsePlaceholderRef,
  PROVIDERS,
  providerAllowsRole,
  secretEnvName,
  traceSummary,
  VAULT_PLACEHOLDER_RE,
} from "./index.js";

describe("traces", () => {
  it("shows the live line while running and a tool summary when done", () => {
    expect(traceSummary({ status: "running", toolCount: 1, apps: [], line: "Searching Airbnb" })).toBe(
      "Searching Airbnb",
    );
    expect(
      traceSummary({
        status: "done",
        toolCount: 3,
        apps: [
          { id: "gcal", name: "Google Calendar" },
          { id: "maps", name: "Maps" },
          { id: "resy", name: "Resy" },
        ],
      }),
    ).toBe("Used 3 tools · Google Calendar, Maps, Resy");
    expect(traceSummary({ status: "done", toolCount: 1, apps: [] })).toBe("Used 1 tool");
  });
});

describe("vault placeholders", () => {
  it("parses {{vault:name.field}} against known names", () => {
    const matches = [..."pw={{vault:resy.login.password}} k={{vault:openai}}".matchAll(VAULT_PLACEHOLDER_RE)];
    expect(matches.map((m) => m[1])).toEqual(["resy.login.password", "openai"]);
    const known = new Set(["resy.login", "openai"]);
    expect(parsePlaceholderRef("resy.login.password", known)).toEqual({
      name: "resy.login",
      field: "password",
    });
    expect(parsePlaceholderRef("openai", known)).toEqual({ name: "openai" });
  });

  it("derives bash env var names", () => {
    expect(secretEnvName("resy.login", "password")).toBe("POKE_SECRET_RESY_LOGIN_PASSWORD");
  });
});

describe("models", () => {
  it("never offers the Claude subscription outside Poke and Side chat", () => {
    const anthropic = PROVIDERS.find((p) => p.id === "anthropic")!;
    expect(providerAllowsRole(anthropic, "poke")).toBe(true);
    expect(providerAllowsRole(anthropic, "sidechat")).toBe(true);
    expect(providerAllowsRole(anthropic, "agents")).toBe(false);
    expect(providerAllowsRole(anthropic, "memory.chat")).toBe(false);
    expect(providerAllowsRole({ ...anthropic, allowedRoles: ["agents"] }, "agents")).toBe(false);
  });
});

describe("context", () => {
  it("clamps the budget to the model window", () => {
    expect(clampBudget(272_000, 200_000)).toBe(200_000);
    expect(clampBudget(272_000, 1_000_000)).toBe(272_000);
    expect(clampBudget(272_000, undefined)).toBe(272_000);
  });

  it("detects the cache lifetime and only idles-compacts on a 1h cache", () => {
    expect(detectCacheLifetime({ ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 0 })).toBe("1h");
    expect(detectCacheLifetime({ ephemeral_5m_input_tokens: 10 })).toBe("5m");
    expect(claudeIdleCompactionDelay("1h", 10 * 60_000)).toBe(50 * 60_000);
    expect(claudeIdleCompactionDelay("5m", 10 * 60_000)).toBeUndefined();
  });
});

describe("misc", () => {
  it("validates skill names", () => {
    expect(isValidSkillName("resy-booking")).toBe(true);
    expect(isValidSkillName("Resy")).toBe(false);
    expect(isValidSkillName("-bad")).toBe(false);
    expect(isValidSkillName("a--b")).toBe(false);
  });

  it("joins message text and classifies events", () => {
    expect(
      messageText({
        parts: [
          { type: "text", text: "a" },
          { type: "block", blockId: "b" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("ab");
    expect(isPersisted({ type: "message.delta", messageId: "m", scope: "main", text: "x" })).toBe(false);
    expect(isPersisted({ type: "vault.deleted", name: "x" })).toBe(true);
  });
});
