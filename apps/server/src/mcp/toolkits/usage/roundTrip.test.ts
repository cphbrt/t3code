/**
 * End-to-end: a provider's live rate-limit event lands on the persisted
 * usage-limit map, and the `usage_status` tool serves it over MCP.
 *
 * Everything here except the runtime-ingestion `if` is the real thing — the
 * real `ProviderRegistryLive` (including its monotonic usage-limit map and
 * snapshot projection), the real toolkit registration, and the real MCP
 * `callTool` path. The ingestion branch itself is reproduced literally from
 * `ProviderRuntimeIngestion.processRuntimeEvent`, because dragging the whole
 * orchestration graph in would prove less about this tool than it costs.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as ServerConfig from "../../../config.ts";
import { ProviderRegistryLive } from "../../../provider/Layers/ProviderRegistry.ts";
import type { ProviderInstance } from "../../../provider/ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../../../provider/providerMaintenance.ts";
import * as ProviderInstanceRegistry from "../../../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import * as QuotaHistoryStore from "../../../usage/QuotaHistoryStore.ts";
import { UsageToolkitRegistrationLive } from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const instanceId = ProviderInstanceId.make("claudeAgent");
const driver = ProviderDriverKind.make("claudeAgent");

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-usage-round-trip"),
  threadId: ThreadId.make("thread-usage-round-trip"),
  providerSessionId: "provider-session-usage-round-trip",
  providerInstanceId: instanceId,
  capabilities: new Set(["preview", "settle", "usage"]),
  issuedAt: 0,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "usage-round-trip", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const providerAt = (observedAt: string, usedPercent: number): ServerProvider => ({
  instanceId,
  driver,
  status: "ready",
  enabled: true,
  installed: true,
  auth: { status: "authenticated" },
  checkedAt: observedAt,
  version: "2026.08.01",
  models: [],
  slashCommands: [],
  skills: [],
  quota: {
    observedAt,
    planLabel: "Max",
    windows: [{ id: "five_hour", label: "5-hour", usedPercent }],
  },
});

/**
 * A quota stamped at the current instant, so reading the tool never provokes a
 * probe: most of these tests are about the usage-limit path, not the freshness
 * policy.
 */
const makeProvider = Effect.map(DateTime.now, (now) => providerAt(DateTime.formatIso(now), 100));

const makeInstance = (provider: ServerProvider, refreshed?: ServerProvider) =>
  ({
    instanceId,
    driverKind: driver,
    continuationIdentity: {
      driverKind: driver,
      continuationKey: "claudeAgent:instance:claudeAgent",
    },
    displayName: undefined,
    enabled: true,
    snapshot: {
      maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
        provider: driver,
        packageName: null,
      }),
      getSnapshot: Effect.succeed(provider),
      refresh: Effect.succeed(refreshed ?? provider),
      streamChanges: Stream.empty,
    },
    adapter: {} as ProviderInstance["adapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
  }) satisfies ProviderInstance;

interface RecordedQuota {
  readonly instanceId: string;
  readonly observedAt: string;
  readonly windows: readonly { readonly id: string; readonly usedPercent: number }[];
}

/**
 * A recording stand-in for the real store. `QuotaHistoryStore.layerTest`
 * swallows everything, which is right for suites that only need the tag but
 * useless for proving that anything reaches it.
 */
const makeQuotaHistoryLayer = (recorded: Array<RecordedQuota>) =>
  Layer.succeed(
    QuotaHistoryStore.QuotaHistoryStore,
    QuotaHistoryStore.QuotaHistoryStore.of({
      record: (input) =>
        Effect.sync(() => {
          recorded.push({
            instanceId: input.instanceId,
            observedAt: input.observedAt,
            windows: input.windows.map((window) => ({
              id: window.id,
              usedPercent: window.usedPercent,
            })),
          });
        }),
      read: () => Effect.succeed([]),
      annotateCycles: (input) => Effect.succeed(input.windows),
    }),
  );

const makeInstanceRegistryLayer = (instance: ProviderInstance) =>
  Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
    getInstance: (candidate) => Effect.succeed(candidate === instanceId ? instance : undefined),
    listInstances: Effect.succeed([instance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
  });

const buildServices = (
  instance: ProviderInstance,
  prefix: string,
  recorded: Array<RecordedQuota> = [],
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    return yield* Layer.build(
      UsageToolkitRegistrationLive.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(ProviderRegistryLive),
        Layer.provideMerge(makeQuotaHistoryLayer(recorded)),
        Layer.provideMerge(makeInstanceRegistryLayer(instance)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ).pipe(Scope.provide(scope));
  });

