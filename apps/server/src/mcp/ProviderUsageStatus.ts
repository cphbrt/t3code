/**
 * ProviderUsageStatus — the freshness policy behind the `usage_status` MCP
 * tool.
 *
 * The server already holds everything an agent needs on its `ServerProvider`
 * snapshot: `usageLimit` (hard exhaustion, pushed live mid-turn from the
 * adapter's rate-limit events) and `quota` (descriptive allowance windows,
 * produced by the provider status probe). Only `quota` goes stale, because it
 * refreshes on the probe's schedule rather than on demand.
 *
 * This service decides when a read is worth a probe. It never errors on
 * staleness: a failed or slow refresh serves the cached snapshot with its own
 * `observedAt`, and the caller learns the truth from `stale`.
 *
 * @module ProviderUsageStatus
 */
import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderQuota,
  ServerProviderUsageLimit,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import { providerQuotaRefreshMinIntervalMillis } from "../provider/providerQuota.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";

/**
 * How long a quota reading counts as fresh, and — deliberately the same
 * number — the minimum spacing between refreshes of one instance. One
 * threshold means a caller can never provoke a probe that its own previous
 * call would not already have provoked, and it keeps `stale` from reading
 * true almost always: a reading is stale exactly when we would be willing to
 * go get a newer one.
 *
 * Sourced from `PROVIDER_QUOTA_REFRESH_MIN_INTERVAL`, which is the policy
 * ceiling on how often we may ask a provider about usage. Read through the
 * function rather than captured at module load so a test can reason about the
 * constant without import-order games.
 */
const quotaFreshnessWindowMillis = providerQuotaRefreshMinIntervalMillis;

/**
 * Upper bound on how long a tool call waits for a refresh before answering
 * from cache. The drivers' own probes are slower than this in the worst case
 * (Claude's capabilities probe allows 25 s), and an agent asking how much
 * runway it has should not be parked for that long to find out.
 */
export const QUOTA_REFRESH_TIMEOUT_MS = 15_000;

export interface ProviderUsageStatusReading {
  readonly provider: ProviderDriverKind;
  readonly usageLimit: ServerProviderUsageLimit | undefined;
  readonly quota: ServerProviderQuota | undefined;
  /** The served quota is missing or older than the refresh interval. */
  readonly stale: boolean;
}

export interface ProviderUsageStatusShape {
  /**
   * Read one instance's usage status, refreshing first when the quota is
   * missing or stale and the refresh throttle allows it. Resolves `undefined`
   * when the registry holds no snapshot for the instance.
   */
  readonly read: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderUsageStatusReading | undefined>;
}

export class ProviderUsageStatus extends Context.Service<
  ProviderUsageStatus,
  ProviderUsageStatusShape
>()("t3/mcp/ProviderUsageStatus") {}

const parseObservedAtMillis = (observedAt: string): number | undefined => {
  const millis = Date.parse(observedAt);
  return Number.isNaN(millis) ? undefined : millis;
};

/**
 * A quota with an unreadable or absent `observedAt` counts as stale. Serving
 * an unverifiable timestamp as fresh is the one outcome worth avoiding here,
 * since the whole point of the reading is its age.
 */
export const isQuotaFresh = (
  quota: ServerProviderQuota | undefined,
  nowMillis: number,
): boolean => {
  if (!quota) return false;
  const observedAtMillis = parseObservedAtMillis(quota.observedAt);
  if (observedAtMillis === undefined) return false;
  return nowMillis - observedAtMillis < quotaFreshnessWindowMillis();
};

const make = Effect.gen(function* () {
  const registry = yield* ProviderRegistry;
  // One permit per instance. A second caller arriving while a refresh is in
  // flight blocks here rather than starting a second probe, then finds the
  // attempt stamp below already set and skips — which is what coalescing
  // concurrent tool calls onto one refresh amounts to.
  const gatesRef = yield* Ref.make<ReadonlyMap<ProviderInstanceId, Semaphore.Semaphore>>(new Map());
  const lastAttemptRef = yield* Ref.make<ReadonlyMap<ProviderInstanceId, number>>(new Map());

  const findSnapshot = (
    instanceId: ProviderInstanceId,
  ): Effect.Effect<ServerProvider | undefined> =>
    registry.getProviders.pipe(
      Effect.map((providers) => providers.find((provider) => provider.instanceId === instanceId)),
    );

  const gateFor = (instanceId: ProviderInstanceId) =>
    Ref.modify(gatesRef, (gates) => {
      const existing = gates.get(instanceId);
      if (existing) return [existing, gates] as const;
      const created = Semaphore.makeUnsafe(1);
      const next = new Map(gates);
      next.set(instanceId, created);
      return [created, next] as const;
    });

  const refreshIfDue = Effect.fn("ProviderUsageStatus.refreshIfDue")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const gate = yield* gateFor(instanceId);
    yield* gate.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const lastAttemptAt = (yield* Ref.get(lastAttemptRef)).get(instanceId);
        if (lastAttemptAt !== undefined && now - lastAttemptAt < quotaFreshnessWindowMillis()) {
          return;
        }
        // Re-read behind the gate: whoever held it before us may already have
        // refreshed this instance.
        const snapshot = yield* findSnapshot(instanceId);
        if (isQuotaFresh(snapshot?.quota, now)) return;
        // Stamped before the probe rather than after, so a slow or failing
        // refresh still throttles the next one. The window bounds refresh
        // starts, not successes.
        yield* Ref.update(lastAttemptRef, (previous) => new Map(previous).set(instanceId, now));
        yield* registry
          .refreshInstance(instanceId)
          .pipe(Effect.timeoutOption(QUOTA_REFRESH_TIMEOUT_MS), Effect.ignoreCause({ log: true }));
      }),
    );
  });

  const read = Effect.fn("ProviderUsageStatus.read")(function* (instanceId: ProviderInstanceId) {
    const cached = yield* findSnapshot(instanceId);
    if (!cached) return undefined;
    const now = yield* Clock.currentTimeMillis;
    if (!isQuotaFresh(cached.quota, now)) {
      yield* refreshIfDue(instanceId);
    }
    // A refresh — ours, or the one we coalesced onto — replaces the snapshot
    // in the registry, so read it again rather than answering from `cached`.
    const snapshot = (yield* findSnapshot(instanceId)) ?? cached;
    const answeredAt = yield* Clock.currentTimeMillis;
    return {
      provider: snapshot.driver,
      usageLimit: snapshot.usageLimit,
      quota: snapshot.quota,
      stale: !isQuotaFresh(snapshot.quota, answeredAt),
    } satisfies ProviderUsageStatusReading;
  });

  return ProviderUsageStatus.of({ read });
});

export const layer = Layer.effect(ProviderUsageStatus, make);
