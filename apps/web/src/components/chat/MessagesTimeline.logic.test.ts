import { describe, expect, it } from "vite-plus/test";
import {
  computeStableMessagesTimelineRows,
  computeMessageDurationStart,
  deriveTimelineMinimapItems,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  reconcileTimelineScrollToEnd,
  resolveTimelineMinimapStepIndex,
  resolveTimelineMinimapTickMetrics,
  shouldPreserveAssistantLineBreaks,
  shouldShowTimelineMinimap,
} from "./MessagesTimeline.logic";

describe("shouldPreserveAssistantLineBreaks", () => {
  it("preserves Claude insight formatting without changing regular markdown", () => {
    expect(
      shouldPreserveAssistantLineBreaks(
        "★ Insight ─────────────────\\nFirst observation\\nSecond observation\\n─────────────────",
      ),
    ).toBe(true);
    expect(shouldPreserveAssistantLineBreaks("A normal\\nmarkdown paragraph")).toBe(false);
  });
});

describe("reconcileTimelineScrollToEnd", () => {
  it("targets the browser's current physical end after every geometry change", () => {
    const requestedTops: number[] = [];
    const target = {
      scrollTop: 200,
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTo: ({ top }: { top: number }) => {
        requestedTops.push(top);
      },
    };

    expect(reconcileTimelineScrollToEnd(target)).toBe(true);
    target.scrollTop = 600;
    expect(reconcileTimelineScrollToEnd(target)).toBe(false);

    target.scrollHeight = 1400;
    expect(reconcileTimelineScrollToEnd(target)).toBe(true);
    expect(requestedTops).toEqual([1000, 1400]);
  });
});

describe("computeMessageDurationStart", () => {
  it("returns message createdAt when there is no preceding user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:05Z",
        updatedAt: "2026-01-01T00:00:10Z",
        streaming: false,
      },
    ]);
    expect(result).toEqual(new Map([["a1", "2026-01-01T00:00:05Z"]]));
  });

  it("uses the user message createdAt for the first assistant response", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("uses the previous completed assistant updatedAt for subsequent assistant responses", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        updatedAt: "2026-01-01T00:00:55Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:30Z"],
      ]),
    );
  });

  it("does not advance the boundary for a streaming message", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:40Z",
        streaming: true,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        updatedAt: "2026-01-01T00:00:55Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("resets the boundary on a new user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
      {
        id: "u2",
        role: "user",
        createdAt: "2026-01-01T00:01:00Z",
        updatedAt: "2026-01-01T00:01:00Z",
        streaming: false,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:01:20Z",
        updatedAt: "2026-01-01T00:01:20Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["u2", "2026-01-01T00:01:00Z"],
        ["a2", "2026-01-01T00:01:00Z"],
      ]),
    );
  });

  it("handles system messages without affecting the boundary", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "s1",
        role: "system",
        createdAt: "2026-01-01T00:00:01Z",
        updatedAt: "2026-01-01T00:00:01Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["s1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("returns empty map for empty input", () => {
    expect(computeMessageDurationStart([])).toEqual(new Map());
  });
});

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording from command labels", () => {
    expect(normalizeCompactToolLabel("Ran command complete")).toBe("Ran command");
  });

  it("removes trailing completion wording from other labels", () => {
    expect(normalizeCompactToolLabel("Read file completed")).toBe("Read file");
  });
});

