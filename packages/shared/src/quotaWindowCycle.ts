/**
 * Whether a provider allowance window renews on a fixed cycle or rolls
 * continuously, plus the one piece of cycle geometry that both answers share.
 *
 * Providers describe every window the same way — a percent used and an instant
 * it "resets" — but two very different things hide behind that shape:
 *
 * - A **fixed** cycle has a real beginning and a real end. Claude's five-hour
 *   allowance is one: `resetsAt` holds still while observations march toward
 *   it, then jumps a whole duration forward when the cycle rolls over. Asking
 *   "how far through this window am I" is meaningful, because there is a
 *   window to be part-way through.
 * - A **rolling** window has no cycle at all. Its `resetsAt` advances with the
 *   clock, so `resetsAt - duration` is always approximately *now*. Elapsed
 *   fraction is permanently ~0 and the question is meaningless.
 *
 * A single live snapshot cannot tell the two apart: both report a reset in the
 * future. Only a series of observations can, which is why this classifier
 * takes history and why the server — the only side that keeps quota history —
 * publishes the answer on the wire.
 *
 * Everything here is pure and clock-free; callers pass instants explicitly.
 *
 * @module quotaWindowCycle
 */
import type { ServerProviderQuotaWindowCycleKind } from "@t3tools/contracts";

/**
 * How a window renews. Re-exported from the wire contract so the classifier
 * and the field it populates can never drift apart.
 */
export type QuotaWindowCycleKind = ServerProviderQuotaWindowCycleKind;

/** One observation of a window's stated reset instant. */
export interface QuotaCycleObservation {
  readonly observedAtMs: number;
  /** The provider's stated reset instant, when it reported one. */
  readonly resetsAtMs: number | null | undefined;
}

/**
 * How far `resetsAt - observedAt` may sit from a full duration and still read
 * as "the whole window is still ahead of me".
 *
 * A fixed cycle's remaining time sweeps the entire range from a full duration
 * down to zero, so it leaves this band as soon as it is observed past its own
 * first tenth. A rolling window never leaves it.
 */
export const ROLLING_OFFSET_TOLERANCE_FRACTION = 0.1;

/**
 * How much of a window's own duration the observations must span before a
 * "rolling" verdict is allowed.
 *
 * Without this, three probes a quarter-hour apart at the top of a fresh
 * seven-day fixed cycle all report ~seven days remaining and look exactly like
 * a rolling window. Requiring the history to cover a quarter of the duration
 * means a fixed cycle has had room to visibly age before we rule it out.
 */
export const ROLLING_MINIMUM_SPAN_FRACTION = 0.25;

/** Fewer observations than this cannot support a "rolling" verdict. */
export const ROLLING_MINIMUM_SAMPLES = 4;

/**
 * Fewer observations than this cannot support a "fixed" verdict either.
 *
 * One observation of a part-spent window is logically proof enough — a
 * rolling window is never part-way through anything — but a lone reading is
 * also exactly what a garbled or half-written provider payload looks like, so
 * a second observation is required to corroborate it.
 */
export const FIXED_MINIMUM_SAMPLES = 2;

/**
 * When the cycle that ends at `resetsAtMs` began, given how long it runs.
 *
 * This is the only derivation of a window's start anywhere in the product:
 * providers report the end and the length, never the beginning. Both inputs
 * are optional on the wire, and a missing one means there is no start to
 * speak of rather than a start of zero.
 */
export function quotaWindowStartMs(
  resetsAtMs: number | null | undefined,
  durationMs: number | null | undefined,
): number | undefined {
  if (resetsAtMs === null || resetsAtMs === undefined || !Number.isFinite(resetsAtMs)) {
    return undefined;
  }
  if (durationMs === null || durationMs === undefined || !Number.isFinite(durationMs)) {
    return undefined;
  }
  if (durationMs <= 0) return undefined;
  return resetsAtMs - durationMs;
}

/**
 * Classifies a window from its own observation history.
 *
 * The discriminating measurement is the *offset* — `resetsAt - observedAt` —
 * at each observation. A fixed cycle's offset counts down from a full duration
 * to zero and starts over; a rolling window's is pinned at a full duration
 * forever. So a single observation taken anywhere but the very top of a fixed
 * cycle is enough to prove the window is fixed, while proving it rolling needs
 * every observation to sit at the top *and* enough history for a fixed cycle
 * to have visibly aged.
 *
 * The bias is deliberate. A false "rolling" hides pace on a window that has
 * one; a false "fixed" shows a meaningless number. Neither is good, but
 * `unknown` is the honest third answer and both callers treat it as "carry on
 * as if fixed", which is what the product did before this existed. So the
 * verdict only moves off `unknown` on evidence, and only reaches `rolling` on
 * unanimous evidence.
 */
export function classifyQuotaWindowCycle(input: {
  /**
   * Accepted as an iterable so a caller holding a large in-memory history can
   * hand over its own values without first copying them into an array.
   */
  readonly observations: Iterable<QuotaCycleObservation>;
  readonly durationMs: number | null | undefined;
}): QuotaWindowCycleKind {
  const durationMs = input.durationMs;
  // With no stated duration there is no offset to compare against, so neither
  // verdict is reachable. This is also why an adapter that omits the length
  // keeps today's behaviour rather than acquiring a guess.
  if (durationMs === null || durationMs === undefined) return "unknown";
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "unknown";

  const tolerance = durationMs * ROLLING_OFFSET_TOLERANCE_FRACTION;
  const pinnedFloor = durationMs - tolerance;
  const pinnedCeiling = durationMs + tolerance;

  let count = 0;
  let sawWindowAge = false;
  let sawImpossibleOffset = false;
  let earliestMs = Number.POSITIVE_INFINITY;
  let latestMs = Number.NEGATIVE_INFINITY;

  for (const observation of input.observations) {
    const { observedAtMs, resetsAtMs } = observation;
    if (!Number.isFinite(observedAtMs)) continue;
    if (resetsAtMs === null || resetsAtMs === undefined || !Number.isFinite(resetsAtMs)) continue;

    const offset = resetsAtMs - observedAtMs;
    if (offset < pinnedFloor) sawWindowAge = true;
    else if (offset > pinnedCeiling) sawImpossibleOffset = true;

    count += 1;
    if (observedAtMs < earliestMs) earliestMs = observedAtMs;
    if (observedAtMs > latestMs) latestMs = observedAtMs;

    // Corroborated proof of a fixed cycle cannot be overturned by anything
    // later in the series, so a long history stops being read here.
    if (sawWindowAge && count >= FIXED_MINIMUM_SAMPLES) return "fixed";
  }

  if (sawWindowAge) return "unknown";
  if (sawImpossibleOffset) return "unknown";
  if (count < ROLLING_MINIMUM_SAMPLES) return "unknown";
  if (latestMs - earliestMs < durationMs * ROLLING_MINIMUM_SPAN_FRACTION) return "unknown";
  return "rolling";
}
