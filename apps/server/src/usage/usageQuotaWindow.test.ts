/**
 * The window trimming applied to quota history before it crosses the wire.
 *
 * Kept apart from a full `UsageService` build on purpose: exercising
 * `readSummary` would walk the developer's real transcript directories, and
 * the rule under test here is pure.
 */
import { describe, expect, it } from "@effect/vitest";

import { makeQuotaWindowFilter } from "./UsageService.ts";

const ms = (iso: string): number => Date.parse(iso);

describe("makeQuotaWindowFilter", () => {
  it("admits samples whose reporting-zone day falls inside the daily window", () => {
    const include = makeQuotaWindowFilter({
      timeZone: "UTC",
      sinceDay: "2026-08-10",
      untilDay: "2026-08-12",
      hourlyWindow: null,
    });

    expect(include(ms("2026-08-09T23:59:59.999Z"))).toBe(false);
    expect(include(ms("2026-08-10T00:00:00.000Z"))).toBe(true);
    expect(include(ms("2026-08-12T23:59:59.999Z"))).toBe(true);
    expect(include(ms("2026-08-13T00:00:00.000Z"))).toBe(false);
  });

  it("bounds the day on the reporting zone, not UTC", () => {
    const include = makeQuotaWindowFilter({
      timeZone: "America/Chicago",
      sinceDay: "2026-08-10",
      untilDay: "2026-08-10",
      hourlyWindow: null,
    });

    // 2026-08-10T02:00Z is still 2026-08-09 in Chicago (UTC-5 in August),
    // while 2026-08-11T02:00Z is the evening of 2026-08-10 there.
    expect(include(ms("2026-08-10T02:00:00.000Z"))).toBe(false);
    expect(include(ms("2026-08-11T02:00:00.000Z"))).toBe(true);
  });

  it("falls back to UTC days rather than failing on an unknown zone", () => {
    const include = makeQuotaWindowFilter({
      timeZone: "Not/AZone",
      sinceDay: "2026-08-10",
      untilDay: "2026-08-10",
      hourlyWindow: null,
    });

    expect(include(ms("2026-08-10T00:00:00.000Z"))).toBe(true);
    expect(include(ms("2026-08-11T00:00:00.000Z"))).toBe(false);
  });

  it("bounds an hourly window on the instant, half-open at the end", () => {
    const include = makeQuotaWindowFilter({
      timeZone: "UTC",
      // Ignored while an hourly window applies; a mismatched day must not
      // narrow the instant bounds.
      sinceDay: "2026-01-01",
      untilDay: "2026-01-01",
      hourlyWindow: {
        sinceTimeMs: ms("2026-08-10T06:00:00.000Z"),
        untilTimeMs: ms("2026-08-10T12:00:00.000Z"),
      },
    });

    expect(include(ms("2026-08-10T05:59:59.999Z"))).toBe(false);
    expect(include(ms("2026-08-10T06:00:00.000Z"))).toBe(true);
    expect(include(ms("2026-08-10T11:59:59.999Z"))).toBe(true);
    expect(include(ms("2026-08-10T12:00:00.000Z"))).toBe(false);
  });
});