describe("timeline minimap landmarks", () => {
  const turnId = "turn-minimap" as never;
  const timelineEntries = [
    {
      id: "user-entry",
      kind: "message" as const,
      createdAt: "2026-01-01T00:00:00Z",
      message: {
        id: "user-message" as never,
        role: "user" as const,
        text: "Please inspect the timeline.\nThen explain it.",
        turnId: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
    },
    {
      id: "commentary-entry",
      kind: "message" as const,
      createdAt: "2026-01-01T00:00:05Z",
      message: {
        id: "commentary-message" as never,
        role: "assistant" as const,
        text: "I’m tracing the rendered rows first.",
        turnId,
        createdAt: "2026-01-01T00:00:05Z",
        updatedAt: "2026-01-01T00:00:06Z",
        streaming: false,
      },
    },
    {
      id: "work-entry",
      kind: "work" as const,
      createdAt: "2026-01-01T00:00:10Z",
      entry: {
        id: "work-message",
        turnId,
        createdAt: "2026-01-01T00:00:10Z",
        label: "Read timeline source",
        tone: "tool" as const,
      },
    },
    {
      id: "final-entry",
      kind: "message" as const,
      createdAt: "2026-01-01T00:00:15Z",
      message: {
        id: "final-message" as never,
        role: "assistant" as const,
        text: "The timeline now has semantic landmarks.",
        turnId,
        createdAt: "2026-01-01T00:00:15Z",
        updatedAt: "2026-01-01T00:00:20Z",
        streaming: false,
      },
    },
  ];

  function deriveRows() {
    return deriveMessagesTimelineRows({
      timelineEntries,
      latestTurn: {
        turnId,
        state: "completed" as const,
        startedAt: "2026-01-01T00:00:01Z",
        completedAt: "2026-01-01T00:00:20Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });
  }

  it("interleaves user and assistant messages in rendered order", () => {
    const items = deriveTimelineMinimapItems(deriveRows());

    expect(items).toMatchObject([
      {
        actor: "user",
        rowIndex: 0,
        previewText: "Please inspect the timeline. Then explain it.",
        secondaryText: "The timeline now has semantic landmarks.",
      },
      {
        actor: "assistant",
        rowIndex: 1,
        previewText: "I’m tracing the rendered rows first.",
        secondaryText: null,
      },
      {
        actor: "assistant",
        rowIndex: 3,
        previewText: "The timeline now has semantic landmarks.",
        secondaryText: null,
      },
    ]);
  });

  it("excludes activity rows from message landmarks", () => {
    const items = deriveTimelineMinimapItems(deriveRows());

    expect(items.map((item) => item.actor)).toEqual(["user", "assistant", "assistant"]);
    expect(items.some((item) => item.previewText?.startsWith("Read timeline"))).toBe(false);
  });

  it("stays hidden for one prompt and one reply, but appears for either repeated actor", () => {
    const user = {
      id: "user",
      rowIndex: 0,
      actor: "user" as const,
      previewText: "Prompt",
      secondaryText: null,
    };
    const assistant = {
      ...user,
      id: "assistant",
      rowIndex: 1,
      actor: "assistant" as const,
      previewText: "Reply",
    };

    expect(shouldShowTimelineMinimap([user, assistant])).toBe(false);
    expect(shouldShowTimelineMinimap([user, { ...user, id: "user-2", rowIndex: 2 }])).toBe(true);
    expect(
      shouldShowTimelineMinimap([
        user,
        assistant,
        { ...assistant, id: "assistant-2", rowIndex: 2 },
      ]),
    ).toBe(true);
  });

  it("steps one landmark relative to the rendered viewport", () => {
    const items = [1, 5, 9].map((rowIndex) => ({
      id: `item-${String(rowIndex)}`,
      rowIndex,
      actor: "assistant" as const,
      previewText: null,
      secondaryText: null,
    }));

    expect(
      resolveTimelineMinimapStepIndex({
        items,
        direction: "previous",
        visibleStartRowIndex: 5,
        visibleEndRowIndex: 7,
      }),
    ).toBe(0);
    expect(
      resolveTimelineMinimapStepIndex({
        items,
        direction: "next",
        visibleStartRowIndex: 5,
        visibleEndRowIndex: 7,
      }),
    ).toBe(2);
    expect(
      resolveTimelineMinimapStepIndex({
        items,
        direction: "previous",
        visibleStartRowIndex: 6,
        visibleEndRowIndex: 8,
      }),
    ).toBe(1);
    expect(
      resolveTimelineMinimapStepIndex({
        items,
        direction: "next",
        visibleStartRowIndex: 6,
        visibleEndRowIndex: 8,
      }),
    ).toBe(2);
    expect(
      resolveTimelineMinimapStepIndex({
        items,
        direction: "next",
        visibleStartRowIndex: 1,
        visibleEndRowIndex: 5,
      }),
    ).toBe(2);
    expect(
      resolveTimelineMinimapStepIndex({
        items,
        direction: "previous",
        visibleStartRowIndex: 1,
        visibleEndRowIndex: 5,
        activeItemId: "item-5",
      }),
    ).toBe(0);
    expect(
      resolveTimelineMinimapStepIndex({
        items,
        direction: "next",
        visibleStartRowIndex: 1,
        visibleEndRowIndex: 5,
        activeItemId: "item-5",
      }),
    ).toBe(2);
  });

  it("steps through a user-only landmark list", () => {
    const items = [
      { id: "user-1", rowIndex: 1, actor: "user" as const },
      { id: "assistant-2", rowIndex: 2, actor: "assistant" as const },
      { id: "assistant-4", rowIndex: 4, actor: "assistant" as const },
      { id: "user-5", rowIndex: 5, actor: "user" as const },
      { id: "assistant-7", rowIndex: 7, actor: "assistant" as const },
      { id: "user-9", rowIndex: 9, actor: "user" as const },
    ]
      .filter((item) => item.actor === "user")
      .map((item) => ({ ...item, previewText: null, secondaryText: null }));

    expect(
      resolveTimelineMinimapStepIndex({
        items,
        direction: "previous",
        visibleStartRowIndex: 4,
        visibleEndRowIndex: 6,
      }),
    ).toBe(0);
    expect(
      resolveTimelineMinimapStepIndex({
        items,
        direction: "next",
        visibleStartRowIndex: 4,
        visibleEndRowIndex: 6,
      }),
    ).toBe(2);
    expect(
      resolveTimelineMinimapStepIndex({
        items,
        direction: "next",
        visibleStartRowIndex: 4,
        visibleEndRowIndex: 6,
        activeItemId: "user-5",
      }),
    ).toBe(2);
    expect(
      resolveTimelineMinimapStepIndex({
        items,
        direction: "previous",
        visibleStartRowIndex: 4,
        visibleEndRowIndex: 6,
        activeItemId: "user-5",
      }),
    ).toBe(0);
  });

  it("magnifies a bounded neighborhood around the active tick", () => {
    expect(resolveTimelineMinimapTickMetrics(5, null)).toEqual({
      width: 8,
      height: 2,
      offsetY: 0,
    });
    expect(resolveTimelineMinimapTickMetrics(5, 5)).toEqual({
      width: 32,
      height: 5,
      offsetY: 0,
    });
    expect(resolveTimelineMinimapTickMetrics(4, 5)).toEqual({
      width: 24,
      height: 4,
      offsetY: -6,
    });
    expect(resolveTimelineMinimapTickMetrics(7, 5)).toEqual({
      width: 18,
      height: 3,
      offsetY: 10,
    });
    expect(resolveTimelineMinimapTickMetrics(2, 5)).toEqual({
      width: 12,
      height: 2,
      offsetY: -12,
    });
    expect(resolveTimelineMinimapTickMetrics(1, 5)).toEqual({
      width: 8,
      height: 2,
      offsetY: -12,
    });
  });
});

describe("resolveAssistantMessageCopyState", () => {
  it("returns enabled copy state for completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Ship it",
        streaming: false,
      }),
    ).toEqual({
      text: "Ship it",
      visible: true,
    });
  });

  it("hides copy while an assistant message is still streaming", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Still streaming",
        streaming: true,
      }),
    ).toEqual({
      text: "Still streaming",
      visible: false,
    });
  });

  it("hides copy for empty completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "   ",
        streaming: false,
      }),
    ).toEqual({
      text: null,
      visible: false,
    });
  });

  it("hides copy for non-terminal assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: false,
        text: "Interim thought",
        streaming: false,
      }),
    ).toEqual({
      text: "Interim thought",
      visible: false,
    });
  });
});

