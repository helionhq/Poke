import { describe, expect, it } from "vitest";
import { parseFrontmatter, parseSkill } from "./parse.js";

const skill = (frontmatter: string, body = "# Steps\nDo the thing.") => `---\n${frontmatter}\n---\n${body}\n`;

describe("SKILL.md", () => {
  it("reads the spec's fields", () => {
    const parsed = parseSkill(
      skill(
        [
          "name: pdf-processing",
          "description: >",
          "  Extract text and tables from PDF files,",
          "  fill forms. Use when working with PDFs.",
          "license: Apache-2.0",
          'compatibility: "Requires python3 and pdfplumber"',
          "metadata:",
          "  author: example-org",
          '  version: "1.0"',
          "allowed-tools: Bash(git:*) Read",
        ].join("\n"),
      ),
      "pdf-processing",
    );
    expect(parsed).toEqual({
      name: "pdf-processing",
      description: "Extract text and tables from PDF files, fill forms. Use when working with PDFs.",
      license: "Apache-2.0",
      compatibility: "Requires python3 and pdfplumber",
      metadata: { author: "example-org", version: "1.0" },
      allowedTools: ["Bash(git:*)", "Read"],
      body: "# Steps\nDo the thing.",
      warnings: [],
    });
  });

  it("is lenient where the spec allows, strict where it can't guess", () => {
    const mismatch = parseSkill(skill("name: flights\ndescription: Find flights"), "travel");
    expect(mismatch).toMatchObject({ name: "flights", warnings: [expect.stringMatching(/doesn't match/)] });

    const unnamed = parseSkill(skill("description: Find flights"), "flights");
    expect(unnamed).toMatchObject({ name: "flights", warnings: [expect.stringMatching(/No name/)] });

    expect(parseSkill(skill("name: flights"), "flights")).toEqual({ error: "SKILL.md has no description" });
    expect(parseSkill("# no frontmatter", "x")).toMatchObject({
      error: expect.stringMatching(/no frontmatter/),
    });
    expect(parseSkill(skill("name: Flights!\ndescription: x"), "x")).toMatchObject({
      error: expect.stringMatching(/isn't a valid skill name/),
    });
    expect(parseSkill(skill("name: x\ndescription: y\n- stray"), "x")).toMatchObject({
      error: expect.stringMatching(/can't be read/),
    });
    // A BOM and CRLF line endings are fine.
    expect(
      parseSkill(String.fromCharCode(0xfeff) + "---\r\nname: x\r\ndescription: y\r\n---\r\nbody", "x"),
    ).toMatchObject({
      name: "x",
      description: "y",
      body: "body",
    });
  });

  it("parses the YAML subset frontmatter uses", () => {
    expect(
      parseFrontmatter(
        ["a: 'it''s'", 'b: [one, "two"]', "c: |", "  line 1", "  line 2", "d:", "  - x", "  - y"].join("\n"),
      ),
    ).toEqual({ a: "it's", b: ["one", "two"], c: "line 1\nline 2", d: ["x", "y"] });
  });
});
