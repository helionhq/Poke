import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBackup, readBackupManifest, restoreBackup } from "./infra/backup.js";
import { ensureDirs, resolvePaths, type PokePaths } from "./infra/paths.js";
import { createKernel } from "./kernel.js";

let home: string;
let paths: PokePaths;
let out: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "poke-backup-"));
  paths = resolvePaths(join(home, "poke"));
  ensureDirs(paths);
  out = join(home, "poke-backup.tar.gz");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("backup and restore", () => {
  it("round-trips the databases, keys and files, and moves what it replaces aside", () => {
    const kernel = createKernel({ paths });
    kernel.settings.set("profile.name", "Arham");
    writeFileSync(paths.masterKey, Buffer.alloc(32, 7));
    writeFileSync(join(paths.library, "notes.md"), "# Lisbon");
    mkdirSync(join(paths.data, "tts"), { recursive: true });
    writeFileSync(join(paths.data, "tts", "cache.wav"), "cached");
    mkdirSync(join(paths.logs), { recursive: true });
    writeFileSync(join(paths.logs, "poke.log"), "log");

    // Taken while the "server" (this kernel) still has the database open.
    const manifest = createBackup({
      paths,
      out,
      version: "1.0.0",
      commit: "abc1234",
      dumpHoncho: (file) => {
        writeFileSync(file, "PGDMP");
        return true;
      },
    });
    kernel.close();
    expect(manifest.contents).toEqual(
      expect.arrayContaining(["data/poke.db", "keys", "library", "honcho.dump"]),
    );
    expect(manifest.contents).not.toContain("data/tts");
    expect(readBackupManifest(paths, out)).toMatchObject({ format: 1, commit: "abc1234", honcho: true });

    // Things change after the backup…
    const later = createKernel({ paths });
    later.settings.set("profile.name", "Someone else");
    later.close();
    writeFileSync(join(paths.library, "notes.md"), "# Porto");
    writeFileSync(paths.masterKey, Buffer.alloc(32, 9));

    const restored = restoreBackup({ paths, file: out });
    const back = createKernel({ paths });
    expect(back.settings.get("profile.name")).toBe("Arham");
    back.close();
    expect(readFileSync(join(paths.library, "notes.md"), "utf8")).toBe("# Lisbon");
    expect(readFileSync(paths.masterKey)).toEqual(Buffer.alloc(32, 7));
    expect(readFileSync(restored.honchoDump!, "utf8")).toBe("PGDMP");
    // …and what was there is kept, not deleted.
    expect(readFileSync(join(restored.previous, "library", "notes.md"), "utf8")).toBe("# Porto");
    expect(existsSync(join(restored.previous, "data", "poke.db"))).toBe(true);
    expect(readdirSync(paths.logs)).toContain("poke.log");
  });

  it("refuses something that isn't a Poke backup", () => {
    const notABackup = join(home, "photo.tar.gz");
    writeFileSync(notABackup, "definitely not gzip");
    expect(() => readBackupManifest(paths, notABackup)).toThrow(/tar failed/);
    expect(() => restoreBackup({ paths, file: notABackup })).toThrow(/tar failed/);
    // Nothing was moved aside.
    expect(readdirSync(paths.home).some((n) => n.startsWith("restore-previous"))).toBe(false);
  });
});