it.effect("serves a usage limit that arrived as a provider rate-limit event", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider;
    const services = yield* buildServices(makeInstance(provider), "t3-usage-status-round-trip-");

    yield* Effect.gen(function* () {
      const registry = yield* ProviderRegistry;
      const server = yield* McpServer.McpServer;

      const before = yield* server
        .callTool({ name: "usage_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(before.isError).toBe(false);
      expect(before.structuredContent).toMatchObject({ provider: driver, stale: false });
      // Nothing has exhausted the account yet.
      expect((before.structuredContent as { usageLimit?: unknown }).usageLimit).toBeUndefined();

      // The synthetic `account.rate-limits.updated` payload, mapped exactly as
      // `ProviderRuntimeIngestion.processRuntimeEvent` maps it.
      const event = {
        type: "account.rate-limits.updated",
        providerInstanceId: instanceId,
        createdAt: "2026-08-17T01:00:00.000Z",
        payload: {
          usageLimit: { status: "limited" as const, resetsAt: "2026-08-17T05:00:00.000Z" },
        },
      };
      yield* registry.setProviderUsageLimitState({
        instanceId: event.providerInstanceId,
        observedAt: event.createdAt,
        state:
          event.payload.usageLimit.status === "limited"
            ? { resetsAt: event.payload.usageLimit.resetsAt }
            : null,
      });

      const after = yield* server
        .callTool({ name: "usage_status", arguments: { reason: "pacing an overnight loop" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(after.isError).toBe(false);
      expect(after.structuredContent).toMatchObject({
        provider: driver,
        usageLimit: {
          resetsAt: "2026-08-17T05:00:00.000Z",
          observedAt: "2026-08-17T01:00:00.000Z",
        },
        stale: false,
      });
      // The descriptive window rides along unchanged.
      expect(after.structuredContent).toMatchObject({
        quota: { windows: [{ id: "five_hour", usedPercent: 100 }] },
      });
    }).pipe(Effect.provide(services));
  }).pipe(Effect.scoped),
);

it.effect("refuses a credential that was not granted the usage capability", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider;
    const services = yield* buildServices(makeInstance(provider), "t3-usage-status-denied-");

    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const denied = yield* server.callTool({ name: "usage_status", arguments: {} }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...invocation,
          capabilities: new Set(["preview", "settle"] as const),
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

      expect(denied.isError).toBe(true);
      // The agent must be told what actually went wrong. Effect's MCP server
      // flattens any non-`Error` declared failure to "internal server error",
      // so this asserts the refusal survives that path intact.
      expect(denied.content).toEqual([
        {
          type: "text",
          text: "This session's T3 Code credential may not read provider usage status.",
        },
      ]);
    }).pipe(Effect.provide(services));
  }).pipe(Effect.scoped),
);

it.effect("feeds a tool-triggered refresh into the quota history store", () =>
  Effect.gen(function* () {
    // The history store hooks `upsertProviders`, and a tool refresh reaches it
    // through refreshInstance -> refreshOneSource -> syncProvider ->
    // upsertProviders, so the recording should be automatic. Asserted rather
    // than assumed, since that chain is theirs to change.
    const nowMillis = yield* Clock.currentTimeMillis;
    const staleObservedAt = DateTime.formatIso(DateTime.makeUnsafe(nowMillis - 10 * 60_000));
    const freshObservedAt = DateTime.formatIso(DateTime.makeUnsafe(nowMillis));
    const recorded: Array<RecordedQuota> = [];
    const services = yield* buildServices(
      makeInstance(providerAt(staleObservedAt, 40), providerAt(freshObservedAt, 55)),
      "t3-usage-status-history-",
      recorded,
    );

    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const answer = yield* server
        .callTool({ name: "usage_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      // The stale snapshot provoked a refresh, and the agent got the new numbers.
      expect(answer.isError).toBe(false);
      expect(answer.structuredContent).toMatchObject({
        quota: { observedAt: freshObservedAt, windows: [{ usedPercent: 55 }] },
        stale: false,
      });

      // The refreshed observation reached the history store.
      expect(recorded).toContainEqual({
        instanceId,
        observedAt: freshObservedAt,
        windows: [{ id: "five_hour", usedPercent: 55 }],
      });
      // Their dedupe key is (instanceId, windowId, observedAt), and quota
      // observedAt is now the provider's own reading time rather than a
      // restamped checkedAt, so a repeat refresh inside the probe cache
      // re-records an identical key instead of inventing a new datapoint.
      const freshRecords = recorded.filter((entry) => entry.observedAt === freshObservedAt);
      expect(freshRecords.every((entry) => entry.instanceId === instanceId)).toBe(true);
    }).pipe(Effect.provide(services));
  }).pipe(Effect.scoped),
);

it.effect("annotates the tool as a read-only status query", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider;
    const services = yield* buildServices(makeInstance(provider), "t3-usage-status-annotations-");

    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const registered = server.tools.find(({ tool }) => tool.name === "usage_status");
      expect(registered?.tool.annotations?.readOnlyHint).toBe(true);
      expect(registered?.tool.annotations?.destructiveHint).toBe(false);
      expect(registered?.tool.annotations?.idempotentHint).toBe(true);
    }).pipe(Effect.provide(services));
  }).pipe(Effect.scoped),
);
