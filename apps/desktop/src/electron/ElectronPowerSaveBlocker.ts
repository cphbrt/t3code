import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

/**
 * The one wake assertion this app is ever allowed to take.
 *
 * Electron documents `prevent-app-suspension` as "Prevent the application
 * from being suspended. Keeps system active but allows screen to be turned
 * off", which on macOS is the `PreventUserIdleSystemSleep` IOKit assertion —
 * the same single assertion bare `caffeinate -i` takes, and the only one the
 * work actually needs. Concretely, it does NOT prevent:
 *
 *   - display sleep or screen dimming
 *   - the screen lock or screensaver
 *   - sleep from closing the lid
 *
 * The other blocker type, `prevent-display-sleep`, does keep the screen on,
 * and is deliberately never used here: nothing about an agent making progress
 * requires a lit panel, and Electron gives it higher precedence, so holding
 * both would silently upgrade us to keeping the display awake too.
 *
 * The assertion is owned by the OS on behalf of this process, so it is
 * released for free when the app quits or crashes. There is no teardown path
 * to get wrong and no way to strand the machine awake.
 */
export const KEEP_AWAKE_BLOCKER_TYPE = "prevent-app-suspension" as const;

export class ElectronPowerSaveBlocker extends Context.Service<
  ElectronPowerSaveBlocker,
  {
    readonly start: (type: typeof KEEP_AWAKE_BLOCKER_TYPE) => Effect.Effect<number>;
    readonly stop: (id: number) => Effect.Effect<boolean>;
    readonly isStarted: (id: number) => Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/electron/ElectronPowerSaveBlocker") {}

export const make = ElectronPowerSaveBlocker.of({
  start: (type) => Effect.sync(() => Electron.powerSaveBlocker.start(type)),
  stop: (id) => Effect.sync(() => Electron.powerSaveBlocker.stop(id)),
  isStarted: (id) => Effect.sync(() => Electron.powerSaveBlocker.isStarted(id)),
});

export const layer = Layer.succeed(ElectronPowerSaveBlocker, make);
