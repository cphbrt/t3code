/**
 * Usage pace: whether a provider allowance window is ahead of or behind a
 * linear budget for its own cycle.
 *
 * A quota percentage on its own says almost nothing. "47% used" is a
 * comfortable place to be four hours into a five-hour window and an alarming
 * one an hour in. Pace supplies the missing half: it compares what has been
 * spent against what a perfectly even spend would have reached by now, and
 * reports the difference in percentage points.
 *
 * ## Elapsed time is measured in scheduled minutes, not wall minutes
 *
 * "How far through the window am I" is not always a clock question. Someone
 * who works office hours has already lost two of a five-hour window that
 * opened at 6am, and a linear budget that counts those two hours tells them
 * they are behind when they have not started. So the primitive here is a
 * *schedule* — a predicate over instants — and elapsed fraction is the ratio
 * of scheduled minutes elapsed to scheduled minutes in the whole window. With
 * the default schedule (both switches off) that ratio is plain wall-clock
 * elapsed time, which is what everyone gets until they say otherwise.
 *
 * Schedules are evaluated in the device's live local zone. There is no
 * persisted timezone, matching how reset instants are already rendered
 * (`providerUsageLimit.ts`): a stored zone would disagree with the clock in
 * the menu bar the moment the machine moves.
 *
 * ## "Now" is the observation time, not the wall clock
 *
 * Every derivation here takes `nowMs` explicitly, and callers must pass the
 * quota snapshot's own `observedAt` rather than `Date.now()`. The percentage
 * is frozen at the instant the provider reported it while the clock keeps
 * running, and the client deliberately tolerates a snapshot up to twenty
 * minutes old (`providerQuota.ts`). On a five-hour window twenty minutes is
 * 6.7% of the cycle, so a wall-clock "now" would walk an idle app steadily
 * toward a false "behind schedule" simply for sitting still. Pairing the
 * frozen numerator with a frozen denominator keeps the statement true: it is
 * a claim about the moment the provider measured, not about right now.
 *
 * A pleasant consequence is that nothing here needs a ticking clock, so pace
 * only recomputes when a new snapshot arrives.
 *
 * Nothing in this module touches the DOM or React.
 *
 * @module usagePace
 */
import { quotaWindowStartMs, type QuotaWindowCycleKind } from "@t3tools/shared/quotaWindowCycle";

const MINUTE_MS = 60_000;

/**
 * Days the calendar walk will step through before giving up.
 *
 * The longest window any provider reports is a week, so eight iterations is
 * the real ceiling; this only exists so a nonsensical input cannot spin.
 */
const MAX_SCHEDULE_DAYS = 400;

/**
 * Which instants count as time spent.
 *
 * Declared structurally rather than imported from the settings contract so
 * this module stays free of contract imports and trivially unit-testable;
 * `UsagePaceSchedule` from `@t3tools/contracts/settings` satisfies it as-is
 * and is passed straight through.
 */
export interface UsagePaceSchedule {
  /** Count only Monday through Friday. */
  readonly workdaysOnly: boolean;
  /** Count only the hours between `startHour` and `endHour`. */
  readonly workHoursOnly: boolean;
  /** Local hour the counted day opens, inclusive (0–23). */
  readonly startHour: number;
  /** Local hour the counted day closes, exclusive (1–24). */
  readonly endHour: number;
}

/** Plain wall-clock time: every minute counts. The product default. */
export const WALL_CLOCK_SCHEDULE: UsagePaceSchedule = {
  workdaysOnly: false,
  workHoursOnly: false,
  startHour: 0,
  endHour: 24,
};

/**
 * The active hour range, or undefined when the schedule imposes none.
 *
 * An incoherent range (`endHour` at or before `startHour`) is treated as no
 * restriction rather than as zero counted time. The settings contract keeps
 * each hour in range but does not enforce the relation between them, and
 * silently counting nothing would present every window as "unknown" with no
 * hint as to why.
 */
function activeHours(
  schedule: UsagePaceSchedule,
): { readonly startHour: number; readonly endHour: number } | undefined {
  if (!schedule.workHoursOnly) return undefined;
  const startHour = Math.trunc(schedule.startHour);
  const endHour = Math.trunc(schedule.endHour);
  if (!Number.isFinite(startHour) || !Number.isFinite(endHour)) return undefined;
  if (startHour < 0 || startHour > 23) return undefined;
  if (endHour < 1 || endHour > 24) return undefined;
  if (endHour <= startHour) return undefined;
  return { startHour, endHour };
}

