import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  annotateQuotaWindowCycles,
  appendQuotaHistory,
  decodeQuotaHistory,
  emptyQuotaHistory,
  encodeQuotaHistory,
  pruneQuotaHistory,
  quotaRowsFromWindows,
  selectQuotaHistory,
  type QuotaHistoryRow,
} from "./QuotaHistoryStore.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const OBSERVED_AT = "2026-08-16T12:00:00.000Z";

function row(overrides: Partial<QuotaHistoryRow> = {}): QuotaHistoryRow {
  return {
    instanceId: "claudeAgent",
    windowId: "5-hour",
    label: "5-hour",
    durationMinutes: 300,
    observedAt: OBSERVED_AT,
    usedPercent: 42,
    resetsAt: "2026-08-16T15:00:00.000Z",
    ...overrides,
  };
}

const iso = (epochMillis: number): string => DateTime.formatIso(DateTime.makeUnsafe(epochMillis));

/** Minutes after `OBSERVED_AT`, as the ISO instant the store speaks in. */
function at(minutes: number): string {
  return iso(Date.parse(OBSERVED_AT) + minutes * 60 * 1000);
}

describe("appendQuotaHistory", () => {
  it("appends one sample per window and reports how many were new", () => {
    const state = emptyQuotaHistory();

    const added = appendQuotaHistory(state, [
      row(),
      row({ windowId: "Weekly", label: "Weekly", durationMinutes: 10_080, usedPercent: 12 }),
    ]);

    expect(added).toBe(2);
    expect(state.series.size).toBe(2);
  });

  it("drops a repeat of the same (instanceId, windowId, observedAt)", () => {
    const state = emptyQuotaHistory();
    appendQuotaHistory(state, [row()]);

    // Claude's probe serves a five-minute internal cache, so a later probe
    // hands back the identical snapshot. It must not become a second row.
    const added = appendQuotaHistory(state, [row(), row({ usedPercent: 43 })]);

    expect(added).toBe(0);
    const [series] = selectQuotaHistory(state);
    expect(series?.samples).toEqual([
      { observedAt: OBSERVED_AT, usedPercent: 42, resetsAt: "2026-08-16T15:00:00.000Z" },
    ]);
  });

  it("keeps the same observedAt on different windows and instances apart", () => {
    const state = emptyQuotaHistory();

    const added = appendQuotaHistory(state, [
      row(),
      row({ windowId: "Weekly", label: "Weekly" }),
      row({ instanceId: "codex", windowId: "Weekly", label: "Weekly" }),
    ]);

    expect(added).toBe(3);
    expect(selectQuotaHistory(state).map((series) => [series.instanceId, series.windowId])).toEqual(
      [
        ["claudeAgent", "5-hour"],
        ["claudeAgent", "Weekly"],
        ["codex", "Weekly"],
      ],
    );
  });

  it("refreshes a window's presentation fields without losing its history", () => {
    const state = emptyQuotaHistory();
    appendQuotaHistory(state, [row()]);

    appendQuotaHistory(state, [
      row({ observedAt: at(5), label: "5 hours", scopeLabel: "Fable", usedPercent: 55 }),
    ]);

    const [series] = selectQuotaHistory(state);
    expect(series?.label).toBe("5 hours");
    expect(series?.scopeLabel).toBe("Fable");
    expect(series?.samples).toHaveLength(2);
  });

  it("ignores rows whose observedAt is not an instant", () => {
    const state = emptyQuotaHistory();

    expect(appendQuotaHistory(state, [row({ observedAt: "never" })])).toBe(0);
    expect(state.series.size).toBe(0);
  });
});

