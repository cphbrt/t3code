import { assert, it } from "@effect/vitest";

import type { ServerProviderQuota } from "@t3tools/contracts";

import {
  applyPreferredCodexDefaultModel,
  isLegacyCodexModel,
  mapCodexModelCapabilities,
  mergeCodexRollingQuotaUpdate,
  normalizeCodexProviderQuota,
  readCodexRollingRateLimits,
} from "./CodexProvider.ts";

it("normalizes primary, weekly, and named Codex quota windows", () => {
  const quota = normalizeCodexProviderQuota(
    {
      rateLimits: {
        planType: "pro",
        limitId: "codex",
        primary: { usedPercent: 64, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 31, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
        credits: { balance: "12", hasCredits: true, unlimited: false },
      },
      rateLimitsByLimitId: {
        reviews: {
          limitId: "reviews",
          limitName: "Code reviews",
          primary: { usedPercent: 82, windowDurationMins: 1_440, resetsAt: 1_800_100_000 },
        },
      },
    },
    "2026-08-15T12:00:00.000Z",
  );

  assert.deepStrictEqual(quota, {
    observedAt: "2026-08-15T12:00:00.000Z",
    planLabel: "ChatGPT Pro 20x",
    windows: [
      {
        id: "codex:primary",
        label: "5-hour",
        usedPercent: 64,
        durationMinutes: 300,
        resetsAt: "2027-01-15T08:00:00.000Z",
      },
      {
        id: "codex:secondary",
        label: "Weekly",
        usedPercent: 31,
        durationMinutes: 10_080,
        resetsAt: "2027-01-21T02:53:20.000Z",
      },
      {
        id: "reviews:primary",
        label: "1-day",
        usedPercent: 82,
        durationMinutes: 1_440,
        resetsAt: "2027-01-16T11:46:40.000Z",
        scopeLabel: "Code reviews",
      },
    ],
    credits: { balance: "12", hasCredits: true, unlimited: false },
  });
});

const PROBED_QUOTA: ServerProviderQuota = {
  observedAt: "2026-08-15T12:00:00.000Z",
  planLabel: "ChatGPT Pro 20x",
  windows: [
    {
      id: "codex:primary",
      label: "5-hour",
      usedPercent: 64,
      durationMinutes: 300,
      resetsAt: "2027-01-15T08:00:00.000Z",
      cycleKind: "fixed",
    },
    {
      id: "codex:secondary",
      label: "Weekly",
      usedPercent: 31,
      durationMinutes: 10_080,
      resetsAt: "2027-01-21T02:53:20.000Z",
    },
    {
      id: "reviews:primary",
      label: "1-day",
      usedPercent: 82,
      durationMinutes: 1_440,
      resetsAt: "2027-01-16T11:46:40.000Z",
      scopeLabel: "Code reviews",
    },
  ],
  credits: { balance: "12", hasCredits: true, unlimited: false },
};

it("folds a sparse rolling update into the last probed Codex quota", () => {
  const merged = mergeCodexRollingQuotaUpdate({
    previousQuota: PROBED_QUOTA,
    // Only `primary` and only `usedPercent`: everything else is absent and
    // must carry forward, including the model-scoped `reviews` window that
    // this notification cannot speak for at all.
    snapshot: { limitId: "codex", primary: { usedPercent: 71 } },
    observedAt: "2026-08-15T12:04:00.000Z",
  });

  assert.deepStrictEqual(merged, {
    observedAt: "2026-08-15T12:04:00.000Z",
    planLabel: "ChatGPT Pro 20x",
    windows: [
      {
        id: "codex:primary",
        label: "5-hour",
        usedPercent: 71,
        durationMinutes: 300,
        resetsAt: "2027-01-15T08:00:00.000Z",
        cycleKind: "fixed",
      },
      {
        id: "codex:secondary",
        label: "Weekly",
        usedPercent: 31,
        durationMinutes: 10_080,
        resetsAt: "2027-01-21T02:53:20.000Z",
      },
      {
        id: "reviews:primary",
        label: "1-day",
        usedPercent: 82,
        durationMinutes: 1_440,
        resetsAt: "2027-01-16T11:46:40.000Z",
        scopeLabel: "Code reviews",
      },
    ],
    credits: { balance: "12", hasCredits: true, unlimited: false },
  });
});

it("treats an explicitly null rolling window as unchanged rather than empty", () => {
  const merged = mergeCodexRollingQuotaUpdate({
    previousQuota: PROBED_QUOTA,
    snapshot: {
      limitId: "codex",
      primary: null,
      secondary: { usedPercent: 33 },
      // Nullable account metadata in a rolling update never clears a
      // previously observed value.
      planType: null,
      credits: null,
    },
    observedAt: "2026-08-15T12:04:00.000Z",
  });

  assert.deepStrictEqual(merged?.windows[0], PROBED_QUOTA.windows[0]);
  assert.deepStrictEqual(merged?.windows[1]?.usedPercent, 33);
  assert.deepStrictEqual(merged?.planLabel, "ChatGPT Pro 20x");
  assert.deepStrictEqual(merged?.credits, { balance: "12", hasCredits: true, unlimited: false });
});

it("leaves the probed quota untouched when a rolling update carries no observation", () => {
  const merged = mergeCodexRollingQuotaUpdate({
    previousQuota: PROBED_QUOTA,
    snapshot: { limitId: "premium", primary: null, rateLimitReachedType: null },
    observedAt: "2026-08-15T12:04:00.000Z",
  });

  // Same reference: the registry treats this as a no-op and never restamps
  // `observedAt` for a notification that reported nothing.
  assert.strictEqual(merged, PROBED_QUOTA);
});

it("targets the default limit's windows when a rolling update omits limitId", () => {
  const merged = mergeCodexRollingQuotaUpdate({
    previousQuota: PROBED_QUOTA,
    snapshot: { primary: { usedPercent: 71 } },
    observedAt: "2026-08-15T12:04:00.000Z",
  });

  assert.deepStrictEqual(
    merged?.windows.map((window) => [window.id, window.usedPercent]),
    [
      ["codex:primary", 71],
      ["codex:secondary", 31],
      ["reviews:primary", 82],
    ],
  );
});

it("adopts fresh duration and reset values a rolling update does supply", () => {
  const merged = mergeCodexRollingQuotaUpdate({
    previousQuota: PROBED_QUOTA,
    snapshot: {
      limitId: "codex",
      primary: { usedPercent: 2, windowDurationMins: 300, resetsAt: 1_800_018_000 },
      planType: "plus",
      credits: { balance: "9", hasCredits: true, unlimited: false },
    },
    observedAt: "2026-08-15T17:01:00.000Z",
  });

  assert.deepStrictEqual(merged?.windows[0], {
    id: "codex:primary",
    label: "5-hour",
    usedPercent: 2,
    durationMinutes: 300,
    resetsAt: "2027-01-15T13:00:00.000Z",
    cycleKind: "fixed",
  });
  assert.deepStrictEqual(merged?.planLabel, "ChatGPT Plus");
  assert.deepStrictEqual(merged?.credits, { balance: "9", hasCredits: true, unlimited: false });
});

it("reports unknown rather than zero when nothing has been probed yet", () => {
  assert.strictEqual(
    mergeCodexRollingQuotaUpdate({
      previousQuota: undefined,
      snapshot: { limitId: "premium", primary: null },
      observedAt: "2026-08-15T12:04:00.000Z",
    }),
    undefined,
  );
});

it("builds a first quota from a rolling update when no probe has landed", () => {
  const merged = mergeCodexRollingQuotaUpdate({
    previousQuota: undefined,
    snapshot: { primary: { usedPercent: 12, windowDurationMins: 300 } },
    observedAt: "2026-08-15T12:04:00.000Z",
  });

  assert.deepStrictEqual(merged, {
    observedAt: "2026-08-15T12:04:00.000Z",
    windows: [{ id: "default:primary", label: "5-hour", usedPercent: 12, durationMinutes: 300 }],
  });
});

it("reads a rate-limits notification payload back off the runtime event", () => {
  assert.deepStrictEqual(
    readCodexRollingRateLimits({ rateLimits: { limitId: "codex", primary: { usedPercent: 71 } } }),
    { limitId: "codex", primary: { usedPercent: 71 } },
  );
  assert.strictEqual(readCodexRollingRateLimits({ notARateLimit: true }), undefined);
});

it("keeps only the GPT-5.6 Codex family out of legacy models", () => {
  assert.deepStrictEqual(
    ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.4"].map((model) => [
      model,
      isLegacyCodexModel(model),
    ]),
    [
      ["gpt-5.6-luna", false],
      ["gpt-5.6-terra", false],
      ["gpt-5.6-sol", false],
      ["gpt-5.4", true],
    ],
  );
});

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("emits no agent profile select for Codex models", () => {
  // Agent profiles are a Claude-only capability (`claude --agent <name>`).
  // Codex builds its descriptors from its own model catalog and must never
  // grow an `agent` select, so a stray selection can only ever be an id the
  // Codex adapter does not read.
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [],
    supportedReasoningEfforts: [{ description: "Balanced", reasoningEffort: "medium" }],
  });

  assert.strictEqual(
    capabilities.optionDescriptors?.some((descriptor) => descriptor.id === "agent"),
    false,
  );
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});
