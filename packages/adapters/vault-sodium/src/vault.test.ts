import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openVault, type SodiumVault } from "./vault.js";

const key = new Uint8Array(randomBytes(32));
let now = 1_800_000_000_000;
const clock = { now: () => now };
let vault: SodiumVault | undefined;
let dir: string | undefined;

afterEach(() => {
  vault?.close();
  vault = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("vault", () => {
  it("stores secrets encrypted and exposes only metadata", async () => {
    dir = mkdtempSync(join(tmpdir(), "poke-vault-"));
    const path = join(dir, "vault.db");
    vault = await openVault({ path, masterKey: key, clock });
    const entry = vault.put({
      name: "Resy.Login",
      kind: "login",
      fields: { username: "arham" },
      secrets: { password: "hunter2-very-secret" },
    });
    expect(entry).toMatchObject({
      name: "resy.login",
      secretFields: ["password"],
      fields: { username: "arham" },
    });
    expect(JSON.stringify(vault.list())).not.toContain("hunter2");
    expect(vault.resolve("resy.login", "password")).toBe("hunter2-very-secret");
    expect(vault.resolve("resy.login")).toBe("hunter2-very-secret");
    expect(vault.resolve("resy.login", "username")).toBe("arham");
    vault.close();
    vault = undefined;
    // On disk: WAL contents included, no plaintext.
    for (const file of ["vault.db", "vault.db-wal"]) {
      try {
        expect(readFileSync(join(dir, file)).includes("hunter2-very-secret")).toBe(false);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    vault = await openVault({ path, masterKey: key, clock });
    expect(vault.reveal("resy.login")).toEqual({ password: "hunter2-very-secret" });
  });

  it("refuses a different master key", async () => {
    dir = mkdtempSync(join(tmpdir(), "poke-vault-"));
    const path = join(dir, "vault.db");
    vault = await openVault({ path, masterKey: key, clock });
    vault.system.set("qwen.apiKey", "sk-sp-abc");
    vault.close();
    vault = await openVault({ path, masterKey: new Uint8Array(randomBytes(32)), clock });
    expect(() => vault!.system.get("qwen.apiKey")).toThrow();
  });

  it("keeps the system namespace apart from entries", async () => {
    vault = await openVault({ path: ":memory:", masterKey: key, clock });
    vault.system.set("anthropic.oauthToken", "sk-ant-oat-xyz");
    expect(vault.list()).toEqual([]);
    expect(vault.resolve("anthropic.oauthToken")).toBeUndefined();
    expect(vault.system.get("anthropic.oauthToken")).toBe("sk-ant-oat-xyz");
    expect(vault.system.keys()).toEqual(["anthropic.oauthToken"]);
    expect(vault.liveSecrets()).toEqual([{ name: "system:anthropic.oauthToken", value: "sk-ant-oat-xyz" }]);
    vault.system.delete("anthropic.oauthToken");
    expect(vault.system.has("anthropic.oauthToken")).toBe(false);
  });

  it("wipes one-time codes after use or after ten minutes", async () => {
    let changes = 0;
    vault = await openVault({ path: ":memory:", masterKey: key, clock, onChange: () => changes++ });
    vault.put({ name: "bank.otp", kind: "code", secrets: { code: "123456" } });
    vault.markUsed("bank.otp", "tsk_1");
    expect(vault.get("bank.otp")).toBeUndefined();
    vault.put({ name: "bank.otp2", kind: "code", secrets: { code: "654321" } });
    now += 11 * 60 * 1000;
    expect(vault.resolve("bank.otp2")).toBeUndefined();
    expect(vault.sweep(now)).toEqual(["bank.otp2"]);
    expect(changes).toBeGreaterThanOrEqual(4);
  });

  it("validates names", async () => {
    vault = await openVault({ path: ":memory:", masterKey: key, clock });
    expect(() => vault!.put({ name: "bad name", kind: "note", secrets: { value: "x" } })).toThrow();
    expect(() => vault!.put({ name: "ok", kind: "note", secrets: {} })).toThrow();
  });
});
