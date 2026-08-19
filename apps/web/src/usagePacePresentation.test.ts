import { describe, expect, it } from "@effect/vitest";

import {
  deriveQuotaWindowPace,
  usagePaceVerdict,
  WALL_CLOCK_SCHEDULE,
  type UsagePace,
  type UsagePaceUnavailableReason,
} from "./lib/usagePace";
import {
  isQuotaWindowCapped,
  quotaWindowTone,
  quotaWindowToneClasses,
  quotaWindowToneRank,
  shouldShowPaceTick,
  usagePaceDeltaArrow,
  usagePaceDeltaLabel,
  usagePaceDescription,
  usagePaceUnavailableDescription,
  worseQuotaWindowTone,
  worstQuotaWindowTone,
  type QuotaWindowTone,
} from "./usagePacePresentation";

/**
 * A well-formed available pace with the given spend and budget. Built through
 * the real verdict function so these tests can never drift from the thresholds
 * the product actually uses.
 */
function pace(usedPercent: number, expectedPercent: number): UsagePace {
  const deltaPoints = usedPercent - expectedPercent;
  const elapsedFraction = expectedPercent / 100;
  return {
    available: true,
    windowStartMs: 0,
    windowEndMs: 18_000_000,
    scheduledTotalMinutes: 300,
    scheduledElapsedMinutes: 300 * elapsedFraction,
    elapsedFraction,
    usedPercent,
    expectedPercent,
    deltaPoints,
    projectedFinalPercent:
      elapsedFraction === 0 ? Number.POSITIVE_INFINITY : usedPercent / elapsedFraction,
    projectedCapAtMs: undefined,
    verdict: usagePaceVerdict(deltaPoints),
  };
}

function unavailable(reason: UsagePaceUnavailableReason): UsagePace {
  return { available: false, reason };
}

describe("usage pace tone", () => {
  it("splits a calm alarm level by what we actually measured", () => {
    // Same fill level, three different states of knowledge.
    expect(quotaWindowTone(30, pace(30, 60))).toBe("headroom");
    expect(quotaWindowTone(30, pace(30, 32))).toBe("on-pace");
    expect(quotaWindowTone(30, unavailable("no-reset"))).toBe("neutral");
  });

  it("lets pace raise the alarm on a window that is nowhere near full", () => {
    expect(quotaWindowTone(30, pace(30, 20))).toBe("warning");
    expect(quotaWindowTone(30, pace(30, 5))).toBe("critical");
  });

  it("suppresses the reassuring tones once the fill level alone is worrying", () => {
    // The floor rule. A window can be coasting and still be nearly spent, and
    // "behind" must never render calmer than the neutral baseline it replaced.
    expect(quotaWindowTone(85, pace(85, 99))).toBe("warning");
    expect(quotaWindowTone(97, pace(97, 99))).toBe("critical");
    // ...and the same at the exact thresholds `providerQuotaSeverity` uses.
    expect(quotaWindowTone(80, pace(80, 95))).toBe("warning");
    expect(quotaWindowTone(95, pace(95, 99))).toBe("critical");
    expect(quotaWindowTone(79, pace(79, 95))).toBe("headroom");
  });

  it("never reports headroom for a window whose pace is unknown", () => {
    for (const reason of [
      "no-reset",
      "no-duration",
      "rolling-window",
      "no-scheduled-time",
    ] as const) {
      expect(quotaWindowTone(20, unavailable(reason))).toBe("neutral");
    }
  });

  it("orders tones by how much attention they ask for", () => {
    const ascending: readonly QuotaWindowTone[] = [
      "headroom",
      "neutral",
      "on-pace",
      "warning",
      "critical",
    ];
    const ranks = ascending.map(quotaWindowToneRank);
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
    expect(new Set(ranks).size).toBe(ascending.length);
    expect(worseQuotaWindowTone("headroom", "warning")).toBe("warning");
    expect(worseQuotaWindowTone("critical", "on-pace")).toBe("critical");
    expect(worstQuotaWindowTone(["neutral", "critical", "on-pace"])).toBe("critical");
    expect(worstQuotaWindowTone([])).toBeUndefined();
  });

  it("keeps good news when every window carries it", () => {
    // `headroom` ranks below `neutral`, so any reduction seeded at `neutral`
    // silently floors an all-coasting provider back to the unmeasured grey and
    // makes "we looked, you are fine" indistinguishable from "we could not
    // look". Seeding from the set itself is the only correct reduction.
    expect(worstQuotaWindowTone(["headroom", "headroom"])).toBe("headroom");
    expect(worstQuotaWindowTone(["headroom", "neutral"])).toBe("neutral");
    expect(quotaWindowToneRank("headroom")).toBeLessThan(quotaWindowToneRank("neutral"));
  });

  it("draws every tone from the themed status tokens, never a raw palette", () => {
    const tones: readonly QuotaWindowTone[] = [
      "headroom",
      "on-pace",
      "warning",
      "critical",
      "neutral",
    ];
    for (const tone of tones) {
      const classes = quotaWindowToneClasses(tone);
      const everyClass = [classes.bar, classes.text, classes.surface, classes.dot].join(" ");
      // A raw Tailwind palette class ignores the user's theme; the previous
      // implementation used them and this is what stops them coming back.
      expect(everyClass).not.toMatch(
        /\b(?:bg|text|border)-(?:red|amber|emerald|blue|green)-\d{2,3}\b/,
      );
    }
    expect(quotaWindowToneClasses("headroom").bar).toBe("bg-success");
    expect(quotaWindowToneClasses("on-pace").bar).toBe("bg-info");
    expect(quotaWindowToneClasses("warning").bar).toBe("bg-warning");
    expect(quotaWindowToneClasses("critical").bar).toBe("bg-error");
    // Unmeasured windows must look exactly as they did before pace existed.
    expect(quotaWindowToneClasses("neutral")).toMatchObject({
      bar: "bg-foreground/60",
      text: "text-foreground",
      surface: "border-border bg-muted/20",
    });
  });
});

