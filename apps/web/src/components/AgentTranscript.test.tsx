import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type {
  OrchestrationSubagentTranscriptEntry,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";

import type { AgentTranscriptRow } from "./AgentTranscript.logic";

import { AgentTranscriptView } from "./AgentTranscript";
import {
  agentPersistedTranscript,
  deriveToolRowIdentity,
  diskTranscriptRows,
  formatToolResult,
  resolveAgentTranscriptSource,
  transcriptRecoveryLossNotice,
  transcriptRedactedThinkingNotice,
  transcriptUnavailableNotice,
} from "./AgentTranscript.logic";

let sequence = 0;
/**
 * Wire-faithful fixture: persisted activities carry NO `sequence` (it is null
 * on every row in a real database), so fixtures must not invent one or they
 * hide every ordering defect.
 */
function activity(
  kind: string,
  payload: Record<string, unknown>,
  summary = kind,
): OrchestrationThreadActivity {
  sequence += 1;
  return wireActivity({
    id: `activity-${sequence}`,
    kind,
    payload,
    summary,
    createdAt: `2026-08-16T10:00:${String(sequence).padStart(2, "0")}.000Z`,
  });
}

/** Same, with the id and timestamp pinned so an ordering case is reproducible. */
function wireActivity(input: {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  summary?: string;
  createdAt: string;
}): OrchestrationThreadActivity {
  return {
    id: input.id,
    tone: input.kind === "tool.completed" || input.kind === "tool.updated" ? "tool" : "info",
    kind: input.kind,
    summary: input.summary ?? input.kind,
    payload: input.payload,
    turnId: null,
    createdAt: input.createdAt,
  } as unknown as OrchestrationThreadActivity;
}

const chrome = {
  markdownCwd: undefined,
  workspaceRoot: undefined,
  resolvedTheme: "light" as const,
};

describe("agentPersistedTranscript", () => {
  it("keeps only the requested agent's rows, in order", () => {
    const { rows, hasNarration } = agentPersistedTranscript(
      [
        activity("agent.message", {
          itemType: "assistant_message",
          detail: "mine",
          agentId: "a1",
        }),
        activity("agent.message", {
          itemType: "assistant_message",
          detail: "theirs",
          agentId: "a2",
        }),
        activity("agent.reasoning", { itemType: "reasoning", detail: "thinking", agentId: "a1" }),
        // Unattributed main-thread work must never leak into an agent's view.
        activity("tool.completed", { itemType: "command_execution", data: { toolName: "Bash" } }),
      ],
      "a1",
    );
    expect(hasNarration).toBe(true);
    expect(rows.map((row) => row.kind)).toEqual(["assistant_message", "reasoning"]);
    expect(rows[0]!.text).toBe("mine");
    expect(rows[1]!.text).toBe("thinking");
  });

  it("collapses a tool call's lifecycle rows into one row carrying its result", () => {
    // Faithful to the wire: ingestion persists tool.started with itemType and
    // detail ONLY (no data at all), so the stable key has to be the detail.
    const { rows } = agentPersistedTranscript(
      [
        activity(
          "tool.started",
          {
            itemType: "command_execution",
            agentId: "a1",
            detail: "Bash: ls -la",
          },
          "Command run started",
        ),
        activity(
          "tool.updated",
          {
            itemType: "command_execution",
            agentId: "a1",
            status: "inProgress",
            detail: "Bash: ls -la",
            data: { toolName: "Bash", input: { command: "ls -la" } },
          },
          "Command run",
        ),
        activity(
          "tool.completed",
          {
            itemType: "command_execution",
            agentId: "a1",
            detail: "Bash: ls -la",
            data: { toolName: "Bash", input: { command: "ls -la" }, result: { content: "a\nb" } },
            fileChanges: [{ path: "/w/a.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b" }],
          },
          "Command run",
        ),
      ],
      "a1",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("tool");
    expect(rows[0]!.toolName).toBe("Bash");
    expect(rows[0]!.summary).toBe("Bash · ls -la");
    expect(rows[0]!.status).toBe("completed");
    expect(rows[0]!.fileChanges).toHaveLength(1);
    expect(formatToolResult(rows[0]!.result)).toBe("a\nb");
  });

  it("never names a row from the generic activity summary", () => {
    const { rows } = agentPersistedTranscript(
      [
        activity(
          "tool.started",
          {
            itemType: "dynamic_tool_call",
            agentId: "a1",
            detail: 'Read: {"file_path":"/w/README.md"}',
          },
          "Tool call started",
        ),
      ],
      "a1",
    );
    expect(rows[0]!.summary).toBe("Read · README.md");
    expect(rows[0]!.toolName).toBe("Read");
    expect(rows[0]!.summary).not.toContain("started");
  });

  it("a settled agent shows no running tool row", () => {
    const rows = (settled: boolean) =>
      agentPersistedTranscript(
        [
          activity(
            "tool.started",
            { itemType: "command_execution", agentId: "a1", detail: "Bash: sleep 100" },
            "Command run started",
          ),
        ],
        "a1",
        { agentSettled: settled },
      ).rows;
    // Live: an unresolved call legitimately reads as still running once a
    // status tick has said so; settled: the claim is dropped.
    expect(rows(false)[0]!.status).toBeUndefined();
    expect(rows(true)[0]!.status).toBeUndefined();

    const withTick = (settled: boolean) =>
      agentPersistedTranscript(
        [
          activity(
            "tool.updated",
            {
              itemType: "command_execution",
              agentId: "a1",
              status: "inProgress",
              detail: "Bash: sleep 100",
            },
            "Command run",
          ),
        ],
        "a1",
        { agentSettled: settled },
      ).rows;
    expect(withTick(false)[0]!.status).toBe("inProgress");
    expect(withTick(true)[0]!.status).toBeUndefined();
  });

  it("a repeated identical call is a second row, not an overwrite", () => {
    const call = (kind: string, extra: Record<string, unknown> = {}) =>
      activity(kind, {
        itemType: "command_execution",
        agentId: "a1",
        detail: "Bash: ls",
        data: { toolName: "Bash", input: { command: "ls" }, ...extra },
      });
    const { rows } = agentPersistedTranscript(
      [
        call("tool.started"),
        call("tool.completed", { result: { content: "first" } }),
        call("tool.started"),
        call("tool.completed", { result: { content: "second" } }),
      ],
      "a1",
    );
    expect(rows).toHaveLength(2);
    expect(formatToolResult(rows[0]!.result)).toBe("first");
    expect(formatToolResult(rows[1]!.result)).toBe("second");
  });

  it("survives updated/completed sharing a millisecond in either id order", () => {
    // The shipped inversion: sequence is null, both stages land on the same
    // millisecond, and tool.updated carries data.result — so a UUID tiebreak
    // decided whether the call rendered as one row or as a duplicate badged
    // "running" underneath its own completed header.
    const SAME_MS = "2026-08-16T10:00:00.000Z";
    const detail = 'Read: {"file_path":"/w/README.md"}';
    const updated = (id: string) =>
      wireActivity({
        id,
        kind: "tool.updated",
        createdAt: SAME_MS,
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          agentId: "a1",
          status: "inProgress",
          detail,
          data: {
            toolName: "Read",
            input: { file_path: "/w/README.md" },
            result: { content: "x" },
          },
        },
      });
    const completed = (id: string) =>
      wireActivity({
        id,
        kind: "tool.completed",
        createdAt: SAME_MS,
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          agentId: "a1",
          detail,
          data: {
            toolName: "Read",
            input: { file_path: "/w/README.md" },
            result: { content: "x" },
          },
        },
      });

    for (const [label, rows] of [
      ["completed id sorts first", [completed("aaa"), updated("zzz")]],
      ["updated id sorts first", [updated("aaa"), completed("zzz")]],
    ] as const) {
      const derived = agentPersistedTranscript(rows, "a1").rows;
      expect(derived, label).toHaveLength(1);
      expect(derived[0]!.status, label).toBe("completed");
      expect(derived[0]!.summary, label).toBe("Read · README.md");
    }
  });

  it("a late updated never walks a finished call back to running", () => {
    // Belt two on its own: even if the sort were bypassed entirely, an
    // earlier lifecycle stage arriving last must not reopen the call.
    const detail = "Bash: ls";
    const base = { itemType: "command_execution", agentId: "a1", detail };
    const { rows } = agentPersistedTranscript(
      [
        wireActivity({
          id: "b",
          kind: "tool.completed",
          createdAt: "2026-08-16T10:00:01.000Z",
          payload: { ...base, data: { toolName: "Bash", result: { content: "ok" } } },
        }),
        wireActivity({
          id: "a",
          kind: "tool.updated",
          createdAt: "2026-08-16T10:00:02.000Z",
          payload: { ...base, status: "inProgress", data: { toolName: "Bash", result: {} } },
        }),
      ],
      "a1",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("completed");
  });

  it("clears a running badge on a settled agent even when updated carried a result", () => {
    // The registration path that the old sweep could not reach: a row opened
    // by a tool.updated whose payload already had data.result.
    const rowsFor = (agentSettled: boolean) =>
      agentPersistedTranscript(
        [
          wireActivity({
            id: "only",
            kind: "tool.updated",
            createdAt: "2026-08-16T10:00:00.000Z",
            payload: {
              itemType: "command_execution",
              agentId: "a1",
              status: "inProgress",
              detail: "Bash: sleep 100",
              data: { toolName: "Bash", result: { content: "partial" } },
            },
          }),
        ],
        "a1",
        { agentSettled },
      ).rows;
    expect(rowsFor(false)[0]!.status).toBe("inProgress");
    expect(rowsFor(true)[0]!.status).toBeUndefined();
  });

  it("does not fuse unidentifiable tool rows into one", () => {
    // Worst case: a future wire change strips both data and detail. Three
    // distinct calls must stay three rows, not collapse onto an empty key.
    const bare = () =>
      activity("tool.completed", { itemType: "command_execution", agentId: "a1" }, "Tool call");
    const { rows } = agentPersistedTranscript([bare(), bare(), bare()], "a1");
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.summary === "Tool call")).toBe(true);
  });

  it("marks a failed call from an error-shaped result", () => {
    const { rows } = agentPersistedTranscript(
      [
        activity("tool.completed", {
          itemType: "command_execution",
          agentId: "a1",
          data: {
            toolName: "Bash",
            input: { command: "boom" },
            result: { is_error: true, content: "no such file" },
          },
        }),
      ],
      "a1",
    );
    expect(rows[0]!.failed).toBe(true);
  });
});

