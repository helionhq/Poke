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
 * Ask Poke for something only Arham can give, and wait for it. The task parks (durably) until it
 * is resolved: a question is answered, a secret is saved to the vault, an app is connected.
 */
export const askPoke = defineToolSpec({
  name: "ask_poke",
  description: [
    "Ask Poke for something only Arham can give, then wait: your task pauses until it's resolved.",
    `kind "question": a choice, a preference or a missing detail you can't reasonably decide or find yourself. You get the answer.`,
    `kind "secret": a password, API key or one-time code. Arham types it into his vault; you never see it. You get the placeholder to use (e.g. {{vault:resy.login.password}}), which is filled in when a tool runs. Prefill what you know (email, username, phone) in fields.`,
    `kind "connection": an app that isn't connected yet (only when no connected account can do the job). You learn whether it was connected.`,
    "Use it rarely: each one interrupts Arham.",
  ].join("\n"),
  input: z
    .object({
      kind: z.enum(["question", "secret", "connection"]),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(300)
        .optional()
        .describe("Why you need it, in a few words. Required for secret and connection."),
      question: z.string().trim().min(1).max(500).optional().describe("question: what to ask"),
      options: z
        .array(z.string().trim().min(1).max(120))
        .max(8)
        .optional()
        .describe("question: choices to offer, when there are a few"),
      service: z.string().trim().min(1).max(80).optional().describe('secret: the service, e.g. "Resy"'),
      fields: z
        .record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), z.string().max(200))
        .optional()
        .describe("secret: non-secret details you already know, e.g. {email: …}"),
      secret: z
        .object({
          label: z.string().trim().min(1).max(40).describe('e.g. "Password", "API key", "Code"'),
          type: z.enum(["password", "api_key", "code", "card", "text"]),
        })
        .optional(),
      vaultName: z
        .string()
        .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
        .optional()
        .describe(`secret: where it's saved, e.g. "resy.login"`),
      app: z.string().trim().min(1).max(80).optional().describe("connection: the app id"),
      appName: z.string().trim().min(1).max(80).optional().describe('connection: its name, e.g. "Notion"'),
      caps: z
        .array(z.string().trim().min(1).max(120))
        .max(6)
        .optional()
        .describe("connection: what you'll do with it"),
    })
    .superRefine((args, ctx) => {
      const need = (field: keyof typeof args, why: string) => {
        if (args[field] === undefined) ctx.addIssue({ code: "custom", path: [field], message: why });
      };
      if (args.kind === "question") need("question", "a question needs the question");
      if (args.kind === "secret") {
        need("service", "a secret needs the service");
        need("secret", "a secret needs secret.label and secret.type");
        need("vaultName", "a secret needs a vaultName");
        need("reason", "a secret needs a reason");
      }
      if (args.kind === "connection") {
        need("app", "a connection needs the app id");
        need("reason", "a connection needs a reason");
      }
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
