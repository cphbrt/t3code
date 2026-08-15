import { describe, expect, it } from "vite-plus/test";

import {
  CLAUDE_PROMPT_CACHE_TTL_MS,
  DEFAULT_PROMPT_CACHE_TTL_MS,
  defaultPromptCacheTtlMs,
  estimatePromptCacheTtl,
  type PromptCacheObservation,
} from "./promptCache.ts";

function observations(
  outcome: PromptCacheObservation["outcome"],
  gapsInMinutes: ReadonlyArray<number>,
): ReadonlyArray<PromptCacheObservation> {
  return gapsInMinutes.map((minutes, index) => ({
    outcome,
    idleGapMs: minutes * 60_000,
    observedAt: `2026-08-15T12:${String(index).padStart(2, "0")}:00.000Z`,
  }));
}

describe("defaultPromptCacheTtlMs", () => {
  it("gives Claude the documented one-hour session cache and everyone else five minutes", () => {
    expect(defaultPromptCacheTtlMs("claudeAgent")).toBe(CLAUDE_PROMPT_CACHE_TTL_MS);
    expect(defaultPromptCacheTtlMs("claudeAgent")).toBe(60 * 60_000);
    expect(defaultPromptCacheTtlMs("claude")).toBe(CLAUDE_PROMPT_CACHE_TTL_MS);
    expect(defaultPromptCacheTtlMs("codex")).toBe(DEFAULT_PROMPT_CACHE_TTL_MS);
    expect(defaultPromptCacheTtlMs("codex")).toBe(5 * 60_000);
    expect(defaultPromptCacheTtlMs("someFutureDriver")).toBe(DEFAULT_PROMPT_CACHE_TTL_MS);
    expect(defaultPromptCacheTtlMs(null)).toBe(DEFAULT_PROMPT_CACHE_TTL_MS);
    expect(defaultPromptCacheTtlMs(undefined)).toBe(DEFAULT_PROMPT_CACHE_TTL_MS);
  });
});

describe("estimatePromptCacheTtl", () => {
  it("starts from the provider's documented fallback", () => {
    expect(estimatePromptCacheTtl([], defaultPromptCacheTtlMs("codex"))).toEqual({
      estimatedTtlMs: DEFAULT_PROMPT_CACHE_TTL_MS,
      observedWarmThroughMs: null,
      observedColdFromMs: null,
      hitSampleCount: 0,
      missSampleCount: 0,
      basis: "default",
      confidence: "low",
    });
    expect(estimatePromptCacheTtl([], defaultPromptCacheTtlMs("claudeAgent")).estimatedTtlMs).toBe(
      CLAUDE_PROMPT_CACHE_TTL_MS,
    );
  });

  it("learns conservatively between repeated hits and misses", () => {
    const estimate = estimatePromptCacheTtl(
      [
        ...observations("hit", [3, 3.5, 4, 4, 4.25, 4.5, 4.5, 4.75, 4.75, 5]),
        ...observations("miss", [7, 7.5, 8, 8, 8.5, 9, 9, 10, 11, 15]),
      ],
      defaultPromptCacheTtlMs("codex"),
    );

    expect(estimate.basis).toBe("learned");
    expect(estimate.confidence).toBe("high");
    // p95 of ten hit gaps is the ninth-smallest, not the seventh a p75 would take.
    expect(estimate.observedWarmThroughMs).toBe(4.75 * 60_000);
    expect(estimate.observedColdFromMs).toBe(8 * 60_000);
    expect(estimate.estimatedTtlMs).toBe(6.375 * 60_000);
  });

  it("credits long-gap warm evidence at p95 while ignoring a lone mislabeled hit", () => {
    const gaps = [4, 4, 4, 4, 5, 5, 5, 6, 6, 6, 7, 7, 7, 8, 8, 9, 9, 10, 11, 90];
    const warmThrough = estimatePromptCacheTtl(
      observations("hit", gaps),
      defaultPromptCacheTtlMs("codex"),
    ).observedWarmThroughMs;

    // Index floor(19 * 0.95) = 18 -> the 19th-smallest gap (11m). The 90m outlier
    // is excluded, but so is nothing else: a p75 would have stopped at 8m.
    expect(warmThrough).toBe(11 * 60_000);
  });

  it("does not let a few long-lived hits immediately overrule the codex fallback", () => {
    const estimate = estimatePromptCacheTtl(
      observations("hit", [12, 15, 18]),
      defaultPromptCacheTtlMs("codex"),
    );

    expect(estimate.basis).toBe("learning");
    expect(estimate.confidence).toBe("low");
    expect(estimate.observedWarmThroughMs).toBe(15 * 60_000);
    // Only 3 of the 20 samples needed for full confidence, so the estimate sits
    // 15% of the way from the five-minute prior toward the 15m warm evidence.
    expect(estimate.estimatedTtlMs).toBe(6.5 * 60_000);
  });

  it("keeps Claude at an hour when only sub-hour hits have been observed", () => {
    const estimate = estimatePromptCacheTtl(
      observations("hit", [2, 5, 9, 12, 16]),
      defaultPromptCacheTtlMs("claudeAgent"),
    );

    // Hits-only stays max(fallback, p95 of hits): warm evidence can only ever
    // raise the estimate, and nothing here reaches the one-hour prior.
    expect(estimate.observedWarmThroughMs).toBe(12 * 60_000);
    expect(estimate.observedColdFromMs).toBeNull();
    expect(estimate.estimatedTtlMs).toBe(CLAUDE_PROMPT_CACHE_TTL_MS);
  });

  it("lets Claude misses pull the estimate back toward a five-minute cache", () => {
    const estimate = estimatePromptCacheTtl(
      [
        ...observations("hit", [1, 2, 2.5, 3, 3.5, 4, 4, 4.5, 4.5, 5]),
        ...observations("miss", [6, 6.5, 7, 7, 8, 8, 9, 12, 20, 40]),
      ],
      defaultPromptCacheTtlMs("claudeAgent"),
    );

    expect(estimate.basis).toBe("learned");
    expect(estimate.observedWarmThroughMs).toBe(4.5 * 60_000);
    expect(estimate.observedColdFromMs).toBe(7 * 60_000);
    expect(estimate.estimatedTtlMs).toBe(5.75 * 60_000);
  });
});
