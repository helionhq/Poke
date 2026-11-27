import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_TOKEN_LIFETIME_MS, LoginService } from "@poke/application";
import type { SystemSecretKey, SystemSecrets } from "@poke/domain";
import { describe, expect, it } from "vitest";
import { claudeTokenCheck, privateFiles } from "./commands/doctor.js";

const DAY = 86_400_000;

describe("poke doctor", () => {
  it("warns 30 days before the Claude token expires and fails after", () => {
    const now = Date.UTC(2026, 10, 27);
    expect(claudeTokenCheck(now + 200 * DAY, now).status).toBe("ok");
    expect(claudeTokenCheck(now + 30 * DAY, now)).toMatchObject({
      status: "warn",
      detail: "the token expires in 30 days",
    });
    expect(claudeTokenCheck(now + 1 * DAY + 5, now).detail).toBe("the token expires in 1 day");
    expect(claudeTokenCheck(now - DAY, now).status).toBe("fail");
    expect(claudeTokenCheck(undefined, now).status).toBe("ok");
  });

  it("dates the Claude login from when the token was saved", () => {
    const setAt = Date.UTC(2026, 0, 1);
    const values = new Map<SystemSecretKey, string>([["anthropic.oauthToken", "sk-ant-oat01-x"]]);
    const secrets: SystemSecrets = {
      get: (k) => values.get(k),
      set: (k, v) => void values.set(k, v),
      delete: (k) => void values.delete(k),
      has: (k) => values.has(k),
      keys: () => [...values.keys()],
      updatedAt: (k) => (values.has(k) ? setAt : undefined),
    };
    const claude = new LoginService(secrets).list().find((l) => l.id === "anthropic");
    expect(claude).toMatchObject({ loggedIn: true, expiresAt: setAt + CLAUDE_TOKEN_LIFETIME_MS });
    const qwen = new LoginService(secrets).list().find((l) => l.id === "qwen");
    expect(qwen?.expiresAt).toBeUndefined();
  });

  it("lists the files that must stay private", () => {
    const home = mkdtempSync(join(tmpdir(), "poke-doctor-"));
    mkdirSync(join(home, "keys"));
    writeFileSync(join(home, "keys", "master.key"), "k");
    mkdirSync(join(home, "services"));
    writeFileSync(join(home, "services", "cloudflared.env"), "TUNNEL_TOKEN=x");
    const files = privateFiles(home, join(home, "services")).map((f) => [
      f.path.slice(home.length + 1),
      f.mode,
    ]);
    expect(files).toEqual([
      ["keys", 0o700],
      [join("keys", "master.key"), 0o600],
      [join("services", "cloudflared.env"), 0o600],
    ]);
    rmSync(home, { recursive: true, force: true });
  });
});
