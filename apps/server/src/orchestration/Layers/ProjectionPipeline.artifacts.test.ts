import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { ServerConfig } from "../../config.ts";
import {
  THREAD_DETAIL_ARTIFACT_EVENT_TYPES,
  THREAD_DETAIL_EVENT_TYPES,
  THREAD_DETAIL_WATERMARK_EVENT_TYPES,
  isThreadDetailEvent,
} from "../threadDetailEvents.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");

// One in-memory database is shared across the whole `it.layer` block, so each
// test works on its own thread rather than assuming an empty projection.
let nextThreadOrdinal = 0;
const nextThreadId = () => {
  nextThreadOrdinal += 1;
  return ThreadId.make(`thread-${nextThreadOrdinal}`);
};

const TestLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provideMerge(OrchestrationProjectionPipelineLive),
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provideMerge(ThreadPlanProgress.layer),
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-projection-artifacts-test-" }),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

let nextEventId = 0;
const makeEvent = (
  threadId: ThreadId,
  type: OrchestrationEvent["type"],
  payload: unknown,
  occurredAt = NOW,
): Omit<OrchestrationEvent, "sequence"> => {
  nextEventId += 1;
  const id = `evt-${nextEventId}`;
  return {
    type,
    eventId: EventId.make(id),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt,
    commandId: CommandId.make(`cmd-${nextEventId}`),
    causationEventId: null,
    correlationId: CommandId.make(`cmd-${nextEventId}`),
    metadata: {},
    payload,
  } as Omit<OrchestrationEvent, "sequence">;
};

