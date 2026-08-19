import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { deriveUsagePace, WALL_CLOCK_SCHEDULE, type UsagePaceSchedule } from "../../lib/usagePace";
import {
  buildCycleOverlay,
  buildQuotaPolyline,
  CAP_PERCENT,
  capIntervalsToFractions,
  clipPolyline,
  decimateSeries,
  deriveCapIntervals,
  HOUR_MS,
  periodStartMs,
  sampleSeriesAt,
  quotaRange,
  quotaSeriesLabel,
  quotaWindowCycleKind,
  resolveSamples,
  shortestWindowPerInstance,
  splitAtCap,
  splitQuotaCycles,
  summarizeCapIntervals,
  timeAxisTicks,
  weeklyWindows,
  type QuotaHistorySample,
  type QuotaHistoryWindow,
} from "./quotaHistory.logic";

/**
 * Cycle boundaries and counted-hour schedules are local-calendar questions, so
 * the whole file runs in one zone rather than asserting different numbers on a
 * developer's machine than in a UTC runner.
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

const ORIGIN_MS = Date.parse("2026-08-01T00:00:00.000Z");

/** Local wall-clock instant in the test zone. */
function local(year: number, month: number, day: number, hour = 0): number {
  return new Date(year, month - 1, day, hour).getTime();
}

function iso(hoursFromOrigin: number): string {
  return new Date(ORIGIN_MS + hoursFromOrigin * HOUR_MS).toISOString();
}

function sample(
  hoursFromOrigin: number,
  usedPercent: number,
  resetsAtHours?: number,
): QuotaHistorySample {
  return {
    observedAt: iso(hoursFromOrigin),
    usedPercent,
    ...(resetsAtHours === undefined ? {} : { resetsAt: iso(resetsAtHours) }),
  };
}

function windowOf(overrides: Partial<QuotaHistoryWindow> = {}): QuotaHistoryWindow {
  return {
    instanceId: "claude",
    windowId: "five_hour",
    label: "5-hour",
    durationMinutes: 300,
    samples: [],
    ...overrides,
  };
}

describe("resolveSamples", () => {
  it("orders by observation time and collapses repeated instants", () => {
    const resolved = resolveSamples(
      windowOf({
        samples: [sample(2, 40), sample(1, 20), sample(2, 45)],
      }),
    );

    expect(resolved.map((entry) => entry.usedPercent)).toEqual([20, 45]);
    expect(resolved[0]?.atMs).toBe(ORIGIN_MS + HOUR_MS);
  });

  it("drops unparseable timestamps and non-finite percentages", () => {
    const resolved = resolveSamples(
      windowOf({
        samples: [
          { observedAt: "not-a-date", usedPercent: 10 },
          { observedAt: iso(1), usedPercent: Number.NaN },
          sample(2, 30),
        ],
      }),
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.usedPercent).toBe(30);
  });
});

