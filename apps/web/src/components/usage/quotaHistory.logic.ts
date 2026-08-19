/**
 * Pure derivations behind the usage page's "Limits over time" charts.
 *
 * The input is provider quota history: for each provider instance and each
 * allowance window it reports, an ordered list of `usedPercent` observations.
 * Everything the charts draw — sawtooth polylines, cap plateaus, lockout
 * bands, per-cycle overlays and the pace projection — is derived here so the
 * components stay presentational and the derivations stay testable. The one
 * exception is pace itself: the projection defers to `lib/usagePace` so the
 * chart and every other quota surface state one rate, not two.
 *
 * Nothing in this module touches the DOM, React, or the clock; callers pass
 * `nowMs` explicitly.
 *
 * @module quotaHistory.logic
 */
import {
  classifyQuotaWindowCycle,
  quotaWindowStartMs,
  type QuotaWindowCycleKind,
} from "@t3tools/shared/quotaWindowCycle";

import {
  deriveUsagePace,
  scheduledMinutesBetween,
  type UsagePace,
  type UsagePaceAvailable,
  type UsagePaceSchedule,
} from "../../lib/usagePace";

/**
 * One observation of a window's fill level.
 *
 * Declared structurally rather than imported from the wire contract so this
 * module stays free of contract imports; `UsageSummary["quotaHistory"]` from
 * `@t3tools/contracts` satisfies it as-is and is passed straight through.
 */
export interface QuotaHistorySample {
  readonly observedAt: string;
  readonly usedPercent: number;
  readonly resetsAt?: string | undefined;
}

/** Every observation collected for one instance's allowance window. */
export interface QuotaHistoryWindow {
  readonly instanceId: string;
  readonly windowId: string;
  readonly label: string;
  readonly durationMinutes?: number | undefined;
  readonly scopeLabel?: string | undefined;
  readonly samples: readonly QuotaHistorySample[];
}

export type QuotaHistory = readonly QuotaHistoryWindow[];

const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * At or above this percent the window is treated as exhausted.
 *
 * Providers report a rounded percentage, so a genuinely full window can land
 * at 99.7 rather than exactly 100. The threshold sits just under 100 to catch
 * that without ever claiming a cap for a window that still has room.
 */
export const CAP_PERCENT = 99.5;

/**
 * A fall of at least this many points between neighbouring samples reads as a
 * reset rather than as noise.
 *
 * Within one cycle usage only accumulates, so any decrease is a boundary in
 * principle. In practice the reported number is rounded and can wobble by a
 * fraction of a point, which would otherwise shred a flat cycle into dozens of
 * one-sample fragments.
 */
const RESET_DROP_PERCENT = 2;

/** How far a reported `resetsAt` may drift inside one cycle before it reads as a new cycle. */
const RESET_DRIFT_TOLERANCE_MS = 5 * MINUTE_MS;

/** Windows at or above a day are the "weekly" family; below it, the short family. */
const WEEKLY_MINIMUM_MINUTES = 24 * 60;

/** Fallback cycle length when a window reports no duration and none can be measured. */
const DEFAULT_CYCLE_HOURS = 168;

/** A half-open span of wall-clock time, in epoch milliseconds. */
export interface QuotaRange {
  readonly startMs: number;
  readonly endMs: number;
}

/** One point on a drawn series. */
export interface QuotaPoint {
  readonly atMs: number;
  readonly usedPercent: number;
}

/** A sample with its timestamps already parsed. */
export interface ResolvedQuotaSample {
  readonly atMs: number;
  readonly usedPercent: number;
  readonly resetsAtMs: number | undefined;
}

function parseMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Trailing `days` of wall-clock time ending at `nowMs`. */
export function quotaRange(days: number, nowMs: number): QuotaRange {
  return { startMs: nowMs - days * DAY_MS, endMs: nowMs };
}

/**
 * Parsed, ordered, de-duplicated samples for one window.
 *
 * Unparseable timestamps and out-of-contract percentages are dropped rather
 * than clamped: a chart that silently invents a 0% reading is worse than one
 * that omits a broken observation. Repeated observations of the same instant
 * collapse to the last one, because a provider that serves a short-lived cache
 * can return the same `observedAt` several times.
 */
