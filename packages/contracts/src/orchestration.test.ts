import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ClientOrchestrationCommand,
  ModelSelection,
  OrchestrationCommand,
  OrchestrationDispatchCommandError,
  OrchestrationEvent,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetTurnDiffInput,
  OrchestrationLatestTurn,
  ProjectCreatedPayload,
  ProjectMetaUpdatedPayload,
  OrchestrationProposedPlan,
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadShell,
  ProjectCreateCommand,
  ThreadMetaUpdatedPayload,
  ThreadTurnStartCommand,
  ThreadCreatedPayload,
  ThreadTurnDiff,
  ThreadTurnStartRequestedPayload,
  isProviderSendTurnSupportedImageMimeType,
} from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const decodeTurnDiffInput = Schema.decodeUnknownEffect(OrchestrationGetTurnDiffInput);
const decodeFullThreadDiffInput = Schema.decodeUnknownEffect(OrchestrationGetFullThreadDiffInput);
const decodeThreadTurnDiff = Schema.decodeUnknownEffect(ThreadTurnDiff);
const decodeProjectCreateCommand = Schema.decodeUnknownEffect(ProjectCreateCommand);
const decodeProjectCreatedPayload = Schema.decodeUnknownEffect(ProjectCreatedPayload);
const decodeProjectMetaUpdatedPayload = Schema.decodeUnknownEffect(ProjectMetaUpdatedPayload);
const decodeThreadTurnStartCommand = Schema.decodeUnknownEffect(ThreadTurnStartCommand);
const decodeClientOrchestrationCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const decodeThreadTurnStartRequestedPayload = Schema.decodeUnknownEffect(
  ThreadTurnStartRequestedPayload,
);
const decodeOrchestrationLatestTurn = Schema.decodeUnknownEffect(OrchestrationLatestTurn);
const decodeOrchestrationProposedPlan = Schema.decodeUnknownEffect(OrchestrationProposedPlan);
const decodeOrchestrationSession = Schema.decodeUnknownEffect(OrchestrationSession);
const decodeOrchestrationThread = Schema.decodeUnknownEffect(OrchestrationThread);
const decodeOrchestrationThreadShell = Schema.decodeUnknownEffect(OrchestrationThreadShell);
const encodeThreadCreatedPayload = Schema.encodeEffect(ThreadCreatedPayload);

function getOptionValue(
  options: ReadonlyArray<{ id: string; value: unknown }> | undefined,
  id: string,
): unknown {
  return options?.find((option) => option.id === id)?.value;
}
const decodeThreadCreatedPayload = Schema.decodeUnknownEffect(ThreadCreatedPayload);
const decodeOrchestrationCommand = Schema.decodeUnknownEffect(OrchestrationCommand);
const decodeClientOrchestrationCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const decodeOrchestrationEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const decodeThreadMetaUpdatedPayload = Schema.decodeUnknownEffect(ThreadMetaUpdatedPayload);
const decodeDispatchCommandError = Schema.decodeUnknownEffect(OrchestrationDispatchCommandError);

it.effect("decodes a dispatch error after its bootstrap thread was deleted", () =>
  Effect.gen(function* () {
    const error = yield* decodeDispatchCommandError({
      _tag: "OrchestrationDispatchCommandError",
      message: "Failed to create worktree.",
      bootstrapThreadDisposition: "deleted",
    });

    assert.strictEqual(error.bootstrapThreadDisposition, "deleted");
  }),
);

it.effect("parses turn diff input when fromTurnCount <= toTurnCount", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeTurnDiffInput({
      threadId: "thread-1",
      fromTurnCount: 1,
      toTurnCount: 2,
    });
    assert.strictEqual(parsed.fromTurnCount, 1);
    assert.strictEqual(parsed.toTurnCount, 2);
  }),
);

it.effect("parses turn diff input with whitespace ignoring enabled", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeTurnDiffInput({
      threadId: "thread-1",
      fromTurnCount: 1,
      toTurnCount: 2,
      ignoreWhitespace: true,
    });
    assert.strictEqual(parsed.ignoreWhitespace, true);
  }),
);

