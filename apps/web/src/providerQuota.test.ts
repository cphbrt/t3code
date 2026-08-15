import { describe, expect, it } from "@effect/vitest";

import {
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
