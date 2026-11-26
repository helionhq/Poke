import { isValidSkillName } from "@poke/domain";

export interface ParsedSkill {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
  /** SKILL.md without its frontmatter. */
  body: string;
  warnings: string[];
}

type Value = string | Record<string, string> | string[];

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'"))
    return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

/**
 * The YAML subset SKILL.md frontmatter uses: scalars (plain, quoted, `|` and `>` blocks), one
 * level of `key: value` maps (metadata) and `- item` lists. Anything else is an error, so the
 * skill is skipped rather than half-read.
 */
export function parseFrontmatter(yaml: string): Record<string, Value> {
  const out: Record<string, Value> = {};
  const lines = yaml.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  const indentOf = (line: string) => line.length - line.trimStart().length;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith("#")) {
      i++;
      continue;
    }
    if (indentOf(line) > 0) throw new Error(`Unexpected indentation: ${line.trim()}`);
    const match = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line);
    if (!match) throw new Error(`Can't read this line: ${line.trim()}`);
    const key = match[1]!;
    const rest = (match[2] ?? "").trim();
    i++;
    const block: string[] = [];
    while (i < lines.length && (lines[i]!.trim() === "" || indentOf(lines[i]!) > 0)) block.push(lines[i++]!);
    while (block.length && !block.at(-1)!.trim()) block.pop();
    if (rest === "|" || rest === ">" || /^[|>][+-]$/.test(rest)) {
      const pad = Math.min(...block.filter((l) => l.trim()).map(indentOf));
      const text = block.map((l) => l.slice(pad));
      out[key] = rest.startsWith("|")
        ? text.join("\n")
        : text
            .join("\n")
            .replace(/([^\n])\n(?=[^\n])/g, "$1 ")
            .trim();
      continue;
    }
    if (rest && !rest.startsWith("#")) {
      if (block.some((l) => l.trim())) {
        // A plain scalar folded over several lines.
        out[key] = [rest, ...block.map((l) => l.trim())].filter(Boolean).join(" ");
      } else if (rest.startsWith("[") && rest.endsWith("]")) {
        out[key] = rest
          .slice(1, -1)
          .split(",")
          .map((s) => unquote(s))
          .filter(Boolean);
      } else {
        out[key] = unquote(rest);
      }
      continue;
    }
    const items = block.filter((l) => l.trim());
    if (items.length === 0) {
      out[key] = "";
    } else if (items.every((l) => l.trimStart().startsWith("- "))) {
      out[key] = items.map((l) => unquote(l.trimStart().slice(2)));
    } else {
      const map: Record<string, string> = {};
      for (const item of items) {
        const pair = /^\s+([^:]+):\s*(.*)$/.exec(item);
        if (!pair) throw new Error(`Can't read this line: ${item.trim()}`);
        map[pair[1]!.trim()] = unquote(pair[2]!);
      }
      out[key] = map;
    }
  }
  return out;
}

const BOM = String.fromCharCode(0xfeff);

const text = (value: Value | undefined): string | undefined =>
  typeof value === "string" ? value : Array.isArray(value) ? value.join(" ") : undefined;

/**
 * SKILL.md per agentskills.io/specification, read leniently as agentskills.io/integrate-skills
 * suggests: a name that doesn't match its folder or is too long is a warning; a missing
 * description or unreadable frontmatter is an error (the skill is skipped).
 */
export function parseSkill(source: string, folder: string): ParsedSkill | { error: string } {
  const normalized = (source.startsWith(BOM) ? source.slice(1) : source).replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) return { error: "SKILL.md has no frontmatter (a block between --- lines at the top)" };
  let fields: Record<string, Value>;
  try {
    fields = parseFrontmatter(match[1]!);
  } catch (error) {
    return { error: `SKILL.md's frontmatter can't be read: ${(error as Error).message}` };
  }
  const warnings: string[] = [];
  const description = text(fields.description)?.trim();
  if (!description) return { error: "SKILL.md has no description" };
  if (description.length > 1024) warnings.push("The description is longer than 1024 characters");
  const name = text(fields.name)?.trim() || folder;
  if (!text(fields.name)) warnings.push(`No name in SKILL.md; using the folder name ${folder}`);
  if (!isValidSkillName(name.slice(0, 64)))
    return { error: `"${name}" isn't a valid skill name (lowercase letters, digits and single hyphens)` };
  if (name.length > 64) warnings.push("The name is longer than 64 characters");
  if (name !== folder) warnings.push(`The name ${name} doesn't match its folder ${folder}`);
  const compatibility = text(fields.compatibility)?.trim();
  if (compatibility && compatibility.length > 500)
    warnings.push("The compatibility note is longer than 500 characters");
  const metadata =
    fields.metadata && typeof fields.metadata === "object" && !Array.isArray(fields.metadata)
      ? fields.metadata
      : undefined;
  const tools = fields["allowed-tools"];
  const allowedTools = Array.isArray(tools)
    ? tools
    : typeof tools === "string" && tools.trim()
      ? tools.trim().split(/\s+/)
      : undefined;
  const license = text(fields.license)?.trim();
  return {
    name,
    description,
    ...(license ? { license } : {}),
    ...(compatibility ? { compatibility } : {}),
    ...(metadata ? { metadata } : {}),
    ...(allowedTools?.length ? { allowedTools } : {}),
    body: normalized.slice(match[0].length).trim(),
    warnings,
  };
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