describe("splitQuotaCycles", () => {
  it("splits on a moved reset instant even when usage keeps climbing", () => {
    // 30% then 35% is a rise, so only the advanced resetsAt reveals the reset.
    const cycles = splitQuotaCycles(
      windowOf({
        samples: [sample(0, 30, 5), sample(1, 35, 5), sample(2, 35, 10), sample(3, 60, 10)],
      }),
    );

    expect(cycles).toHaveLength(2);
    expect(cycles[0]?.samples.map((entry) => entry.usedPercent)).toEqual([30, 35]);
    expect(cycles[1]?.samples.map((entry) => entry.usedPercent)).toEqual([35, 60]);
  });

  it("does not split a rolling window on its constantly advancing reset", () => {
    // A genuinely rolling seven-day window restates its reset as a full week
    // ahead of every probe, so the moved-reset signal fires on every gap and
    // used to shred the series into one-sample cycles — invisible only because
    // the affected bucket happened to read 0%. Synthetic values.
    const WEEK_HOURS = 7 * 24;
    const PROBE_HOURS = 10 / 60;
    const probeCount = Math.round((3 * 24) / PROBE_HOURS);
    const samples: QuotaHistorySample[] = Array.from({ length: probeCount }, (_, index) => {
      const atHours = index * PROBE_HOURS;
      return sample(atHours, (index / probeCount) * 40, atHours + WEEK_HOURS);
    });

    const rolling = windowOf({
      instanceId: "codex",
      windowId: "weekly:primary",
      label: "Weekly",
      durationMinutes: WEEK_HOURS * 60,
      samples,
    });

    expect(quotaWindowCycleKind(rolling)).toBe("rolling");
    const cycles = splitQuotaCycles(rolling);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.samples).toHaveLength(probeCount);
  });

  it("still splits a rolling window when its usage actually falls", () => {
    // Suppressing the reset signal must not suppress the others: a drop past
    // the noise floor is still a refill, whatever the window's cycle kind.
    const WEEK_HOURS = 7 * 24;
    const PROBE_HOURS = 10 / 60;
    const probeCount = Math.round((3 * 24) / PROBE_HOURS);
    const samples: QuotaHistorySample[] = Array.from({ length: probeCount }, (_, index) => {
      const atHours = index * PROBE_HOURS;
      const usedPercent = index < probeCount / 2 ? 40 : 4;
      return sample(atHours, usedPercent, atHours + WEEK_HOURS);
    });

    const cycles = splitQuotaCycles(
      windowOf({
        instanceId: "codex",
        windowId: "weekly:primary",
        label: "Weekly",
        durationMinutes: WEEK_HOURS * 60,
        samples,
      }),
    );

    expect(cycles).toHaveLength(2);
  });

  it("splits on a usage drop when no reset instant is reported", () => {
    const cycles = splitQuotaCycles(
      windowOf({
        durationMinutes: undefined,
        samples: [sample(0, 40), sample(1, 90), sample(2, 5), sample(3, 30)],
      }),
    );

    expect(cycles).toHaveLength(2);
    expect(cycles[1]?.samples.map((entry) => entry.usedPercent)).toEqual([5, 30]);
  });

  it("treats a fractional wobble as noise rather than a reset", () => {
    const cycles = splitQuotaCycles(
      windowOf({ samples: [sample(0, 40), sample(1, 39.4), sample(2, 41)] }),
    );

    expect(cycles).toHaveLength(1);
  });

  it("splits when the gap between samples exceeds the window duration", () => {
    // Same level either side, no reset instant: only the 10h gap across a
    // 5h window proves a cycle rolled over unobserved.
    const cycles = splitQuotaCycles(windowOf({ samples: [sample(0, 50), sample(10, 50)] }));

    expect(cycles).toHaveLength(2);
  });

  it("derives the cycle start from the reported reset minus the duration", () => {
    const cycles = splitQuotaCycles(windowOf({ samples: [sample(3, 20, 5), sample(4, 40, 5)] }));

    // resetsAt is 5h from origin, duration 5h, so the cycle began at the origin.
    expect(cycles[0]?.startMs).toBe(ORIGIN_MS);
    expect(cycles[0]?.endMs).toBe(ORIGIN_MS + 5 * HOUR_MS);
  });

  it("never places a derived start after the first observation", () => {
    // A reset instant that implies a start later than a sample we already hold
    // is incoherent; the observation wins.
    const cycles = splitQuotaCycles(windowOf({ durationMinutes: 60, samples: [sample(0, 20, 5)] }));

    expect(cycles[0]?.startMs).toBe(ORIGIN_MS);
  });
});

