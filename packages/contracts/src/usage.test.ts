import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { USAGE_CONTRACT_VERSION, UsageQuotaHistorySeries, UsageSummary } from "./usage.ts";

const decodeUsageSummary = Schema.decodeUnknownSync(UsageSummary);
const encodeUsageSummary = Schema.encodeSync(UsageSummary);
const decodeSeries = Schema.decodeUnknownSync(UsageQuotaHistorySeries);

const baseSummary = {
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-08-16T12:00:00.000Z",
  timeZone: "UTC",
  sinceDay: "2026-08-01",
  untilDay: "2026-08-16",
  buckets: [],
  sources: [],
  pricing: {
    status: "fresh",
    source: "https://example.invalid/rates.json",
    fetchedAt: null,
    knownModels: 0,
  },
  scanDurationMs: 0,
} as const;

describe("UsageQuotaHistorySeries", () => {
  it("carries the optional window description only when reported", () => {
    const full = decodeSeries({
      instanceId: "claudeAgent",
      windowId: "Weekly",
      label: "Fable Weekly",
      durationMinutes: 10_080,
      scopeLabel: "Fable",
      samples: [
        {
          observedAt: "2026-08-16T12:00:00.000Z",
          usedPercent: 100,
          resetsAt: "2026-08-20T00:00:00.000Z",
        },
      ],
    });
    expect(full.durationMinutes).toBe(10_080);
    expect(full.scopeLabel).toBe("Fable");
    expect(full.samples[0]?.resetsAt).toBe("2026-08-20T00:00:00.000Z");

    const sparse = decodeSeries({
      instanceId: "codex",
      windowId: "Weekly",
      label: "Weekly",
      samples: [{ observedAt: "2026-08-16T12:00:00.000Z", usedPercent: 0 }],
    });
    expect("durationMinutes" in sparse).toBe(false);
    expect("scopeLabel" in sparse).toBe(false);
    expect("resetsAt" in (sparse.samples[0] ?? {})).toBe(false);
  });

  it("rejects a percentage outside 0-100", () => {
    expect(() =>
      decodeSeries({
        instanceId: "claudeAgent",
        windowId: "5-hour",
        label: "5-hour",
        samples: [{ observedAt: "2026-08-16T12:00:00.000Z", usedPercent: 101 }],
      }),
    ).toThrow();
  });
});

describe("UsageSummary quotaHistory", () => {
  it("round trips the series a chart reads", () => {
    const quotaHistory = [
      {
        instanceId: "claudeAgent",
        windowId: "5-hour",
        label: "5-hour",
        durationMinutes: 300,
        samples: [
          { observedAt: "2026-08-16T10:00:00.000Z", usedPercent: 40 },
          {
            observedAt: "2026-08-16T10:05:00.000Z",
            usedPercent: 100,
            resetsAt: "2026-08-16T13:00:00.000Z",
          },
        ],
      },
    ];

    const decoded = decodeUsageSummary({ ...baseSummary, quotaHistory });

    expect(decoded.quotaHistory).toEqual(quotaHistory);
    expect(encodeUsageSummary(decoded).quotaHistory).toEqual(quotaHistory);
  });

  it("defaults to no history when an older environment omits the field", () => {
    // The field is defaulted rather than optional so a summary produced before
    // it existed still decodes instead of failing the whole page.
    expect(decodeUsageSummary(baseSummary).quotaHistory).toEqual([]);
  });
});
