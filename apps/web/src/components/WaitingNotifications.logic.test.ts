import { describe, expect, it } from "vite-plus/test";
import {
  OrchestrationLatestTurn,
  OrchestrationSession,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { DEFAULT_RUNTIME_MODE } from "../types";
import {
  artifactNotificationContent,
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
    unreadArtifactCount = 0,
  ): WaitingNotificationCandidate {
    return { threadKey, kind, snoozed, unreadArtifactCount };
  }

  /** Previously-observed record for a thread that has no artifacts yet. */
  function seen(kind: WaitingNotificationKind | null, unreadArtifactCount = 0) {
    return { kind, unreadArtifactCount };
  }

  it("seeds first-seen threads without notifying", () => {
    const plan = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", "completed"), candidate("env:b", "approval")],
      previousObservations: new Map(),
    });

    expect(plan.emissions).toEqual([]);
    expect([...plan.nextObservations]).toEqual([
      ["env:a", { kind: "completed", unreadArtifactCount: 0 }],
      ["env:b", { kind: "approval", unreadArtifactCount: 0 }],
    ]);
  });

  it("notifies when a known thread enters a waiting state", () => {
    const plan = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", "approval")],
      previousObservations: new Map([["env:a", seen(null)]]),
    });

    expect(plan.emissions).toEqual([{ threadKey: "env:a", reason: "waiting", kind: "approval" }]);
  });

  it("does not repeat a notification while the state holds", () => {
    const plan = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", "approval")],
      previousObservations: new Map([["env:a", seen("approval")]]),
    });

    expect(plan.emissions).toEqual([]);
  });

  it("notifies again once a state resolves and re-occurs", () => {
    const resolved = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", null)],
      previousObservations: new Map([["env:a", seen("approval")]]),
    });
    expect(resolved.emissions).toEqual([]);

    const reoccurred = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", "approval")],
      previousObservations: resolved.nextObservations,
    });
    expect(reoccurred.emissions).toEqual([
      { threadKey: "env:a", reason: "waiting", kind: "approval" },
    ]);
  });

  it("notifies when one waiting state replaces another", () => {
    const plan = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", "approval")],
      previousObservations: new Map([["env:a", seen("completed")]]),
    });

    expect(plan.emissions).toEqual([{ threadKey: "env:a", reason: "waiting", kind: "approval" }]);
  });

  it("stays quiet while the app is focused but still records the state", () => {
    const focused = planWaitingNotifications({
      ...base,
      appFocused: true,
      candidates: [candidate("env:a", "approval")],
      previousObservations: new Map([["env:a", seen(null)]]),
    });
    expect(focused.emissions).toEqual([]);

    // Losing focus must not replay the transition the user already saw.
    const blurred = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", "approval")],
      previousObservations: focused.nextObservations,
    });
    expect(blurred.emissions).toEqual([]);
  });

  it("stays quiet while disabled but still records the state", () => {
    const disabled = planWaitingNotifications({
      ...base,
      enabled: false,
      candidates: [candidate("env:a", "approval")],
      previousObservations: new Map([["env:a", seen(null)]]),
    });
    expect(disabled.emissions).toEqual([]);

    const reenabled = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", "approval")],
      previousObservations: disabled.nextObservations,
    });
    expect(reenabled.emissions).toEqual([]);
  });

  it("skips a snoozed thread and does not replay it when the snooze lapses", () => {
    const snoozed = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", "completed", true)],
      previousObservations: new Map([["env:a", seen(null)]]),
    });
    expect(snoozed.emissions).toEqual([]);

    const woke = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", "completed", false)],
      previousObservations: snoozed.nextObservations,
    });
    expect(woke.emissions).toEqual([]);
  });

  it("drops threads that disappeared so a returning thread reseeds", () => {
    const gone = planWaitingNotifications({
      ...base,
      candidates: [],
      previousObservations: new Map([["env:a", seen(null)]]),
    });
    expect(gone.nextObservations.has("env:a")).toBe(false);

    const returned = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", "approval")],
      previousObservations: gone.nextObservations,
    });
    expect(returned.emissions).toEqual([]);
  });
});