describe("deriveToolRowIdentity", () => {
  const derive = (data: Record<string, unknown> | undefined, detail: string | undefined) =>
    deriveToolRowIdentity({ data, detail, fallback: "Tool call" });

  it("names a row from detail when the wire carried no data", () => {
    expect(derive(undefined, 'Read: {"file_path":"/w/src/README.md"}')).toEqual({
      toolName: "Read",
      label: "Read · README.md",
    });
    expect(derive(undefined, "Bash: git status --short")).toEqual({
      toolName: "Bash",
      label: "Bash · git status --short",
    });
    expect(derive(undefined, 'Grep: {"pattern":"todo"}')).toEqual({
      toolName: "Grep",
      label: "Grep · todo",
    });
    expect(derive(undefined, "mcp__do__droplet-list: {}")).toEqual({
      toolName: "mcp__do__droplet-list",
      label: "mcp__do__droplet-list",
    });
  });

  it("prefers data when it is present", () => {
    expect(derive({ toolName: "Edit", input: { file_path: "/w/a/b.ts" } }, "Edit: {}")).toEqual({
      toolName: "Edit",
      label: "Edit · b.ts",
    });
  });

  it("shortens file_change details that truncation left as invalid JSON", () => {
    // Server-side details are capped at 180 chars, which cuts three quarters
    // of Edit/Write arguments mid-object. The salient field leads the object,
    // so it survives the cut even though the JSON does not.
    const truncatedEdit =
      'Edit: {"file_path":"/Users/x/projects/orrery/src/sim.rs","old_string":"/// Buil';
    expect(derive(undefined, truncatedEdit)).toEqual({
      toolName: "Edit",
      label: "Edit · sim.rs",
    });

    const truncatedWrite =
      'Write: {"file_path":"/tmp/mdv-preview/preview.js","content":"\'use stri';
    expect(derive(undefined, truncatedWrite)).toEqual({
      toolName: "Write",
      label: "Write · preview.js",
    });

    // replace_all leading the object must not become the heading.
    const replaceAllFirst =
      'Edit: {"replace_all":false,"file_path":"/w/src/README.md","old_string":"a';
    expect(derive(undefined, replaceAllFirst).label).toBe("Edit · README.md");

    const notebook = 'NotebookEdit: {"notebook_path":"/w/analysis.ipynb","new_source":"import pand';
    expect(derive(undefined, notebook).label).toBe("NotebookEdit · analysis.ipynb");
  });

  it("never leaves a JSON fragment as a heading", () => {
    for (const detail of [
      'Edit: {"file_path":"/w/a.ts","old_string":"x',
      'Write: {"file_path":"/w/b.ts","content":"y',
      'Read: {"file_path":"/w/c.ts","offs',
    ]) {
      const label = derive(undefined, detail).label;
      expect(label, detail).not.toContain("{");
      expect(label, detail).not.toContain('"');
    }
  });

  it("decodes escapes in a path taken from raw JSON", () => {
    expect(derive(undefined, 'Edit: {"file_path":"/w/a b\\u002Dc.ts","old_string":"z').label).toBe(
      "Edit · a b-c.ts",
    );
  });

  it("keeps an agent tool's bare description as the label", () => {
    expect(derive(undefined, "Audit the orrery repo for safety")).toEqual({
      label: "Audit the orrery repo for safety",
    });
    expect(derive({ toolName: "Agent" }, "Audit the orrery repo for safety")).toEqual({
      toolName: "Agent",
      label: "Agent · Audit the orrery repo for safety",
    });
  });

  it("falls back only when there is nothing else, and never yields a lifecycle phrase", () => {
    expect(derive(undefined, undefined)).toEqual({ label: "Tool call" });
    // A truncated JSON tail must not throw or leak a parse error.
    expect(derive(undefined, 'Read: {"file_path":"/w/x.ts","offs').label).toContain("Read");
  });

  it("keeps a heading to one truncated line", () => {
    const label = derive(undefined, `Bash: ${"x".repeat(400)}\nsecond line`).label;
    expect(label.length).toBeLessThanOrEqual(96);
    expect(label).not.toContain("\n");
  });
});