describe("deriveMessagesTimelineRows", () => {
  it("only enables assistant copy for the terminal assistant message in a turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Write a poem",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "I should ground this first.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Here is the poem.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows).toHaveLength(2);
    expect(assistantRows[0]?.showAssistantCopyButton).toBe(false);
    expect(assistantRows[1]?.showAssistantCopyButton).toBe(true);
  });

  it("marks only the active assistant turn as streaming for copy controls", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-one-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-one" as never,
            role: "assistant",
            text: "Earlier response.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-two-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-two" as never,
            role: "assistant",
            text: "Active response.",
            turnId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-2" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:19Z",
        completedAt: null,
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows[0]?.assistantCopyStreaming).toBe(false);
    expect(assistantRows[1]?.assistantCopyStreaming).toBe(true);
  });

  it("projects assistant diff summaries and user revert counts onto the affected rows", () => {
    const assistantTurnDiffSummary = {
      turnId: "turn-1" as never,
      completedAt: "2026-01-01T00:00:30Z",
      assistantMessageId: "assistant-1" as never,
      checkpointTurnCount: 2,
      checkpointRef: "checkpoint-1" as never,
      status: "ready" as const,
      files: [{ path: "src/index.ts", kind: "modified", additions: 3, deletions: 1 }],
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Do the thing",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "Done",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map([
        ["assistant-1" as never, assistantTurnDiffSummary],
      ]),
      revertTurnCountByUserMessageId: new Map([["user-1" as never, 1]]),
    });

    const userRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "user",
    );
    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(userRow?.revertTurnCount).toBe(1);
    expect(assistantRow?.assistantTurnDiffSummary).toBe(assistantTurnDiffSummary);
  });

  it("keeps meaningful activity visible after a turn settles", () => {
    const turnId = "turn-visible-activity" as never;
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user" as never,
            role: "user",
            text: "Update the README",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:01Z",
          message: {
            id: "commentary" as never,
            role: "assistant",
            text: "I will inspect it first.",
            turnId,
            createdAt: "2026-01-01T00:00:01Z",
            updatedAt: "2026-01-01T00:00:01Z",
            streaming: false,
          },
        },
        {
          id: "read-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:02Z",
          entry: {
            id: "read",
            label: "Read README.md",
            requestKind: "file-read",
            createdAt: "2026-01-01T00:00:02Z",
            turnId,
            tone: "tool",
          },
        },
        {
          id: "edit-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:03Z",
          entry: {
            id: "edit",
            label: "File change",
            itemType: "file_change",
            hasFileDiff: true,
            createdAt: "2026-01-01T00:00:03Z",
            turnId,
            tone: "tool",
          },
        },
        {
          id: "test-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:04Z",
          entry: {
            id: "test",
            label: "Ran tests",
            itemType: "command_execution",
            command: "vp test run README.test.ts",
            createdAt: "2026-01-01T00:00:04Z",
            turnId,
            tone: "tool",
          },
        },
        {
          id: "final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:05Z",
          message: {
            id: "final" as never,
            role: "assistant",
            text: "Updated.",
            turnId,
            createdAt: "2026-01-01T00:00:05Z",
            updatedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
      ],
      latestTurn: {
        turnId,
        state: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:06Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "message",
      "work",
      "work",
      "work",
      "message",
    ]);
    const workRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "work" }> => row.kind === "work",
    );
    const workEntries = workRows.flatMap((row) => row.groupedEntries);
    expect(workEntries.map((entry) => entry.id)).toEqual(["read", "edit", "test"]);
    expect(workEntries.find((entry) => entry.id === "edit")?.hasFileDiff).toBe(true);
  });

  it("only shows assistant metadata on the terminal assistant message", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Checking first.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Done.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows.map((row) => row.showAssistantMeta)).toEqual([false, true]);
  });

  it("withholds assistant metadata while the active turn is still in progress", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Working on it.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRow?.showAssistantMeta).toBe(false);
    expect(assistantRow?.showAssistantCopyButton).toBe(false);
  });
});

