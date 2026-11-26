import { describe, expect, it } from "vitest";
import { describeSchedule, nextRunAfter, parseLocalTime, validateSchedule } from "./schedule.js";

const LISBON = "Europe/Lisbon";
const NY = "America/New_York";
const fresh = { runCount: 0, createdAt: 0 };

describe("schedules", () => {
  it("reads local times in his timezone, across DST", () => {
    // Winter: Lisbon is UTC+0; summer: UTC+1.
    expect(new Date(parseLocalTime("2026-01-15T09:00", LISBON)).toISOString()).toBe(
      "2026-01-15T09:00:00.000Z",
    );
    expect(new Date(parseLocalTime("2026-07-15T09:00", LISBON)).toISOString()).toBe(
      "2026-07-15T08:00:00.000Z",
    );
    expect(new Date(parseLocalTime("2026-07-15T09:00", NY)).toISOString()).toBe("2026-07-15T13:00:00.000Z");
    // An explicit offset wins.
    expect(new Date(parseLocalTime("2026-07-15T09:00Z", NY)).toISOString()).toBe("2026-07-15T09:00:00.000Z");
    // 02:30 doesn't exist on 2026-03-08 in New York; it lands just after the jump.
    const skipped = parseLocalTime("2026-03-08T02:30", NY);
    expect(new Date(skipped).toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(() => parseLocalTime("tomorrow", LISBON)).toThrow(/Not a time/);
  });

  it("finds the next run for each kind, and stops at until and count", () => {
    const at = parseLocalTime("2026-11-27T17:00", LISBON);
    expect(nextRunAfter({ kind: "once", at }, 0, fresh)).toBe(at);
    expect(nextRunAfter({ kind: "once", at }, 0, { runCount: 1, createdAt: 0 })).toBeUndefined();

    const cron = { kind: "cron" as const, expr: "30 7 * * *", tz: LISBON };
    const after = parseLocalTime("2026-11-26T08:00", LISBON);
    expect(nextRunAfter(cron, after, fresh)).toBe(parseLocalTime("2026-11-27T07:30", LISBON));
    // Summer time moves the UTC instant, not the local one.
    expect(nextRunAfter(cron, parseLocalTime("2026-07-01T08:00", LISBON), fresh)).toBe(
      parseLocalTime("2026-07-02T07:30", LISBON),
    );
    expect(nextRunAfter({ ...cron, until: after + 60_000 }, after, fresh)).toBeUndefined();
    expect(nextRunAfter({ ...cron, count: 3 }, after, { runCount: 3, createdAt: 0 })).toBeUndefined();

    const hour = 3_600_000;
    const interval = { kind: "interval" as const, everyMs: 2 * hour, startAt: 10 * hour };
    expect(nextRunAfter(interval, 0, fresh)).toBe(10 * hour);
    expect(nextRunAfter(interval, 10 * hour, fresh)).toBe(12 * hour);
    expect(nextRunAfter(interval, 13 * hour, fresh)).toBe(14 * hour);
  });

  it("refuses schedules that are too frequent or broken", () => {
    expect(() => validateSchedule({ kind: "cron", expr: "* * * * *", tz: LISBON })).toThrow(
      /every 5 minutes/,
    );
    expect(() => validateSchedule({ kind: "cron", expr: "nope", tz: LISBON })).toThrow(/cron expression/);
    expect(() => validateSchedule({ kind: "cron", expr: "0 9 * * *", tz: "Mars/Olympus" })).toThrow(
      /Unknown timezone/,
    );
    expect(() => validateSchedule({ kind: "interval", everyMs: 60_000 })).toThrow(/every 5 minutes/);
    expect(() => validateSchedule({ kind: "cron", expr: "*/5 * * * *", tz: LISBON })).not.toThrow();
  });

  it("says schedules in words", () => {
    expect(describeSchedule({ kind: "cron", expr: "30 7 * * *", tz: LISBON }, LISBON)).toBe(
      "Every day · 7:30 AM",
    );
    expect(describeSchedule({ kind: "cron", expr: "0 9,13 * * 1-5", tz: LISBON }, LISBON)).toBe(
      "Weekdays · 9:00 AM, 1:00 PM",
    );
    expect(describeSchedule({ kind: "cron", expr: "0 18 * * 5", tz: NY }, LISBON)).toBe(
      "Every Fri · 6:00 PM (America/New_York)",
    );
    expect(describeSchedule({ kind: "cron", expr: "0 8 1 * *", tz: LISBON }, LISBON)).toBe(
      "Monthly on the 1st · 8:00 AM",
    );
    expect(describeSchedule({ kind: "interval", everyMs: 2 * 3_600_000, count: 5 }, LISBON)).toBe(
      "Every 2 hours · 5 times",
    );
    expect(describeSchedule({ kind: "once", at: parseLocalTime("2026-11-27T17:00", LISBON) }, LISBON)).toBe(
      "Once · Fri, Nov 27, 5:00 PM",
    );
  });
});
