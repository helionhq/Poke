import { ROUTINE_TOOLS, routineTurn } from "@poke/agent-core";
import {
  type Clock,
  DomainError,
  type IdGenerator,
  type Logger,
  type Repositories,
  type Routine,
  type RoutineDelivery,
  type RoutineRun,
  type Schedule,
  type Timers,
} from "@poke/domain";
import type { AgentsService } from "../agents.js";
import type { EventHub } from "../core/hub.js";
import type { SettingsService } from "../settings.js";
import { handler, json, text, type ToolGateway } from "../tools/gateway.js";
import {
  describeSchedule,
  nextRunAfter,
  parseLocalTime,
  validateSchedule,
  validateTimeZone,
} from "./schedule.js";

/** A run this much past its time is "late" (missed while Poke was down). */
const LATE_MS = 2 * 60_000;
/** Long timers drift and Node caps them; the loop re-checks at least this often. */
const MAX_SLEEP_MS = 15 * 60_000;
const RUNS_KEPT = 50;

export interface RoutinesDeps {
  repos: Repositories;
  hub: EventHub;
  ids: IdGenerator;
  clock: Clock;
  timers: Timers;
  log: Logger;
  settings: Pick<SettingsService, "timezone" | "userName">;
  agents: Pick<AgentsService, "start" | "createTrace">;
  gateway: ToolGateway;
}

/** What tools and the app send; times are in his timezone unless they carry an offset. */
export type ScheduleInput =
  | { kind: "once"; at: string }
  | { kind: "cron"; expr: string; tz?: string | undefined }
  | { kind: "interval"; everyMinutes: number; startAt?: string | undefined };

export interface RoutineInput {
  title: string;
  instructions: string;
  schedule: ScheduleInput;
  until?: string | undefined;
  count?: number | undefined;
  deliver?: RoutineDelivery | undefined;
}

export interface RoutinePatch extends Partial<Omit<RoutineInput, "schedule">> {
  schedule?: ScheduleInput | undefined;
  enabled?: boolean | undefined;
}

export interface RoutineFrame {
  routineId: string;
  runId: string;
  late: boolean;
  /** The frame Poke reads the agent's report in. */
  text: string;
}

/**
 * Routines (section 14): the only proactive mechanism. One loop on persisted `nextRunAt`; a run
 * hands the instructions to an executor, and its report reaches Poke inside the routine frame,
 * where Poke decides what to say (or waits). Missed runs are caught up once at boot.
 */
export class RoutineService {
  #timer?: { cancel(): void };
  #closed = false;

  constructor(private readonly deps: RoutinesDeps) {}

  start(): void {
    this.#registerTools();
    this.#settleInterrupted();
    this.tick();
  }