describe("buildQuotaPolyline", () => {
  it("holds the last level to the reset and then drops vertically to zero", () => {
    const points = buildQuotaPolyline(
      windowOf({ samples: [sample(0, 60, 5), sample(4, 100, 5), sample(6, 10, 10)] }),
    );

    expect(points).toEqual([
      { atMs: ORIGIN_MS, usedPercent: 60 },
      { atMs: ORIGIN_MS + 4 * HOUR_MS, usedPercent: 100 },
      { atMs: ORIGIN_MS + 5 * HOUR_MS, usedPercent: 100 },
      { atMs: ORIGIN_MS + 5 * HOUR_MS, usedPercent: 0 },
      { atMs: ORIGIN_MS + 6 * HOUR_MS, usedPercent: 10 },
    ]);
  });

  it("keeps the cliff inside the observed gap when the reset instant is stale", () => {
    // resetsAt sits before the last observation of its own cycle; the cliff is
    // clamped forward so the polyline never doubles back in time.
    const points = buildQuotaPolyline(
      windowOf({
        durationMinutes: undefined,
        samples: [sample(0, 50, 1), sample(4, 80, 1), sample(5, 5)],
      }),
    );

    const times = points.map((point) => (point.atMs - ORIGIN_MS) / HOUR_MS);
    expect(times).toEqual([0, 4, 4, 4, 5]);
  });

  it("returns nothing for an empty window", () => {
    expect(buildQuotaPolyline(windowOf({ samples: [] }))).toEqual([]);
  });
});

describe("clipPolyline", () => {
  it("interpolates the level where the series enters and leaves the range", () => {
    const points = [
      { atMs: 0, usedPercent: 0 },
      { atMs: 100, usedPercent: 100 },
    ];

    expect(clipPolyline(points, { startMs: 25, endMs: 75 })).toEqual([
      { atMs: 25, usedPercent: 25 },
      { atMs: 75, usedPercent: 75 },
    ]);
  });

  it("keeps a vertical reset intact when it sits on the range edge", () => {
    const points = [
      { atMs: 0, usedPercent: 90 },
      { atMs: 50, usedPercent: 90 },
      { atMs: 50, usedPercent: 0 },
      { atMs: 100, usedPercent: 20 },
    ];

    expect(clipPolyline(points, { startMs: 50, endMs: 100 })).toEqual([
      { atMs: 50, usedPercent: 90 },
      { atMs: 50, usedPercent: 0 },
      { atMs: 100, usedPercent: 20 },
    ]);
  });

  it("returns nothing when the series is entirely outside the range", () => {
    const points = [
      { atMs: 0, usedPercent: 10 },
      { atMs: 10, usedPercent: 20 },
    ];

    expect(clipPolyline(points, { startMs: 100, endMs: 200 })).toEqual([]);
  });
});

describe("decimateSeries", () => {
  const xOf = (point: { readonly atMs: number }) => point.atMs;
  const yOf = (point: { readonly usedPercent: number }) => point.usedPercent;

  it("leaves a series that already fits alone", () => {
    const points = [
      { atMs: 0, usedPercent: 1 },
      { atMs: 10, usedPercent: 2 },
    ];

    expect(decimateSeries(points, xOf, yOf, 0, 10, 8)).toBe(points);
  });

  it("keeps a plateau and the cliff that follows it", () => {
    // 400 points across 4 buckets: a climb, a flat 100, then a reset to zero.
    const points = Array.from({ length: 400 }, (_, index) => ({
      atMs: index,
      usedPercent: index < 200 ? index / 2 : index < 399 ? 100 : 0,
    }));

    const thinned = decimateSeries(points, xOf, yOf, 0, 400, 4);

    expect(thinned.length).toBeLessThan(points.length);
    expect(thinned.some((point) => point.usedPercent === 100)).toBe(true);
    expect(thinned.at(-1)).toEqual({ atMs: 399, usedPercent: 0 });
    expect(thinned[0]).toEqual({ atMs: 0, usedPercent: 0 });
  });

  it("returns points in time order", () => {
    const points = Array.from({ length: 200 }, (_, index) => ({
      atMs: index,
      usedPercent: index % 2 === 0 ? 90 : 10,
    }));

    const thinned = decimateSeries(points, xOf, yOf, 0, 200, 4);
    const times = thinned.map((point) => point.atMs);

    expect(times).toEqual([...times].sort((left, right) => left - right));
  });
});

