import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { CryptoPort, FileStore, Timers } from "@poke/domain";

export const nodeCrypto: CryptoPort = {
  randomBytes: (length) => new Uint8Array(randomBytes(length)),
  randomToken: (bytes = 32) => randomBytes(bytes).toString("base64url"),
  sha256Hex: (data) => createHash("sha256").update(data).digest("hex"),
  safeEqual: (a, b) => {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  },
};

export const nodeTimers: Timers = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return { cancel: () => clearTimeout(handle) };
  },
};

/** Library files on disk; paths are always relative to the library root and never escape it. */
export class NodeFileStore implements FileStore {
  constructor(
    readonly libraryRoot: string,
    readonly workspaceRoot: string,
  ) {}

  absolute(relPath: string): string {
    const full = resolve(this.libraryRoot, normalize(relPath));
    const rel = relative(this.libraryRoot, full);
    if (
      isAbsolute(rel) ||
      rel.startsWith("..") ||
      rel.includes(`..${sep}`) ||
      resolve(full) === resolve(this.libraryRoot)
    ) {
      throw new Error("Path escapes the library");
    }
    return full;
  }

  async write(relPath: string, data: Uint8Array): Promise<void> {
    const full = this.absolute(relPath);
    mkdirSync(dirname(full), { recursive: true });
    const tmp = join(dirname(full), `.tmp-${randomBytes(6).toString("hex")}`);
    await writeFile(tmp, data);
    await rename(tmp, full);
  }

  async read(relPath: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.absolute(relPath)));
  }

  exists(relPath: string): boolean {
    return existsSync(this.absolute(relPath));
  }
}