it.effect("parses full thread diff input with whitespace ignoring enabled", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeFullThreadDiffInput({
      threadId: "thread-1",
      toTurnCount: 2,
      ignoreWhitespace: true,
    });
    assert.strictEqual(parsed.ignoreWhitespace, true);
  }),
);

it.effect("rejects turn diff input when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeTurnDiffInput({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("rejects thread turn diff when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeThreadTurnDiff({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
        diff: "patch",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("trims branded ids and command string fields at decode boundaries", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreateCommand({
      type: "project.create",
      commandId: " cmd-1 ",
      projectId: " project-1 ",
      title: " Project Title ",
      workspaceRoot: " /tmp/workspace ",
      defaultModelSelection: {
        provider: "codex",
        model: " gpt-5.2 ",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.commandId, "cmd-1");
    assert.strictEqual(parsed.projectId, "project-1");
    assert.strictEqual(parsed.title, "Project Title");
    assert.strictEqual(parsed.workspaceRoot, "/tmp/workspace");
    assert.strictEqual(parsed.createWorkspaceRootIfMissing, undefined);
    assert.deepStrictEqual(parsed.defaultModelSelection, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.2",
    });
  }),
);

it.effect("decodes project.create with createWorkspaceRootIfMissing enabled", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreateCommand({
      type: "project.create",
      commandId: "cmd-1",
      projectId: "project-1",
      title: "Project Title",
      workspaceRoot: "/tmp/workspace",
      createWorkspaceRootIfMissing: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.createWorkspaceRootIfMissing, true);
  }),
);

it.effect("decodes historical project.created payloads with a default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreatedPayload({
      projectId: "project-1",
      title: "Project Title",
      workspaceRoot: "/tmp/workspace",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.defaultModelSelection?.instanceId, "codex");
  }),
);

it.effect("decodes project.meta-updated payloads with explicit default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectMetaUpdatedPayload({
      projectId: "project-1",
      defaultModelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.defaultModelSelection?.instanceId, "claudeAgent");
  }),
);

it.effect("rejects command fields that become empty after trim", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeProjectCreateCommand({
        type: "project.create",
        commandId: "cmd-1",
        projectId: "project-1",
        title: "  ",
        workspaceRoot: "/tmp/workspace",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes thread.turn.start defaults for provider and runtime mode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-1",
      threadId: "thread-1",
      message: {
        messageId: "msg-1",
        role: "user",
        text: "hello",
        attachments: [],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection, undefined);
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
  }),
);

it.effect("accepts both inline and uploaded image attachments from clients", () =>
  Effect.gen(function* () {
    const command = yield* decodeClientOrchestrationCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-attachments",
      threadId: "thread-1",
      message: {
        messageId: "msg-attachments",
        role: "user",
        text: "hello",
        attachments: [
          {
            type: "image",
            name: "legacy.png",
            mimeType: "image/png",
            sizeBytes: 3,
            dataUrl: "data:image/png;base64,YWJj",
          },
          {
            type: "image",
            id: "pending-00000000-0000-4000-8000-000000000001",
            name: "uploaded.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    if (command.type !== "thread.turn.start") {
      assert.fail(`Expected thread.turn.start, received ${command.type}.`);
    }
    assert.strictEqual(command.message.attachments.length, 2);
    assert.strictEqual("dataUrl" in command.message.attachments[0]!, true);
    assert.strictEqual("id" in command.message.attachments[1]!, true);
  }),
);

it.effect("preserves explicit provider and runtime mode in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-2",
      threadId: "thread-1",
      message: {
        messageId: "msg-2",
        role: "user",
        text: "hello",
        attachments: [],
      },
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.instanceId, "codex");
    assert.strictEqual(parsed.runtimeMode, "full-access");
    assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
  }),
);

