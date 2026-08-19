import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_artifacts (
      artifact_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      path TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      read_at TEXT,
      starred_at TEXT,
      sequence INTEGER
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_artifacts_thread_recorded
    ON projection_thread_artifacts(thread_id, recorded_at)
  `;

  // Serves the unread recount in refreshThreadShellSummary without scanning a
  // thread's whole artifact history.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_artifacts_thread_unread
    ON projection_thread_artifacts(thread_id, read_at)
  `;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "unread_artifact_count")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN unread_artifact_count INTEGER NOT NULL DEFAULT 0
    `;
  }
});
