import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import type { UsagePaceSchedule } from "../../lib/usagePace";
import {
  coerceScheduleHours,
  describeUsagePaceSchedule,
  formatScheduledHours,
  scheduleWeekStartMs,
  SHORT_WINDOW_HOURS,
  WEEK_HOURS,
} from "./usagePaceSchedule.logic";

/**
 * The summary is a local-calendar derivation, so the suite pins a zone with
 * real daylight-saving transitions rather than inheriting the runner's.
 */
const TEST_TIME_ZONE = "America/New_York";
let originalTimeZone: string | undefined;

beforeAll(() => {
  originalTimeZone = process.env.TZ;
  process.env.TZ = TEST_TIME_ZONE;
});

afterAll(() => {
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
});

function local(year: number, month: number, day: number, hour = 0): number {
  return new Date(year, month - 1, day, hour).getTime();
}

function schedule(overrides: Partial<UsagePaceSchedule> = {}): UsagePaceSchedule {
  return { workdaysOnly: false, workHoursOnly: false, startHour: 9, endHour: 18, ...overrides };
}

/** 2026-08-03 is a Monday. */
const MONDAY = local(2026, 8, 3);

const HOUR_BOUNDS = {
  minStartHour: 0,
  maxStartHour: 23,
  minEndHour: 1,
  maxEndHour: 24,
} as const;

describe("scheduleWeekStartMs", () => {
  it("anchors to local midnight on the Monday at or before the instant", () => {
    expect(scheduleWeekStartMs(local(2026, 8, 3, 13))).toBe(MONDAY);
    expect(scheduleWeekStartMs(local(2026, 8, 6, 23))).toBe(MONDAY);
    // Sunday belongs to the week that began the previous Monday.
    expect(scheduleWeekStartMs(local(2026, 8, 9, 5))).toBe(MONDAY);
    expect(scheduleWeekStartMs(local(2026, 8, 10))).toBe(local(2026, 8, 10));
  });
});

describe("describeUsagePaceSchedule", () => {
  it("counts the whole week under the default wall-clock schedule", () => {
    const summary = describeUsagePaceSchedule(schedule(), MONDAY);

    expect(summary.weeklyScheduledHours).toBe(WEEK_HOURS);
    expect(summary.weeklyTotalHours).toBe(WEEK_HOURS);
    expect(summary.countsEveryHour).toBe(true);
    // Every five-hour window is fully counted, wherever it falls.
    expect(summary.shortWindowMinHours).toBe(SHORT_WINDOW_HOURS);
    expect(summary.shortWindowMaxHours).toBe(SHORT_WINDOW_HOURS);
  });

  it("reports 45 of 168 hours for weekdays nine to six", () => {
    const summary = describeUsagePaceSchedule(
      schedule({ workdaysOnly: true, workHoursOnly: true }),
      MONDAY,
    );

    expect(summary.weeklyScheduledHours).toBe(45);
    expect(summary.countsEveryHour).toBe(false);
    // A window opening at 10am is fully inside the day; one opening Friday
    // evening counts nothing at all before it resets.
    expect(summary.shortWindowMaxHours).toBe(SHORT_WINDOW_HOURS);
    expect(summary.shortWindowMinHours).toBe(0);
  });

  it("separates the two switches: hours every day, and whole weekdays", () => {
    // Chris's personal-account case: 7am to 10pm including weekends.
    const eveningsAndWeekends = describeUsagePaceSchedule(
      schedule({ workHoursOnly: true, startHour: 7, endHour: 22 }),
      MONDAY,
    );
    expect(eveningsAndWeekends.weeklyScheduledHours).toBe(15 * 7);

    const weekdaysAllDay = describeUsagePaceSchedule(schedule({ workdaysOnly: true }), MONDAY);
    expect(weekdaysAllDay.weeklyScheduledHours).toBe(24 * 5);
    // Whole counted days, so only a window straddling midnight into Saturday
    // loses time; one wholly inside a weekday keeps all five hours.
    expect(weekdaysAllDay.shortWindowMaxHours).toBe(SHORT_WINDOW_HOURS);
    expect(weekdaysAllDay.shortWindowMinHours).toBe(0);
  });

  it("measures 168 hours of real time, so a DST week is not misreported", () => {
    // The span is 168 hours of real time because that is exactly what a
    // provider weekly allowance is, not seven local calendar days. Over the
    // spring-forward week the Sunday 00:00–06:00 interval really is five hours
    // rather than six, and the span reaches an hour into the following Monday
    // to make up the difference — so a schedule of six hours a day still
    // counts 42, the same as any other week.
    const springForwardWeek = scheduleWeekStartMs(local(2026, 3, 9));
    const dstWeek = describeUsagePaceSchedule(
      schedule({ workHoursOnly: true, startHour: 0, endHour: 6 }),
      springForwardWeek,
    );
    const ordinaryWeek = describeUsagePaceSchedule(
      schedule({ workHoursOnly: true, startHour: 0, endHour: 6 }),
      MONDAY,
    );

    expect(dstWeek.weeklyScheduledHours).toBe(42);
    expect(ordinaryWeek.weeklyScheduledHours).toBe(42);
  });

  it("treats an incoherent range as no restriction, exactly as pace does", () => {
    const summary = describeUsagePaceSchedule(
      schedule({ workHoursOnly: true, startHour: 18, endHour: 9 }),
      MONDAY,
    );

    expect(summary.weeklyScheduledHours).toBe(WEEK_HOURS);
  });
});

describe("formatScheduledHours", () => {
  it("keeps a small nonzero figure from reading as nothing", () => {
    expect(formatScheduledHours(0)).toBe("0");
    expect(formatScheduledHours(0.01)).toBe("<0.1");
    expect(formatScheduledHours(45)).toBe("45");
    expect(formatScheduledHours(2.25)).toBe("2.3");
  });
});

describe("coerceScheduleHours", () => {
  it("leaves a coherent range alone", () => {
    expect(coerceScheduleHours(9, 18, "start", HOUR_BOUNDS)).toEqual({ startHour: 9, endHour: 18 });
  });

  it("pushes the end when the start is dragged into or past it", () => {
    expect(coerceScheduleHours(18, 18, "start", HOUR_BOUNDS)).toEqual({
      startHour: 18,
      endHour: 19,
    });
    expect(coerceScheduleHours(22, 9, "start", HOUR_BOUNDS)).toEqual({
      startHour: 22,
      endHour: 23,
    });
  });

  it("pushes the start when the end is dragged into or past it", () => {
    expect(coerceScheduleHours(9, 9, "end", HOUR_BOUNDS)).toEqual({ startHour: 8, endHour: 9 });
    expect(coerceScheduleHours(18, 3, "end", HOUR_BOUNDS)).toEqual({ startHour: 2, endHour: 3 });
  });

  it("never produces a range the contract would reject", () => {
    expect(coerceScheduleHours(23, 1, "start", HOUR_BOUNDS)).toEqual({
      startHour: 23,
      endHour: 24,
    });
    expect(coerceScheduleHours(0, 0, "end", HOUR_BOUNDS)).toEqual({ startHour: 0, endHour: 1 });
  });
});