it.effect("accepts bootstrap metadata in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-bootstrap",
      threadId: "thread-1",
      message: {
        messageId: "msg-bootstrap",
        role: "user",
        text: "hello",
        attachments: [],
      },
      bootstrap: {
        createThread: {
          projectId: "project-1",
          title: "Bootstrap thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        prepareWorktree: {
          projectCwd: "/tmp/workspace",
          baseBranch: "main",
          branch: "t3code/example",
          startFromOrigin: true,
        },
        runSetupScript: true,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.bootstrap?.createThread?.projectId, "project-1");
    assert.strictEqual(parsed.bootstrap?.prepareWorktree?.baseBranch, "main");
    assert.strictEqual(parsed.bootstrap?.prepareWorktree?.startFromOrigin, true);
    assert.strictEqual(parsed.bootstrap?.runSetupScript, true);
  }),
);

it.effect("decodes thread.created runtime mode for historical events", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-1",
      projectId: "project-1",
      title: "Thread title",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.modelSelection.instanceId, "codex");
  }),
);

it.effect("decodes thread.meta-updated payloads with explicit provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadMetaUpdatedPayload({
      threadId: "thread-1",
      regenerateTitle: true,
      previousTitle: "Previous title",
      titleRegeneration: {
        requestId: "cmd-title-regenerate",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.previousTitle, "Previous title");
    assert.strictEqual(parsed.titleRegeneration?.requestId, "cmd-title-regenerate");
    assert.strictEqual(parsed.modelSelection?.instanceId, "claudeAgent");
  }),
);

it.effect("decodes thread archive and unarchive commands", () =>
  Effect.gen(function* () {
    const archive = yield* decodeOrchestrationCommand({
      type: "thread.archive",
      commandId: "cmd-archive-1",
      threadId: "thread-1",
    });
    const unarchive = yield* decodeOrchestrationCommand({
      type: "thread.unarchive",
      commandId: "cmd-unarchive-1",
      threadId: "thread-1",
    });

    assert.strictEqual(archive.type, "thread.archive");
    assert.strictEqual(unarchive.type, "thread.unarchive");
  }),
);

it.effect("decodes thread settle and unsettle commands", () =>
  Effect.gen(function* () {
    const settle = yield* decodeOrchestrationCommand({
      type: "thread.settle",
      commandId: "cmd-settle-1",
      threadId: "thread-1",
    });
    const unsettle = yield* decodeOrchestrationCommand({
      type: "thread.unsettle",
      commandId: "cmd-unsettle-1",
      threadId: "thread-1",
      reason: "user",
    });

    assert.strictEqual(settle.type, "thread.settle");
    assert.strictEqual(unsettle.type, "thread.unsettle");

    // "activity" is server-owned: it exists on the event, never on the
    // command, so a client cannot forge the neutral reset.
    const forged = yield* decodeOrchestrationCommand({
      type: "thread.unsettle",
      commandId: "cmd-unsettle-2",
      threadId: "thread-1",
      reason: "activity",
    }).pipe(Effect.flip);
    assert.ok(forged);
  }),
);

it.effect("keeps the agent self-settle request off the client command surface", () =>
  Effect.gen(function* () {
    const request = {
      type: "thread.self-settle.request",
      commandId: "cmd-self-settle-1",
      threadId: "thread-1",
    };
    const internal = yield* decodeOrchestrationCommand(request);
    assert.strictEqual(internal.type, "thread.self-settle.request");

    // It arrives over the thread's own MCP credential, never from a client, so
    // no client may dispatch it and name a thread.
    const forged = yield* decodeClientOrchestrationCommand(request).pipe(Effect.flip);
    assert.ok(forged);
  }),
);

it.effect("decodes agent self-settle lifecycle events", () =>
  Effect.gen(function* () {
    const base = {
      sequence: 1,
      eventId: "event-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-1",
      causationEventId: null,
      correlationId: null,
      metadata: {},
    };
    const requested = yield* decodeOrchestrationEvent({
      ...base,
      type: "thread.self-settle-requested",
      payload: { threadId: "thread-1", requestedAt: "2026-01-01T00:00:00.000Z" },
    });
    assert.strictEqual(requested.type, "thread.self-settle-requested");

    const cleared = yield* decodeOrchestrationEvent({
      ...base,
      type: "thread.self-settle-cleared",
      payload: { threadId: "thread-1", reason: "unclean-turn-end" },
    });
    assert.strictEqual(cleared.type, "thread.self-settle-cleared");

    const unknownReason = yield* decodeOrchestrationEvent({
      ...base,
      type: "thread.self-settle-cleared",
      payload: { threadId: "thread-1", reason: "user" },
    }).pipe(Effect.flip);
    assert.ok(unknownReason);
  }),
);

