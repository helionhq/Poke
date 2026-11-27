import { activateSkillSpec, SKILL_TOOLS } from "@poke/agent-core";
import {
  type Clock,
  DomainError,
  type Logger,
  type Repositories,
  type Skill,
  type SkillFiles,
  type SkillFolder,
} from "@poke/domain";
import type { EventHub } from "../core/hub.js";
import { handler, text, type ToolGateway } from "../tools/gateway.js";
import { escapeXml, parseSkill } from "./parse.js";

const MAX_PER_INSTALL = 20;

export interface SkillsDeps {
  repos: Repositories;
  hub: EventHub;
  clock: Clock;
  log: Logger;
  files: SkillFiles;
  gateway: ToolGateway;
  /** `attachment:<id>` sources: the file's absolute path. */
  attachmentPath(id: string): string;
}

export interface SkillView extends Skill {
  /** SKILL.md without frontmatter (the detail screen renders it). */
  body?: string;
}

/**
 * Agent Skills (section 15): folders in ~/poke/skills with a SKILL.md, a catalog in every agent's
 * prompt, `activate_skill` for Poke (who has no file tools), and `skill_install`. Executors and
 * side chats read SKILL.md themselves from its location.
 */
export class SkillService {
  readonly #activated = new Set<string>();
  #announcements: string[] = [];
  #activeNames = "";

  constructor(private readonly deps: SkillsDeps) {}

  async start(): Promise<void> {
    await this.sync();
    this.deps.gateway.register(
      handler(SKILL_TOOLS.skillInstall, async (args) => {
        const installed = await this.install(args.source);
        return text(
          installed
            .map(
              (s) =>
                `Installed ${s.name}: ${s.description}${s.warnings.length ? ` (note: ${s.warnings.join("; ")})` : ""}`,
            )
            .join("\n") +
            "\nIt's enabled and on the Skills screen. Confirm it to Arham in a line. Agents see it from their next session.",
        );
      }),
      ["poke"],
    );
  }

  /** Brings poke.db in line with the folder: new folders are enabled, gone ones removed. */
  async sync(): Promise<void> {
    const folders = await this.deps.files.scan();
    const seen = new Set<string>();
    for (const folder of folders) {
      const parsed = parseSkill(folder.text, folder.folder);
      if ("error" in parsed) {
        this.deps.log.warn({ folder: folder.folder, error: parsed.error }, "skipped a skill");
        continue;
      }
      if (seen.has(parsed.name)) {
        this.deps.log.warn(
          { folder: folder.folder, name: parsed.name },
          "two skills share a name; kept the first",
        );
        continue;
      }
      seen.add(parsed.name);
      const existing = this.deps.repos.skills.get(parsed.name);
      this.#save(this.#record(parsed, folder.location, existing?.source, existing));
    }
    for (const skill of this.deps.repos.skills.list()) {
      if (!seen.has(skill.name)) this.#delete(skill.name);
    }
    this.#refreshTool();
  }

  list(): Skill[] {
    return this.deps.repos.skills.list();
  }

  async get(name: string): Promise<SkillView> {
    const skill = this.deps.repos.skills.get(name);
    if (!skill) throw new DomainError("not_found", `No skill called ${name}`);
    const folder = (await this.deps.files.scan()).find((f) => f.location === skill.location);
    const parsed = folder ? parseSkill(folder.text, folder.folder) : undefined;
    return { ...skill, ...(parsed && !("error" in parsed) ? { body: parsed.body } : {}) };
  }

  setEnabled(name: string, enabled: boolean): Skill {
    const skill = this.deps.repos.skills.get(name);
    if (!skill) throw new DomainError("not_found", `No skill called ${name}`);
    const updated = { ...skill, enabled, updatedAt: this.deps.clock.now() };
    this.#save(updated);
    this.#refreshTool();
    return updated;
  }

  async remove(name: string): Promise<void> {
    if (!this.deps.repos.skills.get(name)) throw new DomainError("not_found", `No skill called ${name}`);
    await this.deps.files.remove(name);
    this.#delete(name);
    this.#refreshTool();
  }

  /** `<skill>` entries for `<available_skills>`; undefined when none are enabled (no empty block). */
  catalog(): string | undefined {
    const enabled = this.#enabled();
    if (enabled.length === 0) return undefined;
    return enabled
      .map(
        (s) =>
          `<skill>\n<name>${escapeXml(s.name)}</name>\n<description>${escapeXml(s.description)}</description>\n<location>${escapeXml(s.location)}</location>\n</skill>`,
      )
      .join("\n");
  }

  /** Skills installed since the last turn, for "New skill available" in the next turn's context. */
  takeAnnouncements(): string[] {
    const out = this.#announcements;
    this.#announcements = [];
    return out;
  }

  /** A new Poke session starts without any activated skill in its context. */
  resetActivations(): void {
    this.#activated.clear();
  }

