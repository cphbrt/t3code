import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Holds a thread's prompt that waits for a provider usage reset, so the wait
 * survives a server restart.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "scheduled_turn_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN scheduled_turn_json TEXT
    `;
  }
});
