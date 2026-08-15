import { describe, expect, it } from "vite-plus/test";

import {
  resolveSnoozePresets,
  resolveThreadUsageLimitResetAt,
  snoozeWakeDescription,
} from "./Sidebar.snooze";

// Local-time constructor so preset math is timezone-stable in tests.
function localDate(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

describe("resolveSnoozePresets", () => {
  it("offers one hour, three hours, evening, tomorrow, and next week in the morning", () => {
    // Wednesday 2026-04-08 10:00 local.
    const presets = resolveSnoozePresets(localDate(2026, 4, 8, 10), "locale");
    expect(presets.map((preset) => preset.id)).toEqual([
      "hour",
      "three-hours",
      "evening",
      "tomorrow",
      "next-week",
    ]);
    const threeHours = presets.find((preset) => preset.id === "three-hours");
    expect(new Date(threeHours!.snoozedUntil).getHours()).toBe(13);
    const evening = presets.find((preset) => preset.id === "evening");
    expect(new Date(evening!.snoozedUntil).getHours()).toBe(18);
    const tomorrow = presets.find((preset) => preset.id === "tomorrow");
    const tomorrowDate = new Date(tomorrow!.snoozedUntil);
    expect(tomorrowDate.getDate()).toBe(9);
    expect(tomorrowDate.getHours()).toBe(9);
    const nextWeek = presets.find((preset) => preset.id === "next-week");
    const nextWeekDate = new Date(nextWeek!.snoozedUntil);
    expect(nextWeekDate.getDay()).toBe(1);
    expect(nextWeekDate.getDate()).toBe(13);
  });

  it("whenLabel complements the label instead of repeating it", () => {
    const presets = resolveSnoozePresets(localDate(2026, 4, 8, 10), "locale");
    for (const preset of presets) {
      // Day words live in the label column; the time column is time-only
      // (plus a weekday for next week, which names a different day).
      expect(preset.whenLabel.toLowerCase()).not.toContain("tomorrow");
    }
    const tomorrow = presets.find((preset) => preset.id === "tomorrow");
    expect(tomorrow!.whenLabel).toMatch(/9/);
    const nextWeek = presets.find((preset) => preset.id === "next-week");
    expect(nextWeek!.whenLabel).toMatch(/Mon/);
  });

  it("drops the evening preset once evening is near or past", () => {
    expect(
      resolveSnoozePresets(localDate(2026, 4, 8, 17, 30), "locale").map((preset) => preset.id),
    ).toEqual(["hour", "three-hours", "tomorrow", "next-week"]);
    expect(
      resolveSnoozePresets(localDate(2026, 4, 8, 21), "locale").map((preset) => preset.id),
    ).toEqual(["hour", "three-hours", "tomorrow", "next-week"]);
  });

  it("puts next week a full week out when today is Monday", () => {
    // Monday 2026-04-06.
    const presets = resolveSnoozePresets(localDate(2026, 4, 6, 10), "locale");
    const nextWeek = new Date(presets.find((preset) => preset.id === "next-week")!.snoozedUntil);
    expect(nextWeek.getDay()).toBe(1);
    expect(nextWeek.getDate()).toBe(13);
  });
  it("formats preset times with the selected clock preference", () => {
    const twelveHour = resolveSnoozePresets(localDate(2026, 4, 8, 10), "12-hour");
    const twentyFourHour = resolveSnoozePresets(localDate(2026, 4, 8, 10), "24-hour");

    expect(twelveHour.find((preset) => preset.id === "evening")!.whenLabel).toMatch(/PM/i);
    expect(twentyFourHour.find((preset) => preset.id === "evening")!.whenLabel).toBe("18:00");
  });

  it("puts an explicit future usage reset first", () => {
    const now = localDate(2026, 4, 8, 22);
    const resetsAt = localDate(2026, 4, 9, 2, 42).toISOString();
    const presets = resolveSnoozePresets(now, "12-hour", { usageLimitResetsAt: resetsAt });

    expect(presets[0]).toMatchObject({
      id: "usage-limit-reset",
      label: "Until usage resets",
      snoozedUntil: resetsAt,
    });
    expect(presets[0]!.whenLabel).toMatch(/tomorrow.*2:42.*AM/i);
  });

  it("omits missing, invalid, and elapsed usage resets", () => {
    const now = localDate(2026, 4, 8, 22);
    expect(resolveSnoozePresets(now, "locale")[0]?.id).toBe("hour");
    for (const usageLimitResetsAt of [null, "not-a-date", now.toISOString()]) {
      expect(resolveSnoozePresets(now, "locale", { usageLimitResetsAt })[0]?.id).toBe("hour");
    }
  });
});

describe("resolveThreadUsageLimitResetAt", () => {
  const now = new Date("2026-08-14T20:00:00.000Z");
  const providers = [
    { instanceId: "codex", usageLimit: { resetsAt: "2026-08-14T22:00:00.000Z" } },
    { instanceId: "claude", usageLimit: { resetsAt: "2026-08-15T02:42:00.000Z" } },
  ];

  it("uses the running session provider before the saved model selection", () => {
    expect(
      resolveThreadUsageLimitResetAt(
        {
          modelSelection: { instanceId: "codex" },
          session: { providerInstanceId: "claude" },
        },
        providers,
        now,
      ),
    ).toBe("2026-08-15T02:42:00.000Z");
  });

  it("falls back to the model selection and ignores elapsed resets", () => {
    expect(
      resolveThreadUsageLimitResetAt(
        { modelSelection: { instanceId: "codex" }, session: null },
        providers,
        now,
      ),
    ).toBe("2026-08-14T22:00:00.000Z");
    expect(
      resolveThreadUsageLimitResetAt(
        { modelSelection: { instanceId: "codex" }, session: null },
        [{ instanceId: "codex", usageLimit: { resetsAt: now.toISOString() } }],
        now,
      ),
    ).toBeNull();
  });
});

describe("snoozeWakeDescription", () => {
  const now = localDate(2026, 4, 8, 10);

  it("uses bare time today, 'tomorrow' next day, weekday within the week", () => {
    expect(
      snoozeWakeDescription(localDate(2026, 4, 8, 18).toISOString(), now, "locale"),
    ).not.toContain("tomorrow");
    expect(snoozeWakeDescription(localDate(2026, 4, 9, 9).toISOString(), now, "locale")).toContain(
      "tomorrow",
    );
    expect(snoozeWakeDescription(localDate(2026, 4, 13, 9).toISOString(), now, "locale")).toMatch(
      /Mon/,
    );
  });

  it("formats wake descriptions with the selected clock preference", () => {
    expect(snoozeWakeDescription(localDate(2026, 4, 8, 18).toISOString(), now, "12-hour")).toMatch(
      /PM/i,
    );
    expect(snoozeWakeDescription(localDate(2026, 4, 8, 18).toISOString(), now, "24-hour")).toBe(
      "18:00",
    );
  });
});