describe("sampleSeriesAt", () => {
  const points = [
    { atMs: 0, usedPercent: 0 },
    { atMs: 100, usedPercent: 50 },
    { atMs: 200, usedPercent: 60 },
  ];

  it("interpolates between neighbouring points", () => {
    expect(sampleSeriesAt(points, 50)).toBeCloseTo(25);
    expect(sampleSeriesAt(points, 150)).toBeCloseTo(55);
  });

  it("returns the exact level at a point", () => {
    expect(sampleSeriesAt(points, 100)).toBe(50);
    expect(sampleSeriesAt(points, 200)).toBe(60);
  });

  it("reads blank outside the observed span", () => {
    expect(sampleSeriesAt(points, -1)).toBeUndefined();
    expect(sampleSeriesAt(points, 201)).toBeUndefined();
    expect(sampleSeriesAt([], 0)).toBeUndefined();
  });
});

describe("splitAtCap", () => {
  it("splits exactly on the threshold crossing, not on the neighbouring sample", () => {
    const segments = splitAtCap([
      { atMs: 0, usedPercent: 99 },
      { atMs: 100, usedPercent: 100 },
      { atMs: 200, usedPercent: 100 },
    ]);

    expect(segments.map((segment) => segment.atCap)).toEqual([false, true]);
    // 99 -> 100 crosses 99.5 at the midpoint of the first span.
    expect(segments[0]?.points.at(-1)).toEqual({ atMs: 50, usedPercent: CAP_PERCENT });
    expect(segments[1]?.points[0]).toEqual({ atMs: 50, usedPercent: CAP_PERCENT });
  });

  it("keeps a wholly-below series as one below-cap run", () => {
    const segments = splitAtCap([
      { atMs: 0, usedPercent: 10 },
      { atMs: 100, usedPercent: 40 },
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.atCap).toBe(false);
  });

  it("drops degenerate one-point runs", () => {
    expect(splitAtCap([{ atMs: 0, usedPercent: 10 }])).toEqual([]);
  });
});

describe("deriveCapIntervals", () => {
  const range = quotaRange(2, ORIGIN_MS + 48 * HOUR_MS);

  it("runs a cap interval to the first observation that disproves it", () => {
    const intervals = deriveCapIntervals(
      windowOf({
        durationMinutes: undefined,
        samples: [sample(1, 80), sample(2, 100), sample(3, 100), sample(4, 10)],
      }),
      range,
    );

    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.startMs).toBe(ORIGIN_MS + 2 * HOUR_MS);
    expect(intervals[0]?.endMs).toBe(ORIGIN_MS + 4 * HOUR_MS);
  });

  it("gives a single at-cap observation width from its reported reset", () => {
    const intervals = deriveCapIntervals(
      windowOf({ durationMinutes: undefined, samples: [sample(1, 80), sample(2, 100, 3.5)] }),
      range,
    );

    expect(intervals[0]?.startMs).toBe(ORIGIN_MS + 2 * HOUR_MS);
    expect(intervals[0]?.endMs).toBe(ORIGIN_MS + 3.5 * HOUR_MS);
  });

  it("counts separate lockouts separately", () => {
    const intervals = deriveCapIntervals(
      windowOf({
        durationMinutes: undefined,
        samples: [sample(1, 100), sample(2, 10), sample(3, 100), sample(4, 10)],
      }),
      range,
    );

    expect(summarizeCapIntervals(intervals)).toEqual({ hoursAtCap: 2, capEvents: 2 });
  });

  it("clips an interval that starts before the range", () => {
    const intervals = deriveCapIntervals(
      windowOf({ durationMinutes: undefined, samples: [sample(0, 100), sample(40, 10)] }),
      { startMs: ORIGIN_MS + 10 * HOUR_MS, endMs: ORIGIN_MS + 20 * HOUR_MS },
    );

    expect(summarizeCapIntervals(intervals).hoursAtCap).toBe(10);
  });

  it("reports nothing when the window never filled", () => {
    const intervals = deriveCapIntervals(
      windowOf({ samples: [sample(1, 50), sample(2, 60)] }),
      range,
    );

    expect(summarizeCapIntervals(intervals)).toEqual({ hoursAtCap: 0, capEvents: 0 });
  });
});