describe("usage pace tick", () => {
  it("draws the target mark only when there is a target to draw", () => {
    expect(shouldShowPaceTick(40, pace(40, 60))).toBe(true);
    expect(shouldShowPaceTick(40, unavailable("rolling-window"))).toBe(false);
  });

  it("drops the tick once a window is exhausted", () => {
    // At the cap the reader cannot spend more slowly than not at all, so the
    // mark answers a question that no longer has an action behind it.
    expect(isQuotaWindowCapped(99.5)).toBe(true);
    expect(isQuotaWindowCapped(99.4)).toBe(false);
    expect(shouldShowPaceTick(100, pace(100, 68))).toBe(false);
    expect(shouldShowPaceTick(99.5, pace(99.5, 68))).toBe(false);
    expect(shouldShowPaceTick(99.4, pace(99.4, 68))).toBe(true);
  });
});

describe("usage pace wording", () => {
  it("reads the delta in points, in the direction a human would say it", () => {
    expect(usagePaceDeltaLabel(pace(47, 71.1))).toBe("24 pts behind");
    expect(usagePaceDeltaLabel(pace(93, 86.3))).toBe("7 pts ahead");
    expect(usagePaceDeltaLabel(pace(100, 68.1))).toBe("32 pts ahead");
    expect(usagePaceDeltaLabel(pace(50, 50))).toBe("on pace");
    expect(usagePaceDeltaLabel(unavailable("no-duration"))).toBeNull();
  });

  it("never lets the wording contradict the verdict inside the dead band", () => {
    // -4.6 rounds to 5 but is still "on pace"; printing "5 pts behind" beside
    // an on-pace colour is exactly the disagreement this guards against.
    const inBand = pace(45.4, 50);
    expect(inBand.available && inBand.verdict).toBe("on-pace");
    expect(usagePaceDeltaLabel(inBand)).toBe("on pace");
    expect(usagePaceDeltaArrow(inBand)).toBe("→");
  });

  it("carries direction outside colour", () => {
    expect(usagePaceDeltaArrow(pace(20, 60))).toBe("↓");
    expect(usagePaceDeltaArrow(pace(60, 20))).toBe("↑");
    expect(usagePaceDeltaArrow(unavailable("no-reset"))).toBeNull();
  });

  it("names the specific reason a window has no pace", () => {
    expect(usagePaceDescription(unavailable("no-reset"))).toMatch(/when this window resets/);
    expect(usagePaceDescription(unavailable("no-duration"))).toMatch(/how long this window runs/);
    expect(usagePaceDescription(unavailable("rolling-window"))).toMatch(/rolls continuously/);
    expect(usagePaceDescription(unavailable("no-scheduled-time"))).toMatch(/counted hours/);
  });

  it("explains an absent projection with the same words as an absent verdict", () => {
    // The guard against a second vocabulary: the chart and the quota row may
    // disagree about *what* is missing and about nothing else. If a surface
    // ever grows its own list of reasons again, these diverge.
    const reasons: readonly UsagePaceUnavailableReason[] = [
      "no-reset",
      "no-duration",
      "rolling-window",
      "no-scheduled-time",
    ];
    for (const reason of reasons) {
      const forPace = usagePaceUnavailableDescription(reason);
      const forProjection = usagePaceUnavailableDescription(reason, "projection");
      expect(forPace).toBe(usagePaceDescription(unavailable(reason)));
      expect(forProjection).toBe(forPace.replace("No pace", "No projection"));
      expect(forProjection.startsWith("No projection")).toBe(true);
    }
  });

  it("says a self-resolving absence is only temporary", () => {
    // Counted hours starting is a matter of waiting; a provider that publishes
    // no window length is not, and must not read as though it might fix itself.
    expect(usagePaceUnavailableDescription("no-scheduled-time")).toMatch(/^No pace yet: /);
    expect(usagePaceUnavailableDescription("no-scheduled-time", "projection")).toMatch(
      /^No projection yet: /,
    );
    expect(usagePaceUnavailableDescription("no-duration")).toMatch(/^No pace: /);
    expect(usagePaceUnavailableDescription("rolling-window", "projection")).toMatch(
      /^No projection: /,
    );
  });

  it("warns that a fast window runs out early, and stops once it has", () => {
    expect(usagePaceDescription(pace(60, 30))).toMatch(/runs out before the window resets/);
    expect(usagePaceDescription(pace(100, 68))).toMatch(/exhausted and is waiting on its reset/);
    expect(usagePaceDescription(pace(30, 60))).toMatch(/headroom/);
  });
});

