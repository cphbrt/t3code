import { useCallback, useMemo, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import {
  buildQuotaPolyline,
  clipPolyline,
  decimateSeries,
  quotaSeriesKey,
  quotaSeriesLabel,
  sampleSeriesAt,
  splitAtCap,
  timeAxisTicks,
  type QuotaHistoryWindow,
  type QuotaPoint,
  type QuotaRange,
  type QuotaSawtoothSegment,
} from "./quotaHistory.logic";
import { QuotaHistoryEmpty } from "./QuotaHistoryEmpty";
import { quotaSeriesColor } from "./usageProviders";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 200;
const PLOT_TOP = 8;
const PERCENT_TICKS = [0, 25, 50, 75, 100] as const;
const AXIS_TICK_COUNT = 4;
const DAY_MS = 86_400_000;

/**
 * One horizontal bucket per plotted pixel. The plot is drawn into a fixed
 * 960-unit viewBox and stretched, so this is the resolution the geometry can
 * actually express; anything finer is arithmetic the browser throws away.
 */
const DECIMATION_BUCKETS = VIEW_WIDTH;

interface KeyedSegment extends QuotaSawtoothSegment {
  readonly key: string;
}

interface SawtoothSeries {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly segments: readonly KeyedSegment[];
  readonly points: readonly QuotaPoint[];
}

/**
 * Identity for a drawn run.
 *
 * Its start instant alone is not unique — a segment on either side of a reset
 * cliff begins at the same moment — so the level and the treatment come along
 * to separate them. Consecutive runs always alternate `atCap`, so the triple
 * cannot repeat within a series.
 */
function segmentKey(seriesKey: string, segment: QuotaSawtoothSegment): string {
  const first = segment.points[0];
  return `${seriesKey}:${first?.atMs ?? 0}:${first?.usedPercent ?? 0}:${segment.atCap}`;
}

function toX(atMs: number, range: QuotaRange): number {
  const span = range.endMs - range.startMs;
  if (span <= 0) return 0;
  return ((atMs - range.startMs) / span) * VIEW_WIDTH;
}

function toY(usedPercent: number): number {
  return VIEW_HEIGHT - (usedPercent / 100) * (VIEW_HEIGHT - PLOT_TOP);
}

function segmentPath(segment: QuotaSawtoothSegment, range: QuotaRange): string {
  return segment.points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${toX(point.atMs, range).toFixed(2)},${toY(point.usedPercent).toFixed(2)}`,
    )
    .join(" ");
}

/**
 * Percent-used against wall-clock time, one series per allowance window.
 *
 * The sawtooth is the literal shape of living inside a quota: a climb, a
 * plateau whose width *is* the lockout, and a vertical drop at the reset. The
 * plateau is drawn in the alert color so the part that cost you time is the
 * part that reads first, and the guide at 100% gives the climb something to be
 * measured against.
 *
 * Straight segments only. Smoothing the joins — as the cost chart does, where
 * it reflects a real continuous quantity — would round the reset cliff into a
 * slope and invent readings above the plateau that the provider never issued.
 */
export function QuotaSawtoothChart({
  windows,
  range,
  instanceLabels,
  timeZone,
  emptyDetail,
}: {
  readonly windows: readonly QuotaHistoryWindow[];
  readonly range: QuotaRange;
  readonly instanceLabels: ReadonlyMap<string, string>;
  readonly timeZone: string;
  readonly emptyDetail?: string;
}) {
  const [hoverMs, setHoverMs] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);

  const series = useMemo<readonly SawtoothSeries[]>(
    () =>
      windows.flatMap((window, index) => {
        const clipped = clipPolyline(buildQuotaPolyline(window), range);
        const points = decimateSeries(
          clipped,
          (point) => point.atMs,
          (point) => point.usedPercent,
          range.startMs,
          range.endMs,
          DECIMATION_BUCKETS,
        );
        const rawSegments = splitAtCap(points);
        if (rawSegments.length === 0) return [];
        const key = quotaSeriesKey(window);
        return [
          {
            key,
            label: quotaSeriesLabel(window, instanceLabels),
            color: quotaSeriesColor(index),
            segments: rawSegments.map((segment) => ({
              ...segment,
              key: segmentKey(key, segment),
            })),
            points,
          },
        ];
      }),
    [instanceLabels, range, windows],
  );

  const axisTicks = useMemo(() => timeAxisTicks(range, AXIS_TICK_COUNT), [range]);

  const formatInstant = useMemo(() => {
    const fine = range.endMs - range.startMs <= 2 * DAY_MS;
    const format = new Intl.DateTimeFormat("en-US", {
      ...(timeZone === "" ? {} : { timeZone }),
      month: "short",
      day: "numeric",
      ...(fine ? { hour: "numeric" } : {}),
    });
    return (atMs: number) => format.format(new Date(atMs));
  }, [range.endMs, range.startMs, timeZone]);

  const formatHoverInstant = useMemo(() => {
    const format = new Intl.DateTimeFormat("en-US", {
      ...(timeZone === "" ? {} : { timeZone }),
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    return (atMs: number) => format.format(new Date(atMs));
  }, [timeZone]);

  const handleMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const bounds = plotRef.current?.getBoundingClientRect();
      if (bounds === undefined || bounds.width === 0) return;
      const fraction = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
      setHoverMs(range.startMs + fraction * (range.endMs - range.startMs));
    },
    [range.endMs, range.startMs],
  );

  if (series.length === 0) {
    return <QuotaHistoryEmpty {...(emptyDetail === undefined ? {} : { detail: emptyDetail })} />;
  }

  const hoverFraction =
    hoverMs === null ? 0 : (hoverMs - range.startMs) / (range.endMs - range.startMs);

  return (
    <div className="flex flex-col gap-2">
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

        <div
          ref={plotRef}
          className="relative h-48 flex-1"
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverMs(null)}
        >
          <svg
            className="h-full w-full"
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="Percent of each allowance window used over time"
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

            {/* The line every series is trying not to touch. Dashed and tinted
                so it reads as a limit rather than as another gridline. */}
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

            {series.map((entry) =>
              entry.segments.map((segment) => (
                <path
                  key={segment.key}
                  d={segmentPath(segment, range)}
                  fill="none"
                  stroke={segment.atCap ? "var(--error)" : entry.color}
                  strokeWidth={segment.atCap ? 3 : 2}
                  strokeLinecap="butt"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              )),
            )}

            {hoverMs === null ? null : (
              <line
                x1={toX(hoverMs, range)}
                x2={toX(hoverMs, range)}
                y1={PLOT_TOP}
                y2={VIEW_HEIGHT}
                stroke="currentColor"
                strokeWidth={1}
                className="text-muted-foreground"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>

          {hoverMs === null ? null : (
            <div
              className="pointer-events-none absolute top-0 z-10 min-w-44 border border-border bg-background/95 px-2 py-1.5 text-xs"
              style={{
                left: `${hoverFraction * 100}%`,
                transform: hoverFraction > 0.6 ? "translateX(-100%)" : "translateX(0)",
              }}
            >
              <div className="mb-1 text-muted-foreground">{formatHoverInstant(hoverMs)}</div>
              {series.map((entry) => {
                const value = sampleSeriesAt(entry.points, hoverMs);
                return (
                  <div key={entry.key} className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: entry.color }}
                      />
                      {entry.label}
                    </span>
                    <span
                      className={cn(
                        "tabular-nums",
                        value !== undefined && value >= 99.5
                          ? "text-destructive-foreground"
                          : "text-foreground",
                      )}
                    >
                      {value === undefined ? "—" : `${Math.round(value)}%`}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-between pl-16 text-[10px] text-muted-foreground uppercase">
        {axisTicks.map((tick) => (
          <span key={tick}>{formatInstant(tick)}</span>
        ))}
      </div>

      {/* Visible labels, not color alone: several series hues sit under 3:1
          against the light surface, so identity has to survive without them. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-16">
        {series.map((entry) => (
          <span
            key={entry.key}
            className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
          >
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: entry.color }}
            />
            {entry.label}
          </span>
        ))}
        <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span
            aria-hidden
            className="h-0.5 w-3 shrink-0"
            style={{ backgroundColor: "var(--error)" }}
          />
          At limit
        </span>
      </div>
    </div>
  );
}