describe("selectQuotaHistory", () => {
  it("returns samples ascending by observedAt whatever order they arrived in", () => {
    const state = emptyQuotaHistory();
    appendQuotaHistory(state, [
      row({ observedAt: at(10), usedPercent: 3 }),
      row({ observedAt: at(0), usedPercent: 1 }),
      row({ observedAt: at(5), usedPercent: 2 }),
    ]);

    const [series] = selectQuotaHistory(state);
    expect(series?.samples.map((sample) => sample.usedPercent)).toEqual([1, 2, 3]);
    expect(series?.samples.map((sample) => sample.observedAt)).toEqual([at(0), at(5), at(10)]);
  });

  it("keeps only samples the window predicate admits", () => {
    const state = emptyQuotaHistory();
    appendQuotaHistory(state, [
      row({ observedAt: at(-60) }),
      row({ observedAt: at(0) }),
      row({ observedAt: at(60) }),
    ]);

    const selected = selectQuotaHistory(state, {
      includeSample: (observedAtMs) => observedAtMs >= Date.parse(OBSERVED_AT),
    });

    expect(selected[0]?.samples.map((sample) => sample.observedAt)).toEqual([at(0), at(60)]);
  });

  it("omits a window with nothing in range rather than an empty series", () => {
    const state = emptyQuotaHistory();
    appendQuotaHistory(state, [row(), row({ windowId: "Weekly", label: "Weekly" })]);

    expect(selectQuotaHistory(state, { includeSample: () => false })).toEqual([]);
  });

  it("omits optional fields the provider did not report", () => {
    const state = emptyQuotaHistory();
    appendQuotaHistory(state, [
      {
        instanceId: "codex",
        windowId: "Weekly",
        label: "Weekly",
        observedAt: at(0),
        usedPercent: 7,
      },
    ]);

    expect(selectQuotaHistory(state)).toEqual([
      {
        instanceId: "codex",
        windowId: "Weekly",
        label: "Weekly",
        samples: [{ observedAt: at(0), usedPercent: 7 }],
      },
    ]);
  });
});

describe("pruneQuotaHistory", () => {
  it("drops samples older than the cutoff and reports the count", () => {
    const state = emptyQuotaHistory();
    appendQuotaHistory(state, [
      row({ observedAt: iso(Date.parse(OBSERVED_AT) - 91 * DAY_MS) }),
      row({ observedAt: iso(Date.parse(OBSERVED_AT) - 89 * DAY_MS) }),
      row({ observedAt: OBSERVED_AT }),
    ]);

    const removed = pruneQuotaHistory(state, Date.parse(OBSERVED_AT) - 90 * DAY_MS);

    expect(removed).toBe(1);
    expect(selectQuotaHistory(state)[0]?.samples).toHaveLength(2);
  });

  it("drops a series left with no samples", () => {
    const state = emptyQuotaHistory();
    appendQuotaHistory(state, [
      row(),
      row({ windowId: "Weekly", label: "Weekly", observedAt: at(1) }),
    ]);

    pruneQuotaHistory(state, Date.parse(at(1)));

    expect(selectQuotaHistory(state).map((series) => series.windowId)).toEqual(["Weekly"]);
  });
});

describe("quota history round trip", () => {
  it("restores every series and sample unchanged", () => {
    const state = emptyQuotaHistory();
    appendQuotaHistory(state, [
      row({ observedAt: at(0) }),
      row({ observedAt: at(5), usedPercent: 51 }),
      row({
        instanceId: "codex",
        windowId: "Weekly",
        label: "Weekly",
        durationMinutes: 10_080,
        scopeLabel: "Fable",
        observedAt: at(0),
        usedPercent: 9,
      }),
    ]);

    const restored = decodeQuotaHistory(JSON.parse(JSON.stringify(encodeQuotaHistory(state))));

    expect(selectQuotaHistory(restored)).toEqual(selectQuotaHistory(state));
  });

  it("preserves the synthetic marker a fixture generator wrote", () => {
    const state = emptyQuotaHistory();
    state.synthetic = true;
    appendQuotaHistory(state, [row()]);

    const encoded = encodeQuotaHistory(state);

    expect(encoded.synthetic).toBe(true);
    expect(decodeQuotaHistory(JSON.parse(JSON.stringify(encoded))).synthetic).toBe(true);
  });

  it("de-duplicates against reloaded samples rather than appending beside them", () => {
    const first = emptyQuotaHistory();
    appendQuotaHistory(first, [row()]);
    const reloaded = decodeQuotaHistory(JSON.parse(JSON.stringify(encodeQuotaHistory(first))));

    expect(appendQuotaHistory(reloaded, [row()])).toBe(0);
  });

  it("yields empty state for a document of the wrong version", () => {
    const encoded = { ...encodeQuotaHistory(emptyQuotaHistory()), version: 999 };

    expect(decodeQuotaHistory(encoded).series.size).toBe(0);
  });

  it("keeps readable series when one is malformed", () => {
    const state = emptyQuotaHistory();
    appendQuotaHistory(state, [row(), row({ instanceId: "codex" })]);
    const encoded = encodeQuotaHistory(state);
    const corrupted = {
      ...encoded,
      series: [{ ...encoded.series[0], samples: "not an array" }, encoded.series[1]],
    };

    const restored = decodeQuotaHistory(corrupted);

    expect([...restored.series.values()].map((series) => series.instanceId)).toEqual(["codex"]);
  });

  it("yields empty state for anything that is not a document", () => {
    expect(decodeQuotaHistory(null).series.size).toBe(0);
    expect(decodeQuotaHistory("{}").series.size).toBe(0);
  });
});

