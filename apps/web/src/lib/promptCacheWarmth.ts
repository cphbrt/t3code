import type { PromptCacheWarmth } from "@t3tools/contracts";
import type { CSSProperties } from "react";

export type PromptCacheTemperature = "warm" | "lukewarm" | "cold";

export interface PromptCacheWarmthState {
  readonly ageMs: number;
  readonly remainingMs: number;
  readonly elapsedFraction: number;
  readonly likelyCachedFraction: number;
  readonly temperature: PromptCacheTemperature;
  readonly color: string;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function mix(left: number, right: number, amount: number): number {
  return left + (right - left) * amount;
}

function warmthColor(elapsedFraction: number): string {
  const progress = clamp01(elapsedFraction);
  if (progress <= 0.5) {
    const amount = progress * 2;
    return `hsl(${String(Math.round(mix(28, -42, amount)))} ${String(Math.round(mix(88, 72, amount)))}% ${String(Math.round(mix(58, 61, amount)))}%)`;
  }
  const amount = (progress - 0.5) * 2;
  // Hue wraps forward from orchid into indigo-blue rather than crossing green.
  return `hsl(${String(Math.round(mix(318, 218, amount)))} ${String(Math.round(mix(72, 76, amount)))}% ${String(Math.round(mix(61, 62, amount)))}%)`;
}

export function derivePromptCacheWarmthState(
  warmth: PromptCacheWarmth,
  nowMs: number,
): PromptCacheWarmthState {
  const anchorMs = Date.parse(warmth.lastCacheActivityAt);
  const ageMs = Number.isFinite(anchorMs) ? Math.max(0, nowMs - anchorMs) : warmth.estimatedTtlMs;
  const elapsedFraction = clamp01(ageMs / warmth.estimatedTtlMs);
  const remainingMs = Math.max(0, warmth.estimatedTtlMs - ageMs);
  return {
    ageMs,
    remainingMs,
    elapsedFraction,
    likelyCachedFraction: 1 - elapsedFraction,
    temperature: elapsedFraction >= 1 ? "cold" : elapsedFraction >= 0.5 ? "lukewarm" : "warm",
    color: warmthColor(elapsedFraction),
  };
}

// The sidebar bloom stays ember-colored; remaining likely warmth drives both its
// reach and its brightness, and an expired estimate renders the stock card again.
const SIDEBAR_BLOOM_COLOR = "hsl(24 90% 56%)";

export function promptCacheSidebarStyle(
  state: PromptCacheWarmthState | null,
): CSSProperties | undefined {
  if (state === null) return undefined;
  const remaining = state.likelyCachedFraction;
  if (remaining <= 0) return undefined;
  const reach = Math.round(6 + remaining * 96);
  const peak = Math.round((0.08 + remaining * 0.52) * 100);
  const body = Math.round(peak * 0.45);
  return {
    backgroundImage: `radial-gradient(ellipse ${String(reach)}% 170% at -6% 50%, color-mix(in oklab, ${SIDEBAR_BLOOM_COLOR} ${String(peak)}%, transparent), color-mix(in oklab, ${SIDEBAR_BLOOM_COLOR} ${String(body)}%, transparent) 52%, transparent 82%)`,
    transitionProperty: "background-image",
    transitionDuration: "900ms",
  };
}

export function formatPromptCacheDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  if (totalSeconds < 60) return `${String(totalSeconds)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60)
    return seconds === 0 ? `${String(minutes)}m` : `${String(minutes)}m ${String(seconds)}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0
    ? `${String(hours)}h`
    : `${String(hours)}h ${String(remainingMinutes)}m`;
}
