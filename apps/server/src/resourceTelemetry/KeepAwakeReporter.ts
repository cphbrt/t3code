/**
 * Reports how many agent turns are running here to this server's desktop
 * shell, which owns the decision to hold the machine awake.
 *
 * The server deliberately holds no assertion of its own. It only states the
 * fact it alone knows — how much work is in flight — and the shell combines
 * that with power state and the user's settings, which the server does not
 * know. A headless server has no control descriptor, so every send is a
 * no-op and nothing here needs to care.
 *
 * @module KeepAwakeReporter
 */
import type { ProviderRuntimeEvent, ProviderRuntimeEventType } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { countActiveTurns } from "../provider/providerActiveWork.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { DesktopTelemetryReceiver } from "./DesktopTelemetryReceiver.ts";

/**
 * The runtime events that can change how many turns are in flight.
 *
 * Both adapters set `activeTurnId` on `turn.started` and clear it when the
 * turn settles or the session goes away, so these four bracket every
 * transition. Recounting on the whole event stream would mean re-listing
 * every session for each streamed token; recounting on these means a handful
 * of times per turn.
 */
// Annotated as the canonical event-type union so a rename upstream fails
// here, but widened to strings for lookup: the runtime event union carries a
// few types (`tool.denied`) that the shared type list does not enumerate.
const ACTIVE_TURN_COUNT_EVENT_TYPES: ReadonlyArray<ProviderRuntimeEventType> = [
  "turn.started",
  "turn.completed",
  "turn.aborted",
  "session.exited",
];
const activeTurnCountEventTypes = new Set<string>(ACTIVE_TURN_COUNT_EVENT_TYPES);

export const affectsActiveTurnCount = (event: { readonly type: string }): boolean =>
  activeTurnCountEventTypes.has(event.type);

export const make = Effect.gen(function* () {
  const provider = yield* ProviderService;
  const receiver = yield* DesktopTelemetryReceiver;
  // Seeded at -1 rather than 0 so the first recount always reports, giving
  // the shell a known starting point instead of an assumed one.
  const lastReported = yield* Ref.make(-1);

  const report = Effect.gen(function* () {
    const sessions = yield* provider.listSessions();
    const activeTurnCount = countActiveTurns(sessions);
    const changed = yield* Ref.modify(lastReported, (previous) =>
      previous === activeTurnCount ? [false, previous] : [true, activeTurnCount],
    );
    if (!changed) return;
    yield* receiver.setKeepAwake(activeTurnCount);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to report keep-awake active turn count", {
        cause: String(cause),
      }),
    ),
  );

  yield* report;
  yield* provider.streamEvents.pipe(
    Stream.filter((event: ProviderRuntimeEvent) => affectsActiveTurnCount(event)),
    Stream.runForEach(() => report),
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(make);