describe("transcriptRecoveryLossNotice", () => {
  it("stays silent when recovery was lossless", () => {
    expect(transcriptRecoveryLossNotice({ droppedRecords: 0, skippedLines: 0 })).toBeNull();
    // An older server omits the newer counts entirely; that is not a loss.
    expect(
      transcriptRecoveryLossNotice({
        droppedRecords: 0,
        skippedLines: 0,
        redactedThinking: undefined,
      }),
    ).toBeNull();
  });

  it("never folds encrypted reasoning into the loss line", () => {
    // Redacted reasoning is not something we failed to render, so it must not
    // appear in a notice about content that could not be shown.
    expect(
      transcriptRecoveryLossNotice({
        droppedRecords: 0,
        skippedLines: 0,
        redactedThinking: 9,
      }),
    ).toBeNull();
  });
  it("reports dropped records and unreadable lines, singular and plural", () => {
    expect(transcriptRecoveryLossNotice({ droppedRecords: 1, skippedLines: 0 })).toBe(
      "1 step could not be shown.",
    );
    expect(transcriptRecoveryLossNotice({ droppedRecords: 6, skippedLines: 2 })).toBe(
      "6 steps could not be shown and 2 unreadable lines were skipped.",
    );
  });
});

describe("transcriptRedactedThinkingNotice", () => {
  it("stays silent at zero and when an older server omits the count", () => {
    expect(
      transcriptRedactedThinkingNotice({ redactedThinking: 0, reasoningRowCount: 0 }),
    ).toBeNull();
    expect(
      transcriptRedactedThinkingNotice({ redactedThinking: undefined, reasoningRowCount: 0 }),
    ).toBeNull();
    expect(
      transcriptRedactedThinkingNotice({
        redactedThinking: Number.NaN,
        reasoningRowCount: 0,
      }),
    ).toBeNull();
  });

  it("speaks to the whole transcript when redaction left no reasoning at all", () => {
    // The shape that actually occurs: redaction is all-or-nothing per file.
    expect(transcriptRedactedThinkingNotice({ redactedThinking: 7, reasoningRowCount: 0 })).toBe(
      "This agent's reasoning was kept encrypted by the provider and cannot be shown.",
    );
  });

  it("counts steps only when some reasoning did render", () => {
    expect(transcriptRedactedThinkingNotice({ redactedThinking: 1, reasoningRowCount: 2 })).toBe(
      "1 reasoning step was kept encrypted by the provider and cannot be shown.",
    );
    expect(transcriptRedactedThinkingNotice({ redactedThinking: 4, reasoningRowCount: 2 })).toBe(
      "4 reasoning steps were kept encrypted by the provider and cannot be shown.",
    );
  });
});

