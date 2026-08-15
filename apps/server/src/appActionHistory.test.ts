import { assert, it } from "@effect/vitest";
import { AuthSessionId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { record } from "./appActionHistory.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";

const layer = it.layer(SqlitePersistenceMemory);

layer("AppActionHistory", (it) => {
  it.effect("appends structured actions indefinitely and deduplicates retried event ids", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const input = {
        eventId: "action-1",
        occurredAt: DateTime.makeUnsafe(1_786_800_000_000),
        clientKind: "desktop-renderer" as const,
        source: "shortcut" as const,
        action: "terminal.toggle",
        shortcut: "⌘J",
        target: "environment-1/thread-1",
        routeBefore: "/environment-1/thread-1",
        routeAfter: "/environment-1/thread-1",
      };

      yield* record(sql, AuthSessionId.make("session-1"), input);
      yield* record(sql, AuthSessionId.make("session-1"), input);

      const rows = yield* sql<{
        readonly eventId: string;
        readonly source: string;
        readonly action: string;
        readonly shortcut: string | null;
        readonly occurredAt: string;
        readonly recordedAt: string;
      }>`
        SELECT
          event_id AS "eventId",
          source,
          action,
          shortcut,
          occurred_at AS "occurredAt",
          recorded_at AS "recordedAt"
        FROM in_app_action_history
      `;

      assert.lengthOf(rows, 1);
      assert.deepInclude(rows[0], {
        eventId: "action-1",
        source: "shortcut",
        action: "terminal.toggle",
        shortcut: "⌘J",
        occurredAt: DateTime.formatIso(input.occurredAt),
      });
      assert.match(rows[0]?.recordedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    }),
  );
});
