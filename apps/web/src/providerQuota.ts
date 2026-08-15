import type { ServerProviderQuota, ServerProviderQuotaWindow } from "@t3tools/contracts";

export type ProviderQuotaSeverity = "normal" | "warning" | "critical";

export function providerQuotaSeverity(usedPercent: number): ProviderQuotaSeverity {
  if (usedPercent >= 95) return "critical";
  if (usedPercent >= 80) return "warning";
  return "normal";
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