function isWeekend(date: Date): boolean {
  const weekday = date.getDay();
  return weekday === 0 || weekday === 6;
}

/**
 * Minutes of scheduled time in the half-open span `[startMs, endMs)`.
 *
 * The span is walked one *local calendar day* at a time and intersected with
 * that day's active interval. Local-date arithmetic — `new Date(year, month,
 * day + n, hour)` — is what makes this correct across daylight saving: on a
 * spring-forward day a 9am-to-6pm interval really is eight hours and a full
 * day really is twenty-three, and both fall out of the runtime's own local
 * time construction. Advancing a cursor by 86,400,000 milliseconds instead
 * would drift an hour at every transition and silently mis-state pace for the
 * rest of the window.
 *
 * A window is at most a week, so this is at most eight cheap iterations and
 * is safe to call during render. The unrestricted schedule short-circuits to
 * simple subtraction.
 */
export function scheduledMinutesBetween(
  startMs: number,
  endMs: number,
  schedule: UsagePaceSchedule,
): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  if (endMs <= startMs) return 0;

  const hours = activeHours(schedule);
  if (!schedule.workdaysOnly && hours === undefined) return (endMs - startMs) / MINUTE_MS;

  const origin = new Date(startMs);
  const year = origin.getFullYear();
  const month = origin.getMonth();
  const dayOfMonth = origin.getDate();

  let totalMs = 0;
  for (let offset = 0; offset < MAX_SCHEDULE_DAYS; offset += 1) {
    const day = new Date(year, month, dayOfMonth + offset);
    if (day.getTime() >= endMs) break;
    if (schedule.workdaysOnly && isWeekend(day)) continue;

    const opensMs =
      hours === undefined
        ? day.getTime()
        : new Date(year, month, dayOfMonth + offset, hours.startHour).getTime();
    const closesMs =
      hours === undefined
        ? new Date(year, month, dayOfMonth + offset + 1).getTime()
        : new Date(year, month, dayOfMonth + offset, hours.endHour).getTime();

    const from = Math.max(opensMs, startMs);
    const to = Math.min(closesMs, endMs);
    if (to > from) totalMs += to - from;
  }

  return totalMs / MINUTE_MS;
}

/**
 * The instant reached by spending `minutes` of scheduled time from `startMs`.
 *
 * The piece that lets a pace statement be rendered as a wall-clock moment ("at
 * this pace, hits the limit at 4pm") rather than only as a percentage. Returns
 * undefined when the schedule cannot accumulate that much time inside the
 * walk's day budget, which for a real window means the answer is too far out
 * to be worth saying.
 *
 * ## It is only a partial inverse of `scheduledMinutesBetween`
 *
 * It returns the *earliest* instant at which that much scheduled time has
 * accrued, which is the right answer for "when will the budget run out" and
 * the wrong one for "where is the reading I already have". The two agree on
 * counted instants and diverge on uncounted ones, because every instant in an
 * uncounted stretch shares the scheduled total of that stretch's opening:
 * under a weekdays-only schedule, a Saturday 10:00 observation carries
 * Saturday 00:00's scheduled total, and round-tripping it through here lands
 * ten hours earlier than the observation itself.
 *
 * So never use this to re-derive an instant a caller already holds. A chart
 * that anchored a projection here rather than on its own last observation
 * would start the dashed line to the left of the solid one it continues.
 */
export function instantAfterScheduledMinutes(
  startMs: number,
  minutes: number,
  schedule: UsagePaceSchedule,
): number | undefined {
  if (!Number.isFinite(startMs) || !Number.isFinite(minutes) || minutes < 0) return undefined;

  const hours = activeHours(schedule);
  // Rounded because callers treat the result as an instant, and the minute
  // figure usually arrives from a division that leaves a fractional tail.
  if (!schedule.workdaysOnly && hours === undefined) {
    return Math.round(startMs + minutes * MINUTE_MS);
  }

  const origin = new Date(startMs);
  const year = origin.getFullYear();
  const month = origin.getMonth();
  const dayOfMonth = origin.getDate();

  let remainingMs = minutes * MINUTE_MS;
  for (let offset = 0; offset < MAX_SCHEDULE_DAYS; offset += 1) {
    const day = new Date(year, month, dayOfMonth + offset);
    if (schedule.workdaysOnly && isWeekend(day)) continue;

    const opensMs =
      hours === undefined
        ? day.getTime()
        : new Date(year, month, dayOfMonth + offset, hours.startHour).getTime();
    const closesMs =
      hours === undefined
        ? new Date(year, month, dayOfMonth + offset + 1).getTime()
        : new Date(year, month, dayOfMonth + offset, hours.endHour).getTime();

    const from = Math.max(opensMs, startMs);
    if (closesMs <= from) continue;
    const availableMs = closesMs - from;
    if (remainingMs <= availableMs) return Math.round(from + remainingMs);
    remainingMs -= availableMs;
  }

  return undefined;
}

