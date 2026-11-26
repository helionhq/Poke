import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsSkillFiles } from "./skill-files.js";

let dir: string;
let files: FsSkillFiles;
const md = (name: string) => `---\nname: ${name}\ndescription: ${name} things\n---\nBody of ${name}.\n`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "poke-skills-"));
  files = new FsSkillFiles({ root: join(dir, "skills"), staging: join(dir, "tmp") });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("skill files", () => {
  it("installs every skill in a local folder, with its resources", async () => {
    const source = join(dir, "repo");
    mkdirSync(join(source, "skills", "pdf", "scripts"), { recursive: true });
    mkdirSync(join(source, "skills", "flights"), { recursive: true });
    mkdirSync(join(source, ".git", "hidden"), { recursive: true });
    writeFileSync(join(source, "skills", "pdf", "SKILL.md"), md("pdf"));
    writeFileSync(join(source, "skills", "pdf", "scripts", "extract.py"), "print(1)");
    writeFileSync(join(source, "skills", "flights", "SKILL.md"), md("flights"));
    writeFileSync(join(source, ".git", "hidden", "SKILL.md"), md("hidden"));

    const staged = await files.stage(source);
    expect(staged.skills.map((s) => s.folder).sort()).toEqual(["flights", "pdf"]);
    for (const skill of staged.skills) await files.commit(staged.id, skill.folder, skill.folder);
    await files.discard(staged.id);

    const scanned = await files.scan();
    expect(scanned.map((s) => s.folder).sort()).toEqual(["flights", "pdf"]);
    expect(scanned.find((s) => s.folder === "pdf")?.location).toBe(join(dir, "skills", "pdf", "SKILL.md"));
    expect(await files.resources("pdf")).toEqual(["scripts/extract.py"]);
    await files.remove("flights");
    expect((await files.scan()).map((s) => s.folder)).toEqual(["pdf"]);
  });

  it("installs a lone SKILL.md under its own name, and refuses odd sources", async () => {
    const lone = join(dir, "downloads", "SKILL.md");
    mkdirSync(join(dir, "downloads"));
    writeFileSync(lone, md("travel-notes"));
    const staged = await files.stage(lone);
    expect(staged.skills.map((s) => s.folder)).toEqual(["travel-notes"]);
    const location = await files.commit(staged.id, "travel-notes", "travel-notes");
    expect(readFileSync(location, "utf8")).toContain("Body of travel-notes.");

    await expect(files.stage("relative/path")).rejects.toThrow(/URL, an attachment or an absolute/);
    await expect(files.stage("http://example.com/x.zip")).rejects.toThrow(/Only https/);
    await expect(files.stage(join(dir, "missing"))).rejects.toThrow(/Nothing at/);
    await expect(files.commit(staged.id, "x", "../escape")).rejects.toThrow(/valid skill name/);
  });

  it("downloads a single SKILL.md over https", async () => {
    const fetcher = (async () => new Response(md("weather"))) as unknown as typeof fetch;
    files = new FsSkillFiles({ root: join(dir, "skills"), staging: join(dir, "tmp"), fetch: fetcher });
    const staged = await files.stage("https://example.com/skills/weather/SKILL.md");
    expect(staged.skills.map((s) => s.folder)).toEqual(["weather"]);
  });
});
