import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Records which thread's agent spawned a thread, so the sidebar can nest a
 * delegated thread under its parent across restarts.
 *
 * Nullable with no backfill: every thread that existed before `spawn_thread`
 * was started by a person and has no parent, which is exactly what NULL means
 * here.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "parent_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN parent_thread_id TEXT
    `;
  }

  // The sidebar asks "which threads did this parent spawn?" for every parent
  // it renders, so the lookup is by parent, not by child.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_parent_thread
    ON projection_threads (parent_thread_id)
    WHERE parent_thread_id IS NOT NULL
  `;
});