/** Where a window's spend sits relative to its linear budget. */
export type UsagePaceVerdict = "behind" | "on-pace" | "ahead" | "well-ahead";

/**
 * Delta thresholds, in percentage points of `usedPercent - expectedPercent`.
 *
 * Exported so no surface hardcodes them: a chip, a tooltip and a sidebar row
 * that disagree about where "ahead" begins is the same class of defect as a
 * lying spinner.
 *
 * The dead band is deliberately wider on the fast side than a symmetric
 * reading of "on pace" would suggest, because providers report a rounded
 * percentage and because being a little under budget needs no attention at
 * all, while being a little over is the state worth naming.
 */
export const USAGE_PACE_BEHIND_DELTA_POINTS = -5;
export const USAGE_PACE_AHEAD_DELTA_POINTS = 5;
export const USAGE_PACE_WELL_AHEAD_DELTA_POINTS = 20;

/**
 * `behind` means headroom — spending slower than the window is refilling —
 * and is the good outcome, which is the opposite of how an absolute fill
 * level reads. Consumers that colour by pace must not let it override an
 * absolute severity: a window at 97% is not calm just because it got there
 * slowly.
 */
export function usagePaceVerdict(deltaPoints: number): UsagePaceVerdict {
  if (deltaPoints <= USAGE_PACE_BEHIND_DELTA_POINTS) return "behind";
  if (deltaPoints < USAGE_PACE_AHEAD_DELTA_POINTS) return "on-pace";
  if (deltaPoints < USAGE_PACE_WELL_AHEAD_DELTA_POINTS) return "ahead";
  return "well-ahead";
}

/** Why a window has no pace. Machine-readable so the UI can say which. */
export type UsagePaceUnavailableReason =
  /** The provider stated no reset instant, so the window has no end. */
  | "no-reset"
  /** The provider stated no window length, so the window has no start. */
  | "no-duration"
  /** The window rolls continuously; elapsed fraction is meaningless. */
  | "rolling-window"
  /** The schedule counts no elapsed time in this window yet. */
  | "no-scheduled-time";

export interface UsagePaceUnavailable {
  readonly available: false;
  readonly reason: UsagePaceUnavailableReason;
}

export interface UsagePaceAvailable {
  readonly available: true;
  /** Derived as `resetsAt - durationMinutes`. */
  readonly windowStartMs: number;
  /** The provider's stated reset instant. */
  readonly windowEndMs: number;
  readonly scheduledTotalMinutes: number;
  readonly scheduledElapsedMinutes: number;
  /** `scheduledElapsed / scheduledTotal`, clamped to 0–1. */
  readonly elapsedFraction: number;
  /** The provider's figure, clamped to the contract's 0–100 range. */
  readonly usedPercent: number;
  /** What an even spend would have reached by now. */
  readonly expectedPercent: number;
  /** `usedPercent - expectedPercent`. Positive means spending fast. */
  readonly deltaPoints: number;
  /**
   * Where this rate lands at the reset. Deliberately not clamped: a value
   * over 100 is the whole point, and means the window runs out early.
   */
  readonly projectedFinalPercent: number;
  /**
   * When this rate reaches 100%, when that falls inside the window.
   * Undefined when the window resets before the rate would exhaust it.
   */
  readonly projectedCapAtMs: number | undefined;
  readonly verdict: UsagePaceVerdict;
}

export type UsagePace = UsagePaceAvailable | UsagePaceUnavailable;