const seedThread = (eventStore: OrchestrationEventStore["Service"], threadId: ThreadId) =>
  Effect.gen(function* () {
    yield* eventStore.append({
      ...makeEvent(threadId, "project.created", {
        projectId: PROJECT_ID,
        title: "Project 1",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
      }),
      aggregateKind: "project",
      aggregateId: PROJECT_ID,
    });
    yield* eventStore.append(
      makeEvent(threadId, "thread.created", {
        threadId,
        projectId: PROJECT_ID,
        title: "Thread 1",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
  });

interface ArtifactRow {
  readonly artifactId: string;
  readonly path: string;
  readonly readAt: string | null;
  readonly starredAt: string | null;
}

it.layer(TestLayer)("artifact projection", (it) => {
  it.effect("persists a recorded artifact and counts it as unread on the shell row", () =>
    Effect.gen(function* () {
      const pipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;

      const threadId = nextThreadId();
      yield* seedThread(eventStore, threadId);
      yield* eventStore.append(
        makeEvent(threadId, "thread.artifact-recorded", {
          threadId,
          artifact: {
            id: "artifact-1",
            path: "/workspace/example/review.md",
            recordedAt: NOW,
            readAt: null,
            starredAt: null,
          },
        }),
      );
      yield* pipeline.bootstrap;

      const rows = yield* sql<ArtifactRow>`
        SELECT
          artifact_id AS "artifactId",
          path,
          read_at AS "readAt",
          starred_at AS "starredAt"
        FROM projection_thread_artifacts
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(rows, [
        {
          artifactId: "artifact-1",
          path: "/workspace/example/review.md",
          readAt: null,
          starredAt: null,
        },
      ]);

      const threadRows = yield* sql<{ readonly unreadArtifactCount: number }>`
        SELECT unread_artifact_count AS "unreadArtifactCount" FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(threadRows, [{ unreadArtifactCount: 1 }]);
    }),
  );

  it.effect("clears and restores the unread count as the artifact is read and unread", () =>
    Effect.gen(function* () {
      const pipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;

      const threadId = nextThreadId();
      yield* seedThread(eventStore, threadId);
      yield* eventStore.append(
        makeEvent(threadId, "thread.artifact-recorded", {
          threadId,
          artifact: {
            id: "artifact-2",
            path: "/workspace/example/shot.png",
            recordedAt: NOW,
            readAt: null,
            starredAt: null,
          },
        }),
      );
      yield* eventStore.append(
        makeEvent(threadId, "thread.artifact-read-set", {
          threadId,
          artifactId: "artifact-2",
          readAt: "2026-01-01T00:05:00.000Z",
        }),
      );
      yield* pipeline.bootstrap;

      const readRows = yield* sql<{ readonly unreadArtifactCount: number }>`
        SELECT unread_artifact_count AS "unreadArtifactCount" FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(readRows, [{ unreadArtifactCount: 0 }]);

      // Marking unread is the same event with a null readAt, and must restore
      // the badge rather than being a one-way door.
      const unreadEvent = yield* eventStore.append(
        makeEvent(threadId, "thread.artifact-read-set", {
          threadId,
          artifactId: "artifact-2",
          readAt: null,
        }),
      );
      yield* pipeline.projectEvent(unreadEvent);

      const unreadRows = yield* sql<{ readonly unreadArtifactCount: number }>`
        SELECT unread_artifact_count AS "unreadArtifactCount" FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(unreadRows, [{ unreadArtifactCount: 1 }]);
    }),
  );

  it.effect("stars in place without touching read state or the thread's updatedAt", () =>
    Effect.gen(function* () {
      const pipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;

      const threadId = nextThreadId();
      yield* seedThread(eventStore, threadId);
      yield* eventStore.append(
        makeEvent(threadId, "thread.artifact-recorded", {
          threadId,
          artifact: {
            id: "artifact-3",
            path: "/workspace/example/clip.mov",
            recordedAt: NOW,
            readAt: null,
            starredAt: null,
          },
        }),
      );
      yield* pipeline.bootstrap;

      const beforeRows = yield* sql<{ readonly updatedAt: string }>`
        SELECT updated_at AS "updatedAt" FROM projection_threads
        WHERE thread_id = ${threadId}
      `;

      const starEvent = yield* eventStore.append(
        makeEvent(
          threadId,
          "thread.artifact-starred-set",
          {
            threadId,
            artifactId: "artifact-3",
            starredAt: "2026-01-02T00:00:00.000Z",
          },
          "2026-01-02T00:00:00.000Z",
        ),
      );
      yield* pipeline.projectEvent(starEvent);

      const rows = yield* sql<ArtifactRow>`
        SELECT
          artifact_id AS "artifactId",
          path,
          read_at AS "readAt",
          starred_at AS "starredAt"
        FROM projection_thread_artifacts
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(rows, [
        {
          artifactId: "artifact-3",
          path: "/workspace/example/clip.mov",
          readAt: null,
          starredAt: "2026-01-02T00:00:00.000Z",
        },
      ]);

      const afterRows = yield* sql<{ readonly updatedAt: string }>`
        SELECT updated_at AS "updatedAt" FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      // Starring must not float the thread in the sidebar.
      assert.deepEqual(afterRows, beforeRows);
    }),
  );

  it.effect("serves artifacts on the thread detail and the count on the shell", () =>
    Effect.gen(function* () {
      const pipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const threadId = nextThreadId();
      yield* seedThread(eventStore, threadId);
      yield* eventStore.append(
        makeEvent(threadId, "thread.artifact-recorded", {
          threadId,
          artifact: {
            id: "artifact-4",
            path: "/workspace/example/review.md",
            recordedAt: NOW,
            readAt: null,
            starredAt: null,
          },
        }),
      );
      yield* pipeline.bootstrap;

      const detail = yield* snapshotQuery.getThreadDetailSnapshot(threadId);
      if (Option.isNone(detail)) {
        assert.fail("expected a thread detail snapshot");
      }
      assert.deepEqual(detail.value.thread.artifacts, [
        {
          id: "artifact-4",
          path: "/workspace/example/review.md",
          recordedAt: NOW,
          readAt: null,
          starredAt: null,
        },
      ]);

      const shell = yield* snapshotQuery.getShellSnapshot();
      assert.deepEqual(
        shell.threads
          .filter((thread) => thread.id === threadId)
          .map((thread) => thread.unreadArtifactCount),
        [1],
      );
    }),
  );

  /**
   * The watermark must stay reachable by a client that did NOT opt into
   * artifact events: it parks an older page until its live sequence reaches
   * the watermark, and it will never receive an artifact event's sequence.
   * So an artifact must not become the watermark, even though it IS forwarded
   * to opted-in subscribers.
   */
  it.effect("does not let an opt-in artifact event become the thread watermark", () =>
    Effect.gen(function* () {
      const pipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const threadId = nextThreadId();
      yield* seedThread(eventStore, threadId);
      const message = yield* eventStore.append(
        makeEvent(threadId, "thread.message-sent", {
          threadId,
          messageId: MessageId.make(`message-${String(nextEventId)}`),
          role: "user",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      const recorded = yield* eventStore.append(
        makeEvent(threadId, "thread.artifact-recorded", {
          threadId,
          artifact: {
            id: "artifact-5",
            path: "/workspace/example/review.md",
            recordedAt: NOW,
            readAt: null,
            starredAt: null,
          },
        }),
      );
      yield* pipeline.bootstrap;

      // Forwarded to an opted-in subscriber...
      assert.equal(isThreadDetailEvent(recorded), true);
      assert.equal(recorded.sequence > message.sequence, true);

      const page = yield* snapshotQuery.getThreadDetailSnapshot(threadId, { turnLimit: 1 });
      if (Option.isNone(page)) {
        assert.fail("expected a windowed thread detail snapshot");
      }
      // ...but the watermark stops at the last event EVERY subscriber gets.
      assert.equal(page.value.page?.threadSequence, message.sequence);
    }),
  );

  /**
   * Regression: every artifact recorded before the running process started was
   * permanently un-markable and un-starrable.
   *
   * The decider is NOT rehydrated by replaying events through the in-memory
   * projector — `OrchestrationEngine` seeds its command read model from
   * `getCommandReadModel()`, a lightweight projection read. So the projector
   * cases made artifacts work live and did nothing at all across a restart.
   * This exercises the real rehydration path rather than live state.
   */
  it.effect("marks an artifact read after the decider rehydrates from persistence", () =>
    Effect.gen(function* () {
      const pipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const threadId = nextThreadId();
      yield* seedThread(eventStore, threadId);
      const recorded = yield* eventStore.append(
        makeEvent(threadId, "thread.artifact-recorded", {
          threadId,
          artifact: {
            id: "artifact-restart",
            path: "/workspace/example/review.md",
            recordedAt: NOW,
            readAt: null,
            starredAt: null,
          },
        }),
      );
      yield* pipeline.bootstrap;

      // Exactly what OrchestrationEngine does on startup. Nothing from the
      // live in-memory model survives into this value.
      const rehydrated = yield* snapshotQuery.getCommandReadModel();
      const thread = rehydrated.threads.find((entry) => entry.id === threadId);
      assert.deepEqual(
        thread?.artifacts.map((artifact) => artifact.id),
        ["artifact-restart"],
        "rehydrated decider state must carry the thread's artifacts",
      );

      const events = yield* decideOrchestrationCommand({
        command: {
          type: "thread.artifact.set-read",
          commandId: CommandId.make("cmd-set-read-after-restart"),
          threadId,
          artifactId: "artifact-restart",
          read: true,
        },
        readModel: rehydrated,
      }).pipe(Effect.map((result) => (Array.isArray(result) ? result : [result])));

      assert.deepEqual(
        events.map((event) => event.type),
        ["thread.artifact-read-set"],
      );
      assert.equal(recorded.type, "thread.artifact-recorded");
    }),
  );

  /**
   * The reverse states have to survive the restart too: read and starred are
   * columns on the projection row, so a rehydrated artifact must arrive
   * already-read and be un-markable back to unread.
   */
  it.effect("toggles read and starred both ways after rehydration", () =>
    Effect.gen(function* () {
      const pipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const threadId = nextThreadId();
      yield* seedThread(eventStore, threadId);
      yield* eventStore.append(
        makeEvent(threadId, "thread.artifact-recorded", {
          threadId,
          artifact: {
            id: "artifact-toggle",
            path: "/workspace/example/review.md",
            recordedAt: NOW,
            readAt: null,
            starredAt: null,
          },
        }),
      );
      yield* eventStore.append(
        makeEvent(threadId, "thread.artifact-read-set", {
          threadId,
          artifactId: "artifact-toggle",
          readAt: "2026-01-01T00:05:00.000Z",
        }),
      );
      yield* eventStore.append(
        makeEvent(threadId, "thread.artifact-starred-set", {
          threadId,
          artifactId: "artifact-toggle",
          starredAt: "2026-01-01T00:06:00.000Z",
        }),
      );
      yield* pipeline.bootstrap;

      const rehydrated = yield* snapshotQuery.getCommandReadModel();
      const artifact = rehydrated.threads
        .find((entry) => entry.id === threadId)
        ?.artifacts.find((entry) => entry.id === "artifact-toggle");
      assert.equal(artifact?.readAt, "2026-01-01T00:05:00.000Z");
      assert.equal(artifact?.starredAt, "2026-01-01T00:06:00.000Z");

      // Both toggles must still resolve the id, in the clearing direction.
      const unread = yield* decideOrchestrationCommand({
        command: {
          type: "thread.artifact.set-read",
          commandId: CommandId.make("cmd-unread-after-restart"),
          threadId,
          artifactId: "artifact-toggle",
          read: false,
        },
        readModel: rehydrated,
      }).pipe(Effect.map((result) => (Array.isArray(result) ? result : [result])));
      const unstar = yield* decideOrchestrationCommand({
        command: {
          type: "thread.artifact.set-starred",
          commandId: CommandId.make("cmd-unstar-after-restart"),
          threadId,
          artifactId: "artifact-toggle",
          starred: false,
        },
        readModel: rehydrated,
      }).pipe(Effect.map((result) => (Array.isArray(result) ? result : [result])));

      const [unreadEvent] = unread;
      if (unreadEvent?.type !== "thread.artifact-read-set") {
        throw new Error("expected a single thread.artifact-read-set event");
      }
      assert.equal(unreadEvent.payload.readAt, null);
      const [unstarEvent] = unstar;
      if (unstarEvent?.type !== "thread.artifact-starred-set") {
        throw new Error("expected a single thread.artifact-starred-set event");
      }
      assert.equal(unstarEvent.payload.starredAt, null);
    }),
  );
});

it("keeps the artifact events on the shared thread-detail allow-list", () => {
  for (const type of THREAD_DETAIL_ARTIFACT_EVENT_TYPES) {
    assert.equal(THREAD_DETAIL_EVENT_TYPES.includes(type), true, `${type} must be forwardable`);
  }
});

/**
 * The watermark may only count events EVERY subscriber receives. A client
 * parks an older page until its live sequence reaches the watermark, so a
 * watermark naming an opt-in event that a given client never gets can never be
 * reached and parks that page forever behind a permanent spinner.
 */
it("keeps opt-in artifact events out of the thread watermark", () => {
  for (const type of THREAD_DETAIL_ARTIFACT_EVENT_TYPES) {
    assert.equal(
      (THREAD_DETAIL_WATERMARK_EVENT_TYPES as ReadonlyArray<string>).includes(type),
      false,
      `${type} is opt-in and must not gate an older page's merge`,
    );
  }
  // Watermark must stay a subset of what the subscription can deliver.
  for (const type of THREAD_DETAIL_WATERMARK_EVENT_TYPES) {
    assert.equal(
      (THREAD_DETAIL_EVENT_TYPES as ReadonlyArray<string>).includes(type),
      true,
      `${type} is counted by the watermark but never forwarded`,
    );
  }
  assert.equal(
    THREAD_DETAIL_WATERMARK_EVENT_TYPES.length,
    THREAD_DETAIL_EVENT_TYPES.length - THREAD_DETAIL_ARTIFACT_EVENT_TYPES.length,
  );
});