  /** The skill's body for Poke, once per session (agentskills.io/integrate-skills). */
  async activate(name: string): Promise<string> {
    const skill = this.deps.repos.skills.get(name);
    if (!skill?.enabled) throw new DomainError("not_found", `No enabled skill called ${name}`);
    if (this.#activated.has(name)) return `The ${name} skill is already loaded above; follow it from there.`;
    const content = await this.#content(skill);
    this.#activated.add(name);
    return content;
  }

  /** SKILL.md bodies for an agent's first turn (send_to_agent's `skills`). Unknown names are noted. */
  async forTask(names: string[]): Promise<string> {
    const parts: string[] = [];
    for (const name of names) {
      const skill = this.deps.repos.skills.get(name);
      if (!skill?.enabled) {
        parts.push(`(No enabled skill called ${name}.)`);
        continue;
      }
      parts.push(await this.#content(skill));
    }
    return parts.join("\n\n");
  }

  /** From a URL, an attachment or a local folder. Every skill found in the source is installed. */
  async install(source: string): Promise<Skill[]> {
    const resolved = source.startsWith("attachment:")
      ? this.deps.attachmentPath(source.slice("attachment:".length))
      : source;
    const staged = await this.deps.files.stage(resolved);
    try {
      if (staged.skills.length === 0) throw new DomainError("invalid", "No SKILL.md found there");
      if (staged.skills.length > MAX_PER_INSTALL)
        throw new DomainError(
          "invalid",
          `That holds ${staged.skills.length} skills; install at most ${MAX_PER_INSTALL} at once`,
        );
      const errors: string[] = [];
      const installed: Skill[] = [];
      for (const folder of staged.skills) {
        const parsed = parseSkill(folder.text, folder.folder);
        if ("error" in parsed) {
          errors.push(`${folder.folder}: ${parsed.error}`);
          continue;
        }
        const location = await this.deps.files.commit(staged.id, folder.folder, parsed.name);
        // Installed under its own name, so only content warnings remain.
        const warnings = parsed.warnings.filter((w) => !w.includes("doesn't match its folder"));
        const skill = this.#record(
          { ...parsed, warnings },
          location,
          source,
          this.deps.repos.skills.get(parsed.name),
        );
        this.#save({ ...skill, enabled: true });
        installed.push(skill);
        this.#announcements.push(`New skill available: ${skill.name} (${skill.description})`);
      }
      if (installed.length === 0) throw new DomainError("invalid", errors.join("\n"));
      this.#refreshTool();
      return installed;
    } finally {
      await this.deps.files.discard(staged.id).catch(() => undefined);
    }
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────

  #enabled(): Skill[] {
    return this.deps.repos.skills.list().filter((s) => s.enabled);
  }

  async #content(skill: Skill): Promise<string> {
    const folder = (await this.deps.files.scan()).find((f) => f.location === skill.location);
    const parsed = folder ? parseSkill(folder.text, folder.folder) : undefined;
    if (!parsed || "error" in parsed)
      throw new DomainError("unavailable", `The ${skill.name} skill can't be read`);
    const resources = await this.deps.files.resources(skill.name);
    const dir = skill.location.replace(/[\\/]SKILL\.md$/, "");
    const files = resources.length
      ? `\n<skill_resources>\n${resources.map((r) => `<file>${escapeXml(r)}</file>`).join("\n")}\n</skill_resources>`
      : "";
    return `<skill_content name="${escapeXml(skill.name)}">\n${parsed.body}\n\nSkill directory: ${dir}${files}\n</skill_content>`;
  }

  #record(
    parsed: Exclude<ReturnType<typeof parseSkill>, { error: string }>,
    location: string,
    source: string | undefined,
    existing: Skill | undefined,
  ): Skill {
    const now = this.deps.clock.now();
    return {
      name: parsed.name,
      description: parsed.description,
      location,
      enabled: existing?.enabled ?? true,
      ...(source ? { source } : {}),
      ...(parsed.license ? { license: parsed.license } : {}),
      ...(parsed.compatibility ? { compatibility: parsed.compatibility } : {}),
      ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
      ...(parsed.allowedTools ? { allowedTools: parsed.allowedTools } : {}),
      warnings: parsed.warnings,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
    };
  }

  #save(skill: Skill): void {
    const before = this.deps.repos.skills.get(skill.name);
    if (before && JSON.stringify({ ...before, updatedAt: 0 }) === JSON.stringify({ ...skill, updatedAt: 0 }))
      return;
    this.deps.hub.publish(() => {
      this.deps.repos.skills.save(skill);
      return [{ type: "skill.updated", skill }];
    });
  }

  #delete(name: string): void {
    this.#activated.delete(name);
    this.deps.hub.publish(() => {
      this.deps.repos.skills.delete(name);
      return [{ type: "skill.deleted", name }];
    });
  }

  /** activate_skill's enum follows the enabled skills; with none, there's no tool. */
  #refreshTool(): void {
    const names = this.#enabled().map((s) => s.name);
    const key = names.join("\n");
    if (key === this.#activeNames && this.deps.gateway.has("activate_skill") === names.length > 0) return;
    this.#activeNames = key;
    if (this.deps.gateway.has("activate_skill")) this.deps.gateway.unregister("activate_skill");
    if (names.length === 0) return;
    this.deps.gateway.register(
      handler(activateSkillSpec(names as [string, ...string[]]), async (args) =>
        text(await this.activate(args.name)),
      ),
      ["poke"],
    );
  }
}

export type { SkillFolder };