it.effect("defaults settled fields when decoding historical thread data", () =>
  Effect.gen(function* () {
    const common = {
      id: "thread-1",
      projectId: "project-1",
      title: "Historical thread",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      session: null,
    };
    const thread = yield* decodeOrchestrationThread({
      ...common,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    });
    const shell = yield* decodeOrchestrationThreadShell({
      ...common,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    });

    assert.strictEqual(thread.settledOverride, null);
    assert.strictEqual(thread.settledAt, null);
    assert.strictEqual(shell.settledOverride, null);
    assert.strictEqual(shell.settledAt, null);
  }),
);

it.effect("defaults artifact fields when decoding pre-feature thread payloads", () =>
  Effect.gen(function* () {
    const common = {
      id: "thread-1",
      projectId: "project-1",
      title: "Pre-artifact thread",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      session: null,
    };
    const thread = yield* decodeOrchestrationThread({
      ...common,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    });
    const shell = yield* decodeOrchestrationThreadShell({
      ...common,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    });

    assert.deepEqual(thread.artifacts, []);
    assert.strictEqual(shell.unreadArtifactCount, 0);
  }),
);

it.effect("decodes a recorded artifact on the thread detail", () =>
  Effect.gen(function* () {
    const thread = yield* decodeOrchestrationThread({
      id: "thread-1",
      projectId: "project-1",
      title: "Artifact thread",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      session: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      artifacts: [
        {
          id: "artifact-1",
          path: "/workspace/example/review.md",
          recordedAt: "2026-01-01T00:00:00.000Z",
          readAt: null,
          starredAt: null,
        },
      ],
    });

    assert.strictEqual(thread.artifacts.length, 1);
    assert.strictEqual(thread.artifacts[0]?.readAt, null);
  }),
);

it.effect("decodes the three artifact events", () =>
  Effect.gen(function* () {
    const base = {
      sequence: 1,
      eventId: "event-artifact-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-artifact-1",
      causationEventId: null,
      correlationId: "cmd-artifact-1",
      metadata: {},
    };
    const recorded = yield* decodeOrchestrationEvent({
      ...base,
      type: "thread.artifact-recorded",
      payload: {
        threadId: "thread-1",
        artifact: {
          id: "artifact-1",
          path: "/workspace/example/review.md",
          recordedAt: "2026-01-01T00:00:00.000Z",
          readAt: null,
          starredAt: null,
        },
      },
    });
    const readSet = yield* decodeOrchestrationEvent({
      ...base,
      type: "thread.artifact-read-set",
      payload: {
        threadId: "thread-1",
        artifactId: "artifact-1",
        readAt: "2026-01-01T00:01:00.000Z",
      },
    });
    const unreadSet = yield* decodeOrchestrationEvent({
      ...base,
      type: "thread.artifact-read-set",
      payload: { threadId: "thread-1", artifactId: "artifact-1", readAt: null },
    });
    const starredSet = yield* decodeOrchestrationEvent({
      ...base,
      type: "thread.artifact-starred-set",
      payload: {
        threadId: "thread-1",
        artifactId: "artifact-1",
        starredAt: "2026-01-01T00:02:00.000Z",
      },
    });

    if (recorded.type !== "thread.artifact-recorded") {
      assert.fail(`Expected thread.artifact-recorded event, received ${recorded.type}.`);
    }
    assert.strictEqual(recorded.payload.artifact.path, "/workspace/example/review.md");
    if (readSet.type !== "thread.artifact-read-set") {
      assert.fail(`Expected thread.artifact-read-set event, received ${readSet.type}.`);
    }
    assert.strictEqual(readSet.payload.readAt, "2026-01-01T00:01:00.000Z");
    if (unreadSet.type !== "thread.artifact-read-set") {
      assert.fail(`Expected thread.artifact-read-set event, received ${unreadSet.type}.`);
    }
    assert.strictEqual(unreadSet.payload.readAt, null);
    if (starredSet.type !== "thread.artifact-starred-set") {
      assert.fail(`Expected thread.artifact-starred-set event, received ${starredSet.type}.`);
    }
    assert.strictEqual(starredSet.payload.starredAt, "2026-01-01T00:02:00.000Z");
  }),
);

