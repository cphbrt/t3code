import { describe, expect, it } from "vite-plus/test";
import type {
  OrchestrationEvent,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import {
  projectActivityEvent,
  projectActivityPayload,
  projectThreadDetailSnapshot,
} from "./ActivityPayloadProjection.ts";

function activity(payload: Record<string, unknown>): OrchestrationThreadActivity {
  return {
    id: "activity-1",
    tone: "tool",
    kind: "tool.completed",
    summary: "Tool",
    payload,
    turnId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
  } as unknown as OrchestrationThreadActivity;
}

/**
 * Wire-survival regression: the slimming pass rewrites payload.data but must
 * never strip the top-level per-agent fields the subagent fold depends on.
 * If slimming ever moves to an allowlist over the whole payload, these
 * assertions are the tripwire.
 */
describe("projectActivityPayload", () => {
  it("advertises an available patch without putting patch text on the wire", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "file_change",
        fileChanges: [
          {
            path: "src/app.ts",
            kind: "update",
            diff: "@@ -1 +1 @@\n-old\n+new",
          },
        ],
        data: { toolName: "Edit" },
      }),
    );
    expect(projected.payload).toMatchObject({
      itemType: "file_change",
      hasFileDiff: true,
      data: { files: [{ path: "src/app.ts" }] },
    });
    expect(JSON.stringify(projected.payload)).not.toContain("@@ -1 +1 @@");
  });

  it("preserves tool attribution (agentId/parentToolUseId) through data slimming", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        agentId: "task-123",
        parentToolUseId: "toolu_abc",
        data: {
          toolName: "Bash",
          input: { command: "ls" },
          command: "ls",
          rawOutput: { content: "x".repeat(10) },
          somethingClientNeverReads: { big: "blob" },
        },
      }),
    );
    const payload = projected.payload as Record<string, unknown>;
    expect(payload.agentId).toBe("task-123");
    expect(payload.parentToolUseId).toBe("toolu_abc");
    // Slimming itself still applies to data.
    const data = payload.data as Record<string, unknown>;
    expect(data.somethingClientNeverReads).toBeUndefined();
  });

  it("keeps a bounded Codex command output summary", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          item: {
            command: "/bin/zsh -lc 'printf hello'",
            aggregatedOutput: `hello from codex\n${"x".repeat(5000)}`,
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.item).toEqual({
      command: "/bin/zsh -lc 'printf hello'",
      aggregatedOutput: "hello from codex",
    });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("keeps bounded Claude and ACP command output summaries", () => {
    const claude = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          rawOutput: { stdout: `hello from claude\n${"y".repeat(5000)}` },
        },
      }),
    );
    const acp = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          content: [
            {
              type: "content",
              content: { type: "text", text: `hello from acp\n${"z".repeat(5000)}` },
            },
          ],
        },
      }),
    );

    const claudeData = (claude.payload as Record<string, unknown>).data as Record<string, unknown>;
    const acpData = (acp.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(claudeData.rawOutput).toEqual({ content: "hello from claude" });
    expect(acpData.rawOutput).toEqual({ content: "hello from acp" });
    expect(JSON.stringify(claude.payload).length).toBeLessThan(500);
    expect(JSON.stringify(acp.payload).length).toBeLessThan(500);
  });

  it("normalizes Claude and OpenCode command inputs before slimming provider data", () => {
    const claude = projectActivityPayload(
      activity({
        itemType: "command_execution",
        toolCallId: "claude-call-1",
        data: {
          toolName: "Bash",
          input: { command: "vp test run" },
          result: { content: "x".repeat(5_000) },
        },
      }),
    );
    const openCode = projectActivityPayload(
      activity({
        itemType: "command_execution",
        toolCallId: "opencode-call-1",
        data: {
          tool: "bash",
          state: {
            status: "running",
            input: { command: "vp lint" },
            output: "x".repeat(5_000),
          },
        },
      }),
    );

    expect(claude.payload).toMatchObject({
      toolCallId: "claude-call-1",
      data: { command: "vp test run" },
    });
    expect(openCode.payload).toMatchObject({
      toolCallId: "opencode-call-1",
      data: { command: "vp lint" },
    });
    expect(JSON.stringify(claude.payload).length).toBeLessThan(200);
    expect(JSON.stringify(openCode.payload).length).toBeLessThan(200);
  });

  it("slims Codex-shaped mcp_tool_call items to rendered fields plus a result summary", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            type: "mcpToolCall",
            id: "item-1",
            tool: "fetch_pr",
            server: "github",
            status: "completed",
            arguments: { pr: 42 },
            durationMs: 1200,
            result: {
              content: [{ type: "text", text: `PR body line one\n${"x".repeat(5000)}` }],
              structuredContent: { huge: "y".repeat(5000) },
            },
            _meta: { internal: true },
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    const item = data.item as Record<string, unknown>;
    expect(item.tool).toBe("fetch_pr");
    expect(item.server).toBe("github");
    expect(item.arguments).toEqual({ pr: 42 });
    expect(item._meta).toBeUndefined();
    expect(item.result).toEqual({ content: "PR body line one" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("slims Claude-shaped mcp_tool_call data (toolName/input/result block)", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          toolName: "mcp__github__fetch_pr",
          input: { pr: 42 },
          result: {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: `first line of output\n${"z".repeat(5000)}` }],
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.toolName).toBe("mcp__github__fetch_pr");
    expect(data.input).toEqual({ pr: 42 });
    expect(data.result).toEqual({ content: "first line of output" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("keeps Codex command output and reports omitted bytes separately", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          item: {
            type: "commandExecution",
            command: "printf output",
            aggregatedOutput: "x".repeat(1_001),
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.output).toBe("x".repeat(1_000));
    expect(data.outputOmittedBytes).toBe(1);
  });

  it("truncates command output without splitting multibyte characters", () => {
    for (const [character, characterBytes] of [
      ["é", 2],
      ["€", 3],
      ["🙂", 4],
    ] as const) {
      const projected = projectActivityPayload(
        activity({
          itemType: "command_execution",
          data: {
            item: {
              type: "commandExecution",
              command: "printf output",
              aggregatedOutput: `${"x".repeat(999)}${character}tail`,
            },
          },
        }),
      );
      const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
      expect(data.output).toBe("x".repeat(999));
      expect(data.outputOmittedBytes).toBe(characterBytes + 4);
    }
  });

  it("counts trailing whitespace omitted from command output", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          item: {
            type: "commandExecution",
            command: "printf output",
            aggregatedOutput: `${"x".repeat(999)}\n\n`,
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.output).toBe(`${"x".repeat(999)}\n`);
    expect(data.outputOmittedBytes).toBe(1);
  });

  it("keeps Claude command output in the projected payload", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          result: {
            type: "tool_result",
            content: [{ type: "text", text: "tests passed" }],
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.output).toBe("tests passed");
    expect(data.outputOmittedBytes).toBeUndefined();
  });

  it("passes task lifecycle payloads (no data field) through untouched", () => {
    const source = activity({
      taskId: "task-9",
      title: "Audit auth",
      role: "explorer",
      model: "opus",
      effort: "high",
      workflowName: "audit-flow",
      phases: [{ index: 0, title: "Audit" }],
      typedUsage: { totalTokens: 1200 },
      runHandles: { runId: "run-1", scriptPath: "/tmp/wf.js" },
      timelineBypass: true,
    });
    const projected = projectActivityPayload(source);
    expect(projected.payload).toEqual(source.payload);
  });
  it("keeps toolName/input/result on an attributed dynamic_tool_call", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        agentId: "task-123",
        parentToolUseId: "toolu_abc",
        data: {
          toolName: "Grep",
          input: { pattern: "TODO", path: "src" },
          result: { content: "src/app.ts:1:TODO" },
          somethingClientNeverReads: { big: "blob" },
        },
      }),
    );
    const payload = projected.payload as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;
    expect(data.toolName).toBe("Grep");
    expect(data.input).toEqual({ pattern: "TODO", path: "src" });
    expect(data.result).toEqual({ content: "src/app.ts:1:TODO" });
    // Restoring is an allowlist, not a bypass: unread keys still go.
    expect(data.somethingClientNeverReads).toBeUndefined();
  });

  it("keeps the structured patch on an attributed file_change", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "file_change",
        agentId: "task-123",
        fileChanges: [{ path: "src/app.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" }],
        data: { toolName: "Edit", input: { file_path: "src/app.ts" } },
      }),
    );
    const payload = projected.payload as Record<string, unknown>;
    expect(payload.fileChanges).toEqual([
      { path: "src/app.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" },
    ]);
    expect(payload.hasFileDiff).toBe(true);
  });

  it("still slims an unattributed dynamic_tool_call", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        data: {
          toolName: "Grep",
          input: { pattern: "TODO", path: "src" },
          result: { content: "src/app.ts:1:TODO" },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.toolName).toBeUndefined();
    expect(data.input).toBeUndefined();
    expect(data.result).toBeUndefined();
  });

  it("still strips the patch from an unattributed file_change", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "file_change",
        fileChanges: [{ path: "src/app.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" }],
        data: { toolName: "Edit" },
      }),
    );
    const payload = projected.payload as Record<string, unknown>;
    expect(payload.fileChanges).toBeUndefined();
    expect(payload.hasFileDiff).toBe(true);
  });

});

