import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderQuota,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { providerQuotaRefreshMinIntervalMillis } from "../provider/providerQuota.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as ProviderUsageStatus from "./ProviderUsageStatus.ts";

const instanceId = ProviderInstanceId.make("claudeAgent");
const driver = ProviderDriverKind.make("claudeAgent");

// TestClock starts at the epoch, so fixture timestamps are expressed against
// it directly rather than against wall-clock time.
const isoAt = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

// Derived from the policy constant rather than restated, so retuning the
// interval retunes these tests instead of breaking them.
const WINDOW_MS = providerQuotaRefreshMinIntervalMillis();
const INSIDE_WINDOW_MS = WINDOW_MS - 1_000;
const PAST_WINDOW_MS = WINDOW_MS + 1_000;

const quotaAt = (millis: number, usedPercent: number): ServerProviderQuota => ({
  observedAt: isoAt(millis),
  planLabel: "Max",
  windows: [
    {
      id: "five_hour",
      label: "5-hour",
      usedPercent,
      resetsAt: isoAt(millis + 5 * 60 * 60 * 1_000),
    },
  ],
});

const providerWith = (quota: ServerProviderQuota | undefined): ServerProvider => ({
  instanceId,
  driver,
  status: "ready",
  enabled: true,
  installed: true,
  auth: { status: "authenticated" },
  checkedAt: isoAt(0),
  version: "2026.08.01",
  models: [],
  slashCommands: [],
  skills: [],
  ...(quota ? { quota } : {}),
});

interface Harness {
  readonly usage: ProviderUsageStatus.ProviderUsageStatusShape;
  readonly refreshCalls: Ref.Ref<number>;
  readonly setProviders: (providers: ReadonlyArray<ServerProvider>) => Effect.Effect<void>;
}

/**
 * Builds the service over a registry stub whose `refreshInstance` runs
 * `onRefresh` and then publishes whatever `setProviders` last supplied,
 * mirroring the real registry's read-after-refresh behaviour.
 */
const makeHarness = (options?: {
  readonly initial?: ReadonlyArray<ServerProvider>;
  readonly onRefresh?: (refreshed: Ref.Ref<ReadonlyArray<ServerProvider>>) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      options?.initial ?? [providerWith(quotaAt(0, 10))],
    );
    const refreshCalls = yield* Ref.make(0);
    const registryLayer = Layer.mock(ProviderRegistry)({
      getProviders: Ref.get(providersRef),
      refresh: () => Ref.get(providersRef),
      refreshInstance: () =>
        Ref.update(refreshCalls, (count) => count + 1).pipe(
          Effect.andThen(options?.onRefresh?.(providersRef) ?? Effect.void),
          Effect.andThen(Ref.get(providersRef)),
        ),
      getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("unused"),
      setProviderMaintenanceActionState: () => Ref.get(providersRef),
      setProviderUsageLimitState: () => Ref.get(providersRef),
      streamChanges: Stream.empty,
    });
    const usage = yield* ProviderUsageStatus.ProviderUsageStatus.pipe(
      Effect.provide(ProviderUsageStatus.layer.pipe(Layer.provide(registryLayer))),
    );
    return {
      usage,
      refreshCalls,
      setProviders: (providers) => Ref.set(providersRef, providers),
    } satisfies Harness;
  });

it.effect("serves a fresh quota without probing the provider", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* TestClock.adjust(INSIDE_WINDOW_MS);

    const reading = yield* harness.usage.read(instanceId);

    expect(yield* Ref.get(harness.refreshCalls)).toBe(0);
    expect(reading?.stale).toBe(false);
    expect(reading?.provider).toBe(driver);
    expect(reading?.quota?.windows[0]?.usedPercent).toBe(10);
  }),
);

it.effect("refreshes exactly once when the quota has aged past the window", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      onRefresh: (providersRef) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Ref.set(providersRef, [providerWith(quotaAt(now, 42))]),
        ),
    });
    yield* TestClock.adjust(PAST_WINDOW_MS);

    const reading = yield* harness.usage.read(instanceId);

    expect(yield* Ref.get(harness.refreshCalls)).toBe(1);
    // The refreshed numbers are what the agent gets, not the ones we started with.
    expect(reading?.quota?.windows[0]?.usedPercent).toBe(42);
    expect(reading?.stale).toBe(false);
  }),
);

it.effect("still reports stale when a refresh was served from the probe cache", () =>
  Effect.gen(function* () {
    // What the Claude driver's multi-minute capabilities cache actually does:
    // the refresh succeeds and republishes the snapshot, but the usage numbers
    // it carries were read long ago, so `quota.observedAt` stays put. Before
    // `checkClaudeProviderStatus` dated the quota from the probe's own
    // `probedAt`, this case restamped `observedAt` to now and the tool
    // confidently reported minutes-old figures as fresh.
    const harness = yield* makeHarness({
      onRefresh: (providersRef) => Ref.set(providersRef, [providerWith(quotaAt(0, 10))]),
    });
    yield* TestClock.adjust(PAST_WINDOW_MS);

    const reading = yield* harness.usage.read(instanceId);

    expect(yield* Ref.get(harness.refreshCalls)).toBe(1);
    expect(reading?.quota?.observedAt).toBe(isoAt(0));
    expect(reading?.stale).toBe(true);
  }),
);

