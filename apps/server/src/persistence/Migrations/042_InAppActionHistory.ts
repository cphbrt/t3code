import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS in_app_action_history (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      occurred_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      session_id TEXT NOT NULL,
      client_kind TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('mouse', 'shortcut')),
      action TEXT NOT NULL,
      shortcut TEXT,
      target TEXT,
      label TEXT,
      route_before TEXT,
      route_after TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_in_app_action_history_occurred_at
      ON in_app_action_history (occurred_at, sequence)
  `;
});