it.effect("accepts artifact read and star commands from clients", () =>
  Effect.gen(function* () {
    const read = yield* decodeClientOrchestrationCommand({
      type: "thread.artifact.set-read",
      commandId: "cmd-1",
      threadId: "thread-1",
      artifactId: "artifact-1",
      read: true,
    });
    const starred = yield* decodeClientOrchestrationCommand({
      type: "thread.artifact.set-starred",
      commandId: "cmd-2",
      threadId: "thread-1",
      artifactId: "artifact-1",
      starred: false,
    });

    assert.strictEqual(read.type, "thread.artifact.set-read");
    assert.strictEqual(starred.type, "thread.artifact.set-starred");
  }),
);

it.effect("keeps artifact recording off the client command surface", () =>
  Effect.gen(function* () {
    const record = {
      type: "thread.artifact.record",
      commandId: "cmd-3",
      threadId: "thread-1",
      path: "/workspace/example/review.md",
      kind: "markdown",
    };

    const internal = yield* decodeOrchestrationCommand(record);
    assert.strictEqual(internal.type, "thread.artifact.record");

    const rejected = yield* decodeClientOrchestrationCommand(record).pipe(Effect.flip);
    assert.ok(rejected);
  }),
);

it.effect("decodes thread archived and unarchived events", () =>
  Effect.gen(function* () {
    const archived = yield* decodeOrchestrationEvent({
      sequence: 1,
      eventId: "event-archive-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.archived",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-archive-1",
      causationEventId: null,
      correlationId: "cmd-archive-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        archivedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const unarchived = yield* decodeOrchestrationEvent({
      sequence: 2,
      eventId: "event-unarchive-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.unarchived",
      occurredAt: "2026-01-02T00:00:00.000Z",
      commandId: "cmd-unarchive-1",
      causationEventId: null,
      correlationId: "cmd-unarchive-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });

    if (archived.type !== "thread.archived") {
      assert.fail(`Expected thread.archived event, received ${archived.type}.`);
    }
    assert.strictEqual(archived.payload.archivedAt, "2026-01-01T00:00:00.000Z");
    assert.strictEqual(unarchived.type, "thread.unarchived");
  }),
);

it.effect("decodes thread settled and unsettled events", () =>
  Effect.gen(function* () {
    const settled = yield* decodeOrchestrationEvent({
      sequence: 1,
      eventId: "event-settle-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.settled",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-settle-1",
      causationEventId: null,
      correlationId: "cmd-settle-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        settledAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const unsettled = yield* decodeOrchestrationEvent({
      sequence: 2,
      eventId: "event-unsettle-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.unsettled",
      occurredAt: "2026-01-02T00:00:00.000Z",
      commandId: "cmd-unsettle-1",
      causationEventId: null,
      correlationId: "cmd-unsettle-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        reason: "user",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });

    assert.strictEqual(settled.type, "thread.settled");
    assert.strictEqual(unsettled.type, "thread.unsettled");
  }),
);

it.effect("accepts provider-scoped model options in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-options",
      threadId: "thread-1",
      message: {
        messageId: "msg-options",
        role: "user",
        text: "hello",
        attachments: [],
      },
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.instanceId, "codex");
    assert.strictEqual(getOptionValue(parsed.modelSelection?.options, "reasoningEffort"), "high");
    assert.strictEqual(getOptionValue(parsed.modelSelection?.options, "fastMode"), true);
  }),
);

it.effect("normalizes legacy object-shaped modelSelection.options on decode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-1",
      projectId: "project-1",
      title: "Legacy options thread",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: {
          effort: "max",
          fastMode: true,
          // Falsy/garbage entries are dropped, matching migration 026.
          emptyStr: "   ",
          nullish: null,
          nested: { foo: 1 },
        },
      },
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.modelSelection.instanceId, ProviderInstanceId.make("claudeAgent"));
    assert.deepStrictEqual(parsed.modelSelection.options, [
      { id: "effort", value: "max" },
      { id: "fastMode", value: true },
    ]);
  }),
);

