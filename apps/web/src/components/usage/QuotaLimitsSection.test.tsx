import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { QuotaLimitsSection } from "./QuotaLimitsSection";
import { HOUR_MS, type QuotaHistory, type QuotaHistorySample } from "./quotaHistory.logic";

const INSTANCE_LABELS = new Map([
  ["claude", "Claude Code"],
  ["codex", "Codex"],
]);

/**
 * Renders against a fixed clock-independent shape: the section reads the real
 * clock through `useNowMinute`, so these assertions only cover structure and
 * the empty states, never a projected date.
 */
function render(quotaHistory: QuotaHistory) {
  return renderToStaticMarkup(
    <QuotaLimitsSection
      quotaHistory={quotaHistory}
      instanceLabels={INSTANCE_LABELS}
      windowDays={30}
      days={["2026-08-01", "2026-08-02", "2026-08-03"]}
      daily={[]}
      hours={[]}
      hourly={[]}
      metric="cost"
      referenceTime={undefined}
      resolution="day"
      timeZone="UTC"
    />,
  );
}

/** A saw-toothed run of samples: climb to the cap, reset, climb again. */
function sawtoothSamples(cycles: number, cycleHours: number, nowMs: number): QuotaHistorySample[] {
  const samples: QuotaHistorySample[] = [];
  const firstCycleStart = nowMs - cycles * cycleHours * HOUR_MS;
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const cycleStart = firstCycleStart + cycle * cycleHours * HOUR_MS;
    const resetsAt = new Date(cycleStart + cycleHours * HOUR_MS).toISOString();
    for (let step = 0; step < cycleHours; step += 1) {
      samples.push({
        observedAt: new Date(cycleStart + step * HOUR_MS).toISOString(),
        usedPercent: Math.min(100, step * (110 / cycleHours)),
        resetsAt,
      });
    }
  }
  return samples;
}

describe("QuotaLimitsSection", () => {
  it("shows the quiet placeholder when no history has been recorded", () => {
    const markup = render([]);

    expect(markup).toContain("No quota history yet");
    expect(markup).toContain("Limits over time");
  });

  it("renders every variant heading once history exists", () => {
    const nowMs = Date.now();
    const markup = render([
      {
        instanceId: "claude",
        windowId: "five_hour",
        label: "5-hour",
        durationMinutes: 300,
        samples: sawtoothSamples(6, 5, nowMs),
      },
      {
        instanceId: "claude",
        windowId: "weekly",
        label: "Weekly",
        durationMinutes: 7 * 24 * 60,
        samples: sawtoothSamples(4, 168, nowMs),
      },
      {
        instanceId: "codex",
        windowId: "codex_weekly",
        label: "Weekly",
        durationMinutes: 7 * 24 * 60,
        samples: sawtoothSamples(4, 168, nowMs),
      },
    ]);

    expect(markup).toContain("Sawtooth (day)");
    expect(markup).toContain("Sawtooth (weekly windows)");
    expect(markup).toContain("Overlaid window cycles");
    expect(markup).toContain("Lockout bands on the daily cost chart");
    expect(markup).toContain("Capped-time summary tiles");
    expect(markup).not.toContain("No quota history yet");
  });

  it("names series by instance and window, and marks time spent at the limit", () => {
    const nowMs = Date.now();
    const markup = render([
      {
        instanceId: "claude",
        windowId: "five_hour",
        label: "5-hour",
        durationMinutes: 300,
        samples: sawtoothSamples(6, 5, nowMs),
      },
    ]);

    expect(markup).toContain("Claude Code · 5-hour");
    expect(markup).toContain("At limit");
    // The synthetic run tops out every cycle, so the tiles must report lockouts.
    expect(markup).toContain("lockouts");
  });

  it("lists a weekly-only instance once, not twice, in the tiles", () => {
    // Codex publishes no short window, so its weekly one is also its shortest.
    // Both selections must not bill it twice or collide on its key.
    const nowMs = Date.now();
    const markup = render([
      {
        instanceId: "codex",
        windowId: "codex_weekly",
        label: "Weekly",
        durationMinutes: 7 * 24 * 60,
        samples: sawtoothSamples(4, 168, nowMs),
      },
    ]);

    const occurrences = markup.split("at limit across").length - 1;
    expect(occurrences).toBe(1);
  });

  it("survives history whose windows hold no usable samples", () => {
    const markup = render([
      {
        instanceId: "claude",
        windowId: "five_hour",
        label: "5-hour",
        durationMinutes: 300,
        samples: [],
      },
      {
        instanceId: "codex",
        windowId: "codex_weekly",
        label: "Weekly",
        durationMinutes: 7 * 24 * 60,
        samples: [{ observedAt: "not-a-date", usedPercent: 40 }],
      },
    ]);

    expect(markup).toContain("Limits over time");
    expect(markup).toContain("No quota history yet");
  });
});
