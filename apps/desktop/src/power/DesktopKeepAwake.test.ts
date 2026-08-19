import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({
  powerMonitor: {
    on: () => undefined,
    removeListener: () => undefined,
    isOnBatteryPower: () => false,
  },
  powerSaveBlocker: {
    start: () => 1,
    stop: () => true,
    isStarted: () => true,
  },
}));

const { DesktopKeepAwake, make } = await import("./DesktopKeepAwake.ts");
const { ElectronPowerSaveBlocker } = await import("../electron/ElectronPowerSaveBlocker.ts");
const { ElectronPowerMonitor } = await import("../electron/ElectronPowerMonitor.ts");
const DesktopClientSettingsModule = await import("../settings/DesktopClientSettings.ts");

interface BlockerLog {
  readonly started: Array<string>;
  readonly stopped: Array<number>;
  heldCount: number;
}

/**
 * The assertion is not observable through the service (it has no read API by
 * design), so tests assert on what the blocker was actually asked to do.
 */
const makeHarness = (input: {
  readonly settings?: () => Partial<ClientSettings>;
  readonly onBatteryPower?: boolean;
}) =>
  Effect.gen(function* () {
    const log: BlockerLog = { started: [], stopped: [], heldCount: 0 };
    const heldIds = new Set<number>();
    let nextId = 0;

    const service = yield* make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            ElectronPowerSaveBlocker,
            ElectronPowerSaveBlocker.of({
              start: (type) =>
                Effect.sync(() => {
                  log.started.push(type);
                  nextId += 1;
                  heldIds.add(nextId);
                  log.heldCount = heldIds.size;
                  return nextId;
                }),
              stop: (id) =>
                Effect.sync(() => {
                  log.stopped.push(id);
                  heldIds.delete(id);
                  log.heldCount = heldIds.size;
                  return true;
                }),
              isStarted: (id) => Effect.sync(() => heldIds.has(id)),
            }),
          ),
          Layer.succeed(
            ElectronPowerMonitor,
            ElectronPowerMonitor.of({
              isOnBatteryPower: Effect.succeed(input.onBatteryPower ?? false),
              getSystemIdleTime: Effect.succeed(0),
              getSystemIdleState: () => Effect.succeed("active" as const),
              getCurrentThermalState: Effect.succeed("nominal" as const),
              onSimpleEvent: () => Effect.void,
              onThermalStateChange: () => Effect.void,
              onSpeedLimitChange: () => Effect.void,
            }),
          ),
          Layer.succeed(
            DesktopClientSettingsModule.DesktopClientSettings,
            DesktopClientSettingsModule.DesktopClientSettings.of({
              get: Effect.sync(() =>
                Option.some({
                  ...DEFAULT_CLIENT_SETTINGS,
                  ...input.settings?.(),
                } satisfies ClientSettings),
              ),
              set: () => Effect.void,
            }),
          ),
        ),
      ),
    );
    return { service, log };
  });

describe("DesktopKeepAwake", () => {
  it.effect("takes exactly one prevent-app-suspension assertion when a turn starts", () =>
    Effect.gen(function* () {
      const { service, log } = yield* makeHarness({});
      yield* service.setActiveTurns("primary", 1);

      assert.deepStrictEqual(log.started, ["prevent-app-suspension"]);
      assert.strictEqual(log.heldCount, 1);
    }),
  );

  it.effect("never asks for prevent-display-sleep", () =>
    Effect.gen(function* () {
      const { service, log } = yield* makeHarness({});
      yield* service.setActiveTurns("primary", 2);
      yield* service.setActiveTurns("wsl", 1);

      assert.isFalse(log.started.includes("prevent-display-sleep"));
    }),
  );

  it.effect("does not take a second assertion while one is already held", () =>
    Effect.gen(function* () {
      const { service, log } = yield* makeHarness({});
      yield* service.setActiveTurns("primary", 1);
      yield* service.setActiveTurns("primary", 3);
      yield* service.setActiveTurns("wsl", 2);

      assert.strictEqual(log.started.length, 1);
      assert.strictEqual(log.heldCount, 1);
    }),
  );

  it.effect("releases only when the last turn across all local backends ends", () =>
    Effect.gen(function* () {
      const { service, log } = yield* makeHarness({});
      yield* service.setActiveTurns("primary", 1);
      yield* service.setActiveTurns("wsl", 2);

      yield* service.setActiveTurns("primary", 0);
      assert.strictEqual(log.heldCount, 1);

      yield* service.setActiveTurns("wsl", 0);
      assert.strictEqual(log.heldCount, 0);
      assert.strictEqual(log.stopped.length, 1);
    }),
  );

  it.effect("releases when a backend disappears mid-turn", () =>
    Effect.gen(function* () {
      const { service, log } = yield* makeHarness({});
      yield* service.setActiveTurns("primary", 1);
      yield* service.removeSource("primary");

      assert.strictEqual(log.heldCount, 0);
    }),
  );

  it.effect("holds nothing on battery by default", () =>
    Effect.gen(function* () {
      const { service, log } = yield* makeHarness({ onBatteryPower: true });
      yield* service.setActiveTurns("primary", 1);

      assert.deepStrictEqual(log.started, []);
    }),
  );

  it.effect("holds on battery when the override is enabled", () =>
    Effect.gen(function* () {
      const { service, log } = yield* makeHarness({
        onBatteryPower: true,
        settings: () => ({ keepAwakeOnBattery: true }),
      });
      yield* service.setActiveTurns("primary", 1);

      assert.deepStrictEqual(log.started, ["prevent-app-suspension"]);
    }),
  );

  it.effect("holds nothing when the feature is turned off", () =>
    Effect.gen(function* () {
      const { service, log } = yield* makeHarness({
        settings: () => ({ keepAwakeWhileAgentsRun: false }),
      });
      yield* service.setActiveTurns("primary", 4);

      assert.deepStrictEqual(log.started, []);
    }),
  );

  it.effect("turning the setting off drops an assertion that is already held", () =>
    Effect.gen(function* () {
      const current = { enabled: true };
      const { service, log } = yield* makeHarness({
        settings: () => ({ keepAwakeWhileAgentsRun: current.enabled }),
      });

      yield* service.setActiveTurns("primary", 1);
      assert.strictEqual(log.heldCount, 1);

      current.enabled = false;
      yield* service.settingsChanged;

      assert.strictEqual(log.heldCount, 0);
      assert.strictEqual(log.stopped.length, 1);
    }),
  );
});

describe("DesktopKeepAwake service tag", () => {
  it("is registered under a stable key", () => {
    assert.strictEqual(DesktopKeepAwake.key, "@t3tools/desktop/power/DesktopKeepAwake");
  });
});
