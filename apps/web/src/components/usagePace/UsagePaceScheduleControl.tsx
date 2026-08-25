import {
  MAX_USAGE_PACE_END_HOUR,
  MAX_USAGE_PACE_START_HOUR,
  MIN_USAGE_PACE_END_HOUR,
  MIN_USAGE_PACE_START_HOUR,
  type TimestampFormat,
  type UsagePaceSchedule,
} from "@t3tools/contracts/settings";
import { useId, useMemo, type CSSProperties } from "react";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { useUsagePaceSchedule } from "../../hooks/useProviderQuotaWindows";
import { cn } from "../../lib/utils";
import { formatShortTimestamp } from "../../timestampFormat";
import { Switch } from "../ui/switch";
import {
  coerceScheduleHours,
  describeUsagePaceSchedule,
  formatScheduledHours,
  scheduleWeekStartMs,
  SHORT_WINDOW_HOURS,
} from "./usagePaceSchedule.logic";

const HOUR_BOUNDS = {
  minStartHour: MIN_USAGE_PACE_START_HOUR,
  maxStartHour: MAX_USAGE_PACE_START_HOUR,
  minEndHour: MIN_USAGE_PACE_END_HOUR,
  maxEndHour: MAX_USAGE_PACE_END_HOUR,
} as const;

/**
 * Formats a schedule bound as a wall-clock time in the user's chosen clock.
 *
 * Routed through the app's own timestamp formatter rather than a local
 * `Intl.DateTimeFormat`, so these labels honour the 12/24-hour preference and
 * the host locale exactly as every other time in the UI does.
 *
 * Hour 24 is the same instant as hour 0 and is only ever the *end* of a day,
 * where the surrounding label already says so.
 */
function useHourFormatter(): (hour: number) => string {
  const timestampFormat = useClientSettings(selectTimestampFormat);
  return useMemo(() => {
    // Any date works; only the time of day is rendered. A midweek day avoids a
    // daylight-saving Sunday shifting the label by an hour.
    return (value: number) =>
      formatShortTimestamp(new Date(2026, 0, 7, value % 24).toISOString(), timestampFormat);
  }, [timestampFormat]);
}

function selectTimestampFormat(settings: { readonly timestampFormat: TimestampFormat }) {
  return settings.timestampFormat;
}

/**
 * Which hours count toward usage pace.
 *
 * Mounted both on the Usage page — where the numbers it explains are on screen
 * — and in Settings, where every other preference lives. It owns its own
 * reads and writes so the two mount sites are a single tag each and cannot
 * drift apart.
 *
 * The two switches are shown as two switches rather than collapsed into a
 * three-way choice because all four combinations are real, and the composition
 * is spelled out in a sentence underneath so the user never has to work out
 * what "weekdays only" plus "set hours" adds up to.
 *
 * The consequence line is the point of the whole control: a weekly allowance
 * under weekdays 9-to-6 holds 45 of its 168 hours, and a five-hour allowance
 * may hold none of its five. Those are the numbers that make the setting
 * comprehensible, and they are measured with the same function pace uses.
 */
