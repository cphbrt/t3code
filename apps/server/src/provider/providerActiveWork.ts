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
 * How many of these sessions have a turn in flight.
 *
 * The same authoritative signal as `hasActiveTurn`, kept as a count because
 * the desktop shell reports "2 agents running" to the user. Deliberately
 * counts turns only: a thread merely watching something in the background has
 * no `activeTurnId`, and treating it as work would pin a laptop awake forever.
 */
export const countActiveTurns = (sessions: ReadonlyArray<ProviderSession>): number =>
  sessions.reduce((total, session) => (session.activeTurnId === undefined ? total : total + 1), 0);

/**
 * `hasActiveWork` for `makeManagedServerProvider`, read from the driver's own
 * adapter. Each adapter belongs to exactly one provider instance, so this
 * cannot leak demand from one instance to another.
 */
export const adapterHasActiveWork = (adapter: {
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;
}): Effect.Effect<boolean> => Effect.map(adapter.listSessions(), hasActiveTurn);