describe("merge policy", () => {
  it("prefers persisted rows when the agent's narration was recorded", () => {
    const persisted = agentPersistedTranscript(
      [activity("agent.message", { itemType: "assistant_message", detail: "hi", agentId: "a1" })],
      "a1",
    );
    expect(resolveAgentTranscriptSource(persisted)).toBe("persisted");
  });

  it("falls back to the on-disk read for a pre-feature agent with only tool rows", () => {
    const persisted = agentPersistedTranscript(
      [
        activity("tool.completed", {
          itemType: "command_execution",
          agentId: "a1",
          data: { toolName: "Bash" },
        }),
      ],
      "a1",
    );
    expect(persisted.hasNarration).toBe(false);
    expect(persisted.rows).toHaveLength(1);
    expect(resolveAgentTranscriptSource(persisted)).toBe("disk");
  });

  it("reads the on-disk read for an agent with nothing persisted at all", () => {
    expect(resolveAgentTranscriptSource(agentPersistedTranscript([], "a1"))).toBe("disk");
  });
});

describe("hydration gating", () => {
  // The panel picks its source from resolveAgentTranscriptSource, but only
  // acts on "disk" once the thread's activities exist. Before hydration the
  // activity list is [] for every thread, so the answer is meaningless.
  it("an empty activity list is indistinguishable from a pre-feature agent", () => {
    expect(resolveAgentTranscriptSource(agentPersistedTranscript([], "a1"))).toBe("disk");
    // Which is exactly why the panel gates on hydration: the same input that
    // means "fetch from disk" after loading means "not loaded yet" before it.
    const hydrated = agentPersistedTranscript(
      [activity("agent.message", { itemType: "assistant_message", detail: "hi", agentId: "a1" })],
      "a1",
    );
    expect(resolveAgentTranscriptSource(hydrated)).toBe("persisted");
  });

  it("shows the loading state and withholds the manual read until hydrated", () => {
    const props = {
      agent: null,
      agentId: "a1",
      title: "Explore adapter",
      role: null,
      rows: [],
      launchPrompt: null,
      chrome,
      notices: [],
      truncated: false,
      onBack: () => {},
    };
    const beforeHydration = renderToStaticMarkup(<AgentTranscriptView {...props} loading />);
    expect(beforeHydration).toContain("Loading transcript…");
    expect(beforeHydration).not.toContain("Load full transcript");
    expect(beforeHydration).not.toContain("No recorded activity");
  });
});

