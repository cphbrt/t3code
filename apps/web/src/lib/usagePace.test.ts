import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  deriveQuotaWindowPace,
  deriveUsagePace,
  instantAfterScheduledMinutes,
  scheduledMinutesBetween,
  usagePaceVerdict,
  USAGE_PACE_AHEAD_DELTA_POINTS,
  USAGE_PACE_BEHIND_DELTA_POINTS,
  USAGE_PACE_WELL_AHEAD_DELTA_POINTS,
  WALL_CLOCK_SCHEDULE,
  type UsagePaceSchedule,
} from "./usagePace";

/**
 * Every schedule question is a local-time question, so the whole file runs in
 * one zone with real daylight-saving transitions. Without this the suite would
 * assert different numbers on a developer's machine than in a UTC CI runner,
 * and the DST cases — the ones most likely to break — would not exercise
 * anything at all.
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

/** Local wall-clock instant in the test zone. */
function local(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

function schedule(overrides: Partial<UsagePaceSchedule> = {}): UsagePaceSchedule {
  return { workdaysOnly: false, workHoursOnly: false, startHour: 9, endHour: 18, ...overrides };
}

const OFFICE_HOURS = schedule({ workdaysOnly: true, workHoursOnly: true });

describe("scheduledMinutesBetween", () => {
  it("counts every minute under the default wall-clock schedule", () => {
    // 2026-08-03 is a Monday, so the weekday switch is not what is being read.
    expect(
      scheduledMinutesBetween(local(2026, 8, 3, 6), local(2026, 8, 3, 11), WALL_CLOCK_SCHEDULE),
    ).toBe(300);
  });

  it("returns zero for an empty or inverted span", () => {
    expect(scheduledMinutesBetween(local(2026, 8, 3, 9), local(2026, 8, 3, 9), OFFICE_HOURS)).toBe(
      0,
    );
    expect(scheduledMinutesBetween(local(2026, 8, 3, 12), local(2026, 8, 3, 9), OFFICE_HOURS)).toBe(
      0,
    );
  });

  it("counts nothing for a window that falls entirely outside the schedule", () => {
    // 03:00 to 07:00 on a Monday, against 09:00-18:00 office hours.
    expect(scheduledMinutesBetween(local(2026, 8, 3, 3), local(2026, 8, 3, 7), OFFICE_HOURS)).toBe(
      0,
    );
  });

  it("counts only the part of a window that starts before the schedule opens", () => {
    // 08:00 to 13:00 against 09:00-18:00 leaves four counted hours.
    expect(scheduledMinutesBetween(local(2026, 8, 3, 8), local(2026, 8, 3, 13), OFFICE_HOURS)).toBe(
      240,
    );
  });

  it("counts nothing across a weekend when only workdays count", () => {
    // 2026-08-08 is a Saturday and 2026-08-09 a Sunday.
    const weekend = schedule({ workdaysOnly: true });
    expect(scheduledMinutesBetween(local(2026, 8, 8, 1), local(2026, 8, 9, 23), weekend)).toBe(0);
    // The same span picks up Monday's hours once it reaches one.
    expect(scheduledMinutesBetween(local(2026, 8, 8, 1), local(2026, 8, 10, 2), weekend)).toBe(120);
  });

  it("counts a whole-day hour range as the whole day", () => {
    const allDay = schedule({ workHoursOnly: true, startHour: 0, endHour: 24 });
    expect(scheduledMinutesBetween(local(2026, 8, 3, 0), local(2026, 8, 6, 0), allDay)).toBe(
      3 * 24 * 60,
    );
  });

  it("spans multiple office days, counting only their working hours", () => {
    // Monday 15:00 through Wednesday 10:00: 3h Monday + 9h Tuesday + 1h Wednesday.
    expect(
      scheduledMinutesBetween(local(2026, 8, 3, 15), local(2026, 8, 5, 10), OFFICE_HOURS),
    ).toBe((3 + 9 + 1) * 60);
  });

  describe("across daylight saving transitions", () => {
    // 2026-03-08 is the US spring-forward Sunday: local 02:00 never happens,
    // so the calendar day is 23 hours long.
    it("shortens a whole day at spring forward", () => {
      const allDay = schedule({ workHoursOnly: true, startHour: 0, endHour: 24 });
      expect(scheduledMinutesBetween(local(2026, 3, 8, 0), local(2026, 3, 9, 0), allDay)).toBe(
        23 * 60,
      );
    });

    it("shortens an hour range that contains the spring-forward gap", () => {
      const morning = schedule({ workHoursOnly: true, startHour: 1, endHour: 5 });
      expect(scheduledMinutesBetween(local(2026, 3, 8, 0), local(2026, 3, 9, 0), morning)).toBe(
        3 * 60,
      );
    });

    // 2026-11-01 is the US fall-back Sunday: local 01:00 happens twice, so the
    // calendar day is 25 hours long.
    it("lengthens a whole day at fall back", () => {
      const allDay = schedule({ workHoursOnly: true, startHour: 0, endHour: 24 });
      expect(scheduledMinutesBetween(local(2026, 11, 1, 0), local(2026, 11, 2, 0), allDay)).toBe(
        25 * 60,
      );
    });

    it("lengthens an hour range that contains the repeated hour", () => {
      const morning = schedule({ workHoursOnly: true, startHour: 0, endHour: 5 });
      expect(scheduledMinutesBetween(local(2026, 11, 1, 0), local(2026, 11, 2, 0), morning)).toBe(
        6 * 60,
      );
    });

    it("agrees with elapsed wall-clock time across a transition", () => {
      // The unrestricted schedule is pure subtraction, so this pins the DST
      // arithmetic above to the same instants the runtime itself reports.
      const startMs = local(2026, 3, 8, 0);
      const endMs = local(2026, 3, 9, 0);
      expect(scheduledMinutesBetween(startMs, endMs, WALL_CLOCK_SCHEDULE)).toBe(
        (endMs - startMs) / 60_000,
      );
      expect(endMs - startMs).toBe(23 * 60 * 60_000);
    });
  });
});

describe("instantAfterScheduledMinutes", () => {
  it("is plain addition under the wall-clock schedule", () => {
    expect(instantAfterScheduledMinutes(local(2026, 8, 3, 9), 90, WALL_CLOCK_SCHEDULE)).toBe(
      local(2026, 8, 3, 10, 30),
    );
  });

  it("skips past closed hours and weekends", () => {
    // Friday 17:00 plus two office hours lands on Monday 10:00.
    // 2026-08-07 is a Friday.
    expect(instantAfterScheduledMinutes(local(2026, 8, 7, 17), 120, OFFICE_HOURS)).toBe(
      local(2026, 8, 10, 10),
    );
  });

  it("round-trips a counted instant exactly, and an uncounted one to its stretch's opening", () => {
    // Load-bearing asymmetry, not a defect: this answers "when is the budget
    // spent", so it returns the earliest instant holding that total. Every
    // instant in an uncounted stretch shares that stretch's opening total, so
    // a Saturday reading round-trips to Saturday midnight. A surface that
    // re-derived an instant it already held would draw it in the wrong place.
    const workdays = schedule({ workdaysOnly: true });
    const startMs = local(2026, 8, 7, 12); // Friday noon.

    const counted = local(2026, 8, 7, 15);
    expect(
      instantAfterScheduledMinutes(
        startMs,
        scheduledMinutesBetween(startMs, counted, workdays),
        workdays,
      ),
    ).toBe(counted);

    const uncounted = local(2026, 8, 8, 10); // Saturday morning.
    expect(
      instantAfterScheduledMinutes(
        startMs,
        scheduledMinutesBetween(startMs, uncounted, workdays),
        workdays,
      ),
    ).toBe(local(2026, 8, 8, 0));
  });

  it("inverts scheduledMinutesBetween across a DST transition", () => {
    const allDay = schedule({ workHoursOnly: true, startHour: 0, endHour: 24 });
    const startMs = local(2026, 3, 8, 0);
    const reached = instantAfterScheduledMinutes(startMs, 23 * 60, allDay);
    expect(reached).toBe(local(2026, 3, 9, 0));
  });
});

describe("usagePaceVerdict", () => {
  it("names each band at its exact boundary", () => {
    expect(usagePaceVerdict(USAGE_PACE_BEHIND_DELTA_POINTS)).toBe("behind");
    expect(usagePaceVerdict(USAGE_PACE_BEHIND_DELTA_POINTS + 0.1)).toBe("on-pace");
    expect(usagePaceVerdict(0)).toBe("on-pace");
    expect(usagePaceVerdict(USAGE_PACE_AHEAD_DELTA_POINTS - 0.1)).toBe("on-pace");
    expect(usagePaceVerdict(USAGE_PACE_AHEAD_DELTA_POINTS)).toBe("ahead");
    expect(usagePaceVerdict(USAGE_PACE_WELL_AHEAD_DELTA_POINTS - 0.1)).toBe("ahead");
    expect(usagePaceVerdict(USAGE_PACE_WELL_AHEAD_DELTA_POINTS)).toBe("well-ahead");
  });
});

describe("deriveUsagePace", () => {
  // Resolved inside each test rather than captured here: `describe` bodies run
  // while the file is collected, which is before `beforeAll` sets the zone.
  const resetsAtMs = () => local(2026, 8, 3, 14);

  function paceAt(hoursIn: number, usedPercent: number, paceSchedule = WALL_CLOCK_SCHEDULE) {
    return deriveUsagePace({
      usedPercent,
      resetsAtMs: resetsAtMs(),
      durationMinutes: 300,
      nowMs: local(2026, 8, 3, 9) + hoursIn * 3_600_000,
      schedule: paceSchedule,
    });
  }

  it("reads the same percent very differently early and late in a window", () => {
    const early = paceAt(1, 47);
    const late = paceAt(4, 47);
    expect(early.available && early.expectedPercent).toBe(20);
    expect(early.available && early.deltaPoints).toBe(27);
    expect(early.available && early.verdict).toBe("well-ahead");
    expect(late.available && late.expectedPercent).toBe(80);
    expect(late.available && late.deltaPoints).toBe(-33);
    expect(late.available && late.verdict).toBe("behind");
  });

  it("projects the current rate forward to the reset", () => {
    // 30% burned in the first hour of five projects to 150% at the reset, and
    // reaches 100% at 3h20m in.
    const pace = paceAt(1, 30);
    expect(pace.available && pace.projectedFinalPercent).toBeCloseTo(150, 10);
    expect(pace.available && pace.projectedCapAtMs).toBe(local(2026, 8, 3, 9) + 200 * 60_000);
  });

  it("offers no cap instant when the window resets before the rate exhausts it", () => {
    const pace = paceAt(2, 30);
    expect(pace.available && pace.projectedFinalPercent).toBeCloseTo(75, 10);
    expect(pace.available && pace.projectedCapAtMs).toBeUndefined();
  });

  it("measures elapsed time in scheduled minutes, not wall minutes", () => {
    // The window runs 09:00-14:00 on a Monday. Against 10:00-18:00 hours only
    // four of its five hours count, so 11:00 is a quarter of the way through
    // rather than two fifths.
    const restricted = schedule({ workHoursOnly: true, startHour: 10, endHour: 18 });
    const pace = paceAt(2, 40, restricted);
    expect(pace.available && pace.scheduledTotalMinutes).toBe(240);
    expect(pace.available && pace.scheduledElapsedMinutes).toBe(60);
    expect(pace.available && pace.expectedPercent).toBe(25);
    expect(pace.available && pace.verdict).toBe("ahead");
  });

  it("clamps a snapshot observed past its own reset to a full window", () => {
    const pace = paceAt(9, 60);
    expect(pace.available && pace.elapsedFraction).toBe(1);
    expect(pace.available && pace.expectedPercent).toBe(100);
    expect(pace.available && pace.projectedFinalPercent).toBe(60);
  });

  it("reports why there is no pace rather than defaulting to zero", () => {
    expect(
      deriveUsagePace({
        usedPercent: 40,
        resetsAtMs: undefined,
        durationMinutes: 300,
        nowMs: resetsAtMs(),
        schedule: WALL_CLOCK_SCHEDULE,
      }),
    ).toEqual({ available: false, reason: "no-reset" });

    expect(
      deriveUsagePace({
        usedPercent: 40,
        resetsAtMs: resetsAtMs(),
        durationMinutes: undefined,
        nowMs: resetsAtMs(),
        schedule: WALL_CLOCK_SCHEDULE,
      }),
    ).toEqual({ available: false, reason: "no-duration" });

    expect(
      deriveUsagePace({
        usedPercent: 40,
        resetsAtMs: resetsAtMs(),
        durationMinutes: 300,
        cycleKind: "rolling",
        nowMs: resetsAtMs(),
        schedule: WALL_CLOCK_SCHEDULE,
      }),
    ).toEqual({ available: false, reason: "rolling-window" });
  });

  it("treats an unknown cycle kind as fixed", () => {
    const pace = deriveUsagePace({
      usedPercent: 40,
      resetsAtMs: resetsAtMs(),
      durationMinutes: 300,
      cycleKind: "unknown",
      nowMs: local(2026, 8, 3, 11),
      schedule: WALL_CLOCK_SCHEDULE,
    });
    expect(pace.available).toBe(true);
  });

  it("has no pace for a window the schedule never counts", () => {
    // A five-hour window entirely inside a Saturday, with workdays only.
    expect(
      deriveUsagePace({
        usedPercent: 40,
        resetsAtMs: local(2026, 8, 8, 14),
        durationMinutes: 300,
        nowMs: local(2026, 8, 8, 12),
        schedule: OFFICE_HOURS,
      }),
    ).toEqual({ available: false, reason: "no-scheduled-time" });
  });

  it("has no pace before the schedule has counted a single minute", () => {
    // The window opened at 06:00; office hours have not started at 08:00.
    expect(
      deriveUsagePace({
        usedPercent: 12,
        resetsAtMs: local(2026, 8, 3, 11),
        durationMinutes: 300,
        nowMs: local(2026, 8, 3, 8),
        schedule: OFFICE_HOURS,
      }),
    ).toEqual({ available: false, reason: "no-scheduled-time" });
  });
});

describe("deriveQuotaWindowPace", () => {
  it("judges a wire-shaped window at its snapshot's observation time", () => {
    const pace = deriveQuotaWindowPace(
      {
        usedPercent: 60,
        durationMinutes: 300,
        resetsAt: new Date(local(2026, 8, 3, 14)).toISOString(),
      },
      new Date(local(2026, 8, 3, 12)).toISOString(),
      WALL_CLOCK_SCHEDULE,
    );
    expect(pace.available && pace.expectedPercent).toBe(60);
    expect(pace.available && pace.verdict).toBe("on-pace");
  });

  it("uses the observation instant, not a later wall clock", () => {
    // The client tolerates a snapshot up to twenty minutes stale. Judging that
    // frozen percent against a moving clock would walk an idle app toward a
    // false "behind"; this pins which of the two instants is used.
    const window = {
      usedPercent: 60,
      durationMinutes: 300,
      resetsAt: new Date(local(2026, 8, 3, 14)).toISOString(),
    };
    const observedAtMs = local(2026, 8, 3, 12);
    const fromSnapshot = deriveQuotaWindowPace(
      window,
      new Date(observedAtMs).toISOString(),
      WALL_CLOCK_SCHEDULE,
    );
    const fromLaterClock = deriveUsagePace({
      usedPercent: window.usedPercent,
      resetsAtMs: local(2026, 8, 3, 14),
      durationMinutes: window.durationMinutes,
      nowMs: observedAtMs + 20 * 60_000,
      schedule: WALL_CLOCK_SCHEDULE,
    });
    expect(fromSnapshot.available && fromSnapshot.deltaPoints).toBe(0);
    expect(fromLaterClock.available && Math.round(fromLaterClock.deltaPoints)).toBe(-7);
  });

  it("has no pace when the observation instant is unparseable", () => {
    expect(
      deriveQuotaWindowPace(
        {
          usedPercent: 60,
          durationMinutes: 300,
          resetsAt: new Date(local(2026, 8, 3, 14)).toISOString(),
        },
        "not-an-instant",
        WALL_CLOCK_SCHEDULE,
      ),
    ).toEqual({ available: false, reason: "no-scheduled-time" });
  });
});
