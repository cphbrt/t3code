import { assert, describe, it } from "@effect/vitest";

import { shouldHoldKeepAwake } from "./keepAwakeDecision.ts";

const base = {
  activeTurnCount: 1,
  onBatteryPower: false,
  featureEnabled: true,
  allowOnBattery: false,
};

describe("shouldHoldKeepAwake", () => {
  it("holds while agents run on AC power with the feature on", () => {
    assert.isTrue(shouldHoldKeepAwake(base));
  });

  it("does not hold when nothing is running", () => {
    assert.isFalse(shouldHoldKeepAwake({ ...base, activeTurnCount: 0 }));
  });

  it("does not hold when the feature is off, whatever else is true", () => {
    assert.isFalse(
      shouldHoldKeepAwake({
        ...base,
        featureEnabled: false,
        activeTurnCount: 5,
        allowOnBattery: true,
      }),
    );
  });

  it("does not hold on battery by default", () => {
    assert.isFalse(shouldHoldKeepAwake({ ...base, onBatteryPower: true }));
  });

  it("holds on battery when the override is on", () => {
    assert.isTrue(shouldHoldKeepAwake({ ...base, onBatteryPower: true, allowOnBattery: true }));
  });

  // The whole truth table, so no combination is decided by accident.
  it("covers every combination of the four inputs", () => {
    const bools = [false, true];
    for (const featureEnabled of bools) {
      for (const onBatteryPower of bools) {
        for (const allowOnBattery of bools) {
          for (const activeTurnCount of [0, 1, 4]) {
            const expected =
              featureEnabled && activeTurnCount > 0 && (!onBatteryPower || allowOnBattery);
            assert.strictEqual(
              shouldHoldKeepAwake({
                featureEnabled,
                onBatteryPower,
                allowOnBattery,
                activeTurnCount,
              }),
              expected,
              JSON.stringify({ featureEnabled, onBatteryPower, allowOnBattery, activeTurnCount }),
            );
          }
        }
      }
    }
  });
});