it.effect("normalizes legacy object-shaped defaultModelSelection.options on decode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreatedPayload({
      projectId: "project-1",
      title: "Legacy default project",
      workspaceRoot: "/tmp/legacy",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5.4",
        options: { reasoningEffort: "low" },
      },
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.deepStrictEqual(parsed.defaultModelSelection?.options, [
      { id: "reasoningEffort", value: "low" },
    ]);
  }),
);

it.effect(
  "normalizes legacy object-shaped options on decode and re-encodes as canonical array",
  () =>
    Effect.gen(function* () {
      const decoded = yield* decodeThreadCreatedPayload({
        threadId: "thread-1",
        projectId: "project-1",
        title: "Round trip thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4",
          options: { fastMode: true },
        },
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      const encoded = yield* encodeThreadCreatedPayload(decoded);
      assert.deepStrictEqual(encoded.modelSelection.options, [{ id: "fastMode", value: true }]);
    }),
);

it.effect("accepts a title seed in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-title-seed",
      threadId: "thread-1",
      message: {
        messageId: "msg-title-seed",
        role: "user",
        text: "hello",
        attachments: [],
      },
      titleSeed: "Investigate reconnect failures",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.titleSeed, "Investigate reconnect failures");
  }),
);

it.effect("accepts a title regeneration intent in thread.meta.update", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationCommand({
      type: "thread.meta.update",
      commandId: "cmd-title-regenerate",
      threadId: "thread-1",
      regenerateTitle: true,
    });
    assert.strictEqual(parsed.type, "thread.meta.update");
    if (parsed.type === "thread.meta.update") {
      assert.strictEqual(parsed.regenerateTitle, true);
    }
  }),
);

it.effect("accepts an internal title regeneration completion", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationCommand({
      type: "thread.title.regeneration.complete",
      commandId: "cmd-title-regeneration-complete",
      threadId: "thread-1",
      requestId: "cmd-title-regenerate",
      title: "Updated title",
    });
    assert.strictEqual(parsed.type, "thread.title.regeneration.complete");
    if (parsed.type === "thread.title.regeneration.complete") {
      assert.strictEqual(parsed.requestId, "cmd-title-regenerate");
      assert.strictEqual(parsed.title, "Updated title");
    }
  }),
);

it.effect("rejects an explicit title combined with title regeneration", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeOrchestrationCommand({
        type: "thread.meta.update",
        commandId: "cmd-title-regenerate-with-title",
        threadId: "thread-1",
        title: "Explicit title",
        regenerateTitle: true,
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("accepts a source proposed plan reference in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-source-plan",
      threadId: "thread-2",
      message: {
        messageId: "msg-source-plan",
        role: "user",
        text: "implement this",
        attachments: [],
      },
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect(
  "decodes thread.turn-start-requested defaults for provider, runtime mode, and interaction mode",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeThreadTurnStartRequestedPayload({
        threadId: "thread-1",
        messageId: "msg-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      assert.strictEqual(parsed.modelSelection, undefined);
      assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
      assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
      assert.strictEqual(parsed.sourceProposedPlan, undefined);
    }),
);

it.effect("decodes thread.turn-start-requested source proposed plan metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-2",
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect("decodes thread.turn-start-requested title seed when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-2",
      titleSeed: "Investigate reconnect failures",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.titleSeed, "Investigate reconnect failures");
  }),
);

it.effect("decodes latest turn source proposed plan metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationLatestTurn({
      turnId: "turn-2",
      state: "running",
      requestedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: null,
      assistantMessageId: null,
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect("decodes orchestration session runtime mode defaults", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationSession({
      threadId: "thread-1",
      status: "idle",
      providerName: null,
      providerSessionId: null,
      providerThreadId: null,
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
  }),
);

it.effect("defaults proposed plan implementation metadata for historical rows", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProposedPlan({
      id: "plan-1",
      turnId: "turn-1",
      planMarkdown: "# Plan",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.implementedAt, null);
    assert.strictEqual(parsed.implementationThreadId, null);
  }),
);

it.effect("preserves proposed plan implementation metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProposedPlan({
      id: "plan-2",
      turnId: "turn-2",
      planMarkdown: "# Plan",
      implementedAt: "2026-01-02T00:00:00.000Z",
      implementationThreadId: "thread-2",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    assert.strictEqual(parsed.implementedAt, "2026-01-02T00:00:00.000Z");
    assert.strictEqual(parsed.implementationThreadId, "thread-2");
  }),
);

