import type { ServerProviderUsageLimit } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { getTimestampFormatOptions } from "./timestampFormat";

export interface ProviderUsageLimitCountdown {
  /** Exact minute-level label for roomy surfaces, e.g. `3h 14m`. */
  readonly exact: string;
  /** Coarse label for the provider-icon badge, e.g. `3h`. */
  readonly compact: string;
}

export function providerUsageLimitCountdown(
  usageLimit: ServerProviderUsageLimit | undefined,
  nowMinute: string,
): ProviderUsageLimitCountdown | null {
  if (!usageLimit) return null;

  const resetsAtMs = Date.parse(usageLimit.resetsAt);
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);
  if (!Number.isFinite(resetsAtMs) || !Number.isFinite(nowMs) || resetsAtMs <= nowMs) {
    return null;
  }

  const minutes = Math.max(1, Math.ceil((resetsAtMs - nowMs) / 60_000));
  if (minutes < 60) {
    return { exact: `${minutes}m`, compact: `${minutes}m` };
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return {
    exact: remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`,
    compact: `${hours}h`,
  };
}

export function providerUsageLimitBannerMessage(
  usageLimit: ServerProviderUsageLimit | undefined,
  nowMinute: string,
  timestampFormat: TimestampFormat,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string | null {
  if (providerUsageLimitCountdown(usageLimit, nowMinute) === null || !usageLimit) {
    return null;
  }

  const resetDate = new Date(usageLimit.resetsAt);
  if (Number.isNaN(resetDate.getTime())) return null;
  const resetTime = new Intl.DateTimeFormat(undefined, {
    ...getTimestampFormatOptions(timestampFormat, false),
    ...(timeZone ? { timeZone } : {}),
  }).format(resetDate);

  return `Usage limit reached · resets ${resetTime}${timeZone ? ` (${timeZone})` : ""}`;
}
