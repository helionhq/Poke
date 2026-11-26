import type { Schedule } from "@poke/domain";
import { Cron } from "croner";

/** A routine may not run more often than this. */
export const MIN_INTERVAL_MS = 5 * 60_000;

/** The UTC offset (ms) of `timeZone` at instant `at`. */
function offsetAt(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const local = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return local - Math.floor(at / 1000) * 1000;
}

/**
 * "2026-11-27T17:00" in his timezone → epoch ms. A trailing Z or offset is taken as written.
 * A local time skipped by a DST change moves forward by the gap.
 */
export function parseLocalTime(value: string, timeZone: string): number {
  if (/(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const at = Date.parse(value);
    if (Number.isNaN(at)) throw new Error(`Not a time: ${value}`);
    return at;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (!m) throw new Error(`Not a time: ${value}`);
  const wall = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
  const first = wall - offsetAt(wall, timeZone);
  const second = wall - offsetAt(first, timeZone);
  if (second + offsetAt(second, timeZone) === wall) return second;
  // The wall time falls in a DST gap: take the later reading, i.e. moved forward by the gap.
  return Math.max(first, second);
}

export function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    throw new Error(`Unknown timezone ${timeZone}`);
  }
}

/** Checks a schedule; throws a plain-words error. */
export function validateSchedule(schedule: Schedule): void {
  if (schedule.kind === "cron") {
    validateTimeZone(schedule.tz);
    try {
      new Cron(schedule.expr, { timezone: schedule.tz, paused: true });
    } catch (error) {
      throw new Error(`That cron expression doesn't work: ${(error as Error).message}`, { cause: error });
    }
    const cron = new Cron(schedule.expr, { timezone: schedule.tz, paused: true });
    const [a, b] = cron.nextRuns(2);
    if (a && b && b.getTime() - a.getTime() < MIN_INTERVAL_MS)
      throw new Error("Routines can run at most every 5 minutes");
  }
  if (schedule.kind === "interval" && schedule.everyMs < MIN_INTERVAL_MS)
    throw new Error("Routines can run at most every 5 minutes");
}

/**
 * The first run strictly after `after`, or undefined when the schedule is done (a one-shot that
 * ran, past `until`, or `count` runs reached).
 */
export function nextRunAfter(
  schedule: Schedule,
  after: number,
  state: { runCount: number; createdAt: number },
): number | undefined {
  let next: number | undefined;
  switch (schedule.kind) {
    case "once":
      return state.runCount === 0 ? schedule.at : undefined;
    case "cron":
      next = new Cron(schedule.expr, { timezone: schedule.tz, paused: true })
        .nextRun(new Date(after))
        ?.getTime();
      break;
    case "interval": {
      const start = schedule.startAt ?? state.createdAt;
      next =
        after < start
          ? start
          : start + (Math.floor((after - start) / schedule.everyMs) + 1) * schedule.everyMs;
      break;
    }
  }
  if (next === undefined) return undefined;
  if (schedule.until !== undefined && next > schedule.until) return undefined;
  if (schedule.count !== undefined && state.runCount >= schedule.count) return undefined;
  return next;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function clock(hour: number, minute: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

function dayList(field: string): string | undefined {
  if (field === "*") return undefined;
  if (field === "1-5") return "weekdays";
  if (field === "0,6" || field === "6,0") return "weekends";
  const days = field.split(",").map((d) => Number(d) % 7);
  if (days.some((d) => Number.isNaN(d))) return undefined;
  return days.map((d) => DAYS[d]).join(", ");
}

/** "Every day · 7:30 AM", "Weekdays · 9:00 AM, 1:00 PM", "Every 2 hours", "Once · Thu, Nov 27, 5:00 PM". */
export function describeSchedule(schedule: Schedule, timeZone: string): string {
  const fmt = (at: number, withTime = true) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
    }).format(new Date(at));
  let text: string;
  if (schedule.kind === "once") text = `Once · ${fmt(schedule.at)}`;
  else if (schedule.kind === "interval") {
    const minutes = Math.round(schedule.everyMs / 60_000);
    text =
      minutes % 1440 === 0
        ? `Every ${minutes / 1440 === 1 ? "day" : `${minutes / 1440} days`}`
        : minutes % 60 === 0
          ? `Every ${minutes / 60 === 1 ? "hour" : `${minutes / 60} hours`}`
          : `Every ${minutes} minutes`;
  } else {
    const [min, hour, dom, mon, dow] = schedule.expr.trim().split(/\s+/);
    const simple = min && hour && /^\d+$/.test(min) && /^\d+(,\d+)*$/.test(hour) && mon === "*";
    if (simple && dom === "*") {
      const times = hour.split(",").map((h) => clock(Number(h), Number(min)));
      const days = dayList(dow ?? "*");
      const label = !days
        ? "Every day"
        : days === "weekdays"
          ? "Weekdays"
          : days === "weekends"
            ? "Weekends"
            : `Every ${days}`;
      text = `${label} · ${times.join(", ")}`;
    } else if (simple && dom && /^\d+$/.test(dom) && dow === "*") {
      text = `Monthly on the ${dom}${["th", "st", "nd", "rd"][Number(dom) % 10 > 3 || [11, 12, 13].includes(Number(dom)) ? 0 : Number(dom) % 10]} · ${hour
        .split(",")
        .map((h) => clock(Number(h), Number(min)))
        .join(", ")}`;
    } else text = `On schedule · ${schedule.expr}`;
    if (schedule.tz !== timeZone) text += ` (${schedule.tz})`;
  }
  if (schedule.kind !== "once" && schedule.until !== undefined)
    text += ` · until ${fmt(schedule.until, false)}`;
  if (schedule.kind !== "once" && schedule.count !== undefined) text += ` · ${schedule.count} times`;
  return text;
}
