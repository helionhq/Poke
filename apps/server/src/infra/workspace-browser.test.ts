import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceBrowser } from "./workspace-browser.js";

describe("WorkspaceBrowser", () => {
  let base: string;
  let root: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "poke-ws-"));
    root = join(base, "workspace");
    mkdirSync(join(root, "notes"), { recursive: true });
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, "notes", "plan.md"), "# plan");
    writeFileSync(join(root, "todo.txt"), "milk");
    writeFileSync(join(base, "outside.txt"), "secret");
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("lists folders first and hides dot-files", async () => {
    const listing = await new WorkspaceBrowser(root).list("");
    expect(listing.entries.map((e) => [e.name, e.kind])).toEqual([
      ["notes", "dir"],
      ["todo.txt", "file"],
    ]);
    const inner = await new WorkspaceBrowser(root).list("notes");
    expect(inner.entries[0]).toMatchObject({ path: "notes/plan.md", kind: "file", size: 6 });
  });

  it("refuses paths that leave the workspace", async () => {
    const ws = new WorkspaceBrowser(root);
    await expect(ws.list("../")).rejects.toThrow(/workspace/);
    await expect(ws.file("../outside.txt")).rejects.toThrow(/workspace/);
    await expect(ws.file("notes/../../outside.txt")).rejects.toThrow(/workspace/);
    await expect(ws.list(".claude")).rejects.toThrow(/workspace/);
  });

  it("skips and refuses symlinks that point outside", async () => {
    try {
      symlinkSync(join(base, "outside.txt"), join(root, "link.txt"));
    } catch {
      return; // Windows without symlink rights.
    }
    const ws = new WorkspaceBrowser(root);
    expect((await ws.list("")).entries.some((e) => e.name === "link.txt")).toBe(false);
    await expect(ws.file("link.txt")).rejects.toThrow(/workspace/);
  });
});
