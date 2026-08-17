import { useMemo } from "react";

import {
  deriveCapIntervals,
  quotaSeriesKey,
  quotaSeriesLabel,
  summarizeCapIntervals,
  type QuotaHistoryWindow,
  type QuotaRange,
} from "./quotaHistory.logic";
import { QuotaHistoryEmpty } from "./QuotaHistoryEmpty";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function formatHours(hours: number): string {
  if (hours === 0) return "0h";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 10) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours)}h`;
}

/**
 * Hours lost to each allowance window in the selected range, as plain numbers.
 *
 * The charts show *when* the limit bound; this shows how much it cost, which is
 * the part worth knowing without reading a shape. It mirrors the token metrics
 * strip above it — same grid, same three-line tile — so it reads as one more
 * row of the page's own summary rather than as a chart accessory.
 */
export function QuotaCappedTimeTiles({
  windows,
  range,
  instanceLabels,
}: {
  readonly windows: readonly QuotaHistoryWindow[];
  readonly range: QuotaRange;
  readonly instanceLabels: ReadonlyMap<string, string>;
}) {
  const tiles = useMemo(
    () =>
      windows.map((window) => {
        const summary = summarizeCapIntervals(deriveCapIntervals(window, range));
        return {
          key: quotaSeriesKey(window),
          label: quotaSeriesLabel(window, instanceLabels),
          ...summary,
        };
      }),
    [instanceLabels, range, windows],
  );

  if (tiles.length === 0) return <QuotaHistoryEmpty short />;

  return (
    <section className="grid grid-cols-2 gap-px border-y border-border bg-border md:grid-cols-4">
      {tiles.map((tile) => (
        <div key={tile.key} className="flex flex-col gap-0.5 bg-background px-4 py-3">
          {/* Instance-qualified window names outrun a quarter-width tile, so
              the truncated label carries its full text in a tooltip. */}
          <Tooltip>
            <TooltipTrigger render={<span className="truncate text-xs text-muted-foreground" />}>
              {tile.label}
            </TooltipTrigger>
            <TooltipPopup side="top">{tile.label}</TooltipPopup>
          </Tooltip>
          <span
            className={
              tile.capEvents === 0
                ? "text-lg text-muted-foreground tabular-nums"
                : "text-lg text-foreground tabular-nums"
            }
          >
            {formatHours(tile.hoursAtCap)}
          </span>
          <span className="text-xs text-muted-foreground">
            {tile.capEvents === 0
              ? "never at limit"
              : `at limit across ${tile.capEvents} ${tile.capEvents === 1 ? "lockout" : "lockouts"}`}
          </span>
        </div>
      ))}
    </section>
  );
}
