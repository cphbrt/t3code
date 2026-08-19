import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThreadArtifact,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");

const ARTIFACT: OrchestrationThreadArtifact = {
  id: "artifact-1",
  path: "/workspace/example/review.md",
  recordedAt: NOW,
  readAt: null,
  starredAt: null,
};

function makeReadModel(
  input: {
    readonly artifacts?: ReadonlyArray<OrchestrationThreadArtifact>;
    readonly archivedAt?: string | null;
  } = {},
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: input.archivedAt ?? null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        artifacts: input.artifacts ?? [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const decide =
  (command: Parameters<typeof decideOrchestrationCommand>[0]["command"]) =>
  (readModel: OrchestrationReadModel) =>
    decideOrchestrationCommand({ command, readModel }).pipe(
      Effect.map((result) => (Array.isArray(result) ? result : [result])),
    );

const recordArtifact = decide({
  type: "thread.artifact.record",
  commandId: CommandId.make("cmd-record"),
  threadId: THREAD_ID,
  path: "/workspace/example/review.md",
});

const setRead = (read: boolean) =>
  decide({
    type: "thread.artifact.set-read",
    commandId: CommandId.make(`cmd-read-${String(read)}`),
    threadId: THREAD_ID,
    artifactId: "artifact-1",
    read,
  });

const setStarred = (starred: boolean) =>
  decide({
    type: "thread.artifact.set-starred",
    commandId: CommandId.make(`cmd-star-${String(starred)}`),
    threadId: THREAD_ID,
    artifactId: "artifact-1",
    starred,
  });

it.layer(NodeServices.layer)("artifact decider", (it) => {
  it.effect("mints the artifact's id from the event and stamps server time", () =>
    Effect.gen(function* () {
      const events = yield* recordArtifact(makeReadModel());
      expect(events).toHaveLength(1);
      const [recorded] = events;
      if (recorded?.type !== "thread.artifact-recorded") throw new Error("wrong event");
      expect(recorded.payload.threadId).toBe(THREAD_ID);
      // The id is the event's own id, so no caller has to mint (or collide on) one.
      expect(recorded.payload.artifact.id).toBe(recorded.eventId);
      expect(recorded.payload.artifact.path).toBe("/workspace/example/review.md");
      expect(recorded.payload.artifact.recordedAt).toBe(recorded.occurredAt);
      expect(recorded.payload.artifact.readAt).toBeNull();
      expect(recorded.payload.artifact.starredAt).toBeNull();
    }),
  );

  it.effect("records onto an archived thread rather than losing the agent's file", () =>
    Effect.gen(function* () {
      const events = yield* recordArtifact(makeReadModel({ archivedAt: NOW }));
      expect(events.map((event) => event.type)).toEqual(["thread.artifact-recorded"]);
    }),
  );

  it.effect("stamps readAt on mark-read and clears it on mark-unread", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel({ artifacts: [ARTIFACT] });
      const [marked] = yield* setRead(true)(readModel);
      if (marked?.type !== "thread.artifact-read-set") throw new Error("wrong event");
      expect(marked.payload.artifactId).toBe("artifact-1");
      expect(marked.payload.readAt).toBe(marked.occurredAt);

      const [cleared] = yield* setRead(false)(readModel);
      if (cleared?.type !== "thread.artifact-read-set") throw new Error("wrong event");
      expect(cleared.payload.readAt).toBeNull();
    }),
  );

  it.effect("stamps starredAt on star and clears it on unstar", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel({ artifacts: [ARTIFACT] });
      const [starred] = yield* setStarred(true)(readModel);
      if (starred?.type !== "thread.artifact-starred-set") throw new Error("wrong event");
      expect(starred.payload.starredAt).toBe(starred.occurredAt);

      const [unstarred] = yield* setStarred(false)(readModel);
      if (unstarred?.type !== "thread.artifact-starred-set") throw new Error("wrong event");
      expect(unstarred.payload.starredAt).toBeNull();
    }),
  );

  it.effect("rejects a read or star naming an artifact this thread does not have", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel();
      const readError = yield* setRead(true)(readModel).pipe(Effect.flip);
      expect(readError._tag).toBe("OrchestrationCommandInvariantError");
      expect(readError.message).toContain("artifact-1");

      const starError = yield* setStarred(true)(readModel).pipe(Effect.flip);
      expect(starError._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("still reads and stars on an archived thread", () =>
    Effect.gen(function* () {
      // Matching record: you can tidy an archived thread's artifacts, and an
      // archived thread stuck with a permanent unread count is worse than
      // allowing the toggle.
      const readModel = makeReadModel({ artifacts: [ARTIFACT], archivedAt: NOW });
      const [marked] = yield* setRead(true)(readModel);
      expect(marked?.type).toBe("thread.artifact-read-set");

      const [starred] = yield* setStarred(true)(readModel);
      expect(starred?.type).toBe("thread.artifact-starred-set");
    }),
  );

  it.effect("never bumps the thread while recording, reading, or starring", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel({ artifacts: [ARTIFACT] });
      const events = [
        ...(yield* recordArtifact(readModel)),
        ...(yield* setRead(true)(readModel)),
        ...(yield* setStarred(true)(readModel)),
      ];
      // A bumped updatedAt would reorder the sidebar under the user.
      for (const event of events) {
        expect(event.payload).not.toHaveProperty("updatedAt");
      }
    }),
  );
});
