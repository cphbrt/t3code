import { type ProviderEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

/**
 * Hard-exhaustion detection for Codex, validated against a real
 * exhausted-account capture (2026-08-15). Observed behavior:
 *
 * - The definitive signal is an `error` notification (mirrored on
 *   `turn/completed`) with the structured enum
 *   `codexErrorInfo: "usageLimitExceeded"` and `willRetry: false`. Its
 *   `message` carries the reset time only as human text in local time
 *   ("... try again at Aug 19th, 2026 11:34 PM.").
 * - `account/rateLimits/updated` telemetry on an established session carries
 *   the machine-readable reset (`primary: { resetsAt, usedPercent: 100 }`),
 *   but fresh sessions may receive a sparse snapshot with no windows at all
 *   (`limitId: "premium"`, `primary: null`) and `rateLimitReachedType` stayed
 *   null throughout. Telemetry alone therefore cannot declare exhaustion; it
 *   only refines the reset time once the error has been seen.
 * - OpenAI enforces the limit at turn start: turns already in flight keep
 *   running and complete normally, so a successful turn must not clear the
 *   limited state.
 */

function readPayload<A>(
  schema: Schema.Schema<A>,
  payload: ProviderEvent["payload"],
): A | undefined {
  const isPayload = Schema.is(schema);
  return isPayload(payload) ? payload : undefined;
}

export type CodexUsageLimitUpdate =
  | { readonly status: "limited"; readonly resetsAt: string }
  | { readonly status: "available" };

type RateLimitSnapshot =
  EffectCodexSchema.V2AccountRateLimitsUpdatedNotification__RateLimitSnapshot;
type RateLimitWindow = EffectCodexSchema.V2AccountRateLimitsUpdatedNotification__RateLimitWindow;

interface ExhaustedWindow {
  /** limitId + window duration; distinguishes e.g. weekly vs five-hour. */
  readonly key: string;
  readonly resetsAtMs: number;
}

function windowKey(snapshot: RateLimitSnapshot, window: RateLimitWindow): string {
  return `${snapshot.limitId ?? ""}:${window.windowDurationMins ?? ""}`;
}

function snapshotWindows(
  snapshot: RateLimitSnapshot,
): ReadonlyArray<{ readonly key: string; readonly window: RateLimitWindow }> {
  const windows: Array<{ key: string; window: RateLimitWindow }> = [];
  for (const window of [snapshot.primary, snapshot.secondary]) {
    if (window !== undefined && window !== null) {
      windows.push({ key: windowKey(snapshot, window), window });
    }
  }
  return windows;
}

function exhaustedWindowResetMs(window: RateLimitWindow): number | undefined {
  const resetsAt = window.resetsAt;
  if (window.usedPercent >= 100 && resetsAt !== undefined && resetsAt !== null) {
    return Number.isFinite(resetsAt) ? resetsAt * 1_000 : undefined;
  }
  return undefined;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * Parses the human reset time out of a Codex usage-limit error message, e.g.
 * "... or try again at Aug 19th, 2026 11:34 PM.". The Codex CLI renders this
 * in the machine's local time zone, so the local Date constructor is correct.
 * Returns epoch millis, or undefined when the message does not match the
 * observed shape (we never guess).
 */
export function parseCodexUsageLimitResetText(message: string): number | undefined {
  const match =
    /try again at\s+([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(
      message,
    );
  if (!match) {
    return undefined;
  }
  const [, monthName, dayText, yearText, hourText, minuteText, meridiem] = match;
  if (!monthName || !dayText || !yearText || !hourText || !minuteText || !meridiem) {
    return undefined;
  }
  const month = MONTHS[monthName.slice(0, 3).toLowerCase()];
  if (month === undefined) {
    return undefined;
  }
  const hour12 = Number(hourText);
  if (hour12 < 1 || hour12 > 12) {
    return undefined;
  }
  const hour = meridiem.toUpperCase() === "PM" ? (hour12 % 12) + 12 : hour12 % 12;
  const zoned = DateTime.makeZoned(
    {
      year: Number(yearText),
      month,
      day: Number(dayText),
      hour,
      minute: Number(minuteText),
      second: 0,
      millisecond: 0,
    },
    { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
  );
  return Option.isSome(zoned) ? DateTime.toEpochMillis(zoned.value) : undefined;
}

function isUsageLimitErrorInfo(info: unknown): boolean {
  return info === "usageLimitExceeded";
}

/**
 * Per-instance tracker fed every native Codex app-server event. Returns a
 * provider-neutral usage-limit update when the instance's hard-exhaustion
 * state changes, to be attached to an `account.rate-limits.updated` runtime
 * event; the shared registry and UI take it from there.
 */
export class CodexUsageLimitTracker {
  /** Exhausted (>=100%) windows seen in telemetry, latest reset per key. */
  private readonly exhaustedWindows = new Map<string, ExhaustedWindow>();
  private limitedResetsAtMs: number | undefined;

  observe(event: ProviderEvent): CodexUsageLimitUpdate | undefined {
    if (event.kind !== "notification") {
      return undefined;
    }
    if (event.method === "account/rateLimits/updated") {
      const payload = readPayload(
        EffectCodexSchema.V2AccountRateLimitsUpdatedNotification,
        event.payload,
      );
      return payload ? this.observeRateLimits(payload.rateLimits, event.createdAt) : undefined;
    }
    if (event.method === "error") {
      const payload = readPayload(EffectCodexSchema.V2ErrorNotification, event.payload);
      if (!payload || payload.willRetry || !isUsageLimitErrorInfo(payload.error.codexErrorInfo)) {
        return undefined;
      }
      return this.observeUsageLimitError(payload.error.message, event.createdAt);
    }
    if (event.method === "turn/completed") {
      const payload = readPayload(EffectCodexSchema.V2TurnCompletedNotification, event.payload);
      const error = payload?.turn.error;
      if (!error || !isUsageLimitErrorInfo(error.codexErrorInfo)) {
        return undefined;
      }
      return this.observeUsageLimitError(error.message, event.createdAt);
    }
    return undefined;
  }

  private observeRateLimits(
    snapshot: RateLimitSnapshot,
    observedAtIso: string,
  ): CodexUsageLimitUpdate | undefined {
    const observedAtMs = Date.parse(observedAtIso);
    for (const [key, window] of this.exhaustedWindows) {
      if (window.resetsAtMs <= observedAtMs) {
        this.exhaustedWindows.delete(key);
      }
    }
    let recoveredTrackedWindow = false;
    for (const { key, window } of snapshotWindows(snapshot)) {
      if (window.usedPercent >= 100) {
        const resetsAtMs = exhaustedWindowResetMs(window);
        if (resetsAtMs !== undefined) {
          this.exhaustedWindows.set(key, { key, resetsAtMs });
        }
      } else if (this.exhaustedWindows.delete(key)) {
        // Updates are sparse: a window recovering below 100% is explicit
        // evidence for that window only; absent windows stay tracked.
        recoveredTrackedWindow = true;
      }
    }
    if (this.limitedResetsAtMs === undefined) {
      return undefined;
    }
    // Provider-reported credits becoming available (e.g. the user bought
    // credits) makes the account usable again even while windows stay full.
    const credits = snapshot.credits;
    if (credits && (credits.hasCredits === true || credits.unlimited === true)) {
      return this.clearLimited();
    }
    const bestReset = this.bestFutureWindowResetMs(observedAtMs);
    if (bestReset === undefined) {
      // Clear only on explicit evidence: every window we saw exhausted has
      // recovered below 100%. A healthy window in a sparse snapshot that
      // never covered the exhausted one is not evidence (and a limited state
      // established from error text alone waits for credits or expiry).
      if (this.exhaustedWindows.size === 0 && recoveredTrackedWindow) {
        return this.clearLimited();
      }
      return undefined;
    }
    if (bestReset !== this.limitedResetsAtMs) {
      // Refine the reset with machine-readable telemetry (the error message
      // only carries local-time text).
      this.limitedResetsAtMs = bestReset;
      return { status: "limited", resetsAt: DateTime.formatIso(DateTime.makeUnsafe(bestReset)) };
    }
    return undefined;
  }

  private observeUsageLimitError(
    message: string,
    observedAtIso: string,
  ): CodexUsageLimitUpdate | undefined {
    const observedAtMs = Date.parse(observedAtIso);
    const resetsAtMs =
      this.bestFutureWindowResetMs(observedAtMs) ??
      this.parseFutureResetText(message, observedAtMs);
    if (resetsAtMs === undefined) {
      // No trustworthy reset time; the fork policy is to omit the state
      // rather than guess. The turn still fails visibly on its own thread.
      return undefined;
    }
    if (this.limitedResetsAtMs === resetsAtMs) {
      // The same failure arrives on both the `error` notification and
      // `turn/completed`; emit once.
      return undefined;
    }
    this.limitedResetsAtMs = resetsAtMs;
    return { status: "limited", resetsAt: DateTime.formatIso(DateTime.makeUnsafe(resetsAtMs)) };
  }

  private parseFutureResetText(message: string, observedAtMs: number): number | undefined {
    const parsed = parseCodexUsageLimitResetText(message);
    return parsed !== undefined && parsed > observedAtMs ? parsed : undefined;
  }

  /**
   * The account frees up once every exhausted window has reset, so the
   * governing reset is the latest one still in the future.
   */
  private bestFutureWindowResetMs(observedAtMs: number): number | undefined {
    let best: number | undefined;
    for (const window of this.exhaustedWindows.values()) {
      if (window.resetsAtMs <= observedAtMs) {
        continue;
      }
      if (best === undefined || window.resetsAtMs > best) {
        best = window.resetsAtMs;
      }
    }
    return best;
  }

  private clearLimited(): CodexUsageLimitUpdate {
    this.limitedResetsAtMs = undefined;
    this.exhaustedWindows.clear();
    return { status: "available" };
  }
}
