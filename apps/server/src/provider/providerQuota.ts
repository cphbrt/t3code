/**
 * How often CPH Code is willing to ask a provider what our account's usage
 * looks like.
 *
 * @module providerQuota
 */
import * as Duration from "effect/Duration";

/**
 * The Executive-set ceiling on *demand-driven* quota probes: work we start
 * because something asked us to, per provider instance. Change it here and
 * every consumer below follows; do not reintroduce a local interval next to a
 * caller.
 *
 * If this is ever lowered, one minute is the hard floor — below that we are
 * making an authenticated network call per instance often enough to look like
 * polling to the provider. `providerQuota.test.ts` enforces the floor.
 *
 * Consumers today:
 *
 * - `mcp/ProviderUsageStatus` throttles the `usage_status` tool's refreshes to
 *   this interval, and treats a reading older than it as stale. That is the
 *   only consumer, and deliberately so: neither driver's status probe caches
 *   its own quota reading, so this one throttle is what bounds both providers
 *   on the caller-driven path.
 *
 * What this deliberately does NOT govern, so nobody reads it as a global
 * guarantee:
 *
 * - Background provider-status polling, whose cadence is the user-configurable
 *   `providerHealthRefreshInterval`. Both providers' quotas ride that probe, so
 *   in practice their numbers can refresh more often than this interval — this
 *   constant bounds only what we initiate on a caller's behalf. A driver that
 *   also applies this floor internally does not make the system safer; it just
 *   adds a second clock of the same period for the tick to beat against.
 * - The web UI's display-staleness threshold in `apps/web/src/providerQuota.ts`,
 *   an independent 20 minutes. That answers "should this look dimmed to a
 *   human", not "may we call the provider", and the two are free to differ.
 */
export const PROVIDER_QUOTA_REFRESH_MIN_INTERVAL: Duration.Duration = Duration.minutes(5);

/** The same interval in milliseconds, for arithmetic against `Clock` readings. */
export const providerQuotaRefreshMinIntervalMillis = (): number =>
  Duration.toMillis(PROVIDER_QUOTA_REFRESH_MIN_INTERVAL);

/**
 * The interval written out for prose that agents and users read, e.g.
 * "5 minutes". `Duration.format` renders "5m", which is fine in a log line and
 * needlessly cryptic in a tool description.
 */
export const providerQuotaRefreshMinIntervalLabel = (): string => {
  const minutes = Duration.toMinutes(PROVIDER_QUOTA_REFRESH_MIN_INTERVAL);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
};
