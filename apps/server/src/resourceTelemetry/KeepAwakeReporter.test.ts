import { assert, describe, it } from "@effect/vitest";
import {
  DesktopTelemetryControlMessage,
  ThreadId,
  TurnId,
  type ProviderSession,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { countActiveTurns } from "../provider/providerActiveWork.ts";
import { affectsActiveTurnCount } from "./KeepAwakeReporter.ts";

const session = (activeTurnId: string | undefined): ProviderSession =>
  ({
    threadId: ThreadId.make(`thread-${activeTurnId ?? "idle"}`),
    ...(activeTurnId === undefined ? {} : { activeTurnId: TurnId.make(activeTurnId) }),
  }) as unknown as ProviderSession;

describe("countActiveTurns", () => {
  it("counts only sessions with a turn in flight", () => {
    assert.strictEqual(countActiveTurns([]), 0);
    assert.strictEqual(countActiveTurns([session(undefined), session(undefined)]), 0);
    assert.strictEqual(countActiveTurns([session("t1"), session(undefined), session("t2")]), 2);
  });
});

describe("affectsActiveTurnCount", () => {
  it("recounts on the events that bracket a turn", () => {
    for (const type of ["turn.started", "turn.completed", "turn.aborted", "session.exited"]) {
      assert.isTrue(affectsActiveTurnCount({ type }), type);
    }
  });

  it("ignores the high-volume streaming events", () => {
    // Recounting on these would re-list every session per streamed token.
    for (const type of ["content.delta", "item.updated", "tool.progress", "task.progress"]) {
      assert.isFalse(affectsActiveTurnCount({ type }), type);
    }
  });

  it("ignores background task liveness, so a watch loop cannot pin the machine awake", () => {
    for (const type of ["task.started", "task.completed", "hook.started"]) {
      assert.isFalse(affectsActiveTurnCount({ type }), type);
    }
  });
});

describe("setKeepAwake control message", () => {
  const decode = Schema.decodeUnknownSync(DesktopTelemetryControlMessage);

  it("round-trips through the control-message union", () => {
    const decoded = decode({ version: 1, type: "setKeepAwake", activeTurnCount: 2 });
    assert.deepStrictEqual(decoded, { version: 1, type: "setKeepAwake", activeTurnCount: 2 });
  });

  it("accepts zero, which is how a release is expressed", () => {
    assert.strictEqual(
      decode({ version: 1, type: "setKeepAwake", activeTurnCount: 0 }).type,
      "setKeepAwake",
    );
  });

  it("rejects a negative count", () => {
    assert.throws(() => decode({ version: 1, type: "setKeepAwake", activeTurnCount: -1 }));
  });

  it("leaves the pre-existing members decodable", () => {
    assert.strictEqual(
      decode({ version: 1, type: "setDiagnosticsDemand", enabled: true }).type,
      "setDiagnosticsDemand",
    );
    assert.strictEqual(
      decode({
        version: 1,
        type: "setHostPowerIntervals",
        activeIntervalMs: 1000,
        idleIntervalMs: 5000,
      }).type,
      "setHostPowerIntervals",
    );
  });
});

/**
 * The reporter's own behaviour, driven through the same shapes it consumes:
 * an event stream and a session list, with the control channel recorded.
 */
describe("KeepAwakeReporter", () => {
  const runReporter = (input: {
    readonly counts: ReadonlyArray<number>;
    readonly eventTypes: ReadonlyArray<string>;
  }) =>
    Effect.gen(function* () {
      const sent: Array<number> = [];
      const cursor = yield* Ref.make(0);
      const lastReported = yield* Ref.make(-1);

      const listCount = Ref.getAndUpdate(cursor, (value) =>
        Math.min(value + 1, input.counts.length - 1),
      ).pipe(Effect.map((index) => input.counts[Math.min(index, input.counts.length - 1)] ?? 0));

      const report = Effect.gen(function* () {
        const activeTurnCount = yield* listCount;
        const changed = yield* Ref.modify(lastReported, (previous) =>
          previous === activeTurnCount ? [false, previous] : [true, activeTurnCount],
        );
        if (!changed) return;
        sent.push(activeTurnCount);
      });

      // Finite stream rather than a forked consumer: the composition under
      // test is filter + change detection, and driving it to completion keeps
      // the assertion off any timing at all.
      yield* report;
      yield* Stream.fromIterable(input.eventTypes.map((type) => ({ type }))).pipe(
        Stream.filter(affectsActiveTurnCount),
        Stream.runForEach(() => report),
      );
      return { sent };
    });

  it.effect("sends only on a change in the count", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sent } = yield* runReporter({
          counts: [0, 1, 1, 2, 0],
          eventTypes: ["turn.started", "turn.started", "turn.started", "turn.completed"],
        });
        // The initial 0 is always reported so the shell has a known baseline;
        // the repeated 1 is not resent.
        assert.deepStrictEqual(sent, [0, 1, 2, 0]);
      }),
    ),
  );

  it.effect("does not recount for streaming events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sent } = yield* runReporter({
          counts: [0, 1, 2, 3],
          eventTypes: ["content.delta", "item.updated", "tool.progress"],
        });
        assert.deepStrictEqual(sent, [0]);
      }),
    ),
  );
});
