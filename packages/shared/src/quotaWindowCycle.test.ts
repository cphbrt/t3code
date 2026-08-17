import { describe, expect, it } from "vite-plus/test";

import {
  classifyQuotaWindowCycle,
  quotaWindowStartMs,
  type QuotaCycleObservation,
} from "./quotaWindowCycle.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const ORIGIN_MS = Date.parse("2026-08-01T00:00:00.000Z");
const FIVE_HOUR_MS = 5 * HOUR_MS;
const SEVEN_DAY_MS = 7 * DAY_MS;

/**
 * A rolling window as Codex reports one: every probe restates the reset as a
 * full duration ahead of the moment it was taken, so `resetsAt - duration` is
 * always approximately now. Values are synthetic.
 */
function rollingSamples(count: number, cadenceMs = 5 * MINUTE_MS): QuotaCycleObservation[] {
  return Array.from({ length: count }, (_, index) => {
    const observedAtMs = ORIGIN_MS + index * cadenceMs;
    return { observedAtMs, resetsAtMs: observedAtMs + SEVEN_DAY_MS };
  });
}

/** A fixed cycle: the reset instant holds still while observations march at it. */
function fixedSamples(count: number, cadenceMs = 30 * MINUTE_MS): QuotaCycleObservation[] {
  const resetsAtMs = ORIGIN_MS + FIVE_HOUR_MS;
  return Array.from({ length: count }, (_, index) => ({
    observedAtMs: ORIGIN_MS + index * cadenceMs,
    resetsAtMs,
  }));
}

describe("quotaWindowStartMs", () => {
  it("subtracts the duration from the stated reset", () => {
    expect(quotaWindowStartMs(ORIGIN_MS + FIVE_HOUR_MS, FIVE_HOUR_MS)).toBe(ORIGIN_MS);
  });

  it("has no start when either input is missing or nonsensical", () => {
    expect(quotaWindowStartMs(undefined, FIVE_HOUR_MS)).toBeUndefined();
    expect(quotaWindowStartMs(ORIGIN_MS, undefined)).toBeUndefined();
    expect(quotaWindowStartMs(ORIGIN_MS, null)).toBeUndefined();
    expect(quotaWindowStartMs(ORIGIN_MS, 0)).toBeUndefined();
    expect(quotaWindowStartMs(Number.NaN, FIVE_HOUR_MS)).toBeUndefined();
  });
});

describe("classifyQuotaWindowCycle", () => {
  it("calls a window rolling when its reset never stops advancing", () => {
    // Three days of five-minute probes on a seven-day window.
    expect(
      classifyQuotaWindowCycle({
        observations: rollingSamples((3 * DAY_MS) / (5 * MINUTE_MS)),
        durationMs: SEVEN_DAY_MS,
      }),
    ).toBe("rolling");
  });

  it("calls a window fixed when its reset holds still", () => {
    expect(
      classifyQuotaWindowCycle({ observations: fixedSamples(6), durationMs: FIVE_HOUR_MS }),
    ).toBe("fixed");
  });

  it("calls a window fixed as soon as one corroborated observation sits mid-cycle", () => {
    // Both readings are a full window ahead except the last, which was taken
    // an hour into the cycle. A rolling window is never an hour into anything.
    const observations: QuotaCycleObservation[] = [
      { observedAtMs: ORIGIN_MS, resetsAtMs: ORIGIN_MS + FIVE_HOUR_MS },
      { observedAtMs: ORIGIN_MS + HOUR_MS, resetsAtMs: ORIGIN_MS + FIVE_HOUR_MS },
    ];
    expect(classifyQuotaWindowCycle({ observations, durationMs: FIVE_HOUR_MS })).toBe("fixed");
  });

  it("stays unknown on a single mid-cycle reading", () => {
    const observations: QuotaCycleObservation[] = [
      { observedAtMs: ORIGIN_MS + HOUR_MS, resetsAtMs: ORIGIN_MS + FIVE_HOUR_MS },
    ];
    expect(classifyQuotaWindowCycle({ observations, durationMs: FIVE_HOUR_MS })).toBe("unknown");
  });

  it("stays unknown with too few observations to judge", () => {
    expect(
      classifyQuotaWindowCycle({ observations: rollingSamples(3), durationMs: SEVEN_DAY_MS }),
    ).toBe("unknown");
  });

  it("stays unknown until the history spans enough of the window", () => {
    // Six probes over half an hour cannot tell a rolling seven-day window from
    // a fixed one observed at the very top of a fresh cycle.
    expect(
      classifyQuotaWindowCycle({ observations: rollingSamples(6), durationMs: SEVEN_DAY_MS }),
    ).toBe("unknown");
  });

  it("stays unknown without a stated duration", () => {
    const observations = rollingSamples((3 * DAY_MS) / (5 * MINUTE_MS));
    expect(classifyQuotaWindowCycle({ observations, durationMs: undefined })).toBe("unknown");
    expect(classifyQuotaWindowCycle({ observations, durationMs: 0 })).toBe("unknown");
  });

  it("stays unknown when a reset sits further out than the window is long", () => {
    const observations = rollingSamples(600).map((sample) => ({
      ...sample,
      resetsAtMs: (sample.resetsAtMs ?? 0) + 2 * DAY_MS,
    }));
    expect(classifyQuotaWindowCycle({ observations, durationMs: SEVEN_DAY_MS })).toBe("unknown");
  });

  it("ignores observations that carry no reset at all", () => {
    const observations: QuotaCycleObservation[] = [
      ...rollingSamples(600),
      { observedAtMs: ORIGIN_MS + DAY_MS, resetsAtMs: null },
      { observedAtMs: ORIGIN_MS + DAY_MS, resetsAtMs: undefined },
    ];
    expect(classifyQuotaWindowCycle({ observations, durationMs: SEVEN_DAY_MS })).toBe("rolling");
  });
});
