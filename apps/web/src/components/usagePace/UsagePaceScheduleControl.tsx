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
 * Style hooks the shared `.settings-slider` look reads (see `index.css`).
 *
 * Copied from the glass-opacity row rather than abstracted, because it is two
 * derived numbers and the alternative is a wrapper whose only job is to hide
 * them.
 */
function sliderStyle(value: number, min: number, max: number): CSSProperties {
  const ratio = max === min ? 0 : (value - min) / (max - min);
  return {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;
}

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
          <HourSlider
            id={startId}
            label="Day starts"
            ariaLabel="Counted day starts"
            value={schedule.startHour}
            min={MIN_USAGE_PACE_START_HOUR}
            max={MAX_USAGE_PACE_START_HOUR}
            display={formatHour(schedule.startHour)}
            onChange={(value) => setHour("start", value)}
          />
          <HourSlider
            id={endId}
            label="Day ends"
            ariaLabel="Counted day ends"
            value={schedule.endHour}
            min={MIN_USAGE_PACE_END_HOUR}
            max={MAX_USAGE_PACE_END_HOUR}
            display={formatHour(schedule.endHour)}
            onChange={(value) => setHour("end", value)}
          />
          <ScheduleDayStrip startHour={schedule.startHour} endHour={schedule.endHour} />
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

function HourSlider({
  id,
  label,
  ariaLabel,
  value,
  min,
  max,
  display,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly ariaLabel: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly display: string;
  readonly onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
      <output
        className="min-w-16 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium text-foreground tabular-nums"
        htmlFor={id}
      >
        {display}
      </output>
      <input
        aria-label={ariaLabel}
        className="settings-slider min-w-0 flex-1"
        id={id}
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        step={1}
        style={sliderStyle(value, min, max)}
        type="range"
        value={value}
      />
    </div>
  );
}

/**
 * A day drawn end to end with the counted stretch filled.
 *
 * Two sliders on separate tracks say what each bound is but not what the pair
 * means; this says it in one glance. Static — it repaints only when a bound
 * changes.
 */
function ScheduleDayStrip({
  startHour,
  endHour,
}: {
  readonly startHour: number;
  readonly endHour: number;
}) {
  return (
    <div className="flex flex-col gap-1 pt-0.5">
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
        <div
          className="absolute inset-y-0 bg-primary"
          style={{
            left: `${(startHour / 24) * 100}%`,
            width: `${((endHour - startHour) / 24) * 100}%`,
          }}
        />
      </div>
      <div
        className="flex justify-between text-[10px] text-muted-foreground tabular-nums"
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
