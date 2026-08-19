/**
 * What a counted-time schedule costs, stated in hours.
 *
 * The schedule switches on their own are easy to set and hard to understand:
 * "weekdays only, 9 to 6" is four words and a completely different budget from
 * the one the user had a minute ago. So the control reports the consequence
 * next to the choice — 45 of 168 hours a week, and a five-hour allowance that
 * may count anywhere from none to all of its hours.
 *
 * Every figure here is measured with `scheduledMinutesBetween`, the same
 * function pace itself uses, rather than recomputed from `endHour - startHour`.
 * Arithmetic would be a second implementation of the schedule and would drift:
 * it would miss daylight saving, and it would confidently report a number for
 * an incoherent range that the pace module deliberately treats as "no
 * restriction at all".
 *
 * The week is a *representative* one, anchored at a real local Monday so
 * weekday and DST behaviour are the real ones. It is not a claim about any
 * particular window the provider is reporting.
 *
 * Nothing here touches the DOM, React, or the clock; callers pass the anchor.
 *
 * @module usagePaceSchedule.logic
 */
import { scheduledMinutesBetween, type UsagePaceSchedule } from "../../lib/usagePace";

const HOUR_MS = 3_600_000;

/** Hours in a week. Also the length of every provider "weekly" allowance. */
export const WEEK_HOURS = 168;

/** The shortest allowance window either supported provider publishes. */
export const SHORT_WINDOW_HOURS = 5;

/**
 * Local midnight beginning the Monday at or before `atMs`.
 *
 * Anchored to a Monday so a workdays-only schedule reads as five counted days
 * followed by two empty ones rather than being split across the sample's edges,
 * and built with local-date arithmetic so the week is the viewer's own week.
 */
export function scheduleWeekStartMs(atMs: number): number {
  const at = new Date(atMs);
  // getDay() is 0 for Sunday; shift so Monday is 0.
  const sinceMonday = (at.getDay() + 6) % 7;
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() - sinceMonday).getTime();
}

export interface UsagePaceScheduleSummary {
  /** Counted hours in the representative week. */
  readonly weeklyScheduledHours: number;
  /** Hours in that week, counted or not. Always `WEEK_HOURS`. */
  readonly weeklyTotalHours: number;
  /** Length of the short window the min/max figures describe. */
  readonly shortWindowHours: number;
  /** Fewest counted hours a short window can hold, over every start hour in the week. */
  readonly shortWindowMinHours: number;
  /** Most counted hours a short window can hold. */
  readonly shortWindowMaxHours: number;
  /** True when every minute counts, i.e. the schedule imposes nothing. */
  readonly countsEveryHour: boolean;
}

/**
 * The schedule's consequences for the two window lengths users actually see.
 *
 * The short-window figures are a range rather than a single number because
 * where a five-hour window falls decides everything: under weekdays 9–6 one
 * that opens at 10am counts all five of its hours and one that opens at 7pm
 * counts none. A single average would hide exactly the fact worth knowing —
 * that some cycles are simply unmeasurable under this schedule, and pace stays
 * silent for them.
 *
 * The scan steps one wall-clock hour at a time across the week, which is 164
 * short spans; each is a two-day walk inside `scheduledMinutesBetween`. Cheap,
 * but memoize it rather than calling it per render.
 */
export function describeUsagePaceSchedule(
  schedule: UsagePaceSchedule,
  weekStartMs: number,
  shortWindowHours: number = SHORT_WINDOW_HOURS,
): UsagePaceScheduleSummary {
  const weeklyScheduledHours =
    scheduledMinutesBetween(weekStartMs, weekStartMs + WEEK_HOURS * HOUR_MS, schedule) / 60;

  let shortWindowMinHours = shortWindowHours;
  let shortWindowMaxHours = 0;
  for (let offset = 0; offset + shortWindowHours <= WEEK_HOURS; offset += 1) {
    const startMs = weekStartMs + offset * HOUR_MS;
    const hours =
      scheduledMinutesBetween(startMs, startMs + shortWindowHours * HOUR_MS, schedule) / 60;
    if (hours < shortWindowMinHours) shortWindowMinHours = hours;
    if (hours > shortWindowMaxHours) shortWindowMaxHours = hours;
  }

  return {
    weeklyScheduledHours,
    weeklyTotalHours: WEEK_HOURS,
    shortWindowHours,
    shortWindowMinHours,
    shortWindowMaxHours,
    countsEveryHour: !schedule.workdaysOnly && !schedule.workHoursOnly,
  };
}

/**
 * Rounds an hour count for display without ever rounding a nonzero figure to
 * zero, which would read as "this schedule counts nothing" when it counts a
 * little.
 */
export function formatScheduledHours(hours: number): string {
  if (hours === 0) return "0";
  const rounded = Math.round(hours * 10) / 10;
  if (rounded === 0) return "<0.1";
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Whether two schedules describe the same counted time. */
export function usagePaceSchedulesEqual(
  left: UsagePaceSchedule,
  right: UsagePaceSchedule,
): boolean {
  if (left.workdaysOnly !== right.workdaysOnly) return false;
  if (left.workHoursOnly !== right.workHoursOnly) return false;
  // The hours are only part of the schedule's meaning while they are switched
  // on, so a stored 9-to-6 with the switch off is the same schedule as a
  // stored 7-to-10 with the switch off.
  if (!left.workHoursOnly) return true;
  return left.startHour === right.startHour && left.endHour === right.endHour;
}

/**
 * Keeps a start/end pair coherent as one of them moves.
 *
 * `usagePace` reads a range whose end is at or before its start as *no*
 * restriction, silently. That is the right defensive default for a persisted
 * value, and a terrible thing to let a drag produce: the user would haul one
 * handle past the other and watch the whole restriction quietly evaporate. So
 * the control pushes the other bound instead of allowing the crossing, leaving
 * at least one counted hour in the day.
 */
export function coerceScheduleHours(
  startHour: number,
  endHour: number,
  moved: "start" | "end",
  bounds: {
    readonly minStartHour: number;
    readonly maxStartHour: number;
    readonly minEndHour: number;
    readonly maxEndHour: number;
  },
): { readonly startHour: number; readonly endHour: number } {
  const clampedStart = Math.min(
    Math.max(Math.trunc(startHour), bounds.minStartHour),
    bounds.maxStartHour,
  );
  const clampedEnd = Math.min(Math.max(Math.trunc(endHour), bounds.minEndHour), bounds.maxEndHour);
  if (clampedEnd > clampedStart) return { startHour: clampedStart, endHour: clampedEnd };

  return moved === "start"
    ? {
        startHour: Math.min(clampedStart, bounds.maxEndHour - 1),
        endHour: Math.min(clampedStart + 1, bounds.maxEndHour),
      }
    : {
        startHour: Math.max(clampedEnd - 1, bounds.minStartHour),
        endHour: Math.max(clampedEnd, bounds.minStartHour + 1),
      };
}
