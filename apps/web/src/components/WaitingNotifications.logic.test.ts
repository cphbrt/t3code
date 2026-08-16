import { describe, expect, it } from "vite-plus/test";
import {
  OrchestrationLatestTurn,
  OrchestrationSession,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { DEFAULT_RUNTIME_MODE } from "../types";
import {
  planWaitingNotifications,
  resolveWaitingNotificationKind,
  waitingNotificationContent,
  type WaitingNotificationCandidate,
  type WaitingNotificationKind,
  type WaitingNotificationThreadInput,
} from "./WaitingNotifications.logic";

function makeLatestTurn(overrides?: Partial<OrchestrationLatestTurn>): OrchestrationLatestTurn {
  return {
    turnId: "turn-1" as never,
    state: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: "2026-03-09T10:00:00.000Z",
    completedAt: "2026-03-09T10:05:00.000Z",
    ...overrides,
  };
}

function makeSession(overrides?: Partial<OrchestrationSession>): OrchestrationSession {
  return {
    threadId: ThreadId.make("thread-1"),
    status: "running",
    providerName: "Claude",
    providerInstanceId: ProviderInstanceId.make("claude"),
    runtimeMode: DEFAULT_RUNTIME_MODE,
    activeTurnId: "turn-1" as never,
    lastError: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
    ...overrides,
  };
}

function makeThread(
  overrides?: Partial<WaitingNotificationThreadInput>,
): WaitingNotificationThreadInput {
  return {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default",
    latestTurn: null,
    session: null,
    ...overrides,
  };
}

describe("resolveWaitingNotificationKind", () => {
  it("reports a pending approval ahead of everything but a lost runtime", () => {
    expect(
      resolveWaitingNotificationKind(
        makeThread({ hasPendingApprovals: true, session: makeSession() }),
      ),
    ).toBe("approval");
  });

  it("reports awaiting input below approval", () => {
    expect(
      resolveWaitingNotificationKind(
        makeThread({ hasPendingUserInput: true, session: makeSession() }),
      ),
    ).toBe("input");
    expect(
      resolveWaitingNotificationKind(
        makeThread({
          hasPendingApprovals: true,
          hasPendingUserInput: true,
          session: makeSession(),
        }),
      ),
    ).toBe("approval");
  });

  it("reports an interrupted runtime even with a stale approval attached", () => {
    expect(
      resolveWaitingNotificationKind(
        makeThread({
          hasPendingApprovals: true,
          session: makeSession({ status: "interrupted", activeTurnId: null }),
        }),
      ),
    ).toBe("interrupted");
  });

  it("reports a session error as an agent error", () => {
    expect(
      resolveWaitingNotificationKind(
        makeThread({ session: makeSession({ status: "error", lastError: "boom" }) }),
      ),
    ).toBe("failed");
  });

  it("stays silent while the agent is working or monitoring", () => {
    expect(resolveWaitingNotificationKind(makeThread({ session: makeSession() }))).toBeNull();
    expect(
      resolveWaitingNotificationKind(makeThread({ session: makeSession({ status: "starting" }) })),
    ).toBeNull();
    expect(
      resolveWaitingNotificationKind(makeThread({ backgroundLiveness: "monitoring" })),
    ).toBeNull();
  });

  it("reports a completion the user has not opened yet", () => {
    expect(
      resolveWaitingNotificationKind(
        makeThread({
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
        }),
      ),
    ).toBe("completed");
  });

  it("stays silent once the completion has been visited", () => {
    expect(
      resolveWaitingNotificationKind(
        makeThread({
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:06:00.000Z",
        }),
      ),
    ).toBeNull();
  });

  // A session that has merely booted reports "ready" with no completed turn.
  // Without the completed-turn anchor this would read as a finished run and
  // fire a banner at thread birth.
  it("stays silent for a resting thread that never completed a turn", () => {
    expect(
      resolveWaitingNotificationKind(
        makeThread({ session: makeSession({ status: "ready", activeTurnId: null }) }),
      ),
    ).toBeNull();
  });
});

describe("planWaitingNotifications", () => {
  const base = { enabled: true, appFocused: false } as const;

  function candidate(
    threadKey: string,
    kind: WaitingNotificationKind | null,
    snoozed = false,
  ): WaitingNotificationCandidate {
    return { threadKey, kind, snoozed };
  }

  it("seeds first-seen threads without notifying", () => {
    const plan = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", "completed"), candidate("env:b", "approval")],
      previousKinds: new Map(),
    });

    expect(plan.emissions).toEqual([]);
    expect([...plan.nextKinds]).toEqual([
      ["env:a", "completed"],
      ["env:b", "approval"],
    ]);
  });

  it("notifies when a known thread enters a waiting state", () => {
    const plan = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", "approval")],
      previousKinds: new Map([["env:a", null]]),
    });

    expect(plan.emissions).toEqual([{ threadKey: "env:a", kind: "approval" }]);
  });

  it("does not repeat a notification while the state holds", () => {
    const plan = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", "approval")],
      previousKinds: new Map([["env:a", "approval"]]),
    });

    expect(plan.emissions).toEqual([]);
  });

  it("notifies again once a state resolves and re-occurs", () => {
    const resolved = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", null)],
      previousKinds: new Map([["env:a", "approval"]]),
    });
    expect(resolved.emissions).toEqual([]);

    const reoccurred = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", "approval")],
      previousKinds: resolved.nextKinds,
    });
    expect(reoccurred.emissions).toEqual([{ threadKey: "env:a", kind: "approval" }]);
  });

  it("notifies when one waiting state replaces another", () => {
    const plan = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", "approval")],
      previousKinds: new Map([["env:a", "completed"]]),
    });

    expect(plan.emissions).toEqual([{ threadKey: "env:a", kind: "approval" }]);
  });

  it("stays quiet while the app is focused but still records the state", () => {
    const focused = planWaitingNotifications({
      ...base,
      appFocused: true,
      candidates: [candidate("env:a", "approval")],
      previousKinds: new Map([["env:a", null]]),
    });
    expect(focused.emissions).toEqual([]);

    // Losing focus must not replay the transition the user already saw.
    const blurred = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", "approval")],
      previousKinds: focused.nextKinds,
    });
    expect(blurred.emissions).toEqual([]);
  });

  it("stays quiet while disabled but still records the state", () => {
    const disabled = planWaitingNotifications({
      ...base,
      enabled: false,
      candidates: [candidate("env:a", "approval")],
      previousKinds: new Map([["env:a", null]]),
    });
    expect(disabled.emissions).toEqual([]);

    const reenabled = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", "approval")],
      previousKinds: disabled.nextKinds,
    });
    expect(reenabled.emissions).toEqual([]);
  });

  it("skips a snoozed thread and does not replay it when the snooze lapses", () => {
    const snoozed = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", "completed", true)],
      previousKinds: new Map([["env:a", null]]),
    });
    expect(snoozed.emissions).toEqual([]);

    const woke = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", "completed", false)],
      previousKinds: snoozed.nextKinds,
    });
    expect(woke.emissions).toEqual([]);
  });

  it("drops threads that disappeared so a returning thread reseeds", () => {
    const gone = planWaitingNotifications({
      ...base,
      candidates: [],
      previousKinds: new Map([["env:a", null]]),
    });
    expect(gone.nextKinds.has("env:a")).toBe(false);

    const returned = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", "approval")],
      previousKinds: gone.nextKinds,
    });
    expect(returned.emissions).toEqual([]);
  });
});

describe("waitingNotificationContent", () => {
  it("puts the waiting state in the title and the thread in the body", () => {
    expect(waitingNotificationContent("approval", "Rename the widget")).toEqual({
      title: "Pending approval",
      body: "Rename the widget",
    });
    expect(waitingNotificationContent("completed", "Rename the widget").title).toBe(
      "Turn completed",
    );
  });
});