function commandActivity(options: {
  readonly id: string;
  readonly turnId: string | null;
  readonly status?: string;
  readonly output?: string;
}): OrchestrationThreadActivity {
  return {
    id: options.id,
    tone: "tool",
    kind: "tool.completed",
    summary: "Command",
    payload: {
      itemType: "command_execution",
      ...(options.status ? { status: options.status } : {}),
      data: {
        item: {
          type: "commandExecution",
          command: "pnpm test",
          aggregatedOutput: options.output ?? "the command output",
        },
      },
    },
    turnId: options.turnId,
    createdAt: "2026-08-01T10:00:00.000Z",
  } as unknown as OrchestrationThreadActivity;
}

function snapshotOf(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: string | null,
): OrchestrationThreadDetailSnapshot {
  return {
    snapshotSequence: 1,
    thread: {
      id: "thread-1",
      activities,
      latestTurn: latestTurnId === null ? null : { turnId: latestTurnId, state: "completed" },
    },
  } as unknown as OrchestrationThreadDetailSnapshot;
}

function payloadOf(activity: OrchestrationThreadActivity): Record<string, unknown> {
  return activity.payload as Record<string, unknown>;
}

function dataOf(activity: OrchestrationThreadActivity): Record<string, unknown> {
  return payloadOf(activity).data as Record<string, unknown>;
}