describe("planWaitingNotifications artifacts", () => {
  const base = { enabled: true, appFocused: false } as const;

  function candidate(
    threadKey: string,
    kind: WaitingNotificationKind | null,
    snoozed = false,
    unreadArtifactCount = 0,
  ): WaitingNotificationCandidate {
    return { threadKey, kind, snoozed, unreadArtifactCount };
  }

  function seen(kind: WaitingNotificationKind | null, unreadArtifactCount = 0) {
    return { kind, unreadArtifactCount };
  }

  it("notifies when a known thread's unread count rises", () => {
    const plan = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", null, false, 1)],
      previousObservations: new Map([["env:a", seen(null, 0)]]),
    });

    expect(plan.emissions).toEqual([
      { threadKey: "env:a", reason: "artifacts", newArtifactCount: 1 },
    ]);
  });

  it("seeds a first-seen thread's artifacts silently", () => {
    const plan = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", null, false, 4)],
      previousObservations: new Map(),
    });

    expect(plan.emissions).toEqual([]);
    expect(plan.nextObservations.get("env:a")).toEqual({ kind: null, unreadArtifactCount: 4 });
  });

  it("coalesces a burst into one banner carrying the rise", () => {
    const plan = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", null, false, 3)],
      previousObservations: new Map([["env:a", seen(null, 0)]]),
    });

    expect(plan.emissions).toEqual([
      { threadKey: "env:a", reason: "artifacts", newArtifactCount: 3 },
    ]);
  });

  it("stays quiet while the count holds or falls", () => {
    const held = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", null, false, 2)],
      previousObservations: new Map([["env:a", seen(null, 2)]]),
    });
    expect(held.emissions).toEqual([]);

    // Reading one lowers the count; that is the user acting, not news.
    const read = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", null, false, 1)],
      previousObservations: new Map([["env:a", seen(null, 2)]]),
    });
    expect(read.emissions).toEqual([]);
  });

  it("stays quiet for a snoozed thread and does not replay it when the snooze lapses", () => {
    const snoozed = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", null, true, 1)],
      previousObservations: new Map([["env:a", seen(null, 0)]]),
    });
    expect(snoozed.emissions).toEqual([]);

    const woke = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", null, false, 1)],
      previousObservations: snoozed.nextObservations,
    });
    expect(woke.emissions).toEqual([]);
  });

  it("stays quiet while focused or disabled and does not replay on the next pass", () => {
    for (const suppressor of [{ appFocused: true }, { enabled: false }]) {
      const quiet = planWaitingNotifications({
        ...base,
        ...suppressor,
        candidates: [candidate("env:a", null, false, 1)],
        previousObservations: new Map([["env:a", seen(null, 0)]]),
      });
      expect(quiet.emissions).toEqual([]);

      const after = planWaitingNotifications({
        ...base,
        candidates: [candidate("env:a", null, false, 1)],
        previousObservations: quiet.nextObservations,
      });
      expect(after.emissions).toEqual([]);
    }
  });

  it("lets the waiting state win when both land in one pass, and does not defer the artifact", () => {
    const collided = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", "approval", false, 1)],
      previousObservations: new Map([["env:a", seen(null, 0)]]),
    });
    // One banner per thread: they share a tag, so a second would replace it.
    expect(collided.emissions).toEqual([
      { threadKey: "env:a", reason: "waiting", kind: "approval" },
    ]);
    expect(collided.nextObservations.get("env:a")).toEqual({
      kind: "approval",
      unreadArtifactCount: 1,
    });

    // The skipped artifact is dropped, not queued behind the waiting banner.
    const next = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", "approval", false, 1)],
      previousObservations: collided.nextObservations,
    });
    expect(next.emissions).toEqual([]);
  });

  it("still announces an artifact when the waiting state is unchanged", () => {
    const plan = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", "approval", false, 1)],
      previousObservations: new Map([["env:a", seen("approval", 0)]]),
    });

    expect(plan.emissions).toEqual([
      { threadKey: "env:a", reason: "artifacts", newArtifactCount: 1 },
    ]);
  });

  it("drops a vanished thread's artifact count so a returning thread reseeds", () => {
    const gone = planWaitingNotifications({
      ...base,
      candidates: [],
      previousObservations: new Map([["env:a", seen(null, 0)]]),
    });
    const returned = planWaitingNotifications({
      ...base,
      candidates: [candidate("env:a", null, false, 5)],
      previousObservations: gone.nextObservations,
    });
    expect(returned.emissions).toEqual([]);
  });
});

describe("artifactNotificationContent", () => {
  it("reads naturally for one file and for a coalesced burst", () => {
    expect(artifactNotificationContent(1, "Rename the widget")).toEqual({
      title: "New artifact",
      body: "Rename the widget",
    });
    expect(artifactNotificationContent(3, "Rename the widget")).toEqual({
      title: "3 new artifacts",
      body: "Rename the widget",
    });
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
