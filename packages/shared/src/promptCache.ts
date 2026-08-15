import type {
  PromptCacheEstimateBasis,
  PromptCacheEstimateConfidence,
  PromptCacheObservationOutcome,
} from "@t3tools/contracts";

/**
 * Prior used for providers whose cache lifetime we have no documented reason to
 * treat as longer. Codex and any unrecognized driver land here.
 */
export const DEFAULT_PROMPT_CACHE_TTL_MS = 5 * 60_000;

/**
 * Anthropic documents the Claude Code harness as holding its session prompt
 * cache for an hour, dropping back to five minutes only while an account is in
 * usage overage. Starting Claude threads at the documented hour is the honest
 * prior; if a particular account is actually being served the five-minute cache,
 * its misses pull the learned estimate back down on their own.
 */
export const CLAUDE_PROMPT_CACHE_TTL_MS = 60 * 60_000;

export const PROMPT_CACHE_OBSERVATIONS_PER_OUTCOME = 100;

const MIN_ESTIMATED_TTL_MS = 60_000;
const MAX_ESTIMATED_TTL_MS = 24 * 60 * 60_000;
const FULL_LEARNING_SAMPLE_COUNT = 20;

/**
 * Provider driver kinds served by Anthropic's Claude Code harness. `claudeAgent`
 * is the built-in driver kind; `claude` is accepted because older persisted rows
 * and provider-neutral usage vocabulary spell it that way. Matching is exact
 * rather than prefixed so a fork's unrelated `claude`-ish driver does not
 * silently inherit the hour.
 */
const CLAUDE_PROVIDER_KINDS: ReadonlySet<string> = new Set(["claudeagent", "claude"]);

/**
 * Prior cache lifetime for a provider driver kind, used until observations
 * accumulate. Call this at every site that needs a fallback TTL rather than
 * reaching for a constant, so provider-specific priors stay in one place.
 */
export function defaultPromptCacheTtlMs(provider: string | null | undefined): number {
  return provider !== null &&
    provider !== undefined &&
    CLAUDE_PROVIDER_KINDS.has(provider.trim().toLowerCase())
    ? CLAUDE_PROMPT_CACHE_TTL_MS
    : DEFAULT_PROMPT_CACHE_TTL_MS;
}

export interface PromptCacheObservation {
  readonly idleGapMs: number;
  readonly outcome: Extract<PromptCacheObservationOutcome, "hit" | "miss">;
  readonly observedAt: string;
}

export interface PromptCacheEstimate {
  readonly estimatedTtlMs: number;
  readonly observedWarmThroughMs: number | null;
  readonly observedColdFromMs: number | null;
  readonly hitSampleCount: number;
  readonly missSampleCount: number;
  readonly basis: PromptCacheEstimateBasis;
  readonly confidence: PromptCacheEstimateConfidence;
}

function percentile(values: ReadonlyArray<number>, quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * quantile)),
  );
  return sorted[index] ?? null;
}

function clampTtl(value: number): number {
  return Math.max(MIN_ESTIMATED_TTL_MS, Math.min(MAX_ESTIMATED_TTL_MS, Math.round(value)));
}

/**
 * Estimate the provider/model cache boundary from a bounded evidence window.
 *
 * Hits provide a lower bound and misses an upper bound. We fill the interval
 * between them and blend toward the provider's prior (see
 * `defaultPromptCacheTtlMs`) until twenty eligible samples have accumulated, so
 * the estimate deliberately learns slowly.
 *
 * The bounds are percentiles rather than extrema because both inputs are
 * approximate: hits and misses are classified heuristically from token counts,
 * and idle gaps are measured between activity timestamps, not against the
 * provider's own clock. The warm bound takes p95 of hit gaps — high enough to
 * actually credit long-gap warm evidence instead of discarding the top quarter
 * of it, while still shrugging off a handful of mislabeled observations. It is
 * not p100 because the asymmetry still holds: predicting warm when the cache is
 * cold costs a full uncached resubmit, while predicting cold early costs
 * nothing but a dimmer glow. The miss bound stays at p25 for the same reason.
 *
 * `fallbackTtlMs` is required so every caller has to decide which provider's
 * prior applies.
 */
export function estimatePromptCacheTtl(
  observations: ReadonlyArray<PromptCacheObservation>,
  fallbackTtlMs: number,
): PromptCacheEstimate {
  const recentHits = observations
    .filter((sample) => sample.outcome === "hit")
    .slice(0, PROMPT_CACHE_OBSERVATIONS_PER_OUTCOME);
  const recentMisses = observations
    .filter((sample) => sample.outcome === "miss")
    .slice(0, PROMPT_CACHE_OBSERVATIONS_PER_OUTCOME);
  const hitSampleCount = recentHits.length;
  const missSampleCount = recentMisses.length;
  const sampleCount = hitSampleCount + missSampleCount;
  const observedWarmThroughMs = percentile(
    recentHits.map((sample) => sample.idleGapMs),
    0.95,
  );
  const observedColdFromMs = percentile(
    recentMisses.map((sample) => sample.idleGapMs),
    0.25,
  );

  let evidenceEstimate = fallbackTtlMs;
  if (observedWarmThroughMs !== null && observedColdFromMs !== null) {
    evidenceEstimate =
      observedWarmThroughMs <= observedColdFromMs
        ? (observedWarmThroughMs + observedColdFromMs) / 2
        : (percentile(
            [...recentHits, ...recentMisses].map((sample) => sample.idleGapMs),
            0.5,
          ) ?? fallbackTtlMs);
  } else if (observedWarmThroughMs !== null) {
    evidenceEstimate = Math.max(fallbackTtlMs, observedWarmThroughMs);
  } else if (observedColdFromMs !== null) {
    evidenceEstimate = Math.min(fallbackTtlMs, observedColdFromMs);
  }

  const learningWeight = Math.min(1, sampleCount / FULL_LEARNING_SAMPLE_COUNT);
  const estimatedTtlMs = clampTtl(
    fallbackTtlMs * (1 - learningWeight) + evidenceEstimate * learningWeight,
  );
  const basis: PromptCacheEstimateBasis =
    sampleCount === 0 ? "default" : learningWeight < 1 ? "learning" : "learned";
  const confidence: PromptCacheEstimateConfidence =
    sampleCount >= FULL_LEARNING_SAMPLE_COUNT && hitSampleCount > 0 && missSampleCount > 0
      ? "high"
      : sampleCount >= 6
        ? "medium"
        : "low";

  return {
    estimatedTtlMs,
    observedWarmThroughMs,
    observedColdFromMs,
    hitSampleCount,
    missSampleCount,
    basis,
    confidence,
  };
}