describe("diskTranscriptRows", () => {
  const entry = (
    over: Partial<OrchestrationSubagentTranscriptEntry>,
  ): OrchestrationSubagentTranscriptEntry =>
    ({
      id: "e1",
      createdAt: "2026-08-16T10:00:00.000Z",
      tone: "info",
      kind: "assistant_message",
      summary: "Assistant message",
      itemType: "assistant_message",
      ...over,
    }) as OrchestrationSubagentTranscriptEntry;

  it("maps recovered entries onto the shared row shape", () => {
    const rows = diskTranscriptRows([
      entry({ id: "p", kind: "user_message", itemType: "user_message", text: "do the thing" }),
      entry({ id: "t", kind: "reasoning", itemType: "reasoning", text: "considering" }),
      entry({ id: "a", text: "done" }),
      entry({
        id: "c",
        kind: "tool.completed",
        itemType: "command_execution",
        tone: "error",
        status: "failed",
        summary: "Bash: ls",
        data: { toolName: "Bash", input: { command: "ls" }, result: { content: "boom" } },
      }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual([
      "user_message",
      "reasoning",
      "assistant_message",
      "tool",
    ]);
    expect(rows[3]!.toolName).toBe("Bash");
    expect(rows[3]!.failed).toBe(true);
    // The server's own richer label survives instead of being replaced by the
    // bare tool name.
    expect(rows[3]!.summary).toBe("Bash · ls");
  });
});

describe("transcriptUnavailableNotice", () => {
  it("explains the provider that keeps no transcript", () => {
    expect(transcriptUnavailableNotice("provider-unsupported")).toContain("does not keep");
  });
  it("falls back for an unknown or absent reason", () => {
    expect(transcriptUnavailableNotice(undefined)).toBe("The full transcript could not be loaded.");
    expect(transcriptUnavailableNotice("something-new")).toBe(
      "The full transcript could not be loaded.",
    );
  });
});

describe("AgentTranscriptView", () => {
  const baseProps = {
    agent: null,
    agentId: "a1",
    title: "Explore adapter",
    role: "junior",
    rows: [],
    launchPrompt: null,
    chrome,
    notices: [],
    truncated: false,
    loading: false,
    onBack: () => {},
  };

  it("renders the header, launch prompt, narration, and thinking", () => {
    const markup = renderToStaticMarkup(
      <AgentTranscriptView
        {...baseProps}
        launchPrompt="Read the adapter"
        rows={[
          { id: "r1", createdAt: null, kind: "reasoning", summary: "Thinking", text: "weighing" },
          {
            id: "r2",
            createdAt: null,
            kind: "assistant_message",
            summary: "msg",
            text: "found it",
          },
        ]}
      />,
    );
    expect(markup).toContain("Explore adapter");
    expect(markup).toContain("junior");
    expect(markup).toContain("Read the adapter");
    expect(markup).toContain("Thinking");
    expect(markup).toContain("weighing");
    expect(markup).toContain("found it");
    expect(markup).toContain("Back to agents");
  });

  it("offers the wrap toggle on an expanded diff-bearing tool row only", () => {
    // A subagent's prose edit clips horizontally without this, exactly as the
    // chat transcript's File change cell did before it gained the control.
    const toolRow = (fileChanges?: AgentTranscriptRow["fileChanges"]): AgentTranscriptRow => ({
      id: "r1",
      createdAt: null,
      kind: "tool",
      summary: "Edit · README.md",
      toolName: "Edit",
      input: { file_path: "/w/README.md" },
      ...(fileChanges ? { fileChanges } : {}),
    });
    const changes = [
      { path: "/w/README.md", kind: "update" as const, diff: "@@ -1 +1 @@\n-a\n+b" },
    ];

    // A patch-bearing row opens on its own, so the diff and its control are
    // both reachable without a click.
    const expanded = renderToStaticMarkup(
      <AgentTranscriptView {...baseProps} rows={[toolRow(changes)]} />,
    );
    expect(expanded).toContain("Wrap long lines");
    // Matching the timeline's default: off, so today's rendering is preserved.
    expect(expanded).toContain('aria-pressed="false"');

    // A tool row with no patch has nothing to wrap, and stays collapsed.
    expect(
      renderToStaticMarkup(<AgentTranscriptView {...baseProps} rows={[toolRow()]} />),
    ).not.toContain("Wrap long lines");
  });

  it("shows a tool row with its name, collapsed", () => {
    const markup = renderToStaticMarkup(
      <AgentTranscriptView
        {...baseProps}
        rows={[
          {
            id: "r1",
            createdAt: null,
            kind: "tool",
            summary: "Bash",
            toolName: "Bash",
            input: { command: "ls -la" },
            result: { content: "total 0" },
            status: "completed",
          },
        ]}
      />,
    );
    expect(markup).toContain("Bash");
    // Collapsed by default: the body is not in the markup yet.
    expect(markup).not.toContain("ls -la");
  });

  it("renders several independent advisories together", () => {
    const markup = renderToStaticMarkup(
      <AgentTranscriptView
        {...baseProps}
        rows={[{ id: "r1", createdAt: null, kind: "tool", summary: "Grep", toolName: "Grep" }]}
        notices={[
          transcriptRecoveryLossNotice({ droppedRecords: 2, skippedLines: 0 }) ?? "",
          transcriptRedactedThinkingNotice({ redactedThinking: 5, reasoningRowCount: 0 }) ?? "",
        ]}
        truncated
      />,
    );
    expect(markup).toContain("2 steps could not be shown");
    expect(markup).toContain("kept encrypted by the provider");
    expect(markup).toContain("too long to load in full");
  });

  it("shows the unavailable notice alongside whatever persisted rows exist", () => {
    const markup = renderToStaticMarkup(
      <AgentTranscriptView
        {...baseProps}
        rows={[{ id: "r1", createdAt: null, kind: "tool", summary: "Grep", toolName: "Grep" }]}
        notices={[transcriptUnavailableNotice("provider-unsupported")]}
      />,
    );
    expect(markup).toContain("Grep");
    expect(markup).toContain("does not keep a full transcript");
  });

  it("announces truncation and the loading state", () => {
    expect(renderToStaticMarkup(<AgentTranscriptView {...baseProps} truncated />)).toContain(
      "too long to load in full",
    );
    expect(renderToStaticMarkup(<AgentTranscriptView {...baseProps} loading />)).toContain(
      "Loading transcript…",
    );
  });

  it("offers the explicit disk read only when a handler is supplied", () => {
    expect(renderToStaticMarkup(<AgentTranscriptView {...baseProps} />)).not.toContain(
      "Load full transcript",
    );
    expect(
      renderToStaticMarkup(<AgentTranscriptView {...baseProps} onLoadFullTranscript={() => {}} />),
    ).toContain("Load full transcript");
  });

  it("says so when an agent recorded nothing", () => {
    expect(renderToStaticMarkup(<AgentTranscriptView {...baseProps} />)).toContain(
      "No recorded activity",
    );
  });
});
