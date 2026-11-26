import { PROMPT_SOURCES, type PromptName } from "./prompts.generated.js";

export type { PromptName };
export type Slots = Record<string, string | undefined>;

const SECTION_RE = /\{\{#([a-z_]+)\}\}\n?([\s\S]*?)\{\{\/\1\}\}\n?/g;
const SLOT_RE = /\{\{([a-z_]+)\}\}/g;

/**
 * Tiny template language: `{{slot}}` is replaced (a missing value is an error, so a typo can't ship
 * silently), `{{#slot}}…{{/slot}}` keeps its body only when the slot is non-empty. Anything else in
 * braces (`{{vault:name.field}}`) is left alone.
 */
export function render(template: string, slots: Slots): string {
  const withSections = template.replace(SECTION_RE, (_m, name: string, body: string) =>
    slots[name]?.trim() ? body : "",
  );
  return withSections
    .replace(SLOT_RE, (_m, name: string) => {
      const value = slots[name];
      if (value === undefined) throw new Error(`Prompt slot "${name}" has no value`);
      return value;
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function prompt(name: PromptName, slots: Slots): string {
  return render(PROMPT_SOURCES[name], slots);
}

export interface PersonaSlots {
  userName: string;
  timezone: string;
  homeCity?: string;
  /** Honcho peer card, read once per session. */
  memoryCard?: string;
  integrations?: string;
  skillsIndex?: string;
  workspace: string;
}

function slots(p: PersonaSlots): Slots {
  return {
    user_name: p.userName,
    timezone: p.timezone,
    home_city: p.homeCity ?? "",
    memory_card: p.memoryCard ?? "",
    integrations: p.integrations ?? "",
    skills_index: p.skillsIndex ?? "",
    workspace: p.workspace,
  };
}

/** The interaction agent's system prompt: persona first, then how it works. */
export function interactionPrompt(p: PersonaSlots): string {
  return `${prompt("personality", slots(p))}\n\n${prompt("interaction", slots(p))}`;
}

export function executorPrompt(p: PersonaSlots): string {
  return prompt("executor", slots(p));
}

export function sidechatPrompt(p: PersonaSlots): string {
  return prompt("sidechat", slots(p));
}

export function voiceTurnNote(userName: string): string {
  return prompt("voice", { user_name: userName });
}

export function routineTurn(input: {
  userName: string;
  title: string;
  runId: string;
  prompt: string;
  onlyIfNotable: boolean;
}): string {
  return prompt("routine", {
    user_name: input.userName,
    routine_title: input.title,
    run_id: input.runId,
    routine_prompt: input.prompt,
    only_if_notable: input.onlyIfNotable ? "yes" : "",
  });
}

/** Per-turn facts. They go into the user turn, never the system prompt, to keep the cache warm. */
export function turnContext(facts: {
  now: number;
  timezone: string;
  presence?: string;
  location?: string;
  activeTasks?: string[];
  pendingBlocks?: string[];
  extra?: string[];
}): string {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: facts.timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(facts.now);
  const lines = [`time: ${time} (${facts.timezone})`];
  if (facts.location) lines.push(`location: ${facts.location}`);
  if (facts.presence) lines.push(`app: ${facts.presence}`);
  if (facts.activeTasks?.length) lines.push(`running: ${facts.activeTasks.join("; ")}`);
  if (facts.pendingBlocks?.length) lines.push(`waiting on him: ${facts.pendingBlocks.join("; ")}`);
  for (const line of facts.extra ?? []) lines.push(line);
  return `<context>\n${lines.join("\n")}\n</context>`;
}
