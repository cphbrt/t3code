import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type ScheduledThreadTurn,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const RESET_AT = "2026-08-15T08:00:00.000Z";
const SCHEDULED_FOR = "2026-08-15T08:01:00.000Z";
const PROVIDER = ProviderInstanceId.make("claude");
const SCHEDULE_ID = CommandId.make("schedule-1");

const scheduledTurn: ScheduledThreadTurn = {
  scheduleId: SCHEDULE_ID,
  message: {
    messageId: MessageId.make("message-1"),
    role: "user",
    text: "The usage limit reset; continue as you were.",
    attachments: [],
  },
  modelSelection: { instanceId: PROVIDER, model: "claude-sonnet-4-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  providerInstanceId: PROVIDER,
  reportedResetAt: RESET_AT,
  scheduledFor: SCHEDULED_FOR,
  createdAt: "2026-08-15T01:00:00.000Z",
};

function makeReadModel(pending: ScheduledThreadTurn | null): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Limited session",
        modelSelection: scheduledTurn.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: scheduledTurn.createdAt,
        updatedAt: scheduledTurn.createdAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        scheduledTurn: pending,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: scheduledTurn.createdAt,
  };
}

it.layer(NodeServices.layer)("scheduled usage-reset turn decider", (it) => {
  it.effect("holds the prompt without adding it to transcript history", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.schedule",
          commandId: SCHEDULE_ID,
          threadId: ThreadId.make("thread-1"),
          message: scheduledTurn.message,
          modelSelection: scheduledTurn.modelSelection,
          runtimeMode: scheduledTurn.runtimeMode,
          interactionMode: scheduledTurn.interactionMode,
          providerInstanceId: PROVIDER,
          reportedResetAt: RESET_AT,
          scheduledFor: SCHEDULED_FOR,
          createdAt: scheduledTurn.createdAt,
        },
        readModel: makeReadModel(null),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual(["thread.turn-scheduled"]);
    }),
  );

  it.effect("atomically clears, publishes, and starts a due prompt", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.release-scheduled",
          commandId: CommandId.make("release-1"),
          threadId: ThreadId.make("thread-1"),
          scheduleId: SCHEDULE_ID,
          createdAt: SCHEDULED_FOR,
        },
        readModel: makeReadModel(scheduledTurn),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.turn-schedule-cleared",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
    }),
  );

  it.effect("refuses a stale release after cancellation wins", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.release-scheduled",
          commandId: CommandId.make("release-stale"),
          threadId: ThreadId.make("thread-1"),
          scheduleId: SCHEDULE_ID,
          createdAt: SCHEDULED_FOR,
        },
        readModel: makeReadModel(null),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("refuses to release before the grace period unless the user sends now", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.release-scheduled",
          commandId: CommandId.make("release-early"),
          threadId: ThreadId.make("thread-1"),
          scheduleId: SCHEDULE_ID,
          createdAt: RESET_AT,
        },
        readModel: makeReadModel(scheduledTurn),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("moves the deadline forward without replacing the held prompt", () =>
    Effect.gen(function* () {
      const laterReset = "2026-08-15T10:00:00.000Z";
      const laterSchedule = "2026-08-15T10:01:00.000Z";
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.reschedule",
          commandId: CommandId.make("reschedule-1"),
          threadId: ThreadId.make("thread-1"),
          scheduleId: SCHEDULE_ID,
          reportedResetAt: laterReset,
          scheduledFor: laterSchedule,
          createdAt: RESET_AT,
        },
        readModel: makeReadModel(scheduledTurn),
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.turn-scheduled");
      if (event.type !== "thread.turn-scheduled") return;
      expect(event.payload.scheduledTurn).toEqual({
        ...scheduledTurn,
        reportedResetAt: laterReset,
        scheduledFor: laterSchedule,
      });
    }),
  );
});