export function resolveSamples(window: QuotaHistoryWindow): readonly ResolvedQuotaSample[] {
  const byInstant = new Map<number, ResolvedQuotaSample>();
  for (const sample of window.samples) {
    const atMs = parseMs(sample.observedAt);
    if (atMs === undefined) continue;
    if (!Number.isFinite(sample.usedPercent)) continue;
    byInstant.set(atMs, {
      atMs,
      usedPercent: sample.usedPercent,
      resetsAtMs: parseMs(sample.resetsAt),
    });
  }
  return [...byInstant.values()].sort((left, right) => left.atMs - right.atMs);
}

/** One reset-to-reset span of a window's life. */
export interface QuotaCycle {
  readonly key: string;
  /** Best estimate of when this cycle began accumulating. */
  readonly startMs: number;
  /** The reported reset instant, when any sample in the cycle carried one. */
  readonly endMs: number | undefined;
  readonly samples: readonly ResolvedQuotaSample[];
}

/**
 * Whether `next` belongs to a later cycle than `previous`.
 *
 * Three independent signals, in order of trust:
 *
 * 1. A moved `resetsAt`. The provider states the end of the current cycle
 *    directly, so when it jumps forward the cycle demonstrably rolled over.
 *    This is the only signal that survives a reset the sampler slept through.
 *    It is also the only signal that is *wrong* for a rolling window, whose
 *    reset advances with every probe by design: read literally it declares a
 *    new cycle at every observation and shreds the series into one-sample
 *    fragments, so a window classified as rolling ignores it.
 * 2. A meaningful drop in `usedPercent`. Usage only accumulates within a
 *    cycle, so a fall past the noise floor can only be a refill.
 * 3. A sampling gap longer than the window itself. A whole cycle cannot fit
 *    between two neighbouring samples without at least one reset happening,
 *    even if the level happens to land back where it was.
 */
function startsNewCycle(
  previous: ResolvedQuotaSample,
  next: ResolvedQuotaSample,
  durationMs: number | undefined,
  cycleKind: QuotaWindowCycleKind,
): boolean {
  if (
    cycleKind !== "rolling" &&
    previous.resetsAtMs !== undefined &&
    next.resetsAtMs !== undefined
  ) {
    if (next.resetsAtMs - previous.resetsAtMs > RESET_DRIFT_TOLERANCE_MS) return true;
  }
  if (next.usedPercent <= previous.usedPercent - RESET_DROP_PERCENT) return true;
  if (durationMs !== undefined && next.atMs - previous.atMs > durationMs) return true;
  return false;
}

/**
 * How this window renews, judged from its own charted history.
 *
 * The charts classify locally rather than reading the server's annotation
 * because they hold the very history the answer is derived from, and because
 * a series is redrawn for whatever range the viewer picked — including ranges
 * that predate the server ever having seen the window.
 */
export function quotaWindowCycleKind(window: QuotaHistoryWindow): QuotaWindowCycleKind {
  return classifyQuotaWindowCycle({
    observations: resolveSamples(window).map((sample) => ({
      observedAtMs: sample.atMs,
      resetsAtMs: sample.resetsAtMs,
    })),
    durationMs: cycleDurationMs(window),
  });
}

function cycleDurationMs(window: QuotaHistoryWindow): number | undefined {
  const minutes = window.durationMinutes;
  if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) return undefined;
  return minutes * MINUTE_MS;
}

/**
 * Splits a window's samples into cycles.
 *
 * A cycle's start is taken from the provider's own `resetsAt` minus the window
 * duration when both are known, which is exact; otherwise it falls back to the
 * first observation in the cycle, which is only a lower bound (usage may have
 * begun before anyone was watching). The derived start is never allowed to sit
 * after the first observation it is supposed to precede.
 */
export function splitQuotaCycles(window: QuotaHistoryWindow): readonly QuotaCycle[] {
  const samples = resolveSamples(window);
  if (samples.length === 0) return [];
  const durationMs = cycleDurationMs(window);
  const cycleKind = quotaWindowCycleKind(window);

  const groups: ResolvedQuotaSample[][] = [];
  let current: ResolvedQuotaSample[] = [];
  for (const sample of samples) {
    const previous = current[current.length - 1];
    if (previous !== undefined && startsNewCycle(previous, sample, durationMs, cycleKind)) {
      groups.push(current);
      current = [];
    }
    current.push(sample);
  }
  groups.push(current);

  return groups.flatMap((group) => {
    const first = group[0];
    if (first === undefined) return [];
    const endMs = group.findLast((sample) => sample.resetsAtMs !== undefined)?.resetsAtMs;
    const derivedStart = quotaWindowStartMs(endMs, durationMs);
    const startMs = derivedStart === undefined ? first.atMs : Math.min(derivedStart, first.atMs);
    return [
      {
        key: `${window.instanceId}:${window.windowId}:${startMs}`,
        startMs,
        endMs,
        samples: group,
      },
    ];
  });
}