describe("quotaRowsFromWindows", () => {
  it("stamps every window of a snapshot with the snapshot's observedAt", () => {
    const rows = quotaRowsFromWindows({
      instanceId: "claudeAgent",
      observedAt: OBSERVED_AT,
      windows: [
        { id: "5-hour", label: "5-hour", usedPercent: 42, durationMinutes: 300 },
        { id: "Weekly", label: "Weekly", usedPercent: 12, scopeLabel: "Fable" },
      ],
    });

    expect(rows).toEqual([
      {
        instanceId: "claudeAgent",
        windowId: "5-hour",
        label: "5-hour",
        observedAt: OBSERVED_AT,
        usedPercent: 42,
        durationMinutes: 300,
      },
      {
        instanceId: "claudeAgent",
        windowId: "Weekly",
        label: "Weekly",
        observedAt: OBSERVED_AT,
        usedPercent: 12,
        scopeLabel: "Fable",
      },
    ]);
  });
});

describe("annotateQuotaWindowCycles", () => {
  const WEEK_MINUTES = 7 * 24 * 60;
  const WEEK_MS = WEEK_MINUTES * 60 * 1000;

  /**
   * A rolling weekly window as Codex reports one: every probe restates the
   * reset a full week ahead of itself. Synthetic values.
   */
  function rollingRows(probeCount: number, everyMinutes = 10): readonly QuotaHistoryRow[] {
    return Array.from({ length: probeCount }, (_, index) => {
      const observedAtMs = Date.parse(OBSERVED_AT) + index * everyMinutes * 60 * 1000;
      return row({
        windowId: "weekly:primary",
        label: "Weekly",
        durationMinutes: WEEK_MINUTES,
        observedAt: iso(observedAtMs),
        usedPercent: (index / probeCount) * 40,
        resetsAt: iso(observedAtMs + WEEK_MS),
      });
    });
  }

  it("marks a window whose reset advances with every probe as rolling", () => {
    const state = emptyQuotaHistory();
    appendQuotaHistory(state, rollingRows(600));

    expect(
      annotateQuotaWindowCycles(state, "claudeAgent", [
        { id: "weekly:primary", label: "Weekly", usedPercent: 40, durationMinutes: WEEK_MINUTES },
      ]),
    ).toEqual([
      {
        id: "weekly:primary",
        label: "Weekly",
        usedPercent: 40,
        durationMinutes: WEEK_MINUTES,
        cycleKind: "rolling",
      },
    ]);
  });

  it("marks a window whose reset holds still as fixed", () => {
    const state = emptyQuotaHistory();
    appendQuotaHistory(state, [
      row({ observedAt: at(0), usedPercent: 10 }),
      row({ observedAt: at(60), usedPercent: 25 }),
      row({ observedAt: at(120), usedPercent: 44 }),
    ]);

    const annotated = annotateQuotaWindowCycles(state, "claudeAgent", [
      { id: "5-hour", label: "5-hour", usedPercent: 44, durationMinutes: 300 },
    ]);

    expect(annotated[0]?.cycleKind).toBe("fixed");
  });

  it("marks a window with no recorded history as unknown", () => {
    const annotated = annotateQuotaWindowCycles(emptyQuotaHistory(), "claudeAgent", [
      { id: "5-hour", label: "5-hour", usedPercent: 44, durationMinutes: 300 },
    ]);

    expect(annotated[0]?.cycleKind).toBe("unknown");
  });

  it("falls back to the recorded duration when a snapshot stops reporting one", () => {
    const state = emptyQuotaHistory();
    appendQuotaHistory(state, rollingRows(600));

    const annotated = annotateQuotaWindowCycles(state, "claudeAgent", [
      { id: "weekly:primary", label: "Weekly", usedPercent: 40 },
    ]);

    expect(annotated[0]?.cycleKind).toBe("rolling");
  });
});
