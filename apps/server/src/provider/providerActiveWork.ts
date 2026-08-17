/**
 * Server-side provider-status demand from work the user is already paying for.
 *
 * @module providerActiveWork
 */
import type { ProviderSession } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/**
 * Whether any of a provider instance's live sessions has a turn in flight.
 *
 * Both adapters keep `activeTurnId` on their in-memory session record: it is
 * set when `turn.started` is emitted and cleared when the turn settles or the
 * session closes. That makes it the authoritative "an agent is running right
 * now" signal, with no parallel bookkeeping to drift out of sync.
 */
export const hasActiveTurn = (sessions: ReadonlyArray<ProviderSession>): boolean =>
  sessions.some((session) => session.activeTurnId !== undefined);

/**
 * `hasActiveWork` for `makeManagedServerProvider`, read from the driver's own
 * adapter. Each adapter belongs to exactly one provider instance, so this
 * cannot leak demand from one instance to another.
 */
export const adapterHasActiveWork = (adapter: {
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;
}): Effect.Effect<boolean> => Effect.map(adapter.listSessions(), hasActiveTurn);
