import { describe, expect, it } from "@effect/vitest";

import {
  combinedQuotaSeverity,
  primaryProviderQuotaWindow,
  providerQuotaFreshness,
  providerQuotaResetCountdown,
  providerQuotaSeverity,
  providerQuotaWindowLabel,
} from "./providerQuota";

describe("provider quota presentation", () => {
  it("prioritizes the account five-hour window for compact surfaces", () => {
    expect(
      primaryProviderQuotaWindow({
        observedAt: "2026-08-15T12:00:00.000Z",
        windows: [
          {
            id: "weekly-opus",
            label: "Weekly",
            scopeLabel: "Opus",
            usedPercent: 92,
          },
          {
            id: "five-hour",
            label: "5-hour",
            durationMinutes: 300,
            usedPercent: 64,
          },
        ],
      }),
    ).toMatchObject({ id: "five-hour" });
  });

  it("formats reset countdowns without continuously repainting", () => {
    expect(providerQuotaResetCountdown("2026-08-15T15:14:00.000Z", "2026-08-15T12:00")).toBe(
      "3h 14m",
    );
    expect(providerQuotaResetCountdown("2026-08-18T14:00:00.000Z", "2026-08-15T12:00")).toBe(
      "3d 2h",
    );
  });

  it("keeps normal, warning, and critical utilization visually distinct", () => {
    expect([79, 80, 94, 95].map(providerQuotaSeverity)).toEqual([
      "normal",
      "warning",
      "warning",
      "critical",
    ]);
  });

  it("takes the worse of how full a window is and how fast it is filling", () => {
    // Pace can only ever raise the alarm. Neither input excuses the other: a
    // window at 97% is not calm because it got there slowly, and one at 30%
    // is not calm because it still has room.
    expect(combinedQuotaSeverity(30, "behind")).toBe("normal");
    expect(combinedQuotaSeverity(30, "on-pace")).toBe("normal");
    expect(combinedQuotaSeverity(30, "ahead")).toBe("warning");
    expect(combinedQuotaSeverity(30, "well-ahead")).toBe("critical");
    expect(combinedQuotaSeverity(85, "behind")).toBe("warning");
    expect(combinedQuotaSeverity(97, "behind")).toBe("critical");
    expect(combinedQuotaSeverity(85, "well-ahead")).toBe("critical");
  });

  it("falls back to the fill level alone when pace is unknown", () => {
    for (const usedPercent of [10, 80, 95]) {
      expect(combinedQuotaSeverity(usedPercent, undefined)).toBe(
        providerQuotaSeverity(usedPercent),
      );
    }
  });

  it("labels scoped windows and stale snapshots honestly", () => {
    expect(
      providerQuotaWindowLabel({
        id: "opus",
        label: "Weekly",
        scopeLabel: "Opus",
        usedPercent: 20,
      }),
    ).toBe("Opus Weekly");
    expect(providerQuotaFreshness("2026-08-15T11:30:00.000Z", "2026-08-15T12:00")).toBe("stale");
  });
});