function interpolatePercent(from: QuotaPoint, to: QuotaPoint, atMs: number): number {
  const span = to.atMs - from.atMs;
  if (span <= 0) return to.usedPercent;
  const ratio = (atMs - from.atMs) / span;
  return from.usedPercent + (to.usedPercent - from.usedPercent) * ratio;
}

/**
 * The polyline for one window, including the vertical drop at every reset.
 *
 * Between two cycles the series holds its last observed level up to the reset
 * instant and then falls to zero at that same instant, which is what draws the
 * sawtooth's cliff. Without those two synthetic points the line would slope
 * gently from the old peak to the new floor and read as "usage declined"
 * rather than "the allowance refilled".
 */
export function buildQuotaPolyline(window: QuotaHistoryWindow): readonly QuotaPoint[] {
  const cycles = splitQuotaCycles(window);
  const points: QuotaPoint[] = [];

  cycles.forEach((cycle, index) => {
    for (const sample of cycle.samples) {
      points.push({ atMs: sample.atMs, usedPercent: sample.usedPercent });
    }
    const next = cycles[index + 1];
    const last = cycle.samples[cycle.samples.length - 1];
    const nextFirst = next?.samples[0];
    if (next === undefined || last === undefined || nextFirst === undefined) return;

    // Prefer the provider's stated reset instant, but never place the cliff
    // outside the observed gap it has to live in.
    const candidate = cycle.endMs ?? next.startMs ?? (last.atMs + nextFirst.atMs) / 2;
    const resetMs = Math.min(Math.max(candidate, last.atMs), nextFirst.atMs);
    points.push({ atMs: resetMs, usedPercent: last.usedPercent });
    points.push({ atMs: resetMs, usedPercent: 0 });
  });

  return points;
}

/**
 * The portion of a non-decreasing-in-time polyline inside `range`, with the
 * crossings interpolated so a clipped series still meets the plot edges.
 */
export function clipPolyline(
  points: readonly QuotaPoint[],
  range: QuotaRange,
): readonly QuotaPoint[] {
  const inside: QuotaPoint[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point === undefined) continue;

    if (point.atMs < range.startMs) {
      const next = points[index + 1];
      if (next !== undefined && next.atMs > range.startMs) {
        inside.push({
          atMs: range.startMs,
          usedPercent: interpolatePercent(point, next, range.startMs),
        });
      }
      continue;
    }
    if (point.atMs > range.endMs) {
      const previous = points[index - 1];
      if (previous !== undefined && previous.atMs < range.endMs) {
        inside.push({
          atMs: range.endMs,
          usedPercent: interpolatePercent(previous, point, range.endMs),
        });
      }
      break;
    }
    inside.push(point);
  }
  return inside;
}

/**
 * Thins a series to at most four points per horizontal bucket while keeping
 * the shape intact.
 *
 * A quota probe every five minutes is ~26k observations per window over 90
 * days, and a plot is under a thousand pixels wide; handing every one of them
 * to the DOM costs a great deal and shows nothing. Each bucket keeps its first
 * and last point — so the line still joins its neighbours — plus its lowest
 * and highest, which is what preserves the features that matter here: the flat
 * top of a plateau and the vertical face of a reset both survive as a
 * min/max pair inside their bucket, where naive every-nth-point sampling would
 * round the cliff off or miss it entirely.
 */
