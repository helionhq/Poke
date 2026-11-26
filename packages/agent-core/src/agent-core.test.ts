import { describe, expect, it } from "vitest";
// @ts-expect-error: plain .mjs script without types
import { renderGenerated } from "../../../scripts/gen-prompts.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  executorPrompt,
  interactionPrompt,
  render,
  routineTurn,
  sendToAgent,
  sidechatPrompt,
  toolLabel,
  turnContext,
  voiceTurnNote,
} from "./index.js";

const persona = { userName: "Arham", timezone: "Europe/Lisbon", workspace: "~/poke/workspace" };

describe("prompts", () => {
  it("are in sync with the markdown sources", () => {
    const generated = readFileSync(join(import.meta.dirname, "prompts.generated.ts"), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    expect(generated).toBe((renderGenerated as () => string)());
  });

  it("render every prompt with no leftover slots", () => {
    for (const text of [
      interactionPrompt({
        ...persona,
        homeCity: "Lisbon",
        memoryCard: "- Likes window seats",
        skillsIndex: "- pdf: PDFs",
      }),
      executorPrompt(persona),
      sidechatPrompt(persona),
      voiceTurnNote("Arham"),
      routineTurn({
        userName: "Arham",
        title: "Morning brief",
        runId: "run_1",
        prompt: "Check my calendar",
        onlyIfNotable: true,
      }),
    ]) {
      expect(text).not.toMatch(/\{\{(?!vault:)[^}]*\}\}/);
      expect(text).not.toMatch(/\n{3,}/);
    }
  });

  it("drops empty sections and keeps vault placeholders", () => {
    const text = interactionPrompt(persona);
    expect(text).not.toContain("Home city");
    expect(text).not.toContain("Connected apps");
    expect(text).toContain("You are Poke, Arham's personal assistant.");
    expect(executorPrompt(persona)).toContain("{{vault:name.field}}");
    expect(executorPrompt(persona)).not.toContain("</available_skills>");
    expect(executorPrompt({ ...persona, skillsIndex: "- pdf" })).toContain(
      "<available_skills>\n- pdf\n</available_skills>",
    );
    expect(
      routineTurn({ userName: "A", title: "t", runId: "r", prompt: "p", onlyIfNotable: false }),
    ).not.toContain("wait");
  });

  it("never calls the machine a home server, and calls automations routines", () => {
    const all = [interactionPrompt(persona), executorPrompt(persona), sidechatPrompt(persona)].join("\n");
    expect(all).not.toMatch(/home server|Arham's server/i);
    expect(all).toMatch(/dedicated/);
    expect(interactionPrompt(persona)).toContain('never "triggers"');
  });

  it("throws on an unknown slot", () => {
    expect(() => render("hi {{nme}}", { name: "x" })).toThrow(/nme/);
  });

  it("formats per-turn context in the user's timezone", () => {
    const text = turnContext({
      now: Date.UTC(2026, 10, 26, 18, 30),
      timezone: "Europe/Lisbon",
      activeTasks: ["lisbon-stays"],
    });
    expect(text).toContain("18:30");
    expect(text).toContain("running: lisbon-stays");
  });
});

describe("tool specs", () => {
  it("produce plain JSON Schema and validate input", () => {
    expect(sendToAgent.spec.inputSchema).toMatchObject({ type: "object", required: ["name", "goal"] });
    expect(sendToAgent.spec.inputSchema.$schema).toBeUndefined();
    expect(() => sendToAgent.parse({ name: "x" })).toThrow(/goal/);
    expect(sendToAgent.parse({ name: "x", goal: "y" })).toEqual({ name: "x", goal: "y" });
  });

  it("label tool calls for traces", () => {
    expect(toolLabel("bash", { command: "ls -la" })).toMatchObject({
      done: "Ran a command",
      live: "Running ls -la",
    });
    expect(toolLabel("read", { path: "/home/poke/notes/plan.md" }).done).toBe("Read plan.md");
    expect(toolLabel("gcal_create", {}, { id: "gcal", name: "Google Calendar" }).done).toBe(
      "Used Google Calendar",
    );
    expect(toolLabel("mcp__github__list_issues", {}).done).toBe("Used list issues");
  });
});
