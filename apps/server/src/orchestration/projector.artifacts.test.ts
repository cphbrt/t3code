import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { shouldPublishAgentAwarenessEvent } from "../relay/AgentAwarenessRelay.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeEvent(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly payload: unknown;
  readonly occurredAt?: string;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: input.occurredAt ?? NOW,
    commandId: CommandId.make(`cmd-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

const threadCreated = makeEvent({
  sequence: 1,
  type: "thread.created",
  payload: {
    threadId: "thread-1",
    projectId: ProjectId.make("project-1"),
    title: "demo",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
});

const artifactRecorded = (id: string, recordedAt: string, sequence: number) =>
  makeEvent({
    sequence,
    type: "thread.artifact-recorded",
    occurredAt: recordedAt,
    payload: {
      threadId: "thread-1",
      artifact: {
        id,
        path: `/workspace/example/${id}.md`,
        recordedAt,
        readAt: null,
        starredAt: null,
      },
    },
  });

const readSet = (artifactId: string, readAt: string | null, sequence: number) =>
  makeEvent({
    sequence,
    type: "thread.artifact-read-set",
    payload: { threadId: "thread-1", artifactId, readAt },
  });

const apply = Effect.fn("applyProjectorEvents")(function* (
  events: ReadonlyArray<OrchestrationEvent>,
) {
  let model = createEmptyReadModel(NOW);
  for (const event of events) {
    model = yield* projectEvent(model, event);
  }
  return model;
});

const TWO_ARTIFACTS = [
  threadCreated,
  artifactRecorded("artifact-a", "2026-01-02T00:00:00.000Z", 2),
  artifactRecorded("artifact-b", "2026-01-03T00:00:00.000Z", 3),
];

it.effect("appends a recorded artifact without bumping the thread", () =>
  Effect.gen(function* () {
    const model = yield* apply([
      threadCreated,
      artifactRecorded("artifact-1", "2026-01-02T00:00:00.000Z", 2),
    ]);
    const thread = model.threads[0];

    expect(thread?.artifacts).toEqual([
      {
        id: "artifact-1",
        path: "/workspace/example/artifact-1.md",
        recordedAt: "2026-01-02T00:00:00.000Z",
        readAt: null,
        starredAt: null,
      },
    ]);
    // The sidebar must not reorder because a file arrived.
    expect(thread?.updatedAt).toBe(NOW);
  }),
);

it.effect("keeps artifacts in recording order and dedupes a replayed record", () =>
  Effect.gen(function* () {
    const model = yield* apply([
      threadCreated,
      artifactRecorded("artifact-b", "2026-01-03T00:00:00.000Z", 2),
      artifactRecorded("artifact-a", "2026-01-02T00:00:00.000Z", 3),
      artifactRecorded("artifact-b", "2026-01-03T00:00:00.000Z", 4),
    ]);

    expect(model.threads[0]?.artifacts.map((artifact) => artifact.id)).toEqual([
      "artifact-a",
      "artifact-b",
    ]);
  }),
);

it.effect("sets readAt in place without reordering", () =>
  Effect.gen(function* () {
    const model = yield* apply([
      ...TWO_ARTIFACTS,
      readSet("artifact-a", "2026-01-04T00:00:00.000Z", 4),
    ]);

    expect(model.threads[0]?.artifacts.map((artifact) => [artifact.id, artifact.readAt])).toEqual([
      ["artifact-a", "2026-01-04T00:00:00.000Z"],
      ["artifact-b", null],
    ]);
  }),
);

it.effect("clears readAt again on mark-unread", () =>
  Effect.gen(function* () {
    const model = yield* apply([
      ...TWO_ARTIFACTS,
      readSet("artifact-a", "2026-01-04T00:00:00.000Z", 4),
      readSet("artifact-a", null, 5),
    ]);

    expect(model.threads[0]?.artifacts[0]?.readAt).toBeNull();
  }),
);

it.effect("stars in place and never moves the row", () =>
  Effect.gen(function* () {
    const model = yield* apply([
      ...TWO_ARTIFACTS,
      makeEvent({
        sequence: 4,
        type: "thread.artifact-starred-set",
        payload: {
          threadId: "thread-1",
          artifactId: "artifact-b",
          starredAt: "2026-01-05T00:00:00.000Z",
        },
      }),
    ]);

    // Chris was explicit that starring highlights in place rather than sorting.
    expect(model.threads[0]?.artifacts.map((artifact) => artifact.id)).toEqual([
      "artifact-a",
      "artifact-b",
    ]);
    expect(model.threads[0]?.artifacts[1]?.starredAt).toBe("2026-01-05T00:00:00.000Z");
  }),
);

it.effect("ignores artifact events for a thread it does not know", () =>
  Effect.gen(function* () {
    const model = yield* apply([readSet("artifact-a", NOW, 1)]);
    expect(model.threads).toEqual([]);
  }),
);

it("never re-announces agent state because of an artifact", () => {
  for (const type of [
    "thread.artifact-recorded",
    "thread.artifact-read-set",
    "thread.artifact-starred-set",
  ] as const) {
    expect(
      shouldPublishAgentAwarenessEvent(makeEvent({ sequence: 1, type, payload: {} })),
      type,
    ).toBe(false);
  }
});
