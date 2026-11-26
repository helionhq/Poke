import { z } from "zod";
import { defineToolSpec } from "./define.js";

const localTime = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/,
    "use YYYY-MM-DDTHH:MM in his timezone",
  );

const schedule = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("once"),
    at: localTime.describe("When, in his timezone unless it ends with Z or an offset"),
  }),
  z.object({
    kind: z.literal("cron"),
    expr: z
      .string()
      .min(9)
      .max(120)
      .describe("5-field cron: '30 7 * * *' every day 7:30, '0 9,13,18 * * 1-5' three times on weekdays"),
    tz: z.string().max(64).optional().describe("IANA timezone; his by default"),
  }),
  z.object({
    kind: z.literal("interval"),
    everyMinutes: z.number().int().min(5).max(525_600),
    startAt: localTime.optional(),
  }),
]);

const limits = {
  until: localTime.optional().describe("Stop after this time"),
  count: z.number().int().min(1).max(10_000).optional().describe("Stop after this many runs"),
};

const deliver = z
  .enum(["always", "only_if_notable"])
  .describe("only_if_notable: message him only when something is worth it (checks, monitors)");

export const routineCreate = defineToolSpec({
  name: "routine_create",
  description:
    "Create a routine: anything that should happen later or repeatedly (reminders, recurring checks, digests, a follow-up you promised). Each run hands the instructions to an agent and its result comes back to you.",
  input: z.object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .describe("Short and friendly: 'Morning brief', 'SFO → LIS prices'"),
    instructions: z.string().trim().min(1).max(4000).describe("What to do each run, in plain words"),
    schedule,
    ...limits,
    deliver: deliver.optional(),
  }),
  callers: ["model"],
});

export const routineUpdate = defineToolSpec({
  name: "routine_update",
  description:
    "Change a routine: pause or resume it (enabled), or change its title, instructions, schedule or delivery.",
  input: z.object({
    id: z.string().min(1),
    title: z.string().trim().min(1).max(80).optional(),
    instructions: z.string().trim().min(1).max(4000).optional(),
    schedule: schedule.optional(),
    ...limits,
    deliver: deliver.optional(),
    enabled: z.boolean().optional(),
  }),
  callers: ["model"],
});

export const routineDelete = defineToolSpec({
  name: "routine_delete",
  description: "Delete a routine for good.",
  input: z.object({ id: z.string().min(1) }),
  callers: ["model"],
});

export const routineList = defineToolSpec({
  name: "routine_list",
  description: "List routines with their schedule, next run and last result.",
  input: z.object({}),
  callers: ["model"],
  replay: "safe",
});

export const ROUTINE_TOOLS = { routineCreate, routineUpdate, routineDelete, routineList };
