import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  isShutdownRequested,
  markShutdownRequested,
  watchShutdownSignals,
} from "./processShutdown.ts";

describe("processShutdown", () => {
  it.effect("observes shutdown signals only for the life of the scope", () =>
    Effect.gen(function* () {
      // Ordered before the flag test below: this asserts the pre-shutdown state.
      assert.equal(isShutdownRequested(), false);

      const listening = Effect.sync(() => ({
        sigint: process.listeners("SIGINT").includes(markShutdownRequested),
        sigterm: process.listeners("SIGTERM").includes(markShutdownRequested),
      }));

      assert.deepEqual(yield* listening, { sigint: false, sigterm: false });

      const inScope = yield* Effect.scoped(watchShutdownSignals.pipe(Effect.andThen(listening)));

      assert.deepEqual(inScope, { sigint: true, sigterm: true });
      assert.deepEqual(yield* listening, { sigint: false, sigterm: false });
    }),
  );

  it.effect("latches once shutdown is requested", () =>
    Effect.sync(() => {
      markShutdownRequested();
      assert.equal(isShutdownRequested(), true);

      markShutdownRequested();
      assert.equal(isShutdownRequested(), true);
    }),
  );
});
