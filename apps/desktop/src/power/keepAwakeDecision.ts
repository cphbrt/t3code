/**
 * Whether this machine should currently be held awake for its own agents.
 *
 * Deliberately pure and dependency-free: the decision is the part worth
 * testing exhaustively, and it should be readable without knowing anything
 * about Electron or file descriptors.
 *
 * @module keepAwakeDecision
 */

export interface KeepAwakeInputs {
  /**
   * Turns in flight on backends this desktop started, summed across them.
   *
   * Only local backends report over the control channel, so a window viewing
   * a remote environment contributes nothing here — its agents run on another
   * machine and keeping this one awake would achieve nothing. Background
   * monitoring is likewise excluded upstream, on the server: a watch loop is
   * not a reason to pin a laptop awake, and counting it would recreate the
   * permanent assertion this feature exists to replace.
   */
  readonly activeTurnCount: number;
  readonly onBatteryPower: boolean;
  /** The master toggle, `keepAwakeWhileAgentsRun`. Defaults on. */
  readonly featureEnabled: boolean;
  /** The `keepAwakeOnBattery` override. Defaults off. */
  readonly allowOnBattery: boolean;
}

export const shouldHoldKeepAwake = (inputs: KeepAwakeInputs): boolean => {
  if (!inputs.featureEnabled) return false;
  if (inputs.activeTurnCount <= 0) return false;
  if (inputs.onBatteryPower && !inputs.allowOnBattery) return false;
  return true;
};