it.effect("throttles a second stale read inside the same window", () =>
  Effect.gen(function* () {
    // The refresh deliberately does not update the snapshot, so the second
    // read is just as stale as the first and would re-probe if unthrottled.
    const harness = yield* makeHarness();
    yield* TestClock.adjust(PAST_WINDOW_MS);

    const first = yield* harness.usage.read(instanceId);
    yield* TestClock.adjust(WINDOW_MS / 2);
    const second = yield* harness.usage.read(instanceId);

    expect(yield* Ref.get(harness.refreshCalls)).toBe(1);
    expect(first?.stale).toBe(true);
    expect(second?.stale).toBe(true);

    // Once the window has fully elapsed the next read is allowed to probe again.
    yield* TestClock.adjust(WINDOW_MS / 2 + 1_000);
    yield* harness.usage.read(instanceId);
    expect(yield* Ref.get(harness.refreshCalls)).toBe(2);
  }),
);

it.effect("coalesces concurrent reads onto one in-flight refresh", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const harness = yield* makeHarness({
      onRefresh: (providersRef) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(
            Effect.flatMap(Clock.currentTimeMillis, (now) =>
              Ref.set(providersRef, [providerWith(quotaAt(now, 77))]),
            ),
          ),
        ),
    });
    yield* TestClock.adjust(PAST_WINDOW_MS);

    // `startImmediately` plus the refresh's own `started` signal is what makes
    // "the second caller arrives mid-refresh" deterministic rather than a race
    // the scheduler happens to win: the first fiber runs until it parks inside
    // the refresh, and the second then runs until it parks on the gate. No
    // sleeps, and no chance of the second fiber simply starting late and
    // passing for the wrong reason.
    const first = yield* Effect.forkChild(harness.usage.read(instanceId), {
      startImmediately: true,
    });
    yield* Deferred.await(started);
    const second = yield* Effect.forkChild(harness.usage.read(instanceId), {
      startImmediately: true,
    });
    yield* Deferred.succeed(release, undefined);

    const firstReading = yield* Fiber.join(first);
    const secondReading = yield* Fiber.join(second);

    expect(yield* Ref.get(harness.refreshCalls)).toBe(1);
    // The coalesced caller sees the refreshed numbers, not the stale ones it
    // arrived with.
    expect(firstReading?.quota?.windows[0]?.usedPercent).toBe(77);
    expect(secondReading?.quota?.windows[0]?.usedPercent).toBe(77);
  }),
);

it.effect("serves the cached snapshot when the refresh fails", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      onRefresh: () => Effect.die(new Error("provider probe exploded")),
    });
    yield* TestClock.adjust(PAST_WINDOW_MS);

    const reading = yield* harness.usage.read(instanceId);

    expect(yield* Ref.get(harness.refreshCalls)).toBe(1);
    // Honest, not empty: the old numbers with their real age.
    expect(reading?.quota?.observedAt).toBe(isoAt(0));
    expect(reading?.quota?.windows[0]?.usedPercent).toBe(10);
    expect(reading?.stale).toBe(true);
  }),
);

it.effect("gives up on a refresh that outlasts the tool's patience", () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    const harness = yield* makeHarness({
      onRefresh: () => Deferred.await(release),
    });
    yield* TestClock.adjust(PAST_WINDOW_MS);

    const reading = yield* Effect.forkChild(harness.usage.read(instanceId));
    yield* TestClock.adjust(ProviderUsageStatus.QUOTA_REFRESH_TIMEOUT_MS);
    const served = yield* Fiber.join(reading);

    expect(served?.quota?.observedAt).toBe(isoAt(0));
    expect(served?.stale).toBe(true);
  }),
);

it.effect("reports an exhausted account that has never reported a quota", () =>
  Effect.gen(function* () {
    const limited = {
      ...providerWith(undefined),
      usageLimit: { resetsAt: isoAt(3_600_000), observedAt: isoAt(0) },
    } satisfies ServerProvider;
    const harness = yield* makeHarness({ initial: [limited] });

    const reading = yield* harness.usage.read(instanceId);

    expect(reading?.usageLimit).toEqual({ resetsAt: isoAt(3_600_000), observedAt: isoAt(0) });
    expect(reading?.quota).toBeUndefined();
    // No quota at all is a stale reading, not a fresh "you have no limits".
    expect(reading?.stale).toBe(true);
  }),
);

it.effect("resolves nothing for an instance the registry does not know", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ initial: [] });

    expect(yield* harness.usage.read(instanceId)).toBeUndefined();
    expect(yield* Ref.get(harness.refreshCalls)).toBe(0);
  }),
);

it.effect("treats an unreadable observedAt as stale rather than trusting it", () =>
  Effect.gen(function* () {
    expect(ProviderUsageStatus.isQuotaFresh(undefined, 0)).toBe(false);
    expect(
      ProviderUsageStatus.isQuotaFresh({ observedAt: "not a timestamp", windows: [] }, 0),
    ).toBe(false);
    expect(ProviderUsageStatus.isQuotaFresh(quotaAt(0, 1), WINDOW_MS - 1)).toBe(true);
    expect(ProviderUsageStatus.isQuotaFresh(quotaAt(0, 1), WINDOW_MS)).toBe(false);
    return yield* Effect.void;
  }),
);