// ── ModelSelection: instance-keyed wire shape + legacy decoder ────────
//
// `ModelSelection` is routing-keyed on `instanceId` — never a driver kind.
// Persisted and in-flight payloads from pre-instance builds carry a
// `provider` field whose value was a driver kind; those payloads are migrated
// at the wire boundary by
// promoting `provider` to the default instance id for that driver
// (built-in drivers use the driver kind slug as their default instance id, so
// the migration is a 1:1 rename).
//
// These tests pin the rollback/fork tolerance invariant: legacy payloads
// decode cleanly for fork-provided drivers, and the decoded form uses
// `instanceId` uniformly regardless of origin.

const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);
const encodeModelSelection = Schema.encodeUnknownEffect(ModelSelection);

it.effect("ModelSelection migrates legacy `provider` field to `instanceId`", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      provider: "codex",
      model: "gpt-5-codex",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex"));
    assert.strictEqual(parsed.model, "gpt-5-codex");
    assert.deepStrictEqual(parsed.options, [{ id: "reasoningEffort", value: "high" }]);
  }),
);

it.effect("ModelSelection accepts an explicit instanceId routing key", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      instanceId: "codex_personal",
      model: "gpt-5-codex",
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex_personal"));
  }),
);

it.effect("ModelSelection prefers explicit instanceId over legacy provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      provider: "codex",
      instanceId: "codex_personal",
      model: "gpt-5-codex",
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex_personal"));
  }),
);

it.effect(
  "ModelSelection decodes unknown driver kinds via legacy provider (rollback / fork invariant)",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeModelSelection({
        provider: "ollama",
        model: "llama3:70b",
        options: [{ id: "temperature", value: "0.4" }],
      });
      assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("ollama"));
      assert.strictEqual(parsed.model, "llama3:70b");
    }),
);

it.effect("ModelSelection encodes to the canonical instanceId wire form", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeModelSelection({
      provider: "ollama",
      model: "llama3:70b",
      options: [{ id: "temperature", value: "0.4" }],
    });
    const encoded = yield* encodeModelSelection(decoded);
    assert.deepStrictEqual(encoded, {
      instanceId: "ollama",
      model: "llama3:70b",
      options: [{ id: "temperature", value: "0.4" }],
    });
  }),
);

it.effect("ModelSelection rejects malformed instance ids", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeModelSelection({
        instanceId: "1invalid", // must start with a letter
        model: "x",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("project favicon overrides accept only supported image files", () =>
  Effect.gen(function* () {
    const valid = yield* decodeOrchestrationCommand({
      type: "project.meta.update",
      commandId: "cmd-project-favicon",
      projectId: "project-1",
      faviconPath: "brand/icon.svg",
    });
    assert.strictEqual(valid.type, "project.meta.update");

    const invalid = yield* Effect.exit(
      decodeOrchestrationCommand({
        type: "project.meta.update",
        commandId: "cmd-project-secret",
        projectId: "project-1",
        faviconPath: ".env",
      }),
    );
    assert.strictEqual(invalid._tag, "Failure");
  }),
);

it("isProviderSendTurnSupportedImageMimeType accepts raster formats and rejects svg", () => {
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("image/png"), true);
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("IMAGE/JPEG"), true);
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("image/svg+xml"), false);
});