describe("periodStartMs", () => {
  it("reads a day period as local midnight, not UTC midnight", () => {
    expect(periodStartMs("2026-08-01", "day")).toBe(new Date(2026, 7, 1).getTime());
  });

  it("reads an hour period as an absolute instant", () => {
    expect(periodStartMs("2026-08-01T05:00:00.000Z", "hour")).toBe(
      Date.parse("2026-08-01T05:00:00.000Z"),
    );
  });

  it("rejects a malformed period", () => {
    expect(periodStartMs("nonsense", "day")).toBeUndefined();
    expect(periodStartMs("nonsense", "hour")).toBeUndefined();
  });
});

describe("capIntervalsToFractions", () => {
  const interval = (startMs: number, endMs: number) => ({
    instanceId: "claude",
    windowId: "five_hour",
    startMs,
    endMs,
  });

  it("maps an interval onto the plot's width", () => {
    const [band] = capIntervalsToFractions([interval(25, 75)], 0, 100);

    expect(band?.startFraction).toBeCloseTo(0.25);
    expect(band?.endFraction).toBeCloseTo(0.75);
  });

  it("clamps an interval that overhangs either edge", () => {
    const [band] = capIntervalsToFractions([interval(-50, 150)], 0, 100);

    expect(band?.startFraction).toBe(0);
    expect(band?.endFraction).toBe(1);
  });

  it("drops a band with no width left after clamping", () => {
    expect(capIntervalsToFractions([interval(150, 200)], 0, 100)).toEqual([]);
  });

  it("drops everything on a degenerate domain", () => {
    expect(capIntervalsToFractions([interval(0, 10)], 50, 50)).toEqual([]);
  });
});

