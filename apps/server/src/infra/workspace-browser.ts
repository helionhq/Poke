import { realpathSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { DomainError } from "@poke/domain";
import type { WorkspaceEntry } from "@poke/contracts";

/**
 * Read-only view of Poke's workspace folder for the Library. Every path is resolved through
 * symlinks and must stay inside the workspace root; dot-files (.git, .claude, caches) stay hidden.
 */
export class WorkspaceBrowser {
  readonly #root: string;

  constructor(root: string) {
    this.#root = realpathSync(root);
  }

  /** Resolves a client path to an absolute one inside the workspace, or throws not_found. */
  async resolve(path: string): Promise<string> {
    const clean = path.replace(/\\/g, "/").replace(/^\/+/, "");
    if (clean.split("/").some((part) => part === ".." || part.startsWith("."))) {
      throw new DomainError("not_found", "Not in the workspace");
    }
    let real: string;
    try {
      real = await realpath(join(this.#root, clean));
    } catch {
      throw new DomainError("not_found", "Not in the workspace");
    }
    const rel = relative(this.#root, real);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new DomainError("not_found", "Not in the workspace");
    return real;
  }

  async list(path: string): Promise<{ path: string; entries: WorkspaceEntry[] }> {
    const dir = await this.resolve(path);
    const info = await stat(dir);
    if (!info.isDirectory()) throw new DomainError("invalid", "That's a file, not a folder");
    const dirents = await readdir(dir, { withFileTypes: true });
    const entries: WorkspaceEntry[] = [];
    for (const d of dirents) {
      if (d.name.startsWith(".")) continue;
      const abs = join(dir, d.name);
      try {
        // Follow symlinks only when they stay inside the workspace.
        const real = await realpath(abs);
        const rel = relative(this.#root, real);
        if (rel.startsWith("..") || isAbsolute(rel)) continue;
        const s = await stat(real);
        entries.push({
          name: d.name,
          path: relative(this.#root, abs).split(sep).join("/"),
          kind: s.isDirectory() ? "dir" : "file",
          ...(s.isDirectory() ? {} : { size: s.size }),
          modifiedAt: Math.round(s.mtimeMs),
        });
      } catch {
        // Broken link or vanished file: skip it.
      }
    }
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
    return { path: relative(this.#root, dir).split(sep).join("/"), entries };
  }

  /** A file to download: absolute path and size. */
  async file(path: string): Promise<{ abs: string; size: number; name: string }> {
    const abs = await this.resolve(path);
    const s = await stat(abs);
    if (!s.isFile()) throw new DomainError("invalid", "That's a folder");
    return { abs, size: s.size, name: abs.split(sep).at(-1) ?? "file" };
  }
}
