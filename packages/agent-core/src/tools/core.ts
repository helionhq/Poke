import { z } from "zod";
import { defineToolSpec } from "./define.js";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, "use YYYY-MM-DD")
  .describe("ISO date, e.g. 2026-10-09");

// ── Interaction agent (Poke) ─────────────────────────────────────────────────────────────────

export const sendToAgent = defineToolSpec({
  name: "send_to_agent",
  description:
    "Hand work to an agent on your machine: start a new one (name + goal + context), or message a running or finished one by agentId. Returns at once; several can run in parallel.",
  input: z.object({
    agentId: z
      .string()
      .optional()
      .describe("An existing agent's id or name, to message it instead of starting one"),
    name: z.string().min(1).max(48).describe("Short handle for the work, e.g. lisbon-stays"),
    goal: z
      .string()
      .min(1)
      .describe("What done looks like, in one or two sentences, or the message for an existing agent"),
    context: z
      .string()
      .optional()
      .describe("Everything the agent needs that it can't find itself: preferences, ids, links, constraints"),
    skills: z.array(z.string()).optional().describe("Skill names to load before it starts"),
  }),
});

export const listAgents = defineToolSpec({
  name: "list_agents",
  description: "List your agents with their status (running, waiting, done, failed), most recent first.",
  input: z.object({ includeFinished: z.boolean().optional() }),
  replay: "safe",
});

export const cancelAgent = defineToolSpec({
  name: "cancel_agent",
  description: "Stop a running agent by id or name.",
  input: z.object({ agentId: z.string().min(1) }),
});

export const wait = defineToolSpec({
  name: "wait",
  description:
    "Say nothing this turn: for agent updates or routine results that aren't worth a message. Use it instead of replying, not with a reply.",
  input: z.object({ reason: z.string().optional().describe("Why nothing is said (for the log only)") }),
  replay: "safe",
});

export const searchThread = defineToolSpec({
  name: "search_thread",
  description:
    "Search everything ever said in this thread (exact words, links, numbers) when it isn't in your context any more.",
  input: z.object({
    query: z.string().min(1),
    before: isoDate.optional(),
    after: isoDate.optional(),
    limit: z.number().int().min(1).max(30).optional(),
  }),
  replay: "safe",
});

// ── Execution agents ─────────────────────────────────────────────────────────────────────────

export const reportProgress = defineToolSpec({
  name: "report_progress",
  description:
    'Post a short present-tense status line for Poke ("Searching Airbnb for stays in Príncipe Real"). Doesn\'t end your work.',
  input: z.object({ text: z.string().min(1).max(160) }),
  callers: ["model"],
  replay: "safe",
});

/**
 * Ask Poke for something only Arham can give, and wait for it. The task parks (durably) until
 * the answer arrives. Secrets and connections join in milestones 5 and 6.
 */
export const askPoke = defineToolSpec({
  name: "ask_poke",
  description:
    "Ask Poke a question only Arham can answer (a choice, a preference, a missing detail) and wait for the answer. Use it only when you can't reasonably decide or find it yourself.",
  input: z.object({
    kind: z.literal("question"),
    question: z.string().min(1).max(500),
    options: z
      .array(z.string().min(1).max(120))
      .max(8)
      .optional()
      .describe("Choices to offer, when there are a few"),
    reason: z.string().max(300).optional().describe("Why you need it, in a few words"),
  }),
  callers: ["model"],
  replay: "safe",
});

export const CORE_TOOLS = {
  sendToAgent,
  listAgents,
  cancelAgent,
  wait,
  searchThread,
  reportProgress,
  askPoke,
} as const;

/** Tool names whose calls never show as Trace steps (bookkeeping, not work). */
export const SILENT_TOOLS = new Set(["report_progress", "wait", "list_agents"]);