describe("buildCycleOverlay", () => {
  const weekly = (samples: readonly QuotaHistorySample[]): QuotaHistoryWindow =>
    windowOf({
      windowId: "weekly",
      label: "Weekly",
      durationMinutes: 7 * 24 * 60,
      samples,
    });

  const OFFICE_HOURS: UsagePaceSchedule = {
    workdaysOnly: true,
    workHoursOnly: true,
    startHour: 9,
    endHour: 18,
  };

  const overlayOf = (
    samples: readonly QuotaHistorySample[],
    nowMs: number,
    schedule: UsagePaceSchedule = WALL_CLOCK_SCHEDULE,
  ) => buildCycleOverlay(weekly(samples), quotaRange(30, nowMs), nowMs, schedule);

  const lastPoint = (overlay: ReturnType<typeof buildCycleOverlay>) => {
    const points = overlay.projection?.points ?? [];
    return points[points.length - 1];
  };

  it("normalises every cycle onto hours-into-the-cycle", () => {
    const overlay = buildCycleOverlay(
      weekly([sample(0, 10, 168), sample(24, 30, 168), sample(170, 5, 336), sample(200, 20, 336)]),
      quotaRange(30, ORIGIN_MS + 200 * HOUR_MS),
      ORIGIN_MS + 200 * HOUR_MS,
      WALL_CLOCK_SCHEDULE,
    );

    expect(overlay.cycleHours).toBe(168);
    expect(overlay.cycles).toHaveLength(2);
    expect(overlay.cycles[0]?.points.map((point) => point.hoursIn)).toEqual([0, 24]);
    // Second cycle starts at resetsAt(336h) - 168h = 168h, so 170h is 2h in.
    expect(overlay.cycles[1]?.points.map((point) => point.hoursIn)).toEqual([2, 32]);
  });

  it("marks only the in-progress cycle as current", () => {
    const nowMs = ORIGIN_MS + 200 * HOUR_MS;
    const overlay = buildCycleOverlay(
      weekly([sample(0, 10, 168), sample(170, 5, 336), sample(200, 20, 336)]),
      quotaRange(30, nowMs),
      nowMs,
      WALL_CLOCK_SCHEDULE,
    );

    expect(overlay.cycles.map((cycle) => cycle.isCurrent)).toEqual([false, true]);
  });

  it("projects the average burn rate to the cap and dates the crossing", () => {
    const nowMs = ORIGIN_MS + 40 * HOUR_MS;
    // Cycle began at the origin; 40h of a 168h cycle at 20% projects to 84% at
    // the reset, so the cap never arrives and the line ends at the reset.
    const slow = overlayOf([sample(40, 20, 168)], nowMs);
    expect(slow.projection?.capHoursIn).toBeUndefined();
    expect(slow.projection?.pace.projectedFinalPercent).toBeCloseTo(84);
    expect(lastPoint(slow)).toEqual({ hoursIn: 168, usedPercent: 84 });

    // 40h in at 50% projects to 210%: the cap lands at 80h, inside the cycle.
    const fast = overlayOf([sample(40, 50, 168)], nowMs);
    expect(fast.projection?.capHoursIn).toBeCloseTo(80);
    expect(fast.projection?.capAtMs).toBe(ORIGIN_MS + 80 * HOUR_MS);
    expect(lastPoint(fast)).toEqual({ hoursIn: 80, usedPercent: 100 });
  });

  it("continues the observed line without a kink", () => {
    const overlay = overlayOf([sample(40, 50, 168)], ORIGIN_MS + 40 * HOUR_MS);

    expect(overlay.projection?.points[0]).toEqual({ hoursIn: 40, usedPercent: 50 });
  });

  it("draws a straight line under the default wall-clock schedule", () => {
    // No counted-hour boundaries to bend around, so two points is the whole
    // projection and the SVG stays as cheap as it was.
    const overlay = overlayOf([sample(40, 50, 168)], ORIGIN_MS + 40 * HOUR_MS);

    expect(overlay.projection?.points).toHaveLength(2);
  });

  it("offers no projection once the cycle is already full", () => {
    const overlay = overlayOf([sample(40, 100, 168)], ORIGIN_MS + 40 * HOUR_MS);

    expect(overlay.projection).toBeUndefined();
  });

  it("offers no projection when no cycle is in progress", () => {
    // Now sits well past the end of the only observed cycle.
    const nowMs = ORIGIN_MS + 400 * HOUR_MS;
    const overlay = overlayOf([sample(40, 50, 168)], nowMs);

    expect(overlay.cycles.every((cycle) => !cycle.isCurrent)).toBe(true);
    expect(overlay.pace).toBeUndefined();
    expect(overlay.projection).toBeUndefined();
  });

  it("still draws an axis without a reported duration, but stays quiet about pace", () => {
    // The longest observed span is a lower bound on the cycle, which is fine
    // for placing a line on an axis and useless as a denominator: it would
    // overstate the burn rate and cry wolf. The old projection extended it
    // anyway; this one says why it will not.
    const nowMs = ORIGIN_MS + 100 * HOUR_MS;
    const overlay = buildCycleOverlay(
      windowOf({
        durationMinutes: undefined,
        // Resets are reported; only the window's length is missing, so this
        // isolates the duration fallback from the reset one.
        samples: [sample(0, 10, 50), sample(50, 90, 50), sample(60, 5, 110), sample(100, 40, 110)],
      }),
      quotaRange(30, nowMs),
      nowMs,
      WALL_CLOCK_SCHEDULE,
    );

    expect(overlay.cycleHours).toBe(50);
    expect(overlay.cycles.length).toBeGreaterThan(0);
    expect(overlay.pace).toEqual({ available: false, reason: "no-duration" });
    expect(overlay.projection).toBeUndefined();
  });

  it("stays quiet when the provider stated no reset for the cycle", () => {
    // Without a reset the cycle's start is only the first observation, which
    // is a lower bound for the same reason.
    const nowMs = ORIGIN_MS + 40 * HOUR_MS;
    const overlay = buildCycleOverlay(
      weekly([sample(20, 30), sample(40, 50)]),
      quotaRange(30, nowMs),
      nowMs,
      WALL_CLOCK_SCHEDULE,
    );

    expect(overlay.pace).toEqual({ available: false, reason: "no-reset" });
    expect(overlay.projection).toBeUndefined();
  });

  describe("under a counted-hours schedule", () => {
    // A Monday-to-Monday weekly cycle in the test zone, observed at the end of
    // its first counted day.
    const CYCLE_START = local(2026, 8, 3);
    const RESETS_AT = local(2026, 8, 10);
    const OBSERVED_AT = local(2026, 8, 3, 18);

    const mondayWeekly = (usedPercent: number): QuotaHistoryWindow =>
      windowOf({
        windowId: "weekly",
        label: "Weekly",
        durationMinutes: 7 * 24 * 60,
        samples: [
          {
            observedAt: new Date(OBSERVED_AT).toISOString(),
            usedPercent,
            resetsAt: new Date(RESETS_AT).toISOString(),
          },
        ],
      });

    it("flattens the projection through uncounted hours instead of sloping", () => {
      // 9 counted hours of the week's 45 are spent, at 25%, so the pace burns
      // a quarter of the allowance per counted day and caps after four of
      // them — Thursday at 6pm, not Thursday at midnight.
      const overlay = buildCycleOverlay(
        mondayWeekly(25),
        quotaRange(30, OBSERVED_AT),
        OBSERVED_AT,
        OFFICE_HOURS,
      );

      const hoursIn = (atMs: number) => (atMs - CYCLE_START) / HOUR_MS;
      expect(overlay.projection?.points).toEqual([
        { hoursIn: hoursIn(local(2026, 8, 3, 18)), usedPercent: 25 },
        { hoursIn: hoursIn(local(2026, 8, 4, 9)), usedPercent: 25 },
        { hoursIn: hoursIn(local(2026, 8, 4, 18)), usedPercent: 50 },
        { hoursIn: hoursIn(local(2026, 8, 5, 9)), usedPercent: 50 },
        { hoursIn: hoursIn(local(2026, 8, 5, 18)), usedPercent: 75 },
        { hoursIn: hoursIn(local(2026, 8, 6, 9)), usedPercent: 75 },
        { hoursIn: hoursIn(local(2026, 8, 6, 18)), usedPercent: 100 },
      ]);
      expect(overlay.projection?.capAtMs).toBe(local(2026, 8, 6, 18));
    });

    it("states the same cap instant as the shared pace derivation", () => {
      // The point of routing the projection through `deriveUsagePace`: this
      // chart and every other quota surface cannot disagree about when the
      // window runs out, because there is only one calculation.
      const overlay = buildCycleOverlay(
        mondayWeekly(25),
        quotaRange(30, OBSERVED_AT),
        OBSERVED_AT,
        OFFICE_HOURS,
      );
      const pace = deriveUsagePace({
        usedPercent: 25,
        resetsAtMs: RESETS_AT,
        durationMinutes: 7 * 24 * 60,
        nowMs: OBSERVED_AT,
        schedule: OFFICE_HOURS,
      });

      expect(pace.available).toBe(true);
      expect(overlay.projection?.capAtMs).toBe(pace.available ? pace.projectedCapAtMs : undefined);
      expect(overlay.pace).toEqual(pace);
    });

    it("reaches the limit later than wall-clock time would claim", () => {
      const scheduled = buildCycleOverlay(
        mondayWeekly(25),
        quotaRange(30, OBSERVED_AT),
        OBSERVED_AT,
        OFFICE_HOURS,
      );
      const wallClock = buildCycleOverlay(
        mondayWeekly(25),
        quotaRange(30, OBSERVED_AT),
        OBSERVED_AT,
        WALL_CLOCK_SCHEDULE,
      );

      // Wall clock counts the 18 hours since midnight, including the night, so
      // it reads the same spend as far faster and dates the cap 18 hours early.
      expect(wallClock.projection?.capAtMs).toBe(local(2026, 8, 6));
      expect(scheduled.projection?.capAtMs).toBeGreaterThan(wallClock.projection?.capAtMs ?? 0);
    });

    it("says so rather than guessing when the schedule has counted nothing yet", () => {
      // 2026-08-08 is a Saturday: a cycle observed entirely outside counted
      // time has no elapsed fraction to be ahead or behind of.
      const saturday = windowOf({
        windowId: "five_hour",
        durationMinutes: 300,
        samples: [
          {
            observedAt: new Date(local(2026, 8, 8, 12)).toISOString(),
            usedPercent: 40,
            resetsAt: new Date(local(2026, 8, 8, 14)).toISOString(),
          },
        ],
      });

      const overlay = buildCycleOverlay(
        saturday,
        quotaRange(30, local(2026, 8, 8, 12)),
        local(2026, 8, 8, 12),
        OFFICE_HOURS,
      );

      expect(overlay.pace).toEqual({ available: false, reason: "no-scheduled-time" });
      expect(overlay.projection).toBeUndefined();
    });
  });
});