export function decimateSeries<T>(
  points: readonly T[],
  xOf: (point: T) => number,
  yOf: (point: T) => number,
  domainStart: number,
  domainEnd: number,
  buckets: number,
): readonly T[] {
  if (points.length <= buckets || buckets <= 0 || domainEnd <= domainStart) return points;

  const span = domainEnd - domainStart;
  const kept: T[] = [];
  let bucketIndex = -1;
  let group: T[] = [];

  const flush = () => {
    if (group.length === 0) return;
    const first = group[0];
    const last = group[group.length - 1];
    if (first === undefined || last === undefined) return;
    let lowest: T = first;
    let highest: T = first;
    for (const point of group) {
      if (yOf(point) < yOf(lowest)) lowest = point;
      if (yOf(point) > yOf(highest)) highest = point;
    }
    const chosen = [first, lowest, highest, last]
      .filter((point, index, all) => all.indexOf(point) === index)
      .sort((left, right) => xOf(left) - xOf(right));
    kept.push(...chosen);
    group = [];
  };

  for (const point of points) {
    const ratio = (xOf(point) - domainStart) / span;
    const index = Math.min(buckets - 1, Math.max(0, Math.floor(ratio * buckets)));
    if (index !== bucketIndex) {
      flush();
      bucketIndex = index;
    }
    group.push(point);
  }
  flush();

  return kept;
}

/**
 * The level of a series at `atMs`, interpolated between neighbouring points.
 *
 * Returns undefined outside the series' own span rather than clamping to its
 * ends, so a crosshair over a stretch with no observations reads blank instead
 * of asserting a level nobody measured.
 */
export function sampleSeriesAt(points: readonly QuotaPoint[], atMs: number): number | undefined {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return undefined;
  if (atMs < first.atMs || atMs > last.atMs) return undefined;

  let low = 0;
  let high = points.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    const point = points[middle];
    if (point === undefined) break;
    if (point.atMs <= atMs) low = middle;
    else high = middle;
  }
  const from = points[low];
  const to = points[high];
  if (from === undefined) return undefined;
  if (to === undefined) return from.usedPercent;
  return interpolatePercent(from, to, atMs);
}

/** A run of the polyline drawn in one treatment: at the cap, or below it. */
export interface QuotaSawtoothSegment {
  readonly atCap: boolean;
  readonly points: readonly QuotaPoint[];
}

function capCrossing(from: QuotaPoint, to: QuotaPoint): QuotaPoint {
  const span = to.usedPercent - from.usedPercent;
  if (span === 0 || to.atMs === from.atMs) return { atMs: to.atMs, usedPercent: CAP_PERCENT };
  const ratio = (CAP_PERCENT - from.usedPercent) / span;
  return { atMs: from.atMs + (to.atMs - from.atMs) * ratio, usedPercent: CAP_PERCENT };
}

/**
 * Cuts a polyline into at-cap and below-cap runs, splitting exactly on the
 * threshold crossing.
 *
 * The plateau is the whole point of the sawtooth — its width is the lockout —
 * so it gets its own segments to paint in the alert color. Splitting at the
 * interpolated crossing rather than at the neighbouring sample keeps the
 * coloured run from over- or under-stating that width by up to a whole
 * sampling interval.
 */
export function splitAtCap(points: readonly QuotaPoint[]): readonly QuotaSawtoothSegment[] {
  const first = points[0];
  if (first === undefined) return [];

  const segments: { atCap: boolean; points: QuotaPoint[] }[] = [];
  let current = { atCap: first.usedPercent >= CAP_PERCENT, points: [first] };

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const next = points[index];
    if (previous === undefined || next === undefined) continue;
    const nextAtCap = next.usedPercent >= CAP_PERCENT;
    if (nextAtCap === current.atCap) {
      current.points.push(next);
      continue;
    }
    const crossing = capCrossing(previous, next);
    current.points.push(crossing);
    segments.push(current);
    current = { atCap: nextAtCap, points: [crossing, next] };
  }
  segments.push(current);

  // A one-point run draws nothing; dropping it keeps the renderer free of
  // degenerate paths.
  return segments.filter((segment) => segment.points.length >= 2);
}