  /** Runs a restart cut short: their agent is gone (or done) and nobody will settle them. */
  #settleInterrupted(): void {
    const active = new Set(this.deps.repos.tasks.active().map((t) => t.id));
    for (const routine of this.deps.repos.routines.list()) {
      for (const run of this.deps.repos.routines.runs(routine.id, 5)) {
        if (run.status !== "running" || (run.taskId && active.has(run.taskId))) continue;
        this.deps.repos.routines.saveRun({
          ...run,
          status: "failed",
          endedAt: this.deps.clock.now(),
          summary: "Poke restarted before this run finished",
        });
      }
    }
  }

  close(): void {
    this.#closed = true;
    this.#timer?.cancel();
  }

  list(): Routine[] {
    return this.deps.repos.routines.list();
  }

  get(id: string): { routine: Routine; runs: RoutineRun[] } {
    const routine = this.#get(id);
    return { routine, runs: this.deps.repos.routines.runs(id, RUNS_KEPT) };
  }

  describe(routine: Routine): string {
    return describeSchedule(routine.schedule, this.deps.settings.timezone());
  }

  create(input: RoutineInput): Routine {
    const now = this.deps.clock.now();
    const schedule = this.#schedule(input.schedule, input.until, input.count);
    if (schedule.kind === "once" && schedule.at < now - 60_000)
      throw new DomainError("invalid", "That time has already passed");
    const routine: Routine = {
      id: this.deps.ids.next("rtn"),
      title: input.title.trim(),
      instructions: input.instructions.trim(),
      schedule,
      deliver: input.deliver ?? "always",
      enabled: true,
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    const next = nextRunAfter(schedule, now - 1, routine);
    if (next === undefined) throw new DomainError("invalid", "That schedule never runs");
    routine.nextRunAt = Math.max(next, now);
    this.#save(routine);
    this.#arm();
    return routine;
  }

  update(id: string, patch: RoutinePatch): Routine {
    const current = this.#get(id);
    const now = this.deps.clock.now();
    const scheduleChanged =
      patch.schedule !== undefined || patch.until !== undefined || patch.count !== undefined;
    const schedule = patch.schedule
      ? this.#schedule(patch.schedule, patch.until, patch.count)
      : scheduleChanged
        ? this.#withLimits(current.schedule, patch.until, patch.count)
        : current.schedule;
    const routine: Routine = {
      ...current,
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.instructions !== undefined ? { instructions: patch.instructions.trim() } : {}),
      ...(patch.deliver !== undefined ? { deliver: patch.deliver } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      schedule,
      // A new schedule starts counting again.
      ...(patch.schedule ? { runCount: 0 } : {}),
      updatedAt: now,
    };
    if (routine.enabled && (scheduleChanged || patch.enabled === true || routine.nextRunAt === undefined)) {
      const next = nextRunAfter(routine.schedule, now - 1, routine);
      if (next === undefined) {
        if (patch.enabled === true || patch.schedule)
          throw new DomainError("invalid", "That schedule has nothing left to run");
        delete routine.nextRunAt;
      } else routine.nextRunAt = Math.max(next, now);
    }
    if (!routine.enabled) delete routine.nextRunAt;
    this.#save(routine);
    this.#arm();
    return routine;
  }

  delete(id: string): void {
    this.#get(id);
    this.deps.hub.publish(() => {
      this.deps.repos.routines.delete(id);
      return [{ type: "routine.deleted", routineId: id }];
    });
    this.#arm();
  }

  /** "Run now" from the app: its schedule is left as it is. */
  async runNow(id: string): Promise<RoutineRun> {
    const routine = this.#get(id);
    return this.#run(routine, this.deps.clock.now(), false);
  }

  /** The frame for an agent report that belongs to a routine run. */
  frame(runId: string): RoutineFrame | undefined {
    const run = this.deps.repos.routines.getRun(runId);
    const routine = run ? this.deps.repos.routines.get(run.routineId) : undefined;
    if (!run || !routine) return undefined;
    const when = new Intl.DateTimeFormat("en-US", {
      timeZone: this.deps.settings.timezone(),
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(run.scheduledFor));
    const late = run.late ? `\n(This run is late: it was due ${when}, while Poke was offline.)` : "";
    return {
      routineId: routine.id,
      runId: run.id,
      late: run.late,
      text:
        routineTurn({
          userName: this.deps.settings.userName(),
          title: routine.title,
          runId: run.id,
          prompt: routine.instructions,
          onlyIfNotable: routine.deliver === "only_if_notable",
        }) + late,
    };
  }

  /** Poke's turn about a run ended: what reached him, if anything. */
  settle(runId: string, result: { messageId?: string | undefined; failed?: string | undefined }): void {
    const run = this.deps.repos.routines.getRun(runId);
    if (!run || run.status !== "running") return;
    const routine = this.deps.repos.routines.get(run.routineId);
    const settled: RoutineRun = {
      ...run,
      endedAt: this.deps.clock.now(),
      status: result.failed ? "failed" : result.messageId ? "delivered" : "quiet",
      ...(result.messageId ? { messageId: result.messageId } : {}),
      ...(result.failed ? { summary: result.failed.slice(0, 500) } : {}),
    };
    this.deps.repos.routines.saveRun(settled);
    if (routine) this.#publish(routine);
  }

  // ── the loop ─────────────────────────────────────────────────────────────────────────────────

  /** Fires what is due and sleeps until the next run. */
  tick(): void {
    if (this.#closed) return;
    const now = this.deps.clock.now();
    for (const routine of this.deps.repos.routines.due(now)) {
      const scheduledFor = routine.nextRunAt ?? now;
      void this.#fire(routine, scheduledFor, now - scheduledFor > LATE_MS).catch((error: unknown) =>
        this.deps.log.error({ err: error, routine: routine.id }, "routine run failed"),
      );
    }
    this.#arm();
  }

  #arm(): void {
    this.#timer?.cancel();
    this.#timer = undefined;
    if (this.#closed) return;
    const now = this.deps.clock.now();
    const next = this.deps.repos.routines
      .list()
      .filter((r) => r.enabled && r.nextRunAt !== undefined)
      .reduce((min, r) => Math.min(min, r.nextRunAt!), Infinity);
    if (next === Infinity) return;
    this.#timer = this.deps.timers.setTimeout(
      () => this.tick(),
      Math.min(Math.max(next - now, 0), MAX_SLEEP_MS),
    );
  }

  /** Advance the schedule first (missed recurring runs collapse into this one), then run. */
  async #fire(routine: Routine, scheduledFor: number, late: boolean): Promise<void> {
    const now = this.deps.clock.now();
    const runCount = routine.runCount + 1;
    const next = nextRunAfter(routine.schedule, now, { runCount, createdAt: routine.createdAt });
    const advanced: Routine = {
      ...routine,
      runCount,
      lastRunAt: now,
      updatedAt: now,
      // A one-shot (or a finished schedule) stays listed, paused.
      enabled: next !== undefined && routine.enabled,
    };
    if (next === undefined) delete advanced.nextRunAt;
    else advanced.nextRunAt = next;
    this.#save(advanced);
    await this.#run(advanced, scheduledFor, late);
  }

  async #run(routine: Routine, scheduledFor: number, late: boolean): Promise<RoutineRun> {
    const now = this.deps.clock.now();
    const run: RoutineRun = {
      id: this.deps.ids.next("run"),
      routineId: routine.id,
      scheduledFor,
      startedAt: now,
      status: "running",
      late,
    };
    this.deps.repos.routines.saveRun(run);
    // The trace's message is written only if Poke says something, so a quiet run leaves no trace
    // in the thread.
    const trace = this.deps.agents.createTrace(this.deps.ids.next("msg"));
    try {
      const task = await this.deps.agents.start(
        {
          name: `routine-${slug(routine.title)}`,
          goal: routine.instructions,
          context: `This is a run of the routine "${routine.title}" (${this.describe(routine)}). Do it now and report what you found; Poke decides what to tell ${this.deps.settings.userName()}.`,
        },
        {
          traceId: trace.id,
          routineRunId: run.id,
          ...(routine.model ? { model: routine.model } : {}),
        },
      );
      const started = { ...run, taskId: task.id };
      this.deps.repos.routines.saveRun(started);
      this.#publish(routine);
      return started;
    } catch (error) {
      const failed: RoutineRun = {
        ...run,
        status: "failed",
        endedAt: this.deps.clock.now(),
        summary: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      };
      this.deps.repos.routines.saveRun(failed);
      this.#publish(routine);
      this.deps.log.warn({ routine: routine.id, error: failed.summary }, "a routine couldn't start");
      return failed;
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────

  #get(id: string): Routine {
    const routine = this.deps.repos.routines.get(id);
    if (!routine) throw new DomainError("not_found", `No routine ${id}`);
    return routine;
  }

  #save(routine: Routine): void {
    this.deps.hub.publish(() => {
      this.deps.repos.routines.save(routine);
      return [{ type: "routine.updated", routine }];
    });
  }

  #publish(routine: Routine): void {
    const current = this.deps.repos.routines.get(routine.id);
    if (current) this.deps.hub.publish(() => [{ type: "routine.updated", routine: current }]);
  }

  #schedule(input: ScheduleInput, until?: string, count?: number): Schedule {
    const tz = this.deps.settings.timezone();
    let schedule: Schedule;
    try {
      if (input.kind === "once") schedule = { kind: "once", at: parseLocalTime(input.at, tz) };
      else if (input.kind === "cron") {
        if (input.tz) validateTimeZone(input.tz);
        schedule = { kind: "cron", expr: input.expr.trim(), tz: input.tz ?? tz };
      } else
        schedule = {
          kind: "interval",
          everyMs: input.everyMinutes * 60_000,
          ...(input.startAt ? { startAt: parseLocalTime(input.startAt, tz) } : {}),
        };
      schedule = this.#withLimits(schedule, until, count);
      validateSchedule(schedule);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("invalid", (error as Error).message);
    }
    return schedule;
  }

  #withLimits(schedule: Schedule, until?: string, count?: number): Schedule {
    if (schedule.kind === "once") return schedule;
    const tz = this.deps.settings.timezone();
    return {
      ...schedule,
      ...(until !== undefined ? { until: parseLocalTime(until, tz) } : {}),
      ...(count !== undefined ? { count } : {}),
    };
  }

  #summary(routine: Routine): Record<string, unknown> {
    const last = this.deps.repos.routines.runs(routine.id, 1)[0];
    const tz = this.deps.settings.timezone();
    const at = (ms: number) =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(ms));
    return {
      id: routine.id,
      title: routine.title,
      schedule: this.describe(routine),
      enabled: routine.enabled,
      deliver: routine.deliver,
      instructions: routine.instructions,
      ...(routine.nextRunAt ? { nextRun: at(routine.nextRunAt) } : {}),
      ...(last ? { lastRun: `${at(last.startedAt)} (${last.status})` } : {}),
    };
  }

  #registerTools(): void {
    const { gateway } = this.deps;
    gateway.register(
      handler(ROUTINE_TOOLS.routineCreate, (args) => {
        const routine = this.create(args);
        return json({
          ...this.#summary(routine),
          note: "Created. Tell him in a line, with when it first runs.",
        });
      }),
      ["poke"],
    );
    gateway.register(
      handler(ROUTINE_TOOLS.routineUpdate, (args) => {
        const { id, ...patch } = args;
        return json(this.#summary(this.update(id, patch)));
      }),
      ["poke"],
    );
    gateway.register(
      handler(ROUTINE_TOOLS.routineDelete, (args) => {
        const routine = this.#get(args.id);
        this.delete(args.id);
        return text(`Deleted ${routine.title}.`);
      }),
      ["poke"],
    );
    gateway.register(
      handler(ROUTINE_TOOLS.routineList, () => {
        const routines = this.list();
        return routines.length ? json(routines.map((r) => this.#summary(r))) : text("No routines yet.");
      }),
      ["poke"],
    );
  }
}

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "run"
  );
}