export function UsagePaceScheduleControl({ className }: { readonly className?: string }) {
  const schedule = useUsagePaceSchedule();
  const updateSettings = useUpdateClientSettings();
  const formatHour = useHourFormatter();
  const startId = useId();
  const endId = useId();

  // Anchored once per mount. The figures describe a representative week, so a
  // page left open across a Monday has nothing to recompute, and the control
  // subscribes to no clock at all.
  const weekStartMs = useMemo(() => scheduleWeekStartMs(Date.now()), []);
  const summary = useMemo(
    () => describeUsagePaceSchedule(schedule, weekStartMs),
    [schedule, weekStartMs],
  );

  // Whole-object replacement: the contract stores the schedule as one value
  // because a partial patch could leave the hours describing a range nobody
  // chose.
  const applySchedule = (next: UsagePaceSchedule) => {
    updateSettings({ usagePaceSchedule: next });
  };

  const setHour = (moved: "start" | "end", value: number) => {
    if (!Number.isInteger(value)) return;
    const hours = coerceScheduleHours(
      moved === "start" ? value : schedule.startHour,
      moved === "end" ? value : schedule.endHour,
      moved,
      HOUR_BOUNDS,
    );
    if (hours.startHour === schedule.startHour && hours.endHour === schedule.endHour) return;
    applySchedule({ ...schedule, ...hours });
  };

  const dayPart = schedule.workdaysOnly ? "Monday to Friday" : "every day";
  const hourPart = schedule.workHoursOnly
    ? `${formatHour(schedule.startHour)} to ${formatHour(schedule.endHour)}`
    : "every hour";
  const shortWindowSentence =
    summary.shortWindowMinHours === summary.shortWindowMaxHours
      ? `every hour of a ${SHORT_WINDOW_HOURS}-hour window`
      : `between ${formatScheduledHours(summary.shortWindowMinHours)} and ${formatScheduledHours(
          summary.shortWindowMaxHours,
        )} hours of a ${SHORT_WINDOW_HOURS}-hour window, depending on when it opens`;

  return (
    <div className={cn("flex w-full flex-col gap-3", className)}>
      <div className="flex flex-col gap-2">
        <label className="flex items-center justify-between gap-4 text-sm text-foreground">
          <span>Weekdays only</span>
          <Switch
            checked={schedule.workdaysOnly}
            onCheckedChange={(checked) =>
              applySchedule({ ...schedule, workdaysOnly: Boolean(checked) })
            }
            aria-label="Count weekdays only"
          />
        </label>
        <label className="flex items-center justify-between gap-4 text-sm text-foreground">
          <span>Set hours</span>
          <Switch
            checked={schedule.workHoursOnly}
            onCheckedChange={(checked) =>
              applySchedule({ ...schedule, workHoursOnly: Boolean(checked) })
            }
            aria-label="Count set hours only"
          />
        </label>
      </div>

      {schedule.workHoursOnly ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card/40 px-3 py-2.5">
          <ScheduleHourRange
            startId={startId}
            endId={endId}
            startHour={schedule.startHour}
            endHour={schedule.endHour}
            startDisplay={formatHour(schedule.startHour)}
            endDisplay={formatHour(schedule.endHour)}
            onChange={setHour}
          />
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Counting {hourPart}, {dayPart}.{" "}
        {summary.countsEveryHour ? (
          "Pace is measured against plain wall-clock time."
        ) : (
          <>
            That is {formatScheduledHours(summary.weeklyScheduledHours)} of{" "}
            {summary.weeklyTotalHours} hours in a week, and {shortWindowSentence}.
          </>
        )}
      </p>
    </div>
  );
}

/** The day the range is drawn against, and the handle width the track is inset by. */
const DAY_HOURS = 24;
const HANDLE_REM = 1;

/** Position of an hour along the drawn track, in the handles' own travel. */
function hourOffset(hour: number): string {
  return `calc(${HANDLE_REM / 2}rem + (100% - ${HANDLE_REM}rem) * ${hour / DAY_HOURS})`;
}

/** Width of a span of hours in that same geometry. */
function hourSpan(hours: number): string {
  return `calc((100% - ${HANDLE_REM}rem) * ${hours / DAY_HOURS})`;
}

/**
 * Geometry for one overlaid input.
 *
 * Each input keeps its own min/max, so its handle travels across only part of
 * the day. Sizing the input to exactly that part — plus one handle width, since
 * a native handle's centre stops half a handle inside either end — puts the
 * handle where the drawn track says the hour is.
 */
function rangeInputStyle(min: number, max: number): CSSProperties {
  return {
    left: hourSpan(min),
    width: `calc(${HANDLE_REM}rem + ${hourSpan(max - min)})`,
  };
}

/**
 * The counted day as one track with a handle at each end.
 *
 * A barbell rather than two stacked sliders because the pair is a single range;
 * separate tracks stated each bound but left the shape of the day to be
 * assembled by eye. The tick labels beneath are the day itself, so the same
 * track carries both the values and their context.
 *
 * The handles are two ordinary range inputs stacked on the drawn track, so
 * focus, arrow keys, Home/End and Page keys are the browser's own and match
 * every other slider in Settings. Crossing is prevented by the shared
 * `coerceScheduleHours`, which pushes the other bound rather than swapping.
 *
 * Static: it repaints only when a bound changes.
 */
function ScheduleHourRange({
  startId,
  endId,
  startHour,
  endHour,
  startDisplay,
  endDisplay,
  onChange,
}: {
  readonly startId: string;
  readonly endId: string;
  readonly startHour: number;
  readonly endHour: number;
  readonly startDisplay: string;
  readonly endDisplay: string;
  readonly onChange: (moved: "start" | "end", value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-xs text-muted-foreground" htmlFor={startId}>
          Day starts
          <span className="rounded-md bg-muted px-2 py-1 font-mono text-xs font-medium text-foreground tabular-nums">
            {startDisplay}
          </span>
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground" htmlFor={endId}>
          <span className="rounded-md bg-muted px-2 py-1 font-mono text-xs font-medium text-foreground tabular-nums">
            {endDisplay}
          </span>
          Day ends
        </label>
      </div>

      <div className="relative h-6 w-full">
        <div
          className="absolute inset-x-2 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-muted"
          aria-hidden
        />
        <div
          className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-primary"
          style={{ left: hourOffset(startHour), width: hourSpan(endHour - startHour) }}
          aria-hidden
        />
        <input
          aria-label="Counted day starts"
          className="settings-slider settings-range-input"
          id={startId}
          max={MAX_USAGE_PACE_START_HOUR}
          min={MIN_USAGE_PACE_START_HOUR}
          onChange={(event) => onChange("start", Number(event.currentTarget.value))}
          step={1}
          style={rangeInputStyle(MIN_USAGE_PACE_START_HOUR, MAX_USAGE_PACE_START_HOUR)}
          type="range"
          value={startHour}
        />
        <input
          aria-label="Counted day ends"
          className="settings-slider settings-range-input"
          id={endId}
          max={MAX_USAGE_PACE_END_HOUR}
          min={MIN_USAGE_PACE_END_HOUR}
          onChange={(event) => onChange("end", Number(event.currentTarget.value))}
          step={1}
          style={rangeInputStyle(MIN_USAGE_PACE_END_HOUR, MAX_USAGE_PACE_END_HOUR)}
          type="range"
          value={endHour}
        />
      </div>

      <div
        className="flex justify-between px-2 text-[10px] text-muted-foreground tabular-nums"
        aria-hidden
      >
        <span>12a</span>
        <span>6a</span>
        <span>12p</span>
        <span>6p</span>
        <span>12a</span>
      </div>
    </div>
  );
}