describe("computeStableMessagesTimelineRows", () => {
  it("returns the previous result when row order and content are unchanged", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      updatedAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(rows, {
      byId: new Map(),
      result: [],
    });

    const repeated = computeStableMessagesTimelineRows(rows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result).toBe(initial.result);
  });

  it("reuses work rows when equivalent timeline derivations create new grouped arrays", () => {
    const firstWorkEntry = {
      id: "work-1",
      createdAt: "2026-01-01T00:00:00Z",
      label: "thinking",
      detail: "Inspecting repository state",
      tone: "thinking" as const,
    };
    const secondWorkEntry = {
      id: "work-2",
      createdAt: "2026-01-01T00:00:01Z",
      label: "read",
      detail: "Reading package.json",
      tone: "tool" as const,
    };

    const createRows = () =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "entry-work-1",
            kind: "work",
            createdAt: firstWorkEntry.createdAt,
            entry: firstWorkEntry,
          },
          {
            id: "entry-work-2",
            kind: "work",
            createdAt: secondWorkEntry.createdAt,
            entry: secondWorkEntry,
          },
        ],
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });

    const firstRows = createRows();
    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });
    const secondRows = createRows();

    expect(secondRows[0]).not.toBe(firstRows[0]);

    const repeated = computeStableMessagesTimelineRows(secondRows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result[0]).toBe(initial.result[0]);
  });

  it("returns a new result when row order changes without content changes", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      updatedAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const firstRows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });

    const reordered = computeStableMessagesTimelineRows([firstRows[1]!, firstRows[0]!], initial);

    expect(reordered).not.toBe(initial);
    expect(reordered.result).toEqual([initial.result[1], initial.result[0]]);
  });
});
