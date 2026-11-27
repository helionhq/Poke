import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SystemSecretKey, SystemSecrets } from "@poke/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupDatabase, migrateDatabase, prepareTunnel, restoreDatabase } from "./infra/maintenance.js";
import { resolvePaths } from "./infra/paths.js";
import { createKernel } from "./kernel.js";

function fakeSystem(values: Partial<Record<SystemSecretKey, string>> = {}): SystemSecrets {
  const map = new Map(Object.entries(values) as Array<[SystemSecretKey, string]>);
  return {
    get: (k) => map.get(k),
    set: (k, v) => void map.set(k, v),
    delete: (k) => void map.delete(k),
    has: (k) => map.has(k),
    keys: () => [...map.keys()],
  };
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "poke-maint-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("tunnel env", () => {
  it("writes the token to cloudflared.env, private to Poke's user", () => {
    const paths = resolvePaths(home);
    expect(prepareTunnel({ system: fakeSystem(), paths })).toBe(false);
    expect(existsSync(join(paths.services, "cloudflared.env"))).toBe(false);
    expect(prepareTunnel({ system: fakeSystem({ "cloudflare.tunnelToken": "eyJhIjoi" }), paths })).toBe(true);
    const file = join(paths.services, "cloudflared.env");
    expect(readFileSync(file, "utf8")).toBe("TUNNEL_TOKEN=eyJhIjoi\n");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("database backup for poke update", () => {
  it("backs up, migrates and restores poke.db", () => {
    const paths = resolvePaths(home);
    const kernel = createKernel({ paths });
    kernel.settings.set("profile.name", "Before");
    kernel.close();

    const backup = backupDatabase(paths, "abc1234");
    expect(backup).toBeDefined();
    expect(migrateDatabase(paths)).toBeGreaterThan(0);

    const changed = createKernel({ paths });
    changed.settings.set("profile.name", "After");
    changed.close();

    restoreDatabase(paths, backup!);
    const restored = createKernel({ paths });
    expect(restored.settings.get("profile.name")).toBe("Before");
    restored.close();
  });

  it("keeps the newest five backups", () => {
    const paths = resolvePaths(home);
    createKernel({ paths }).close();
    for (let i = 0; i < 7; i++) backupDatabase(paths, `c${i}`);
    expect(readdirSync(join(paths.data, "backups")).filter((f) => f.endsWith(".db"))).toHaveLength(5);
  });
});
