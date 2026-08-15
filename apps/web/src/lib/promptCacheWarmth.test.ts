import { ProviderInstanceId, type PromptCacheWarmth } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  derivePromptCacheWarmthState,
  formatPromptCacheDuration,
  promptCacheSidebarStyle,
} from "./promptCacheWarmth";

const warmth: PromptCacheWarmth = {
  provider: "claude",
  providerInstanceId: ProviderInstanceId.make("claude"),
  model: "claude-fable-5",
  lastCacheActivityAt: "2026-08-15T12:00:00.000Z",
  cacheableTokens: 800_000,
  estimatedTtlMs: 5 * 60_000,
  observedWarmThroughMs: null,
  observedColdFromMs: null,
  hitSampleCount: 0,
  missSampleCount: 0,
  basis: "default",
  confidence: "low",
  profileUpdatedAt: "2026-08-15T12:00:00.000Z",
  lastOutcome: null,
  lastCachedInputTokens: 0,
  lastCacheWriteInputTokens: 800_000,
};

describe("derivePromptCacheWarmthState", () => {
  it("moves from warm through lukewarm to cold", () => {
    expect(
      derivePromptCacheWarmthState(warmth, Date.parse("2026-08-15T12:01:00Z")).temperature,
    ).toBe("warm");
    expect(
      derivePromptCacheWarmthState(warmth, Date.parse("2026-08-15T12:03:00Z")).temperature,
    ).toBe("lukewarm");
    const cold = derivePromptCacheWarmthState(warmth, Date.parse("2026-08-15T12:06:00Z"));
    expect(cold.temperature).toBe("cold");
    expect(cold.remainingMs).toBe(0);
    expect(cold.likelyCachedFraction).toBe(0);
  });
});

describe("promptCacheSidebarStyle", () => {
  it("recedes and dims with remaining warmth and vanishes at expiry", () => {
    const fresh = promptCacheSidebarStyle(
      derivePromptCacheWarmthState(warmth, Date.parse("2026-08-15T12:00:15Z")),
    );
    const midlife = promptCacheSidebarStyle(
      derivePromptCacheWarmthState(warmth, Date.parse("2026-08-15T12:02:00Z")),
    );
    expect(fresh?.backgroundImage).toContain("ellipse 97%");
    expect(midlife?.backgroundImage).toContain("ellipse 64%");
    // A fresh bloom is brighter than a mid-life one, and both stay ember-colored.
    expect(fresh?.backgroundImage).toContain("57%, transparent)");
    expect(midlife?.backgroundImage).toContain("39%, transparent)");
    expect(fresh?.backgroundImage).toContain("hsl(24 90% 56%)");
  });

  it("renders nothing once the estimate has expired", () => {
    expect(
      promptCacheSidebarStyle(
        derivePromptCacheWarmthState(warmth, Date.parse("2026-08-15T12:06:00Z")),
      ),
    ).toBeUndefined();
    expect(promptCacheSidebarStyle(null)).toBeUndefined();
  });
});

describe("formatPromptCacheDuration", () => {
  it("keeps useful second precision in the hover card", () => {
    expect(formatPromptCacheDuration(150_000)).toBe("2m 30s");
  });
});