describe("window selection", () => {
  const five = windowOf({ instanceId: "claude", windowId: "five_hour", durationMinutes: 300 });
  const weekly = windowOf({
    instanceId: "claude",
    windowId: "weekly",
    label: "Weekly",
    durationMinutes: 10_080,
  });
  const opusWeekly = windowOf({
    instanceId: "claude",
    windowId: "weekly_opus",
    label: "Weekly",
    scopeLabel: "Opus",
    durationMinutes: 10_080,
  });
  const codexWeekly = windowOf({
    instanceId: "codex",
    windowId: "codex_weekly",
    label: "Weekly",
    durationMinutes: 10_080,
  });

  const withSamples = (window: QuotaHistoryWindow): QuotaHistoryWindow => ({
    ...window,
    samples: [sample(0, 10)],
  });

  it("picks each instance's shortest window", () => {
    const picked = shortestWindowPerInstance([five, weekly, codexWeekly].map(withSamples));

    expect(picked.map((window) => window.windowId)).toEqual(["five_hour", "codex_weekly"]);
  });

  it("prefers the account-wide window over a model-scoped one of the same length", () => {
    const picked = shortestWindowPerInstance([opusWeekly, weekly].map(withSamples));

    expect(picked[0]?.windowId).toBe("weekly");
  });

  it("ignores windows that carry no samples", () => {
    expect(shortestWindowPerInstance([five, weekly])).toEqual([]);
  });

  it("collects every day-or-longer window, including model-scoped ones", () => {
    const picked = weeklyWindows([five, weekly, opusWeekly, codexWeekly].map(withSamples));

    expect(picked.map((window) => window.windowId)).toEqual([
      "weekly",
      "weekly_opus",
      "codex_weekly",
    ]);
  });

  it("falls back to the label when a window reports no duration", () => {
    const picked = weeklyWindows([
      withSamples(windowOf({ windowId: "w", label: "Weekly", durationMinutes: undefined })),
      withSamples(windowOf({ windowId: "h", label: "5-hour", durationMinutes: undefined })),
    ]);

    expect(picked.map((window) => window.windowId)).toEqual(["w"]);
  });
});

describe("labels and axes", () => {
  it("qualifies a scoped window with its scope", () => {
    const labels = new Map([["claude", "Claude Code"]]);

    expect(
      quotaSeriesLabel(windowOf({ label: "Weekly", scopeLabel: "Opus", samples: [] }), labels),
    ).toBe("Claude Code · Opus Weekly");
  });

  it("falls back to the instance id when no display name is known", () => {
    expect(quotaSeriesLabel(windowOf({ samples: [] }), new Map())).toBe("claude · 5-hour");
  });

  it("spans the range with evenly spaced ticks", () => {
    expect(timeAxisTicks({ startMs: 0, endMs: 100 }, 4)).toEqual([0, 25, 50, 75, 100]);
  });

  it("degenerates safely on an empty range", () => {
    expect(timeAxisTicks({ startMs: 5, endMs: 5 }, 4)).toEqual([5]);
  });
});
