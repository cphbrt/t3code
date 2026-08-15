import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_prompt_cache_observations (
      observation_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      model TEXT NOT NULL,
      idle_gap_ms INTEGER NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('hit', 'miss')),
      cacheable_tokens INTEGER NOT NULL,
      cached_input_tokens INTEGER NOT NULL,
      cache_write_input_tokens INTEGER NOT NULL,
      observed_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_prompt_cache_observations_profile_outcome_time
    ON projection_prompt_cache_observations (
      provider_instance_id,
      model,
      outcome,
      observed_at DESC
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_prompt_cache_profiles (
      provider_instance_id TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      estimated_ttl_ms INTEGER NOT NULL,
      observed_warm_through_ms INTEGER,
      observed_cold_from_ms INTEGER,
      hit_sample_count INTEGER NOT NULL,
      miss_sample_count INTEGER NOT NULL,
      basis TEXT NOT NULL CHECK (basis IN ('default', 'learning', 'learned')),
      confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (provider_instance_id, model)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_prompt_cache (
      thread_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      model TEXT NOT NULL,
      last_cache_activity_at TEXT NOT NULL,
      cacheable_tokens INTEGER NOT NULL,
      last_outcome TEXT CHECK (last_outcome IN ('hit', 'miss', 'partial')),
      last_cached_input_tokens INTEGER NOT NULL,
      last_cache_write_input_tokens INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_prompt_cache_profile
    ON projection_thread_prompt_cache (provider_instance_id, model)
  `;
});
