import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

const base = {
  provider: ProviderDriverKind.make("codex"),
  createdAt: "2026-08-06T00:00:00.000Z",
  threadId: ThreadId.make("thread-1"),
};

describe("runtimeEventToActivities task progress", () => {
  it("persists usage independently from replaceable activity", () => {
    const taskId = RuntimeTaskId.make("agent-1");
    const usageOnly = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-usage"),
      payload: {
        taskId,
        description: "Agent one",
        typedUsage: { totalTokens: 73_700_000 },
      },
    } satisfies ProviderRuntimeEvent;
    const command = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-command"),
      payload: {
        taskId,
        description: "Agent one",
        summary: "Running tests",
        lastToolName: "exec_command",
      },
    } satisfies ProviderRuntimeEvent;

    const usageActivities = runtimeEventToActivities(usageOnly);
    const commandActivities = runtimeEventToActivities(command);

    expect(usageActivities.map((activity) => activity.id)).toEqual(["task-usage:thread-1:agent-1"]);
    expect(commandActivities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-1",
    ]);
    const usagePayload = usageActivities[0]?.payload as Record<string, unknown> | undefined;
    expect(usagePayload?.typedUsage).toEqual({ totalTokens: 73_700_000 });
    expect(usagePayload?.usageSnapshot).toBe(true);
  });

  it("splits combined progress and usage into their independent snapshots", () => {
    const event = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-combined"),
      payload: {
        taskId: RuntimeTaskId.make("agent-2"),
        description: "Agent two",
        summary: "Inspecting the panel",
        typedUsage: { totalTokens: 4_200, toolUses: 7 },
        status: "running",
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);
    const progressPayload = activities[0]?.payload as Record<string, unknown>;
    const usagePayload = activities[1]?.payload as Record<string, unknown>;

    expect(activities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-2",
      "task-usage:thread-1:agent-2",
    ]);
    expect(progressPayload.summary).toBe("Inspecting the panel");
    expect(progressPayload.status).toBe("running");
    expect(progressPayload).not.toHaveProperty("typedUsage");
    expect(usagePayload.typedUsage).toEqual({ totalTokens: 4_200, toolUses: 7 });
    expect(usagePayload.usageSnapshot).toBe(true);
    expect(usagePayload).not.toHaveProperty("status");
  });
});
describe("runtimeEventToActivities tool streaming persistence", () => {
  const accumulatedStdout = [
    "first line of output",
    ...Array.from({ length: 500 }, (_, index) => `Capturing frame ${index}/9028`),
  ].join("\n");
  const streamingData = {
    toolCallId: "tool-call-1",
    kind: "execute",
    command: "blender --render",
    rawOutput: { stdout: accumulatedStdout },
    content: [{ type: "content", content: { type: "text", text: accumulatedStdout } }],
  };

  it("persists tool.updated with the wire projection of data, not the accumulated stream", () => {
    const event = {
      ...base,
      type: "item.updated",
      eventId: EventId.make("evt-tool-streaming-updated"),
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "Render",
        detail: accumulatedStdout,
        data: streamingData,
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);

    expect(activities).toHaveLength(1);
    const payload = activities[0]?.payload as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;
    expect(payload.status).toBe("inProgress");
    expect(data.toolCallId).toBe("tool-call-1");
    expect(data.command).toBe("blender --render");
    expect(data.rawOutput).toEqual({ content: "first line of output" });
    expect(data.content).toBeUndefined();
    expect(JSON.stringify(data).length).toBeLessThan(1_000);
  });

  it("persists the full terminal payload on tool.completed", () => {
    const event = {
      ...base,
      type: "item.completed",
      eventId: EventId.make("evt-tool-streaming-completed"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Render",
        data: streamingData,
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);

    expect(activities).toHaveLength(1);
    const payload = activities[0]?.payload as Record<string, unknown>;
    expect(payload.data).toEqual(streamingData);
  });
});

describe("runtimeEventToActivities agent narration", () => {
  const narration = (
    itemType: "assistant_message" | "reasoning",
    detail: string,
    agentId?: string,
  ) =>
    ({
      ...base,
      type: "item.completed",
      eventId: EventId.make(`evt-${itemType}`),
      itemId: RuntimeItemId.make("snapshot-uuid:0"),
      payload: {
        itemType,
        status: "completed",
        title: itemType === "reasoning" ? "Thinking" : "Assistant message",
        detail,
        ...(agentId ? { agentId, parentToolUseId: "toolu_agent" } : {}),
      },
    }) satisfies ProviderRuntimeEvent;

  it("persists agent-owned text and thinking as attributed rows", () => {
    const [message] = runtimeEventToActivities(
      narration("assistant_message", "found it", "agent-1"),
    );
    expect(message?.kind).toBe("agent.message");
    expect(message?.payload).toEqual({
      itemType: "assistant_message",
      detail: "found it",
      agentId: "agent-1",
      parentToolUseId: "toolu_agent",
    });

    const [thinking] = runtimeEventToActivities(
      narration("reasoning", "weighing options", "agent-1"),
    );
    expect(thinking?.kind).toBe("agent.reasoning");
    expect(thinking?.summary).toBe("Thinking");
  });

  it("keeps the whole detail: the row IS the agent transcript", () => {
    const long = "y".repeat(5_000);
    const [activity] = runtimeEventToActivities(narration("assistant_message", long, "agent-1"));
    const payload = activity?.payload as Record<string, unknown>;
    expect(payload.detail).toBe(long);
  });

  it("ignores unattributed assistant items, which stay parent messages", () => {
    expect(runtimeEventToActivities(narration("assistant_message", "main thread text"))).toEqual(
      [],
    );
  });
});

describe("runtimeEventToActivities peer messages", () => {
  const peerEvent = (payload: Record<string, unknown>) =>
    ({
      ...base,
      type: "peer.message",
      eventId: EventId.make("evt-peer"),
      payload,
    }) as unknown as ProviderRuntimeEvent;

  it("names the sender and previews the body on an informational row", () => {
    const [activity] = runtimeEventToActivities(
      peerEvent({
        direction: "incoming",
        deliveryKind: "peer",
        peerName: "t3code-9c",
        senderPid: 12345,
        body: "Reply briefly with the word acknowledged.",
      }),
    );

    expect(activity?.kind).toBe("peer.message");
    // Never the error tone: an inbound message is not a fault.
    expect(activity?.tone).toBe("info");
    expect(activity?.summary).toBe(
      "Message from t3code-9c: Reply briefly with the word acknowledged.",
    );
    expect(activity?.payload).toEqual({
      direction: "incoming",
      deliveryKind: "peer",
      detail: "Reply briefly with the word acknowledged.",
      peerName: "t3code-9c",
      senderPid: 12345,
    });
  });

  it("still reports the arrival when the envelope carried no name or body", () => {
    const [activity] = runtimeEventToActivities(
      peerEvent({ direction: "incoming", deliveryKind: "task-notification" }),
    );

    expect(activity?.kind).toBe("peer.message");
    expect(activity?.summary).toBe("Message from another session");
    expect(activity?.payload).toEqual({
      direction: "incoming",
      deliveryKind: "task-notification",
    });
  });

  it("previews a long body on the row label but keeps the whole message to expand", () => {
    const body = "z".repeat(500);
    const [activity] = runtimeEventToActivities(
      peerEvent({ direction: "incoming", deliveryKind: "peer", body }),
    );
    const payload = activity?.payload as Record<string, unknown>;

    expect(activity?.summary.length).toBe(120);
    // The point of expanding a peer message is reading it, so the detail is
    // the message, not a 180-char row label.
    expect(payload.detail).toBe(body);
  });

  it("keeps a realistically large body whole", () => {
    // The largest peer message across every recorded session was ~2.9KB.
    const body = "word ".repeat(1_000);
    const [activity] = runtimeEventToActivities(
      peerEvent({ direction: "incoming", deliveryKind: "peer", body }),
    );
    const payload = activity?.payload as Record<string, unknown>;

    expect(payload.detail).toBe(body);
  });

  it("bounds a pathological body so one sender cannot bloat thread-open", () => {
    const body = "y".repeat(40_000);
    const [activity] = runtimeEventToActivities(
      peerEvent({ direction: "incoming", deliveryKind: "peer", body }),
    );
    const payload = activity?.payload as Record<string, unknown>;

    expect((payload.detail as string).length).toBe(32_000);
    expect(payload.detail).toMatch(/\.\.\.$/);
  });
});

describe("runtimeEventToActivities outgoing peer messages", () => {
  it("labels an outgoing message with its recipient and preview", () => {
    const [activity] = runtimeEventToActivities({
      ...base,
      type: "peer.message",
      eventId: EventId.make("evt-peer-out"),
      payload: {
        direction: "outgoing",
        deliveryKind: "peer",
        peerName: "t3code-9c",
        summary: "Status update",
        body: "Rebase is done and the suite is green.",
      },
    } as unknown as ProviderRuntimeEvent);

    expect(activity?.kind).toBe("peer.message");
    expect(activity?.tone).toBe("info");
    // Symmetric with the incoming label, so a conversation reads as one.
    expect(activity?.summary).toBe("Message to t3code-9c: Rebase is done and the suite is green.");
    expect(activity?.payload).toEqual({
      direction: "outgoing",
      deliveryKind: "peer",
      detail: "Rebase is done and the suite is green.",
      peerName: "t3code-9c",
      summary: "Status update",
    });
  });

  it("drops the generic SendMessage tool row so one send is one row", () => {
    const toolItem = (type: "item.started" | "item.completed") =>
      ({
        ...base,
        type,
        eventId: EventId.make(`evt-${type}`),
        itemId: RuntimeItemId.make("tool-send-1"),
        payload: {
          itemType: "mcp_tool_call",
          status: type === "item.started" ? "inProgress" : "completed",
          title: "SendMessage",
          data: { toolName: "SendMessage", input: { to: "t3code-9c" } },
        },
      }) as unknown as ProviderRuntimeEvent;

    expect(runtimeEventToActivities(toolItem("item.started"))).toEqual([]);
    expect(runtimeEventToActivities(toolItem("item.completed"))).toEqual([]);
  });

  it("leaves other tool rows alone", () => {
    const grep = {
      ...base,
      type: "item.completed",
      eventId: EventId.make("evt-grep"),
      itemId: RuntimeItemId.make("tool-grep-1"),
      payload: {
        itemType: "mcp_tool_call",
        status: "completed",
        title: "Grep",
        data: { toolName: "Grep", input: { pattern: "foo" } },
      },
    } as unknown as ProviderRuntimeEvent;

    expect(runtimeEventToActivities(grep)[0]?.kind).toBe("tool.completed");
  });
});

describe("runtimeEventToActivities subagent-directed messages", () => {
  const injected = (payload: Record<string, unknown>) =>
    ({
      ...base,
      type: "peer.message",
      eventId: EventId.make("evt-peer-agent"),
      payload,
    }) as unknown as ProviderRuntimeEvent;

  it("attributes the row to the receiving subagent so it leaves the parent timeline", () => {
    const [activity] = runtimeEventToActivities(
      injected({
        direction: "incoming",
        deliveryKind: "subagent-injection",
        agentId: "agent-junior-1",
        summary: "Change of plan",
        body: "Do not commit to main.",
      }),
    );

    expect(activity?.kind).toBe("peer.message");
    expect(activity?.tone).toBe("info");
    expect(activity?.payload).toEqual({
      direction: "incoming",
      deliveryKind: "subagent-injection",
      detail: "Do not commit to main.",
      summary: "Change of plan",
      // Presence of agentId is what re-homes the row into the Agents surface.
      agentId: "agent-junior-1",
    });
  });

  it("says the message was sent, never that the agent received it", () => {
    const [activity] = runtimeEventToActivities(
      injected({
        direction: "incoming",
        deliveryKind: "subagent-injection",
        agentId: "agent-junior-1",
        body: "Do not commit to main.",
      }),
    );

    // The harness reports no delivery outcome and drops a message silently
    // when the agent finishes first, so the label may only claim the send.
    expect(activity?.summary).toBe("Message sent from the main thread: Do not commit to main.");
    expect(activity?.summary).not.toContain("received");
  });

  it("does not claim the main thread as sender for a genuine peer message", () => {
    const [activity] = runtimeEventToActivities(
      injected({ direction: "incoming", deliveryKind: "peer", body: "Hello." }),
    );

    const payload = activity?.payload as Record<string, unknown>;
    expect(activity?.summary).toBe("Message from another session: Hello.");
    expect(payload.agentId).toBeUndefined();
  });
});
