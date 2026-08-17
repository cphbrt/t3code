import { useMemo } from "react";

import type { DailyTotals, HourlyTotals } from "@t3tools/shared/usageMerge";

import { useNowMinute } from "../../hooks/useNowMinute";
import {
  quotaRange,
  quotaSeriesKey,
  shortestWindowPerInstance,
  weeklyWindows,
  type QuotaHistory,
} from "./quotaHistory.logic";
import { QuotaCappedTimeTiles } from "./QuotaCappedTimeTiles";
import { QuotaCycleOverlayChart } from "./QuotaCycleOverlayChart";
import { QuotaHistoryEmpty } from "./QuotaHistoryEmpty";
import { QuotaLockoutBandsChart } from "./QuotaLockoutBandsChart";
import { QuotaSawtoothChart } from "./QuotaSawtoothChart";
import type { UsageChartMetric } from "./UsageProviderChart";

/**
 * A cycle-scale view needs several cycles to say anything, so the weekly
 * variants hold a floor of a month regardless of the page's picker. Their
 * headings state the range they actually drew.
 */
const WEEKLY_MINIMUM_DAYS = 30;

function Variant({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}

/**
 * Every limits-over-time view of the recorded quota history, stacked.
 *
 * The five views answer different questions against the same history and are
 * shown together rather than one standing in for the rest: the two sawtooths
 * for how a window fills and how long it stayed full, the cycle overlay for
 * pace against previous cycles, the lockout bands for what the limit cost in
 * spend, and the tiles for what it cost in time.
 */
export function QuotaLimitsSection({
  quotaHistory,
  instanceLabels,
  windowDays,
  days,
  daily,
  hours,
  hourly,
  metric,
  referenceTime,
  resolution,
  timeZone,
}: {
  readonly quotaHistory: QuotaHistory;
  readonly instanceLabels: ReadonlyMap<string, string>;
  readonly windowDays: number;
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly hours: readonly string[];
  readonly hourly: readonly HourlyTotals[];
  readonly metric: UsageChartMetric;
  readonly referenceTime: string | undefined;
  readonly resolution: "day" | "hour";
  readonly timeZone: string;
}) {
  const nowMinute = useNowMinute();
  const nowMs = useMemo(() => {
    const parsed = Date.parse(`${nowMinute}:00.000Z`);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }, [nowMinute]);

  const selectedRange = useMemo(() => quotaRange(windowDays, nowMs), [nowMs, windowDays]);
  const weeklyDays = Math.max(windowDays, WEEKLY_MINIMUM_DAYS);
  const weeklyRange = useMemo(() => quotaRange(weeklyDays, nowMs), [nowMs, weeklyDays]);

  const shortWindows = useMemo(() => shortestWindowPerInstance(quotaHistory), [quotaHistory]);
  const weekly = useMemo(() => weeklyWindows(quotaHistory), [quotaHistory]);

  /**
   * The tiles cover both families, deduplicated.
   *
   * An instance that publishes only a weekly allowance — Codex, today — has
   * that same window as both its shortest and its weekly one, so concatenating
   * the two lists would bill it twice and collide on its key.
   */
  const tileWindows = useMemo(() => {
    const seen = new Set<string>();
    return [...shortWindows, ...weekly].filter((window) => {
      const key = quotaSeriesKey(window);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [shortWindows, weekly]);

  return (
    <section className="flex flex-col gap-8" aria-labelledby="limits-over-time-heading">
      <div className="flex flex-col gap-0.5">
        <h2 id="limits-over-time-heading" className="text-sm font-medium text-foreground">
          Limits over time
        </h2>
        <p className="text-xs text-muted-foreground">Provider-reported limit usage over time.</p>
      </div>

      {quotaHistory.length === 0 ? (
        <QuotaHistoryEmpty detail="Quota history begins accumulating once provider snapshots are recorded." />
      ) : (
        <>
          <Variant
            title="Sawtooth (day)"
            description="Percent used of each instance's fastest window. The plateau's width is the time you spent locked out."
          >
            <QuotaSawtoothChart
              windows={shortWindows}
              range={selectedRange}
              instanceLabels={instanceLabels}
              timeZone={timeZone}
              emptyDetail="No short-window history in this range."
            />
          </Variant>

          <Variant
            title="Sawtooth (weekly windows)"
            description={`Weekly allowances over the last ${weeklyDays} days — roughly one tooth per week.`}
          >
            <QuotaSawtoothChart
              windows={weekly}
              range={weeklyRange}
              instanceLabels={instanceLabels}
              timeZone={timeZone}
              emptyDetail="No weekly-window history in this range."
            />
          </Variant>

          <Variant
            title="Overlaid window cycles"
            description="One weekly window, every cycle laid over the last. Past cycles are ghosted; the dotted line carries the current pace forward."
          >
            <QuotaCycleOverlayChart
              windows={weekly}
              range={weeklyRange}
              instanceLabels={instanceLabels}
              timeZone={timeZone}
              nowMs={nowMs}
            />
          </Variant>

          <Variant
            title="Lockout bands on the daily cost chart"
            description="The spend chart above, shaded over the intervals a window sat at its limit."
          >
            <QuotaLockoutBandsChart
              windows={shortWindows}
              range={selectedRange}
              instanceLabels={instanceLabels}
              days={days}
              daily={daily}
              hours={hours}
              hourly={hourly}
              metric={metric}
              referenceTime={referenceTime}
              resolution={resolution}
              timeZone={timeZone}
            />
          </Variant>

          <Variant
            title="Capped-time summary tiles"
            description="Hours spent at the limit in the selected range, and how many separate lockouts that was."
          >
            <QuotaCappedTimeTiles
              windows={tileWindows}
              range={selectedRange}
              instanceLabels={instanceLabels}
            />
          </Variant>
        </>
      )}
    </section>
  );
}
