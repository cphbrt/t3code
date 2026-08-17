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
 *   this interval, and treats a reading older than it as stale. That throttle
 *   is what bounds Codex, whose status probe has no cache of its own.
 * - `Drivers/ClaudeDriver` sets its capabilities-probe cache TTL from it, so
 *   the cache that actually serves Claude's usage numbers cannot drift away
 *   from the policy the rest of the system believes it is following.
 *
 * What this deliberately does NOT govern, so nobody reads it as a global
 * guarantee:
 *
 * - Background provider-status polling, whose cadence is the user-configurable
 *   `providerHealthRefreshInterval`. Codex's quota rides that probe too, so in
 *   practice its numbers can refresh more often than this interval — this
 *   constant bounds only what we initiate on a caller's behalf.
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
