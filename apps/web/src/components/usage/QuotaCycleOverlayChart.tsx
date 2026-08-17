import { useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import {
  buildCycleOverlay,
  decimateSeries,
  quotaSeriesKey,
  quotaSeriesLabel,
  type QuotaHistoryWindow,
  type QuotaRange,
} from "./quotaHistory.logic";
import { QuotaHistoryEmpty } from "./QuotaHistoryEmpty";
import { quotaSeriesColor } from "./usageProviders";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 200;
const PLOT_TOP = 8;
const PERCENT_TICKS = [0, 25, 50, 75, 100] as const;
const AXIS_TICK_COUNT = 4;
const DECIMATION_BUCKETS = VIEW_WIDTH;

interface CyclePoint {
  readonly hoursIn: number;
  readonly usedPercent: number;
}

function toY(usedPercent: number): number {
  return VIEW_HEIGHT - (usedPercent / 100) * (VIEW_HEIGHT - PLOT_TOP);
}

function polylinePath(points: readonly CyclePoint[], cycleHours: number): string {
  if (cycleHours <= 0) return "";
  return points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${((point.hoursIn / cycleHours) * VIEW_WIDTH).toFixed(2)},${toY(point.usedPercent).toFixed(2)}`,
    )
    .join(" ");
}

/**
 * Every cycle of one allowance window, replotted on a shared "hours into the
 * cycle" axis.
 *
 * Wall-clock time answers "when did I cap"; this answers "am I burning faster
 * than usual", which needs the weeks laid on top of each other rather than
 * beside each other. Past cycles recede to a ghost so they read as the envelope
 * of normal behaviour, and the cycle in progress is the only bold line. The
 * dotted continuation carries the current cycle's average burn rate forward;
 * where it crosses the limit inside the cycle, that crossing is dated, because
 * "caps Thursday afternoon" is the actionable form of the number.
 */
export function QuotaCycleOverlayChart({
  windows,
  range,
  instanceLabels,
  timeZone,
  nowMs,
}: {
  readonly windows: readonly QuotaHistoryWindow[];
  readonly range: QuotaRange;
  readonly instanceLabels: ReadonlyMap<string, string>;
  readonly timeZone: string;
  readonly nowMs: number;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const options = useMemo(
    () =>
      windows.map((window, index) => ({
        key: quotaSeriesKey(window),
        label: quotaSeriesLabel(window, instanceLabels),
        color: quotaSeriesColor(index),
        window,
      })),
    [instanceLabels, windows],
  );

  const selected = options.find((option) => option.key === selectedKey) ?? options[0];

  const overlay = useMemo(
    () => (selected === undefined ? undefined : buildCycleOverlay(selected.window, range, nowMs)),
    [nowMs, range, selected],
  );

  const formatCapMoment = useMemo(() => {
    const format = new Intl.DateTimeFormat("en-US", {
      ...(timeZone === "" ? {} : { timeZone }),
      weekday: "short",
      hour: "numeric",
    });
    return (atMs: number) => format.format(new Date(atMs));
  }, [timeZone]);

  const cycles = useMemo(() => {
    if (overlay === undefined) return [];
    return overlay.cycles.map((cycle) => ({
      ...cycle,
      points: decimateSeries(
        cycle.points,
        (point) => point.hoursIn,
        (point) => point.usedPercent,
        0,
        overlay.cycleHours,
        DECIMATION_BUCKETS,
      ),
    }));
  }, [overlay]);

  if (selected === undefined || overlay === undefined || cycles.length === 0) {
    return (
      <QuotaHistoryEmpty detail="Weekly windows appear here once a full cycle has been observed." />
    );
  }

  const { cycleHours, projection } = overlay;
  const axisTicks = Array.from(
    { length: AXIS_TICK_COUNT + 1 },
    (_, index) => (cycleHours / AXIS_TICK_COUNT) * index,
  );
  const formatAxis = (hours: number) =>
    cycleHours > 48 ? `${Math.round(hours / 24)}d` : `${Math.round(hours)}h`;

  const projectionColor = projection?.capHoursIn === undefined ? selected.color : "var(--error)";
  const capX =
    projection?.capHoursIn === undefined
      ? null
      : (Math.min(projection.capHoursIn, cycleHours) / cycleHours) * VIEW_WIDTH;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-md border border-border">
          {options.map((option) => (
            <button
              key={option.key}
              type="button"
              aria-pressed={option.key === selected.key}
              onClick={() => setSelectedKey(option.key)}
              className={cn(
                "cursor-pointer px-2.5 py-1 text-[10px] tracking-wide uppercase",
                option.key === selected.key
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        {projection?.capAtMs === undefined ? null : (
          <span className="text-[10px] text-destructive-foreground">
            At this pace, hits the limit {formatCapMoment(projection.capAtMs)}
          </span>
        )}
      </div>

      <div className="flex gap-2">
        <div className="relative h-48 w-14 shrink-0">
          {PERCENT_TICKS.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2 text-[10px] text-muted-foreground tabular-nums"
              style={{ top: `${(toY(tick) / VIEW_HEIGHT) * 100}%` }}
            >
              {tick}%
            </span>
          ))}
        </div>

        <div className="relative h-48 flex-1">
          <svg
            className="h-full w-full"
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${selected.label} usage by hours into each cycle`}
          >
            {PERCENT_TICKS.map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={VIEW_WIDTH}
                y1={toY(tick)}
                y2={toY(tick)}
                stroke="currentColor"
                strokeWidth={1}
                className="text-border"
                vectorEffect="non-scaling-stroke"
              />
            ))}

            <line
              x1={0}
              x2={VIEW_WIDTH}
              y1={toY(100)}
              y2={toY(100)}
              stroke="var(--error)"
              strokeOpacity={0.5}
              strokeWidth={1}
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />

            {/* Ghosts first so the live cycle is never crossed by one. */}
            {cycles
              .filter((cycle) => !cycle.isCurrent)
              .map((cycle) => (
                <path
                  key={cycle.key}
                  d={polylinePath(cycle.points, cycleHours)}
                  fill="none"
                  stroke="currentColor"
                  strokeOpacity={0.35}
                  strokeWidth={1.5}
                  className="text-muted-foreground"
                  vectorEffect="non-scaling-stroke"
                />
              ))}

            {projection === undefined ? null : (
              <path
                d={`M${((projection.fromHoursIn / cycleHours) * VIEW_WIDTH).toFixed(2)},${toY(projection.fromPercent).toFixed(2)} L${((projection.toHoursIn / cycleHours) * VIEW_WIDTH).toFixed(2)},${toY(projection.toPercent).toFixed(2)}`}
                fill="none"
                stroke={projectionColor}
                strokeWidth={1.5}
                strokeDasharray="3 4"
                vectorEffect="non-scaling-stroke"
              />
            )}

            {cycles
              .filter((cycle) => cycle.isCurrent)
              .map((cycle) => (
                <path
                  key={cycle.key}
                  d={polylinePath(cycle.points, cycleHours)}
                  fill="none"
                  stroke={selected.color}
                  strokeWidth={2.5}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              ))}

            {capX === null ? null : (
              <line
                x1={capX}
                x2={capX}
                y1={PLOT_TOP}
                y2={VIEW_HEIGHT}
                stroke="var(--error)"
                strokeOpacity={0.6}
                strokeWidth={1}
                strokeDasharray="2 3"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
        </div>
      </div>

      <div className="flex justify-between pl-16 text-[10px] text-muted-foreground uppercase">
        {axisTicks.map((tick) => (
          <span key={tick}>{formatAxis(tick)}</span>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-16 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-0.5 w-3 shrink-0"
            style={{ backgroundColor: selected.color }}
          />
          Current cycle
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-0.5 w-3 shrink-0 bg-muted-foreground/40" />
          {cycles.filter((cycle) => !cycle.isCurrent).length} earlier cycles
        </span>
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-0 w-3 shrink-0 border-t border-dashed"
            style={{ borderColor: projectionColor }}
          />
          Projected at average pace
        </span>
      </div>
    </div>
  );
}
