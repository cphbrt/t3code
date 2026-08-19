import type { ServerProviderQuota, ServerProviderQuotaWindow } from "@t3tools/contracts";

import type { UsagePaceVerdict } from "./lib/usagePace";

export type ProviderQuotaSeverity = "normal" | "warning" | "critical";

export function providerQuotaSeverity(usedPercent: number): ProviderQuotaSeverity {
  if (usedPercent >= 95) return "critical";
  if (usedPercent >= 80) return "warning";
  return "normal";
}

const SEVERITY_RANK: Readonly<Record<ProviderQuotaSeverity, number>> = {
  normal: 0,
  warning: 1,
  critical: 2,
};

/**
 * Where a pace verdict lands on the same alarm scale as an absolute fill
 * level, so the two can be compared rather than fighting over one colour.
 *
 * `behind` is *good* — spending slower than the window refills — so it sits at
 * `normal` alongside `on-pace`. The distinction between the two is a matter of
 * reassurance, not alarm, and is drawn in `usagePacePresentation` rather than
 * here.
 */
function usagePaceSeverity(verdict: UsagePaceVerdict | undefined): ProviderQuotaSeverity {
  switch (verdict) {
    case "well-ahead":
      return "critical";
    case "ahead":
      return "warning";
    case "behind":
    case "on-pace":
    case undefined:
      return "normal";
  }
}

/**
 * The alarm level for a window, given both how full it is and how fast it is
 * filling. The worse of the two always wins.
 *
 * Neither input can excuse the other. A window at 97% is not calm because it
 * got there slowly, and a window at 30% that is sprinting is not calm because
 * it still has room. Taking the maximum is what stops pace from ever making a
 * surface *less* alarming than it is today: the floor is the fill severity
 * this product already shipped, and pace can only raise it.
 *
 * Pass `undefined` for `verdict` when pace could not be derived; unknown pace
 * contributes nothing and the fill level decides alone.
 */
export function combinedQuotaSeverity(
  usedPercent: number,
  verdict: UsagePaceVerdict | undefined,
): ProviderQuotaSeverity {
  const fill = providerQuotaSeverity(usedPercent);
  const pace = usagePaceSeverity(verdict);
  return SEVERITY_RANK[pace] > SEVERITY_RANK[fill] ? pace : fill;
}

export function providerQuotaWindowLabel(window: ServerProviderQuotaWindow): string {
  return window.scopeLabel ? `${window.scopeLabel} ${window.label}` : window.label;
}

export function providerQuotaResetCountdown(
  resetsAt: string | undefined,
  nowMinute: string,
): string | null {
  if (!resetsAt) return null;
  const resetsAtMs = Date.parse(resetsAt);
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);
  if (!Number.isFinite(resetsAtMs) || !Number.isFinite(nowMs) || resetsAtMs <= nowMs) {
    return null;
  }

  const minutes = Math.max(1, Math.ceil((resetsAtMs - nowMs) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
}

export function primaryProviderQuotaWindow(
  quota: ServerProviderQuota | undefined,
): ServerProviderQuotaWindow | null {
  if (!quota || quota.windows.length === 0) return null;
  return (
    quota.windows.find((window) => window.durationMinutes === 300 && !window.scopeLabel) ??
    quota.windows.find((window) => !window.scopeLabel) ??
    quota.windows.toSorted((left, right) => right.usedPercent - left.usedPercent)[0] ??
    null
  );
}

export function providerQuotaPercentLabel(usedPercent: number): string {
  return `${Math.round(usedPercent)}%`;
}

export function providerQuotaFreshness(
  observedAt: string,
  nowMinute: string,
): "fresh" | "stale" | "unknown" {
  const observedAtMs = Date.parse(observedAt);
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(nowMs)) return "unknown";
  return nowMs - observedAtMs > 20 * 60_000 ? "stale" : "fresh";
}
