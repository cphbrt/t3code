import {
  CommandId,
  EventId,
  type OrchestrationThreadActivity,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProviderService } from "../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

type BlockingRequestKind = "approval" | "user-input";

interface OpenBlockingRequest {
  readonly requestId: string;
  readonly kind: BlockingRequestKind;
  readonly turnId: OrchestrationThreadActivity["turnId"];
}

const staleRequestFailure = (activity: OrchestrationThreadActivity): boolean => {
  if (
    activity.kind !== "provider.approval.respond.failed" &&
    activity.kind !== "provider.user-input.respond.failed"
  ) {
    return false;
  }
  const payload =
    typeof activity.payload === "object" && activity.payload !== null
      ? (activity.payload as Record<string, unknown>)
      : null;
  const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : "";
  return detail.includes("stale pending") || detail.includes("unknown pending");
};

export function deriveOpenBlockingRequests(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OpenBlockingRequest> {
  const openByRequestId = new Map<string, OpenBlockingRequest>();
  const ordered = [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );

  for (const activity of ordered) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;

    if (activity.kind === "approval.requested") {
      openByRequestId.set(requestId, {
        requestId,
        kind: "approval",
        turnId: activity.turnId,
      });
      continue;
    }
    if (activity.kind === "user-input.requested") {
      openByRequestId.set(requestId, {
        requestId,
        kind: "user-input",
        turnId: activity.turnId,
      });
      continue;
    }
    if (
      activity.kind === "approval.resolved" ||
      activity.kind === "user-input.resolved" ||
      staleRequestFailure(activity)
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()];
}

const stableId = (input: {
  readonly threadId: ThreadId;
  readonly causeId: string;
  readonly suffix: string;
}) => `runtime-interrupted:${input.threadId}:${input.causeId}:${input.suffix}`;

export const interruptThreadRuntime = Effect.fn("interruptThreadRuntime")(function* (input: {
  readonly threadId: ThreadId;
  readonly causeId: string;
  readonly createdAt: string;
  readonly reason: "provider-session-exited" | "server-restarted";
}) {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const detail = yield* projectionSnapshotQuery.getThreadDetailById(input.threadId);
  if (Option.isNone(detail)) return false;

  const thread = detail.value;
  const session = thread.session;
  if (session === null || (session.status !== "starting" && session.status !== "running")) {
    return false;
  }

  const makeCommandId = (suffix: string) =>
    CommandId.make(stableId({ threadId: input.threadId, causeId: input.causeId, suffix }));
  const makeEventId = (suffix: string) =>
    EventId.make(stableId({ threadId: input.threadId, causeId: input.causeId, suffix }));

  yield* Effect.forEach(
    thread.messages.filter((message) => message.role === "assistant" && message.streaming),
    (message) =>
      orchestrationEngine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: makeCommandId(`message:${message.id}`),
        threadId: input.threadId,
        messageId: message.id,
        ...(message.turnId !== null ? { turnId: message.turnId } : {}),
        createdAt: input.createdAt,
      }),
    { concurrency: 1, discard: true },
  );

  yield* Effect.forEach(
    deriveOpenBlockingRequests(thread.activities),
    (request) => {
      const activity: OrchestrationThreadActivity = {
        id: makeEventId(`${request.kind}:${request.requestId}`),
        tone: "info",
        kind: request.kind === "approval" ? "approval.resolved" : "user-input.resolved",
        summary:
          request.kind === "approval"
            ? "Approval cancelled when the agent stopped"
            : "User input request cancelled when the agent stopped",
        payload:
          request.kind === "approval"
            ? { requestId: request.requestId, decision: "cancel", reason: "interrupted" }
            : { requestId: request.requestId, answers: {}, reason: "interrupted" },
        turnId: request.turnId,
        createdAt: input.createdAt,
      };
      return orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: makeCommandId(`${request.kind}:${request.requestId}`),
        threadId: input.threadId,
        activity,
        createdAt: input.createdAt,
      });
    },
    { concurrency: 1, discard: true },
  );

  yield* orchestrationEngine.dispatch({
    type: "thread.activity.append",
    commandId: makeCommandId("activity"),
    threadId: input.threadId,
    activity: {
      id: makeEventId("activity"),
      tone: "info",
      kind: "turn.interrupted",
      summary: "Agent stopped before completing this turn",
      payload: { reason: input.reason },
      turnId: session.activeTurnId,
      createdAt: input.createdAt,
    },
    createdAt: input.createdAt,
  });

  yield* orchestrationEngine.dispatch({
    type: "thread.session.set",
    commandId: makeCommandId("session"),
    threadId: input.threadId,
    session: {
      ...session,
      status: "interrupted",
      activeTurnId: null,
      lastError: null,
      updatedAt: input.createdAt,
    },
    createdAt: input.createdAt,
  });

  return true;
});

export const reconcileInterruptedProviderSessions = Effect.fn(
  "reconcileInterruptedProviderSessions",
)(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const shell = yield* projectionSnapshotQuery.getShellSnapshot();
  const liveThreadIds = new Set(
    (yield* providerService.listSessions()).map((session) => session.threadId),
  );
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  let interruptedCount = 0;

  for (const thread of shell.threads) {
    const session = thread.session;
    if (
      session === null ||
      (session.status !== "starting" && session.status !== "running") ||
      liveThreadIds.has(thread.id)
    ) {
      continue;
    }

    const interrupted = yield* interruptThreadRuntime({
      threadId: thread.id,
      causeId: session.updatedAt,
      createdAt,
      reason: "server-restarted",
    });
    if (interrupted) interruptedCount += 1;
  }

  if (interruptedCount > 0) {
    yield* Effect.logInfo("reconciled interrupted provider sessions", { interruptedCount });
  }
  return interruptedCount;
});