/**
 * Inlining every historical command's output dominated thread-open transfer,
 * so snapshots carry it only for the latest turn and advertise the rest.
 */
describe("projectThreadDetailSnapshot command output recency", () => {
  it("inlines the latest turn's output and only advertises older turns'", () => {
    const projected = projectThreadDetailSnapshot(
      snapshotOf(
        [
          commandActivity({ id: "old", turnId: "turn-1" }),
          commandActivity({ id: "recent", turnId: "turn-2" }),
        ],
        "turn-2",
      ),
    );

    const [old, recent] = projected.thread.activities;
    expect(dataOf(old!).output).toBeUndefined();
    expect(payloadOf(old!).hasCommandOutput).toBe(true);
    expect(dataOf(recent!).output).toBe("the command output");
    expect(payloadOf(recent!).hasCommandOutput).toBeUndefined();
  });

  it("keeps a still-running command inline even in an older turn", () => {
    const projected = projectThreadDetailSnapshot(
      snapshotOf(
        [commandActivity({ id: "running", turnId: "turn-1", status: "inProgress" })],
        "turn-2",
      ),
    );

    const [running] = projected.thread.activities;
    expect(dataOf(running!).output).toBe("the command output");
    expect(payloadOf(running!).hasCommandOutput).toBeUndefined();
  });

  it("advertises nothing when a history command produced no output", () => {
    const projected = projectThreadDetailSnapshot(
      snapshotOf([commandActivity({ id: "quiet", turnId: "turn-1", output: "   " })], "turn-2"),
    );

    const [quiet] = projected.thread.activities;
    expect(dataOf(quiet!).output).toBeUndefined();
    expect(payloadOf(quiet!).hasCommandOutput).toBeUndefined();
  });

  it("advertises history output on a windowed page with no latest turn present", () => {
    const projected = projectThreadDetailSnapshot(
      snapshotOf([commandActivity({ id: "old", turnId: "turn-1" })], null),
    );

    const [old] = projected.thread.activities;
    expect(dataOf(old!).output).toBeUndefined();
    expect(payloadOf(old!).hasCommandOutput).toBe(true);
  });
});

/**
 * The live stream is what keeps an in-flight command current, so it must keep
 * inlining output exactly as before this deferral existed.
 */
describe("projectActivityEvent command output", () => {
  it("leaves live appended activities inline", () => {
    const projected = projectActivityEvent({
      type: "thread.activity-appended",
      payload: { activity: commandActivity({ id: "live", turnId: "turn-9" }) },
    } as unknown as OrchestrationEvent) as unknown as {
      payload: { activity: OrchestrationThreadActivity };
    };

    const activity = projected.payload.activity;
    expect(dataOf(activity).output).toBe("the command output");
    expect(payloadOf(activity).hasCommandOutput).toBeUndefined();
  });
});
