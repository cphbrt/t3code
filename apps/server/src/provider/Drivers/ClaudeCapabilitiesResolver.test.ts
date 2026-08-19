import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { ClaudeCapabilitiesProbe } from "../Layers/ClaudeProvider.ts";
import { makeClaudeCapabilitiesResolver } from "./ClaudeCapabilitiesResolver.ts";

const usageResponse = (utilization: number) =>
  ({
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization, resets_at: "2026-01-01T00:00:00.000Z" },
    },
  }) as never;

const probeResult = (input?: {
  readonly utilization?: number;
  readonly email?: string;
}): ClaudeCapabilitiesProbe => ({
  email: input?.email ?? "agent@example.test",
  subscriptionType: "max",
  tokenSource: "oauth",
  apiProvider: "firstParty",
  slashCommands: [],
  usage: usageResponse(input?.utilization ?? 10),
  probedAt: "2026-01-01T00:00:00.000Z",
});

/**
 * Counting harness. `probeCalls` is the number of subprocess spawns a real
 * driver would have made, and `usageCalls` the number of live-session control
 * requests; both cost exactly one Anthropic usage request, so their sum is the
 * request count for a run.
 */
const makeHarness = (input?: {
  readonly probeResults?: ReadonlyArray<ClaudeCapabilitiesProbe | undefined>;
  readonly usageResults?: ReadonlyArray<unknown>;
  readonly activeWork?: boolean;
}) =>
  Effect.gen(function* () {
    const probeCalls = yield* Ref.make(0);
    const usageCalls = yield* Ref.make(0);
    const activeWorkRef = yield* Ref.make(input?.activeWork ?? false);
    const probeResults = input?.probeResults ?? [probeResult()];
    const usageResults = input?.usageResults ?? [usageResponse(42)];

    const resolve = yield* makeClaudeCapabilitiesResolver({
      probe: Ref.getAndUpdate(probeCalls, (n) => n + 1).pipe(
        Effect.map((index) => probeResults[Math.min(index, probeResults.length - 1)]),
      ),
      readPlanUsage: () =>
        Ref.getAndUpdate(usageCalls, (n) => n + 1).pipe(
          Effect.map((index) => usageResults[Math.min(index, usageResults.length - 1)] as never),
        ),
      hasActiveWork: Ref.get(activeWorkRef),
    });

    return { resolve, probeCalls, usageCalls, activeWorkRef };
  });

describe("Claude capabilities resolution", () => {
  it.effect("probes a subprocess when nothing is running", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ activeWork: false });

      const first = yield* harness.resolve;
      const second = yield* harness.resolve;

      expect(first?.email).toBe("agent@example.test");
      expect(second?.email).toBe("agent@example.test");
      // One probe per check, no time cache: two checks, two probes.
      expect(yield* Ref.get(harness.probeCalls)).toBe(2);
      // And never the live read, because nothing was live to read from.
      expect(yield* Ref.get(harness.usageCalls)).toBe(0);
    }),
  );

  it.effect("rides a running turn's session instead of spawning a second one", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ activeWork: false });

      // The first check has no retained metadata to reuse, so it probes.
      yield* harness.resolve;
      yield* Ref.set(harness.activeWorkRef, true);
      const duringTurn = yield* harness.resolve;

      expect(yield* Ref.get(harness.probeCalls)).toBe(1);
      expect(yield* Ref.get(harness.usageCalls)).toBe(1);
      // Fresh numbers on the retained account metadata...
      expect(duringTurn?.usage?.rate_limits?.five_hour?.utilization).toBe(42);
      expect(duringTurn?.email).toBe("agent@example.test");
      // ...restamped, because the numbers really were just read.
      expect(duringTurn?.probedAt).not.toBe("2026-01-01T00:00:00.000Z");
    }),
  );

  it.effect("still costs one usage request per check while a turn runs", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ activeWork: true });

      yield* harness.resolve;
      yield* harness.resolve;
      yield* harness.resolve;

      // Three checks: the first probes (nothing retained yet), the rest ride
      // the session. One request each, never both in the same check.
      const probes = yield* Ref.get(harness.probeCalls);
      const reads = yield* Ref.get(harness.usageCalls);
      expect(probes).toBe(1);
      expect(reads).toBe(2);
      expect(probes + reads).toBe(3);
    }),
  );

  it.effect("falls back to the probe when the live read cannot answer", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        activeWork: false,
        usageResults: [undefined],
        probeResults: [probeResult({ utilization: 10 }), probeResult({ utilization: 77 })],
      });

      yield* harness.resolve;
      yield* Ref.set(harness.activeWorkRef, true);
      const second = yield* harness.resolve;

      expect(yield* Ref.get(harness.usageCalls)).toBe(1);
      expect(yield* Ref.get(harness.probeCalls)).toBe(2);
      expect(second?.usage?.rate_limits?.five_hour?.utilization).toBe(77);
    }),
  );

  it.effect("keeps the last known account when a probe fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        activeWork: false,
        probeResults: [probeResult({ email: "agent@example.test" }), undefined],
      });

      yield* harness.resolve;
      const afterFailure = yield* harness.resolve;

      // Without this the status check reports "auth unknown" on one bad probe.
      expect(afterFailure?.email).toBe("agent@example.test");
      // The stamp is not refreshed, so downstream staleness checks still see
      // the reading's real age.
      expect(afterFailure?.probedAt).toBe("2026-01-01T00:00:00.000Z");
    }),
  );

  it.effect("reports nothing when the very first probe fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ activeWork: true, probeResults: [undefined] });

      expect(yield* harness.resolve).toBeUndefined();
      // No retained metadata means no shortcut, so no wasted live read either.
      expect(yield* Ref.get(harness.usageCalls)).toBe(0);
    }),
  );
});
