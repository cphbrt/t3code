import { describe, it, assert } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSession,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { adapterHasActiveWork, hasActiveTurn } from "./providerActiveWork.ts";

const makeSession = (input: {
  readonly instanceId: string;
  readonly threadId: string;
  readonly activeTurnId?: string;
}): ProviderSession => ({
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make(input.instanceId),
  status: "ready",
  runtimeMode: "auto",
  threadId: ThreadId.make(input.threadId),
  ...(input.activeTurnId !== undefined ? { activeTurnId: TurnId.make(input.activeTurnId) } : {}),
  createdAt: "2026-04-10T00:00:00.000Z",
  updatedAt: "2026-04-10T00:00:00.000Z",
});

const idleSessionA = makeSession({
  instanceId: "codex-a",
  threadId: "01999999-0000-7000-8000-00000000000a",
});
const activeSessionA = makeSession({
  instanceId: "codex-a",
  threadId: "01999999-0000-7000-8000-00000000000b",
  activeTurnId: "01999999-0000-7000-8000-0000000000ff",
});
const idleSessionB = makeSession({
  instanceId: "codex-b",
  threadId: "01999999-0000-7000-8000-00000000000c",
});

const fakeAdapter = (sessions: ReadonlyArray<ProviderSession>) => ({
  listSessions: () => Effect.succeed(sessions),
});

describe("providerActiveWork", () => {
  it("reports demand while a session has a turn in flight", () => {
    assert.strictEqual(hasActiveTurn([idleSessionA, activeSessionA]), true);
  });

  it("reports no demand when no session has a turn in flight", () => {
    assert.strictEqual(hasActiveTurn([idleSessionA, idleSessionB]), false);
  });

  it("reports no demand with no sessions at all", () => {
    assert.strictEqual(hasActiveTurn([]), false);
  });

  it.effect("scopes demand to the adapter's own instance", () =>
    Effect.gen(function* () {
      // Each driver instance owns one adapter, so instance B's adapter never
      // sees instance A's running turn.
      const instanceA = fakeAdapter([activeSessionA]);
      const instanceB = fakeAdapter([idleSessionB]);

      assert.strictEqual(yield* adapterHasActiveWork(instanceA), true);
      assert.strictEqual(yield* adapterHasActiveWork(instanceB), false);
    }),
  );
});