describe("usage pace over wire-shaped windows", () => {
  const observedAt = "2026-08-17T22:03:25.000Z";

  it("reports headroom for a fixed window spent slower than its clock", () => {
    // A five-hour window opened at 18:30 and observed at 22:03: 71% elapsed.
    const derived = deriveQuotaWindowPace(
      {
        usedPercent: 47,
        durationMinutes: 300,
        resetsAt: "2026-08-17T23:30:00.000Z",
        cycleKind: "fixed",
      },
      observedAt,
      WALL_CLOCK_SCHEDULE,
    );
    expect(derived.available).toBe(true);
    expect(quotaWindowTone(47, derived)).toBe("headroom");
    expect(usagePaceDeltaLabel(derived)).toBe("24 pts behind");
  });

  it("stays neutral and tickless for a window that rolls instead of resetting", () => {
    // A rolling allowance always reports a reset one full duration out, so
    // `resetsAt - duration` is always now and elapsed fraction is a
    // meaningless zero. Reporting "0% used, 0% expected, perfectly on pace"
    // would be a confident lie.
    const derived = deriveQuotaWindowPace(
      {
        usedPercent: 0,
        durationMinutes: 10_080,
        resetsAt: "2026-08-24T22:03:25.000Z",
        cycleKind: "rolling",
      },
      observedAt,
      WALL_CLOCK_SCHEDULE,
    );
    expect(derived).toMatchObject({ available: false, reason: "rolling-window" });
    expect(quotaWindowTone(0, derived)).toBe("neutral");
    expect(shouldShowPaceTick(0, derived)).toBe(false);
    expect(usagePaceDeltaLabel(derived)).toBeNull();
  });

  it("renders an exhausted weekly window as critical with no target mark", () => {
    const derived = deriveQuotaWindowPace(
      {
        usedPercent: 100,
        durationMinutes: 10_080,
        resetsAt: "2026-08-20T03:35:00.000Z",
        cycleKind: "fixed",
      },
      observedAt,
      WALL_CLOCK_SCHEDULE,
    );
    expect(quotaWindowTone(100, derived)).toBe("critical");
    expect(shouldShowPaceTick(100, derived)).toBe(false);
  });
});
