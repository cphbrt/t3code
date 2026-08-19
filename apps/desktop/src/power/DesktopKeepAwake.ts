/**
 * Holds this Mac awake while its own agents are mid-turn.
 *
 * Three inputs meet here and nowhere else: how many turns the local backends
 * report running, whether the machine is on AC power, and what the user asked
 * for in Settings. The decision itself lives in `keepAwakeDecision.ts` so it
 * can be tested without Electron; this module owns the assertion and the
 * reconciliation.
 *
 * There is deliberately no read API and nothing reported to the renderer: the
 * behaviour is silent, and the Settings toggle is the only control.
 *
 * @module DesktopKeepAwake
 */
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

import {
  ElectronPowerSaveBlocker,
  KEEP_AWAKE_BLOCKER_TYPE,
} from "../electron/ElectronPowerSaveBlocker.ts";
import { ElectronPowerMonitor } from "../electron/ElectronPowerMonitor.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import { shouldHoldKeepAwake } from "./keepAwakeDecision.ts";

export class DesktopKeepAwake extends Context.Service<
  DesktopKeepAwake,
  {
    /**
     * A local backend reporting its current turn count. Keyed by backend so
     * the primary and a WSL backend sum rather than overwrite each other.
     */
    readonly setActiveTurns: (sourceId: string, activeTurnCount: number) => Effect.Effect<void>;
    /** A local backend going away; its turns no longer count. */
    readonly removeSource: (sourceId: string) => Effect.Effect<void>;
    /** Re-read Settings and reconcile, after the renderer writes them. */
    readonly settingsChanged: Effect.Effect<void>;
  }
>()("@t3tools/desktop/power/DesktopKeepAwake") {}

export const make = Effect.gen(function* () {
  const blocker = yield* ElectronPowerSaveBlocker;
  const powerMonitor = yield* ElectronPowerMonitor;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;

  const turnsBySource = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const blockerId = yield* Ref.make<number | null>(null);

  const readSettings = clientSettings.get.pipe(
    Effect.map((settings) =>
      Option.match(settings, {
        onNone: () => ({
          featureEnabled: DEFAULT_CLIENT_SETTINGS.keepAwakeWhileAgentsRun,
          allowOnBattery: DEFAULT_CLIENT_SETTINGS.keepAwakeOnBattery,
        }),
        onSome: (value) => ({
          featureEnabled: value.keepAwakeWhileAgentsRun,
          allowOnBattery: value.keepAwakeOnBattery,
        }),
      }),
    ),
  );

  /**
   * Bring the real assertion in line with the decision. Level-triggered
   * throughout: it reads the current world and converges, so a missed edge
   * cannot strand an assertion.
   */
  const reconcile = Effect.gen(function* () {
    const counts = yield* Ref.get(turnsBySource);
    let activeTurnCount = 0;
    for (const count of counts.values()) activeTurnCount += count;

    const onBatteryPower = yield* powerMonitor.isOnBatteryPower;
    const settings = yield* readSettings;

    const wanted = shouldHoldKeepAwake({ activeTurnCount, onBatteryPower, ...settings });

    const currentId = yield* Ref.get(blockerId);
    const currentlyHeld = currentId === null ? false : yield* blocker.isStarted(currentId);

    if (wanted && !currentlyHeld) {
      const id = yield* blocker.start(KEEP_AWAKE_BLOCKER_TYPE);
      yield* Ref.set(blockerId, id);
    } else if (!wanted && currentId !== null) {
      yield* blocker.stop(currentId);
      yield* Ref.set(blockerId, null);
    }
  });

  // AC/battery transitions change the answer without any turn changing, so
  // they have to reconcile too — that is what releases the assertion when a
  // laptop is unplugged mid-turn. Electron calls these listeners
  // synchronously, so they only nudge a queue that a forked loop drains.
  const powerTransitions = yield* Queue.sliding<void>(1);
  const nudge = (): void => {
    Queue.offerUnsafe(powerTransitions, undefined);
  };
  yield* Effect.all(
    [powerMonitor.onSimpleEvent("on-ac", nudge), powerMonitor.onSimpleEvent("on-battery", nudge)],
    { concurrency: "unbounded" },
  );
  yield* Effect.forever(Queue.take(powerTransitions).pipe(Effect.andThen(reconcile))).pipe(
    Effect.forkScoped,
  );

  return DesktopKeepAwake.of({
    setActiveTurns: (sourceId, activeTurnCount) =>
      Ref.update(turnsBySource, (counts) => {
        const next = new Map(counts);
        next.set(sourceId, Math.max(0, activeTurnCount));
        return next;
      }).pipe(Effect.andThen(reconcile)),
    removeSource: (sourceId) =>
      Ref.update(turnsBySource, (counts) => {
        const next = new Map(counts);
        next.delete(sourceId);
        return next;
      }).pipe(Effect.andThen(reconcile)),
    settingsChanged: reconcile,
  });
});

export const layer = Layer.effect(DesktopKeepAwake, make);

/** Inert stand-in for tests about other things that merely touch this seam. */
export const layerTest = (
  overrides: Partial<DesktopKeepAwake["Service"]> = {},
): Layer.Layer<DesktopKeepAwake> =>
  Layer.succeed(
    DesktopKeepAwake,
    DesktopKeepAwake.of({
      setActiveTurns: () => Effect.void,
      removeSource: () => Effect.void,
      settingsChanged: Effect.void,
      ...overrides,
    }),
  );
