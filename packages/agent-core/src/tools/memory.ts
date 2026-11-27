import { z } from "zod";
import { defineToolSpec } from "./define.js";

/** Read-only: Poke, agents and side chats. */
export const recall = defineToolSpec({
  name: "recall",
  description:
    "Ask what's known about Arham: preferences, people, places, plans, history. Ask a plain question. Use search_thread instead for his exact words, links or numbers.",
  input: z.object({
    question: z.string().min(1).max(1000),
    depth: z
      .enum(["quick", "deep"])
      .optional()
      .describe("deep thinks harder over everything known; slower. Default quick."),
  }),
  replay: "safe",
  searchHint: "memory remember know preferences about him",
});

/** Poke only: a fact Arham asked to keep. Shows a note he can undo. */
export const remember = defineToolSpec({
  name: "remember",
  description:
    "Keep a fact about Arham he asked you to remember (or clearly wants kept). One short fact in the third person: 'Allergic to peanuts'. A note he can undo shows under your reply.",
  input: z.object({ fact: z.string().trim().min(1).max(300) }),
  callers: ["model"],
});

export const MEMORY_TOOLS = { recall, remember };
