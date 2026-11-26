import { z } from "zod";
import { defineToolSpec } from "./define.js";

/**
 * Poke has no file tools, so it activates skills with this (agentskills.io/integrate-skills).
 * The name is an enum of the enabled skills, rebuilt whenever they change; there's no tool at all
 * when none are enabled.
 */
export function activateSkillSpec(names: [string, ...string[]]) {
  return defineToolSpec({
    name: "activate_skill",
    description:
      "Load a skill's full instructions (from <available_skills>) when a task matches its description. Pass the skill names on to agents with send_to_agent's skills.",
    input: z.object({ name: z.enum(names) }),
    callers: ["model"],
    replay: "safe",
  });
}

export const skillInstall = defineToolSpec({
  name: "skill_install",
  description:
    "Install a skill when Arham asks: from a URL (a raw SKILL.md, a GitHub folder or repo, a zip or tarball), an attachment he sent (attachment:<id>), or a folder on this machine an agent wrote (an absolute path). It's validated and enabled; agents see it from their next session.",
  input: z.object({ source: z.string().trim().min(1).max(2000) }),
  callers: ["model"],
});

export const SKILL_TOOLS = { skillInstall };
