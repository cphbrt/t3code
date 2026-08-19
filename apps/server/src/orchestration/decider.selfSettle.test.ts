import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const REQUESTED_AT = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");

function makeSession(status: OrchestrationSession["status"]): OrchestrationSession {
  return {
    threadId: THREAD_ID,
    status,
    providerName: "Claude",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
  };
}

function makeReadModel(overrides: Partial<OrchestrationThread> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        selfSettleRequestedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        artifacts: [],
        checkpoints: [],
        session: makeSession("running"),
        ...overrides,
      },
    ],
    updatedAt: NOW,
  };
}

const requestSelfSettle = (commandId: string, readModel: OrchestrationReadModel) =>
  decideOrchestrationCommand({
    command: {
      type: "thread.self-settle.request",
      commandId: CommandId.make(commandId),
      threadId: THREAD_ID,
    },
    readModel,
  }).pipe(Effect.map((result) => (Array.isArray(result) ? result : [result])));

const setSession = (
  commandId: string,
  status: OrchestrationSession["status"],
  readModel: OrchestrationReadModel,
) =>
  decideOrchestrationCommand({
    command: {
      type: "thread.session.set",
      commandId: CommandId.make(commandId),
      threadId: THREAD_ID,
      session: makeSession(status),
      createdAt: NOW,
    },
    readModel,
  }).pipe(Effect.map((result) => (Array.isArray(result) ? result : [result])));

