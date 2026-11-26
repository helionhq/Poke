/** Agent Skills standard (agentskills.io): a folder with SKILL.md and optional bundled files. */
export interface Skill {
  /** 1–64 chars, lowercase letters, digits and hyphens; matches the folder name. */
  name: string;
  description: string;
  /** Absolute path to SKILL.md. */
  location: string;
  enabled: boolean;
  /** Where it came from (URL, "attachment", "poke"). */
  source?: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
  /** Validation warnings (lenient loading). */
  warnings: string[];
  installedAt: number;
  updatedAt: number;
}

export const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name) && !name.includes("--");
}
