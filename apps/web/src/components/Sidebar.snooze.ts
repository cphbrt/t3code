import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  resolveSnoozePresets as resolveSharedSnoozePresets,
  snoozeWakeLabel,
  type SnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";

import { formatShortTimestamp, parseTimestampDate } from "../timestampFormat";

export { snoozeWakeLabel, type SnoozePreset };

const DAY_MS = 24 * 60 * 60 * 1_000;

interface ThreadProviderUsageTarget {
  readonly modelSelection: { readonly instanceId: string };
  readonly session: { readonly providerInstanceId?: string | undefined } | null;
}

interface ProviderUsageSnapshot {
  readonly instanceId: string;
  readonly usageLimit?: { readonly resetsAt: string } | undefined;
}

function timeOfDayLabel(date: Date, timestampFormat: TimestampFormat): string {
  return formatShortTimestamp(date.toISOString(), timestampFormat);
}

export function resolveSnoozePresets(
  now: Date,
  timestampFormat: TimestampFormat,
  options: { readonly usageLimitResetsAt?: string | null } = {},
): ReadonlyArray<SnoozePreset> {
  const presets = resolveSharedSnoozePresets(now).map((preset) => {
    const wake = parseTimestampDate(preset.snoozedUntil);
    if (wake === null) return preset;
    const time = timeOfDayLabel(wake, timestampFormat);
    return {
      ...preset,
      whenLabel:
        preset.id === "next-week"
          ? `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`
          : time,
    };
  });
  const usageLimitReset = parseTimestampDate(options.usageLimitResetsAt ?? "");
  if (usageLimitReset === null || usageLimitReset.getTime() <= now.getTime()) return presets;

  return [
    {
      id: "usage-limit-reset",
      label: "Until usage resets",
      whenLabel: snoozeWakeDescription(usageLimitReset.toISOString(), now, timestampFormat),
      snoozedUntil: usageLimitReset.toISOString(),
    },
    ...presets,
  ];
}

/**
 * Resolve the explicit usage reset for the provider instance currently
 * running a thread. Session routing wins over the saved model selection,
 * matching the provider countdown shown on the same row.
 */
export function resolveThreadUsageLimitResetAt(
  thread: ThreadProviderUsageTarget,
  providers: ReadonlyArray<ProviderUsageSnapshot>,
  now: Date,
): string | null {
  const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  const resetsAt = providers.find((provider) => provider.instanceId === instanceId)?.usageLimit
    ?.resetsAt;
  if (resetsAt === undefined) return null;
  const reset = parseTimestampDate(resetsAt);
  return reset !== null && reset.getTime() > now.getTime() ? reset.toISOString() : null;
}

/**
 * Human wake time for menus and toasts: "tomorrow 9:00", "Mon 9:00",
 * "17:30" (today).
 */
export function snoozeWakeDescription(
  snoozedUntil: string,
  now: Date,
  timestampFormat: TimestampFormat,
): string {
  const wake = parseTimestampDate(snoozedUntil);
  if (wake === null) return "";
  const time = timeOfDayLabel(wake, timestampFormat);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayDelta = Math.floor((wake.getTime() - startOfToday.getTime()) / DAY_MS);
  if (dayDelta === 0) return time;
  if (dayDelta === 1) return `tomorrow ${time}`;
  const weekday = wake.toLocaleDateString(undefined, { weekday: "short" });
  if (dayDelta < 7) return `${weekday} ${time}`;
  const date = wake.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${date}, ${time}`;
}
