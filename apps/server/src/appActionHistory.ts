import {
  InAppActionHistoryWriteError,
  type AuthSessionId,
  type InAppActionHistoryInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const record = Effect.fn("AppActionHistory.record")(
  function* (sql: SqlClient.SqlClient, sessionId: AuthSessionId, input: InAppActionHistoryInput) {
    const recordedAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
        INSERT OR IGNORE INTO in_app_action_history (
          event_id,
          occurred_at,
          recorded_at,
          session_id,
          client_kind,
          source,
          action,
          shortcut,
          target,
          label,
          route_before,
          route_after
        ) VALUES (
          ${input.eventId},
          ${DateTime.formatIso(input.occurredAt)},
          ${recordedAt},
          ${sessionId},
          ${input.clientKind},
          ${input.source},
          ${input.action},
          ${input.shortcut ?? null},
          ${input.target ?? null},
          ${input.label ?? null},
          ${input.routeBefore ?? null},
          ${input.routeAfter ?? null}
        )
      `;
  },
  Effect.mapError(
    () =>
      new InAppActionHistoryWriteError({
        message: "Failed to record in-app action history.",
      }),
  ),
);