export interface UsagePaceInput {
  readonly usedPercent: number;
  readonly resetsAtMs: number | undefined;
  readonly durationMinutes: number | undefined;
  /** Absent or `"unknown"` is treated as fixed; only `"rolling"` suppresses. */
  readonly cycleKind?: QuotaWindowCycleKind | undefined;
  /** The snapshot's own observation instant. See the module note. */
  readonly nowMs: number;
  readonly schedule: UsagePaceSchedule;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * Pace for one window, or a reason there is none.
 *
 * The unavailable cases are reported rather than defaulted because the honest
 * rendering of "we cannot tell" is "unknown", never a zero that reads as
 * "nothing spent" or a hundred that reads as "exhausted".
 */
export function deriveUsagePace(input: UsagePaceInput): UsagePace {
  // Checked first and independently of the rest: a rolling window usually
  // reports a perfectly good reset and duration, and would otherwise produce
  // a confident, meaningless "0% elapsed".
  if (input.cycleKind === "rolling") return { available: false, reason: "rolling-window" };

  const resetsAtMs = input.resetsAtMs;
  if (resetsAtMs === undefined || !Number.isFinite(resetsAtMs)) {
    return { available: false, reason: "no-reset" };
  }
  const durationMinutes = input.durationMinutes;
  if (durationMinutes === undefined || !Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    return { available: false, reason: "no-duration" };
  }
  const windowStartMs = quotaWindowStartMs(resetsAtMs, durationMinutes * MINUTE_MS);
  if (windowStartMs === undefined) return { available: false, reason: "no-duration" };

  const scheduledTotalMinutes = scheduledMinutesBetween(windowStartMs, resetsAtMs, input.schedule);
  // A snapshot taken outside its own window — a stale reading whose reset has
  // since passed, or a clock skew — is pinned to the window rather than
  // allowed to report a fraction outside 0–1.
  const boundedNowMs = Math.min(Math.max(input.nowMs, windowStartMs), resetsAtMs);
  const scheduledElapsedMinutes = scheduledMinutesBetween(
    windowStartMs,
    boundedNowMs,
    input.schedule,
  );
  // Two genuinely different situations share this reason, and both mean the
  // same thing to a reader: the schedule has counted nothing yet, so there is
  // no budget to be ahead or behind of. Either the whole window falls outside
  // the schedule (a five-hour window over a Sunday, with workdays only), or
  // none of it has been reached yet (a window that opened before this
  // morning's start hour).
  if (scheduledTotalMinutes <= 0 || scheduledElapsedMinutes <= 0) {
    return { available: false, reason: "no-scheduled-time" };
  }

  const elapsedFraction = Math.min(1, scheduledElapsedMinutes / scheduledTotalMinutes);
  const usedPercent = clampPercent(input.usedPercent);
  const expectedPercent = elapsedFraction * 100;
  const deltaPoints = usedPercent - expectedPercent;
  const projectedFinalPercent = usedPercent / elapsedFraction;
  const projectedCapAtMs =
    usedPercent > 0 && projectedFinalPercent > 100
      ? instantAfterScheduledMinutes(
          windowStartMs,
          scheduledElapsedMinutes * (100 / usedPercent),
          input.schedule,
        )
      : undefined;

  return {
    available: true,
    windowStartMs,
    windowEndMs: resetsAtMs,
    scheduledTotalMinutes,
    scheduledElapsedMinutes,
    elapsedFraction,
    usedPercent,
    expectedPercent,
    deltaPoints,
    projectedFinalPercent,
    projectedCapAtMs,
    verdict: usagePaceVerdict(deltaPoints),
  };
}

/**
 * One allowance window as pace needs to see it.
 *
 * Structural for the same reason as `UsagePaceSchedule`;
 * `ServerProviderQuotaWindow` satisfies it as-is.
 */
export interface UsagePaceWindow {
  readonly usedPercent: number;
  readonly durationMinutes?: number | undefined;
  readonly resetsAt?: string | undefined;
  readonly cycleKind?: QuotaWindowCycleKind | undefined;
}

function parseMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Pace for one wire-shaped window, judged at the snapshot's `observedAt`.
 *
 * This is the entry point every surface should use; it is the only place that
 * parses the contract's ISO instants, so no consumer has to remember that
 * `observedAt` and not `Date.now()` is the right "now".
 */
export function deriveQuotaWindowPace(
  window: UsagePaceWindow,
  observedAt: string,
  schedule: UsagePaceSchedule,
): UsagePace {
  const nowMs = parseMs(observedAt);
  return deriveUsagePace({
    usedPercent: window.usedPercent,
    resetsAtMs: parseMs(window.resetsAt),
    durationMinutes: window.durationMinutes,
    cycleKind: window.cycleKind,
    nowMs: nowMs ?? Number.NaN,
    schedule,
  });
}
