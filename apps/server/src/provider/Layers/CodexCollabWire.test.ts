/**
 * Codex multi-agent wire fixtures.
 *
 * The child-interception path is the highest-blast-radius code in the
 * subagent stack: it decides, per notification, whether traffic reaches the
 * parent timeline at all. Three shipped bugs came from that decision being
 * implicit (root thread registered as its own child; `error` and
 * `serverRequest/resolved` swallowed by a catch-all). These tests pin the
 * decision against a REAL capture rather than hand-written shapes.
 *
 * Fixture provenance: codex-cli 0.145.0 driven directly over stdio with
 * gpt-5.6-luna at low effort, prompting a two-child fan-out (alpha, beta).
 * See codexMultiAgentWire.json.
 */
import {
  EventId,
  ProviderDriverKind,
  ProviderItemId,
  type ProviderEvent,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import fixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { mapToRuntimeEvents } from "./CodexAdapter.ts";
import { routeCodexChildNotification } from "./CodexSessionRuntime.ts";

interface WireNotification {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

const notifications = fixture.notifications as ReadonlyArray<WireNotification>;
const rootThreadId = fixture.rootThreadId;
const childThreadIds = new Set(fixture.childThreadIds);

/** Mirrors readNotificationThreadId's addressing for the captured methods. */
function notificationThreadId(entry: WireNotification): string | undefined {
  const params = entry.params;
  const thread = params.thread;
  if (
    typeof thread === "object" &&
    thread !== null &&
    typeof (thread as { id?: unknown }).id === "string"
  ) {
    return (thread as { id: string }).id;
  }
  return typeof params.threadId === "string" ? params.threadId : undefined;
}

function subAgentActivityItems(): ReadonlyArray<Record<string, unknown>> {
  return notifications.flatMap((entry) => {
    const item = entry.params.item;
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    return record.type === "subAgentActivity" ? [record] : [];
  });
}

describe("codex multi-agent wire capture", () => {
  it("captures a real two-child fan-out", () => {
    assert.equal(fixture.capturedWith.model, "gpt-5.6-luna");
    assert.equal(childThreadIds.size, 2);
    const paths = subAgentActivityItems().map((item) => item.agentPath);
    assert.include(paths, "/root/alpha");
    assert.include(paths, "/root/beta");
  });

  it("emits child traffic BEFORE the item that registers the child", () => {
    // Ordering hazard: the child's own thread/status/changed arrives before
    // the parent-side subAgentActivity naming it. Registration must tolerate
    // child-first arrival, so unregistered child traffic passes through
    // rather than being eaten (no regression vs. pre-feature behavior).
    const firstChildTraffic = notifications.findIndex((entry) => {
      const threadId = notificationThreadId(entry);
      return threadId !== undefined && childThreadIds.has(threadId);
    });
    const firstRegistration = notifications.findIndex((entry) => {
      const item = entry.params.item;
      if (typeof item !== "object" || item === null) return false;
      const record = item as Record<string, unknown>;
      return record.type === "subAgentActivity" && record.kind === "started";
    });
    assert.isAtLeast(firstChildTraffic, 0);
    assert.isAtLeast(firstRegistration, 0);
    assert.isBelow(
      firstChildTraffic,
      firstRegistration,
      "capture should exercise child-first ordering",
    );
  });

  it("contains a /root self-activity emitted from a CHILD thread", () => {
    // The bug this guards: the wire reports subAgentActivity about the ROOT
    // (agentPath "/root"). Registering it made the runtime intercept the
    // parent's own final message and turn/completed, so the thread hung
    // "working" forever. The root guard must key on agentPath/thread id,
    // never on which thread the notification arrived from.
    const rootSelfActivity = subAgentActivityItems().find((item) => item.agentPath === "/root");
    assert.isDefined(rootSelfActivity, "capture should contain a /root self-activity");
    assert.equal(rootSelfActivity?.agentThreadId, rootThreadId);
  });

  it("routes every captured child method to a defined disposition", () => {
    const childMethods = new Set(
      notifications
        .filter((entry) => {
          const threadId = notificationThreadId(entry);
          return threadId !== undefined && childThreadIds.has(threadId);
        })
        .map((entry) => entry.method),
    );
    assert.isAbove(childMethods.size, 0);
    for (const method of childMethods) {
      const route = routeCodexChildNotification(method);
      // Child lifecycle traffic must become agent events — never silently
      // dropped, never leaked to the parent timeline.
      assert.equal(route, "agent-event", `${method} should map to an agent event`);
    }
  });
});

/**
 * Adapter half of the child path. The capture contains no child tool item
 * (the children in that trace only reasoned and answered), so the items here
 * are hand-built from the app-server v2 `ThreadItem` schema — the fixture
 * stays a pristine capture. Identity comes from the real capture: the child
 * thread id is the agent id the adapter must stamp.
 */
const CHILD_THREAD_ID = fixture.childThreadIds[0]!;
const CANONICAL_THREAD_ID = ThreadId.make("thread-collab-wire");
const SPAWN_TURN_ID = TurnId.make("00000000-0000-4000-8000-000000000001");

/** Mirrors the synthetic event CodexSessionRuntime emits for a child item. */
function collabItemEvent(
  lifecycle: "started" | "completed",
  item: Record<string, unknown>,
): ProviderEvent {
  return {
    id: EventId.make(`event-${lifecycle}-${String(item.id)}`),
    kind: "notification",
    provider: ProviderDriverKind.make("codex"),
    threadId: CANONICAL_THREAD_ID,
    createdAt: "2026-01-01T00:00:00.000Z",
    method: "collabAgent/item",
    turnId: SPAWN_TURN_ID,
    itemId: ProviderItemId.make(String(item.id)),
    payload: {
      agentThreadId: CHILD_THREAD_ID,
      nickname: "alpha",
      agentPath: "/root/alpha",
      lifecycle,
      agentTurnId: `${CHILD_THREAD_ID}-turn-1`,
      item,
    },
  };
}

const COMMAND_ITEM = {
  id: "item_child_cmd_1",
  type: "commandExecution",
  command: "rg --files apps/server",
  commandActions: [],
  cwd: "/workspace/repo",
  status: "completed",
  exitCode: 0,
  aggregatedOutput: "apps/server/src/bin.ts\n",
  durationMs: 412,
} as const;

function eventsOfType(events: ReadonlyArray<ProviderRuntimeEvent>, type: string) {
  return events.filter((event) => event.type === type);
}

describe("collab child item fidelity", () => {
  it("maps a child item/completed to an attributed, full-fidelity item.completed", () => {
    const mapped = mapToRuntimeEvents(
      collabItemEvent("completed", { ...COMMAND_ITEM }),
      CANONICAL_THREAD_ID,
    );

    const [completed] = eventsOfType(mapped, "item.completed");
    assert.isDefined(completed, "a child's completed item must become item.completed");
    const payload = completed!.payload as Record<string, unknown>;
    // Same shape the PARENT thread's items get...
    assert.equal(payload.itemType, "command_execution");
    assert.equal(payload.status, "completed");
    assert.equal(payload.title, "Ran command");
    assert.equal(payload.detail, COMMAND_ITEM.command);
    // ...including the verbatim item under data.item, which is where both
    // clients read command, output and diffs from.
    const data = payload.data as { readonly item?: Record<string, unknown> };
    assert.deepEqual(data.item, { ...COMMAND_ITEM });
    // ...attributed to the child so clients re-home it into the agent's row.
    assert.equal(payload.agentId, CHILD_THREAD_ID);
    // Correlation: the child's item id rides through as itemId/providerItemId,
    // and the event stays on the parent's spawn turn (fleet batching).
    assert.equal(String(completed!.itemId), COMMAND_ITEM.id);
    assert.equal(String(completed!.providerRefs?.providerItemId), COMMAND_ITEM.id);
    assert.equal(completed!.turnId, SPAWN_TURN_ID);
  });

  it("keeps the Agents-panel heartbeat alongside the item event", () => {
    // The Agents surface reads its activity line from task.progress summaries
    // (latest-state, one row per task); item rows are durable history and feed
    // no panel state. Dropping the heartbeat would blank the panel.
    const mapped = mapToRuntimeEvents(
      collabItemEvent("completed", { ...COMMAND_ITEM }),
      CANONICAL_THREAD_ID,
    );
    const [progress] = eventsOfType(mapped, "task.progress");
    assert.isDefined(progress);
    const payload = progress!.payload as Record<string, unknown>;
    assert.equal(payload.summary, COMMAND_ITEM.command);
    assert.equal(payload.taskId, CHILD_THREAD_ID);
    assert.equal(payload.timelineBypass, true);
  });

  it("mirrors the parent's started lifecycle for a child item/started", () => {
    const mapped = mapToRuntimeEvents(
      collabItemEvent("started", { ...COMMAND_ITEM, status: "inProgress" }),
      CANONICAL_THREAD_ID,
    );
    const [started] = eventsOfType(mapped, "item.started");
    assert.isDefined(started);
    const payload = started!.payload as Record<string, unknown>;
    assert.equal(payload.status, "inProgress");
    assert.equal(payload.agentId, CHILD_THREAD_ID);
    assert.equal(eventsOfType(mapped, "item.completed").length, 0);
  });

  it("maps child commentary and thinking as attributed narration items", () => {
    const message = mapToRuntimeEvents(
      collabItemEvent("completed", {
        id: "item_child_msg_1",
        type: "agentMessage",
        text: "Found three matches.",
      }),
      CANONICAL_THREAD_ID,
    );
    const [assistant] = eventsOfType(message, "item.completed");
    assert.isDefined(assistant);
    const assistantPayload = assistant!.payload as Record<string, unknown>;
    assert.equal(assistantPayload.itemType, "assistant_message");
    assert.equal(assistantPayload.detail, "Found three matches.");
    assert.equal(assistantPayload.agentId, CHILD_THREAD_ID);

    const reasoning = mapToRuntimeEvents(
      collabItemEvent("completed", {
        id: "item_child_reasoning_1",
        type: "reasoning",
        content: ["Checking the server package first.", "Then the web app."],
        summary: ["Locating files"],
      }),
      CANONICAL_THREAD_ID,
    );
    const [thinking] = eventsOfType(reasoning, "item.completed");
    assert.isDefined(thinking);
    const thinkingPayload = thinking!.payload as Record<string, unknown>;
    assert.equal(thinkingPayload.itemType, "reasoning");
    assert.equal(thinkingPayload.agentId, CHILD_THREAD_ID);
    // Reasoning text is string ARRAYS on the wire. A child never gets the
    // reasoning delta stream, so the joined text has to reach `detail` — the
    // narration activity persists detail, not data.
    assert.equal(thinkingPayload.detail, "Checking the server package first.\n\nThen the web app.");
    const thinkingData = thinkingPayload.data as { readonly item?: Record<string, unknown> };
    assert.deepEqual(thinkingData.item?.summary, ["Locating files"]);
  });

  it("degrades to the heartbeat alone for an item shape this build cannot decode", () => {
    // A codex update that adds an item type must not lose the agent's
    // activity line — the same "never vanish" rule the routing table follows.
    const mapped = mapToRuntimeEvents(
      collabItemEvent("completed", { id: "item_child_new_1", type: "quantumThing" }),
      CANONICAL_THREAD_ID,
    );
    assert.deepEqual(
      mapped.map((event) => event.type),
      ["task.progress"],
    );
  });

  it("leaves parent-thread items unattributed", () => {
    // Regression guard for the shared mapping: attribution is child-only.
    const parentEvent: ProviderEvent = {
      id: EventId.make("event-parent-item"),
      kind: "notification",
      provider: ProviderDriverKind.make("codex"),
      threadId: CANONICAL_THREAD_ID,
      createdAt: "2026-01-01T00:00:00.000Z",
      method: "item/completed",
      turnId: SPAWN_TURN_ID,
      payload: {
        completedAtMs: 1785898342000,
        threadId: fixture.rootThreadId,
        turnId: `${fixture.rootThreadId}-turn-1`,
        item: { ...COMMAND_ITEM },
      },
    };
    const [completed] = eventsOfType(
      mapToRuntimeEvents(parentEvent, CANONICAL_THREAD_ID),
      "item.completed",
    );
    assert.isDefined(completed);
    const payload = completed!.payload as Record<string, unknown>;
    assert.equal(payload.itemType, "command_execution");
    assert.isUndefined(payload.agentId);
  });
});

describe("routeCodexChildNotification", () => {
  it("maps child lifecycle to agent events", () => {
    for (const method of [
      "turn/started",
      "turn/completed",
      "thread/status/changed",
      "thread/tokenUsage/updated",
      "item/started",
      "item/completed",
      "thread/closed",
      "error",
    ]) {
      assert.equal(routeCodexChildNotification(method), "agent-event", method);
    }
  });

  it("drops only enumerated child chatter", () => {
    for (const method of [
      "item/agentMessage/delta",
      "item/reasoning/textDelta",
      "item/commandExecution/outputDelta",
      "turn/plan/updated",
      "thread/name/updated",
    ]) {
      assert.equal(routeCodexChildNotification(method), "drop", method);
    }
  });

  it("never routes child-owned thread lifecycle to the parent", () => {
    // These mutate PARENT thread state in CodexAdapter (archived/compacted),
    // so a child emitting them must never reach the parent path. This list
    // mirrors shouldSuppressChildConversationNotification (the v1 collab
    // suppressor) — the two must not drift (review finding: the router
    // initially omitted them and they leaked).
    for (const method of [
      "thread/started",
      "thread/status/changed",
      "thread/archived",
      "thread/unarchived",
      "thread/closed",
      "thread/compacted",
      "thread/name/updated",
      "thread/tokenUsage/updated",
      "turn/started",
      "turn/completed",
      "turn/plan/updated",
      "item/plan/delta",
    ]) {
      assert.notEqual(
        routeCodexChildNotification(method),
        "parent",
        `${method} is child-owned and must not reach the parent path`,
      );
    }
  });

  it("sends parent-owned and UNKNOWN methods to the parent path", () => {
    // serverRequest/resolved clears the parent's approval correlation:
    // swallowing it left approvals stuck (shipped bug). Unknown methods take
    // the same route by design — a codex update that adds a notification
    // must degrade to "parent sees it", never to silent loss.
    assert.equal(routeCodexChildNotification("serverRequest/resolved"), "parent");
    assert.equal(routeCodexChildNotification("thread/somethingBrandNew"), "parent");
    assert.equal(routeCodexChildNotification("account/rateLimits/updated"), "parent");
  });
});