it.layer(NodeServices.layer)("agent self-settle decider", (it) => {
  it.effect("records a pending request while the turn is still running", () =>
    Effect.gen(function* () {
      const events = yield* requestSelfSettle("cmd-self-settle", makeReadModel());
      expect(events.map((event) => event.type)).toEqual(["thread.self-settle-requested"]);
      const [requested] = events;
      if (requested?.type !== "thread.self-settle-requested") throw new Error("wrong event");
      expect(requested.payload.threadId).toBe(THREAD_ID);
      expect(requested.payload.requestedAt).toBeTruthy();
    }),
  );

  it.effect("is idempotent by re-emission and keeps the original requestedAt", () =>
    Effect.gen(function* () {
      const events = yield* requestSelfSettle(
        "cmd-self-settle-again",
        makeReadModel({ selfSettleRequestedAt: REQUESTED_AT }),
      );
      expect(events).toHaveLength(1);
      const [requested] = events;
      if (requested?.type !== "thread.self-settle-requested") throw new Error("wrong event");
      expect(requested.payload.requestedAt).toBe(REQUESTED_AT);
    }),
  );

  it.effect("settles immediately when the tool call raced past the end of its own turn", () =>
    Effect.gen(function* () {
      const events = yield* requestSelfSettle(
        "cmd-self-settle-raced",
        makeReadModel({ session: makeSession("idle") }),
      );
      expect(events.map((event) => event.type)).toEqual(["thread.settled"]);
    }),
  );

  it.effect("clears a pin when the raced request settles a pinned thread", () =>
    Effect.gen(function* () {
      const events = yield* requestSelfSettle(
        "cmd-self-settle-raced-pinned",
        makeReadModel({ session: makeSession("idle"), pinnedAt: NOW }),
      );
      expect(events.map((event) => event.type)).toEqual(["thread.settled", "thread.unpinned"]);
    }),
  );

  it.effect("refuses a raced request on a thread with an open approval", () =>
    Effect.gen(function* () {
      const error = yield* requestSelfSettle(
        "cmd-self-settle-blocked",
        makeReadModel({
          session: makeSession("idle"),
          activities: [
            {
              id: EventId.make("activity-approval"),
              tone: "approval",
              kind: "approval.requested",
              summary: "approval.requested",
              payload: { requestId: "req-1" },
              turnId: null,
              createdAt: NOW,
            } as OrchestrationThread["activities"][number],
          ],
        }),
      ).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("refuses a request on an archived thread", () =>
    Effect.gen(function* () {
      const error = yield* requestSelfSettle(
        "cmd-self-settle-archived",
        makeReadModel({ archivedAt: NOW }),
      ).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("settles when the session leaves running cleanly", () =>
    Effect.gen(function* () {
      for (const status of ["idle", "ready"] as const) {
        const events = yield* setSession(
          `cmd-session-${status}`,
          status,
          makeReadModel({ selfSettleRequestedAt: REQUESTED_AT }),
        );
        // The projector clears selfSettleRequestedAt as part of thread.settled,
        // so the happy path emits no separate cleared event.
        expect(events.map((event) => event.type)).toEqual(["thread.session-set", "thread.settled"]);
      }
    }),
  );

  it.effect("clears without settling when the turn ends badly", () =>
    Effect.gen(function* () {
      for (const status of ["error", "interrupted", "stopped"] as const) {
        const events = yield* setSession(
          `cmd-session-${status}`,
          status,
          makeReadModel({ selfSettleRequestedAt: REQUESTED_AT }),
        );
        expect(events.map((event) => event.type)).toEqual([
          "thread.session-set",
          "thread.self-settle-cleared",
        ]);
        const cleared = events[1];
        if (cleared?.type !== "thread.self-settle-cleared") throw new Error("wrong event");
        expect(cleared.payload.reason).toBe("unclean-turn-end");
      }
    }),
  );

  it.effect("clears without settling when a queued turn start arrived first", () =>
    Effect.gen(function* () {
      const events = yield* setSession(
        "cmd-session-idle-queued",
        "idle",
        makeReadModel({
          selfSettleRequestedAt: REQUESTED_AT,
          messages: [
            {
              id: MessageId.make("message-1"),
              role: "user",
              text: "one more thing",
              attachments: [],
              turnId: null,
              streaming: false,
              createdAt: NOW,
              updatedAt: NOW,
            } as OrchestrationThread["messages"][number],
          ],
        }),
      );
      expect(events.map((event) => event.type)).toEqual([
        "thread.session-set",
        "thread.self-settle-cleared",
      ]);
      const cleared = events[1];
      if (cleared?.type !== "thread.self-settle-cleared") throw new Error("wrong event");
      expect(cleared.payload.reason).toBe("activity");
    }),
  );

  it.effect("clears without settling when the user kept the thread active mid-turn", () =>
    Effect.gen(function* () {
      const events = yield* setSession(
        "cmd-session-idle-kept-active",
        "idle",
        makeReadModel({ selfSettleRequestedAt: REQUESTED_AT, settledOverride: "active" }),
      );
      expect(events.map((event) => event.type)).toEqual([
        "thread.session-set",
        "thread.self-settle-cleared",
      ]);
    }),
  );

  it.effect("leaves the request pending while the session is still coming alive", () =>
    Effect.gen(function* () {
      for (const status of ["starting", "running"] as const) {
        const events = yield* setSession(
          `cmd-session-live-${status}`,
          status,
          makeReadModel({ selfSettleRequestedAt: REQUESTED_AT }),
        );
        expect(events.map((event) => event.type)).toEqual(["thread.session-set"]);
      }
    }),
  );

  it.effect("does nothing extra when no request is pending", () =>
    Effect.gen(function* () {
      const events = yield* setSession("cmd-session-idle-clean", "idle", makeReadModel());
      expect(events.map((event) => event.type)).toEqual(["thread.session-set"]);
    }),
  );

  it.effect("a new user turn cancels a pending request", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("message-2"),
            role: "user",
            text: "actually, keep going",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel({
          selfSettleRequestedAt: REQUESTED_AT,
          session: makeSession("idle"),
        }),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.self-settle-cleared",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      const cleared = events[0];
      if (cleared?.type !== "thread.self-settle-cleared") throw new Error("wrong event");
      expect(cleared.payload.reason).toBe("activity");
    }),
  );
});
