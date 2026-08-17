import { useMemo } from "react";

import type { DailyTotals, HourlyTotals } from "@t3tools/shared/usageMerge";

import {
  capIntervalsToFractions,
  deriveCapIntervals,
  periodStartMs,
  quotaSeriesKey,
  quotaSeriesLabel,
  type QuotaHistoryWindow,
  type QuotaRange,
} from "./quotaHistory.logic";
import { QuotaHistoryEmpty } from "./QuotaHistoryEmpty";
import {
  UsageProviderChart,
  type UsageChartBand,
  type UsageChartMetric,
} from "./UsageProviderChart";
import { quotaSeriesColor } from "./usageProviders";

/**
 * The ordinary spend chart, with the stretches you were locked out shaded in.
 *
 * This variant adds no new chart — it answers a question you can already see
 * but not explain. A flat Tuesday afternoon on the cost chart looks like a
 * quiet afternoon; a band over it says the spend stopped because the allowance
 * did. Reading the two together is the whole point, so the bands are drawn
 * underneath the series rather than beside them.
 */
export function QuotaLockoutBandsChart({
  windows,
  range,
  instanceLabels,
  days,
  daily,
  hours,
  hourly,
  metric,
  referenceTime,
  resolution,
  timeZone,
}: {
  readonly windows: readonly QuotaHistoryWindow[];
  readonly range: QuotaRange;
  readonly instanceLabels: ReadonlyMap<string, string>;
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly hours: readonly string[];
  readonly hourly: readonly HourlyTotals[];
  readonly metric: UsageChartMetric;
  readonly referenceTime: string | undefined;
  readonly resolution: "day" | "hour";
  readonly timeZone: string;
}) {
  const periods = resolution === "hour" ? hours : days;

  const { bands, legend } = useMemo(() => {
    const first = periods[0];
    const last = periods[periods.length - 1];
    const domainStartMs = first === undefined ? undefined : periodStartMs(first, resolution);
    const domainEndMs = last === undefined ? undefined : periodStartMs(last, resolution);
    if (domainStartMs === undefined || domainEndMs === undefined) {
      return {
        bands: [] as UsageChartBand[],
        legend: [] as { key: string; label: string; color: string }[],
      };
    }

    const built: UsageChartBand[] = [];
    const legendEntries: { key: string; label: string; color: string }[] = [];

    windows.forEach((window, index) => {
      const color = quotaSeriesColor(index);
      const label = quotaSeriesLabel(window, instanceLabels);
      const fractions = capIntervalsToFractions(
        deriveCapIntervals(window, range),
        domainStartMs,
        domainEndMs,
      );
      if (fractions.length === 0) return;
      legendEntries.push({ key: quotaSeriesKey(window), label, color });
      for (const fraction of fractions) {
        built.push({
          key: fraction.key,
          startFraction: fraction.startFraction,
          endFraction: fraction.endFraction,
          color,
        });
      }
    });

    return { bands: built, legend: legendEntries };
  }, [instanceLabels, periods, range, resolution, windows]);

  return (
    <div className="flex flex-col gap-2">
      <UsageProviderChart
        bands={bands}
        days={days}
        daily={daily}
        hours={hours}
        hourly={hourly}
        metric={metric}
        referenceTime={referenceTime}
        resolution={resolution}
        timeZone={timeZone}
      />
      {legend.length === 0 ? (
        <QuotaHistoryEmpty
          short
          message="No lockouts in this range"
          detail="Bands appear over the intervals a window sat at its limit."
        />
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-16 text-[10px] text-muted-foreground">
          {legend.map((entry) => (
            <span key={entry.key} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-xs"
                style={{ backgroundColor: entry.color, opacity: 0.35 }}
              />
              {entry.label} at limit
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