/** A stretch of wall-clock time during which one window sat at its cap. */
export interface QuotaCapInterval {
  readonly instanceId: string;
  readonly windowId: string;
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * The intervals during which a window was exhausted, clipped to `range`.
 *
 * A cap is only ever *observed* at sample instants, so the end of a run is
 * bounded by the first observation that disproves it — the next sample, or
 * failing that the reported reset. Attributing the cap up to that next
 * observation slightly overstates the lockout (by at most one sampling
 * interval) but is the only choice that gives an isolated at-cap observation
 * any width at all; treating a run as ending at its own last sample would
 * silently erase every cap seen exactly once.
 */
export function deriveCapIntervals(
  window: QuotaHistoryWindow,
  range: QuotaRange,
): readonly QuotaCapInterval[] {
  const samples = resolveSamples(window);
  const intervals: QuotaCapInterval[] = [];

  let runStart: ResolvedQuotaSample | undefined;
  let runEnd: ResolvedQuotaSample | undefined;

  const closeRun = (following: ResolvedQuotaSample | undefined) => {
    if (runStart === undefined || runEnd === undefined) return;
    const bound =
      following?.atMs ??
      (runEnd.resetsAtMs !== undefined && runEnd.resetsAtMs > runEnd.atMs
        ? runEnd.resetsAtMs
        : runEnd.atMs);
    const startMs = Math.max(runStart.atMs, range.startMs);
    const endMs = Math.min(bound, range.endMs);
    if (endMs > startMs) {
      intervals.push({
        instanceId: window.instanceId,
        windowId: window.windowId,
        startMs,
        endMs,
      });
    }
    runStart = undefined;
    runEnd = undefined;
  };

  for (const sample of samples) {
    if (sample.usedPercent >= CAP_PERCENT) {
      if (runStart === undefined) runStart = sample;
      runEnd = sample;
      continue;
    }
    closeRun(sample);
  }
  closeRun(undefined);

  return intervals;
}

/**
 * The instant a cost-chart period begins.
 *
 * Day periods are calendar days in the viewer's own zone — that is how the
 * usage window is built — so they are parsed as local midnight rather than as
 * UTC. Parsing `"2026-08-01"` with `Date.parse` would yield UTC midnight and
 * slide every band by the viewer's offset, which west of Greenwich is enough to
 * hang a lockout on the wrong day.
 */
export function periodStartMs(period: string, resolution: "day" | "hour"): number | undefined {
  if (resolution === "hour") return parseMs(period);
  const [year, month, day] = period.split("-").map((part) => Number.parseInt(part, 10));
  if (year === undefined || month === undefined || day === undefined) return undefined;
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return undefined;
  return new Date(year, month - 1, day).getTime();
}

/** A cap interval expressed as a fraction of a plot's width. */
export interface QuotaBandFraction {
  readonly key: string;
  readonly instanceId: string;
  readonly windowId: string;
  readonly startFraction: number;
  readonly endFraction: number;
}

/**
 * Projects cap intervals onto a plot whose x-axis runs from `domainStartMs` to
 * `domainEndMs`.
 *
 * The cost chart plots one point per period and places the last period's point
 * at the far right edge, so its drawable domain ends at the *start* of the last
 * period, not its end. A lockout inside that final period therefore clamps to
 * the right edge rather than extending past it; bands left with no width after
 * clamping are dropped instead of being drawn as invisible slivers.
 */
export function capIntervalsToFractions(
  intervals: readonly QuotaCapInterval[],
  domainStartMs: number,
  domainEndMs: number,
): readonly QuotaBandFraction[] {
  const span = domainEndMs - domainStartMs;
  if (span <= 0) return [];
  return intervals.flatMap((interval) => {
    const startFraction = Math.min(1, Math.max(0, (interval.startMs - domainStartMs) / span));
    const endFraction = Math.min(1, Math.max(0, (interval.endMs - domainStartMs) / span));
    if (endFraction <= startFraction) return [];
    return [
      {
        key: `${interval.instanceId}:${interval.windowId}:${interval.startMs}`,
        instanceId: interval.instanceId,
        windowId: interval.windowId,
        startFraction,
        endFraction,
      },
    ];
  });
}

/** How much of the range one window spent locked out. */
export interface QuotaCapSummary {
  readonly hoursAtCap: number;
  readonly capEvents: number;
}

export function summarizeCapIntervals(intervals: readonly QuotaCapInterval[]): QuotaCapSummary {
  const totalMs = intervals.reduce((sum, interval) => sum + (interval.endMs - interval.startMs), 0);
  return { hoursAtCap: totalMs / HOUR_MS, capEvents: intervals.length };
}

/** One historical cycle, replotted against hours-into-the-cycle. */
export interface QuotaOverlayCycle {
  readonly key: string;
  readonly startMs: number;
  readonly isCurrent: boolean;
  readonly points: readonly { readonly hoursIn: number; readonly usedPercent: number }[];
}

/**
 * Where the current cycle's pace lands if nothing changes.
 *
 * The rate is not computed here. It is a `UsagePaceAvailable` — the same
 * derivation every other pace surface reads — so "at this pace, hits the limit
 * on Thursday" under this chart and a pace verdict beside a plan-limit bar are
 * two renderings of one number rather than two models that happen to agree.
 */
export interface QuotaPaceProjection {
  /** The pace this line draws. `projectedFinalPercent > 100` is the cap case. */
  readonly pace: UsagePaceAvailable;
  /**
   * The projected line, on the same hours-into-the-cycle axis as the observed
   * series.
   *
   * A polyline rather than two endpoints because pace advances in *scheduled*
   * minutes: under a restricted schedule the projection is flat through every
   * evening and weekend and climbs only during counted hours. The vertices are
   * the schedule's own transitions, so the line is exact rather than sampled.
   */
  readonly points: readonly { readonly hoursIn: number; readonly usedPercent: number }[];
  /** Hours into the cycle at which the pace reaches 100%, when that is inside the cycle. */
  readonly capHoursIn: number | undefined;
  readonly capAtMs: number | undefined;
}

export interface QuotaCycleOverlay {
  readonly cycleHours: number;
  readonly cycles: readonly QuotaOverlayCycle[];
  /**
   * Pace of the in-progress cycle, or undefined when no cycle is in progress.
   *
   * Carried even when unavailable so the chart can say *why* there is no
   * dotted line rather than silently drawing nothing, which reads as "nothing
   * to worry about".
   */
  readonly pace: UsagePace | undefined;
  readonly projection: QuotaPaceProjection | undefined;
}

/**
 * The cycle length to normalise against: the provider's own figure when it
 * reports one, otherwise the longest observed cycle span, otherwise a week.
 *
 * The *longest* observed span rather than the mean, because a cycle that was
 * only sampled for part of its life measures short, and an x-axis shorter than
 * a real cycle would push that cycle's tail off the right edge.
 */
function resolveCycleHours(window: QuotaHistoryWindow, cycles: readonly QuotaCycle[]): number {
  const durationMs = cycleDurationMs(window);
  if (durationMs !== undefined) return durationMs / HOUR_MS;

  const spans = cycles.flatMap((cycle) => {
    const last = cycle.samples[cycle.samples.length - 1];
    if (last === undefined) return [];
    const span = (cycle.endMs ?? last.atMs) - cycle.startMs;
    return span > 0 ? [span] : [];
  });
  const longest = spans.length === 0 ? undefined : Math.max(...spans);
  return longest === undefined ? DEFAULT_CYCLE_HOURS : longest / HOUR_MS;
}

/**
 * Days the projection's boundary walk steps through before giving up. A cycle
 * is at most a week, so this only exists so a nonsensical input cannot spin.
 */
const PROJECTION_MAX_DAYS = 10;

/**
 * The instants at which the schedule opens or closes, strictly inside a span.
 *
 * These are the projection's vertices. Between two neighbouring boundaries the
 * schedule is either wholly counting or wholly not, so percent against
 * wall-clock is a straight line on each segment and a polyline through the
 * boundaries is exact — no sampling density to tune, and no rounded corner
 * where a weekend should be a flat shelf.
 */
function scheduleBoundariesBetween(
  fromMs: number,
  toMs: number,
  schedule: UsagePaceSchedule,
): readonly number[] {
  if (!schedule.workdaysOnly && !schedule.workHoursOnly) return [];
  if (toMs <= fromMs) return [];

  const origin = new Date(fromMs);
  const year = origin.getFullYear();
  const month = origin.getMonth();
  const dayOfMonth = origin.getDate();

  const boundaries: number[] = [];
  for (let offset = 0; offset <= PROJECTION_MAX_DAYS; offset += 1) {
    const dayStartMs = new Date(year, month, dayOfMonth + offset).getTime();
    // Without an hour restriction the only transitions are midnights, where a
    // weekday becomes a weekend or the reverse.
    const candidates = schedule.workHoursOnly
      ? [
          new Date(year, month, dayOfMonth + offset, schedule.startHour).getTime(),
          new Date(year, month, dayOfMonth + offset, schedule.endHour).getTime(),
        ]
      : [dayStartMs];
    for (const candidate of candidates) {
      if (candidate > fromMs && candidate < toMs) boundaries.push(candidate);
    }
    if (dayStartMs >= toMs) break;
  }
  return boundaries.sort((left, right) => left - right);
}

/**
 * The dotted continuation of one cycle, drawn from a pace.
 *
 * The line starts at the last observation rather than at the earliest instant
 * holding the same scheduled elapsed time. Those differ whenever a snapshot
 * lands in an uncounted hour — a Saturday reading under a weekdays-only
 * schedule carries Friday evening's scheduled total — and anchoring on the
 * scheduled figure would start the dashes to the left of the solid line they
 * are supposed to continue.
 */
function buildPaceProjection(
  pace: UsagePace,
  cycleStartMs: number,
  latestAtMs: number,
  schedule: UsagePaceSchedule,
): QuotaPaceProjection | undefined {
  if (!pace.available) return undefined;
  // Nothing spent has no rate to extend, and a full window has nothing left to
  // project toward.
  if (pace.usedPercent <= 0 || pace.usedPercent >= 100) return undefined;

  const capAtMs = pace.projectedCapAtMs;
  // `projectedCapAtMs` is set exactly when the rate exhausts the window early,
  // so the line ends either at the cap or at the reset.
  const endMs = pace.projectedFinalPercent > 100 ? capAtMs : pace.windowEndMs;
  if (endMs === undefined || endMs <= latestAtMs) return undefined;

  const toHoursIn = (atMs: number) => (atMs - cycleStartMs) / HOUR_MS;
  const percentAt = (atMs: number) =>
    (pace.usedPercent * scheduledMinutesBetween(pace.windowStartMs, atMs, schedule)) /
    pace.scheduledElapsedMinutes;

  return {
    pace,
    points: [
      { hoursIn: toHoursIn(latestAtMs), usedPercent: pace.usedPercent },
      ...scheduleBoundariesBetween(latestAtMs, endMs, schedule).map((atMs) => ({
        hoursIn: toHoursIn(atMs),
        usedPercent: Math.min(100, percentAt(atMs)),
      })),
      { hoursIn: toHoursIn(endMs), usedPercent: Math.min(100, pace.projectedFinalPercent) },
    ],
    capHoursIn: capAtMs === undefined ? undefined : toHoursIn(capAtMs),
    capAtMs,
  };
}

/**
 * Replots every cycle of one window on a shared "hours into the cycle" axis,
 * and carries the in-progress cycle's pace forward.
 *
 * The projection is `deriveUsagePace` rather than a rate worked out here. The
 * two were algebraically the same linear model — average spend since the cycle
 * opened, extended to the reset — so keeping both would only have created two
 * numbers on one screen that could disagree after any change to either.
 *
 * That unification tightens the projection's preconditions, deliberately.
 * Where the old rate would extend any two points, pace needs the provider's
 * own reset and window length: without them the cycle's start is only a lower
 * bound (usage may have begun before anyone was watching), which overstates
 * the burn rate and makes the projection alarmist in exactly the case where
 * nothing is actually known. The axis keeps its fallbacks — a cycle still has
 * to be drawn somewhere — but the dotted line now stays away, and `pace`
 * carries the reason so the chart can say so.
 *
 * The projection deliberately uses the average since the cycle began rather
 * than a recent-window rate. The question the view answers is "am I burning
 * faster than my past weeks", which is a statement about the whole cycle; a
 * trailing rate would swing between an idle hour and a busy one and promise a
 * cap-hit time that moved on every refresh.
 */
export function buildCycleOverlay(
  window: QuotaHistoryWindow,
  range: QuotaRange,
  nowMs: number,
  schedule: UsagePaceSchedule,
): QuotaCycleOverlay {
  const allCycles = splitQuotaCycles(window);
  const cycleHours = resolveCycleHours(window, allCycles);
  const cycleMs = cycleHours * HOUR_MS;

  const visible = allCycles.filter(
    (cycle) => cycle.startMs + cycleMs > range.startMs && cycle.startMs <= range.endMs,
  );

  const newest = visible[visible.length - 1];
  const currentCycle =
    newest !== undefined && newest.startMs + cycleMs > nowMs ? newest : undefined;

  const cycles = visible.map((cycle) => ({
    key: cycle.key,
    startMs: cycle.startMs,
    isCurrent: cycle === currentCycle,
    points: cycle.samples.map((sample) => ({
      hoursIn: (sample.atMs - cycle.startMs) / HOUR_MS,
      usedPercent: sample.usedPercent,
    })),
  }));

  const latest = currentCycle?.samples[currentCycle.samples.length - 1];
  const pace =
    currentCycle === undefined || latest === undefined
      ? undefined
      : deriveUsagePace({
          usedPercent: latest.usedPercent,
          resetsAtMs: currentCycle.endMs,
          durationMinutes: window.durationMinutes,
          cycleKind: quotaWindowCycleKind(window),
          // The observation's own instant, not the wall clock: the percentage
          // is frozen at the moment the provider reported it.
          nowMs: latest.atMs,
          schedule,
        });

  const projection =
    pace === undefined || currentCycle === undefined || latest === undefined
      ? undefined
      : buildPaceProjection(pace, currentCycle.startMs, latest.atMs, schedule);

  return { cycleHours, cycles, pace, projection };
}

/** Human-facing name for a window, e.g. `Claude · Opus Weekly`. */
export function quotaSeriesLabel(
  window: QuotaHistoryWindow,
  instanceLabels: ReadonlyMap<string, string>,
): string {
  const scope =
    window.scopeLabel === undefined ? window.label : `${window.scopeLabel} ${window.label}`;
  return `${instanceLabels.get(window.instanceId) ?? window.instanceId} · ${scope}`;
}

/** Stable identity for one drawn series. */
export function quotaSeriesKey(window: QuotaHistoryWindow): string {
  return `${window.instanceId}:${window.windowId}`;
}

function compareWindows(left: QuotaHistoryWindow, right: QuotaHistoryWindow): number {
  return (
    left.instanceId.localeCompare(right.instanceId) || left.windowId.localeCompare(right.windowId)
  );
}

function hasSamples(window: QuotaHistoryWindow): boolean {
  return window.samples.length > 0;
}

/**
 * The shortest allowance window each instance reports.
 *
 * The day-scale sawtooth wants the fastest-moving window, which for Claude is
 * its five-hour allowance. Codex publishes no five-hour window at all, so
 * asking for "the 5-hour one" by name would simply drop it from the chart;
 * asking each instance for its shortest window gives every provider a series
 * on the same footing. Windows that report no duration sort last — they can
 * still be chosen, but only when an instance offers nothing better.
 */
export function shortestWindowPerInstance(history: QuotaHistory): readonly QuotaHistoryWindow[] {
  const byInstance = new Map<string, QuotaHistoryWindow>();
  for (const window of history) {
    if (!hasSamples(window)) continue;
    const incumbent = byInstance.get(window.instanceId);
    if (incumbent === undefined || isShorterWindow(window, incumbent)) {
      byInstance.set(window.instanceId, window);
    }
  }
  return [...byInstance.values()].sort(compareWindows);
}

function isShorterWindow(candidate: QuotaHistoryWindow, incumbent: QuotaHistoryWindow): boolean {
  const candidateMinutes = candidate.durationMinutes ?? Number.POSITIVE_INFINITY;
  const incumbentMinutes = incumbent.durationMinutes ?? Number.POSITIVE_INFINITY;
  if (candidateMinutes !== incumbentMinutes) return candidateMinutes < incumbentMinutes;
  // Same length: prefer the account-wide window over a model-scoped carve-out,
  // then fall back to a stable name order so the pick never flickers.
  const candidateScoped = candidate.scopeLabel !== undefined;
  const incumbentScoped = incumbent.scopeLabel !== undefined;
  if (candidateScoped !== incumbentScoped) return !candidateScoped;
  return candidate.windowId.localeCompare(incumbent.windowId) < 0;
}

/**
 * Every window that renews on a day-or-longer schedule.
 *
 * Windows without a reported duration fall back to their label, because a
 * provider that omits the figure still calls the window "Weekly".
 */
export function weeklyWindows(history: QuotaHistory): readonly QuotaHistoryWindow[] {
  return history
    .filter((window) => {
      if (!hasSamples(window)) return false;
      if (window.durationMinutes !== undefined) {
        return window.durationMinutes >= WEEKLY_MINIMUM_MINUTES;
      }
      return /week/i.test(window.label);
    })
    .toSorted(compareWindows);
}

/** Evenly spaced instants across `range`, for a time axis with `count` intervals. */
export function timeAxisTicks(range: QuotaRange, count: number): readonly number[] {
  if (count <= 0 || range.endMs <= range.startMs) return [range.startMs];
  const step = (range.endMs - range.startMs) / count;
  return Array.from({ length: count + 1 }, (_, index) => range.startMs + index * step);
}
