// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterAll, assert, describe } from "vite-plus/test";
import { readSubagentTranscript } from "./subagentTranscriptQuery.ts";

// Entirely synthetic fixture. Real transcripts are private user data and must
// never enter this repository.
const SESSION_ID = "00000000-0000-4000-8000-000000000000";
const AGENT_ID = "synthetic0agent01";

const configDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cph-subagent-transcript-"));
const subagentsDir = NodePath.join(
  configDir,
  "projects",
  "-synthetic-workspace",
  SESSION_ID,
  "subagents",
);
NodeFS.mkdirSync(subagentsDir, { recursive: true });

const transcriptPath = NodePath.join(subagentsDir, `agent-${AGENT_ID}.jsonl`);

const records: ReadonlyArray<Record<string, unknown>> = [
  {
    type: "user",
    uuid: "u1",
    parentUuid: null,
    isSidechain: true,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: "Investigate the synthetic widget." },
  },
  // The CLI writes attachment records straight after the launch prompt. They
  // render nothing, but they sit between the prompt and the first assistant
  // reply, so anything that walks parents must treat them as links.
  {
    type: "attachment",
    uuid: "att1",
    parentUuid: "u1",
    isSidechain: true,
    timestamp: "2026-01-01T00:00:00.100Z",
    attachment: { type: "synthetic_context", value: "ignored" },
  },
  {
    type: "attachment",
    uuid: "att2",
    parentUuid: "att1",
    isSidechain: true,
    timestamp: "2026-01-01T00:00:00.200Z",
    attachment: { type: "synthetic_context", value: "ignored" },
  },
  {
    type: "assistant",
    uuid: "a1",
    parentUuid: "att2",
    isSidechain: true,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "assistant",
      model: "synthetic-model",
      usage: {
        input_tokens: 11,
        output_tokens: 22,
        cache_creation_input_tokens: 33,
        cache_read_input_tokens: 44,
      },
      content: [
        // Signature-only thinking: the step happened but its text was never
        // persisted. No row, and counted as redacted.
        { type: "thinking", thinking: "", signature: "synthetic-empty-signature" },
        { type: "thinking", thinking: "Consider the widget.", signature: "synthetic-signature" },
        { type: "text", text: "Starting the search." },
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo hello" } },
      ],
    },
  },
  {
    type: "user",
    uuid: "u2",
    parentUuid: "a1",
    isSidechain: true,
    timestamp: "2026-01-01T00:00:02.000Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hello" }],
    },
    toolUseResult: { stdout: "hello", stderr: "", interrupted: false, isImage: false },
  },
  // A record whose only block is an empty thinking block with NO signature:
  // nothing was there at all. It renders nothing, is not a dropped record, and
  // is not redacted either — there is no evidence a reasoning step happened.
  {
    type: "assistant",
    uuid: "a-empty",
    parentUuid: "u2",
    isSidechain: true,
    timestamp: "2026-01-01T00:00:02.500Z",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "   " }],
    },
  },
  // Parallel tool calls: a2 and a3 both hang off u2, and their results come
  // back in the opposite order. Following one parent per record keeps a single
  // branch and loses the other call and its result outright.
  {
    type: "assistant",
    uuid: "a2",
    parentUuid: "u2",
    isSidechain: true,
    timestamp: "2026-01-01T00:00:03.000Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_2",
          name: "Edit",
          input: { file_path: "/synthetic/widget.ts", old_string: "a", new_string: "b" },
        },
      ],
    },
  },
  {
    type: "assistant",
    uuid: "a3",
    parentUuid: "u2",
    isSidechain: true,
    timestamp: "2026-01-01T00:00:04.000Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_3",
          name: "Read",
          input: { file_path: "/synthetic/notes.md" },
        },
      ],
    },
  },
  // The Read result lands before the Edit result.
  {
    type: "user",
    uuid: "u3",
    parentUuid: "a3",
    isSidechain: true,
    timestamp: "2026-01-01T00:00:05.000Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_3", content: "synthetic notes" }],
    },
  },
  {
    type: "user",
    uuid: "u4",
    parentUuid: "a2",
    isSidechain: true,
    timestamp: "2026-01-01T00:00:06.000Z",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_2", content: "The file has been updated." },
      ],
    },
    toolUseResult: {
      filePath: "/synthetic/widget.ts",
      structuredPatch: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] },
      ],
    },
  },
];

NodeFS.writeFileSync(
  transcriptPath,
  `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
);
NodeFS.writeFileSync(
  transcriptPath.replace(/\.jsonl$/, ".meta.json"),
  JSON.stringify({
    agentType: "intern",
    description: "Catalog synthetic widgets",
    toolUseId: "toolu_parent",
    spawnDepth: 1,
  }),
);

// A transcript that cannot be fully rendered: a torn line, and a conversational
// record whose body is not usable content.
const LOSSY_AGENT_ID = "synthetic0lossy01";
NodeFS.writeFileSync(
  NodePath.join(subagentsDir, `agent-${LOSSY_AGENT_ID}.jsonl`),
  [
    JSON.stringify({
      type: "user",
      uuid: "l1",
      parentUuid: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "Recoverable prompt." },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "l2",
      parentUuid: "l1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "assistant", content: 42 },
    }),
    '{"type":"assistant","uuid":"l3",',
    "",
  ].join("\n"),
);

// A symlink named like a transcript but pointing outside the config dir must
// fail containment, not be served.
const ESCAPE_AGENT_ID = "synthetic0escape1";
const outside = NodePath.join(NodeOS.tmpdir(), "cph-subagent-outside.jsonl");
NodeFS.writeFileSync(outside, "{}\n");
const escapeLink = NodePath.join(subagentsDir, `agent-${ESCAPE_AGENT_ID}.jsonl`);
NodeFS.symlinkSync(outside, escapeLink);
if (!NodeFS.lstatSync(escapeLink).isSymbolicLink()) {
  throw new Error("test setup: escape transcript must be a symlink");
}

afterAll(() => {
  NodeFS.rmSync(configDir, { recursive: true, force: true });
  NodeFS.rmSync(outside, { force: true });
});

interface ToolData {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly result: Record<string, unknown>;
}

describe("readSubagentTranscript", () => {
  effectIt.effect("converts a transcript into renderable rows", () =>
    Effect.gen(function* () {
      const result = yield* readSubagentTranscript({
        configDir,
        sessionId: SESSION_ID,
        agentId: AGENT_ID,
      });

      assert.equal(result.agentId, AGENT_ID);
      assert.equal(result.sessionId, SESSION_ID);
      assert.equal(result.agentType, "intern");
      assert.equal(result.description, "Catalog synthetic widgets");
      assert.equal(result.truncated, false);
      // Recovery is lossless: nothing recorded went unrendered or unparsed.
      assert.equal(result.droppedRecords, 0);
      assert.equal(result.skippedLines, 0);

      // Launch prompt, thinking, assistant text, and one row per tool call.
      // Neither empty thinking block contributes a row, and neither is a loss.
      assert.equal(result.entries.length, 6);
      assert.equal(result.entries.filter((entry) => entry.kind === "reasoning").length, 1);
      // Only the signature-bearing empty block counts as redacted; the bare
      // whitespace block had no reasoning behind it to report.
      assert.equal(result.redactedThinking, 1);

      const [prompt, thinking, text, bash, edit, read] = result.entries;

      // The prompt sits behind two attachment records; it must still render.
      assert.equal(prompt?.kind, "user_message");
      assert.equal(prompt?.itemType, "user_message");
      assert.equal(prompt?.text, "Investigate the synthetic widget.");
      assert.equal(prompt?.createdAt, "2026-01-01T00:00:00.000Z");

      assert.equal(thinking?.kind, "reasoning");
      assert.equal(thinking?.itemType, "reasoning");
      assert.equal(thinking?.text, "Consider the widget.");
      assert.equal(thinking?.model, "synthetic-model");
      assert.deepEqual(thinking?.usage, {
        inputTokens: 11,
        outputTokens: 22,
        cacheCreationInputTokens: 33,
        cacheReadInputTokens: 44,
      });

      assert.equal(text?.kind, "assistant_message");
      assert.equal(text?.text, "Starting the search.");
      // Usage belongs to the record, not to each of its blocks: it is attached
      // once so a client summing rows does not double count.
      assert.isUndefined(text?.usage);

      // One row per tool call, carrying both the call and the result that
      // answered it.
      assert.equal(bash?.kind, "tool.completed");
      assert.equal(bash?.itemType, "command_execution");
      assert.equal(bash?.status, "completed");
      assert.equal(bash?.tone, "tool");
      const bashData = bash?.data as ToolData;
      assert.equal(bashData.toolName, "Bash");
      assert.equal(bashData.input.command, "echo hello");
      assert.equal(bashData.result.content, "hello");
      assert.isUndefined(bash?.fileChanges);

      // Both halves of the parallel fork render, and each keeps the result
      // that answers it even though the results arrived in the other order.
      assert.equal(edit?.itemType, "file_change");
      assert.equal(edit?.status, "completed");
      const editData = edit?.data as ToolData;
      assert.equal(editData.toolName, "Edit");
      assert.equal(editData.result.content, "The file has been updated.");
      assert.equal(edit?.fileChanges?.length, 1);
      assert.equal(edit?.fileChanges?.[0]?.path, "/synthetic/widget.ts");
      assert.equal(edit?.fileChanges?.[0]?.kind, "update");
      assert.include(edit?.fileChanges?.[0]?.diff ?? "", "@@ -1,1 +1,1 @@");
      assert.include(edit?.fileChanges?.[0]?.diff ?? "", "+b");

      assert.equal(read?.status, "completed");
      const readData = read?.data as ToolData;
      assert.equal(readData.toolName, "Read");
      assert.equal(readData.input.file_path, "/synthetic/notes.md");
      assert.equal(readData.result.content, "synthetic notes");
    }),
  );

  effectIt.effect("counts records it could not render instead of hiding them", () =>
    Effect.gen(function* () {
      const result = yield* readSubagentTranscript({
        configDir,
        sessionId: SESSION_ID,
        agentId: LOSSY_AGENT_ID,
      });
      // One good row; one conversational record with an unusable body and one
      // unparseable line, both accounted for rather than silently skipped.
      assert.equal(result.entries.length, 1);
      assert.equal(result.droppedRecords, 1);
      assert.equal(result.skippedLines, 1);
      assert.equal(result.redactedThinking, 0);
    }),
  );

  effectIt.effect("rejects agent ids that are not plain transcript ids", () =>
    Effect.gen(function* () {
      for (const agentId of ["../../etc/passwd", "a/b", "with space", ""]) {
        const reason = yield* Effect.exit(
          readSubagentTranscript({ configDir, sessionId: SESSION_ID, agentId }).pipe(
            Effect.flip,
            Effect.map((error) => error.reason),
          ),
        );
        assert.equal(reason._tag, "Success", `expected ${agentId} to be rejected`);
        if (reason._tag === "Success") {
          assert.equal(reason.value, "invalid-agent-id");
        }
      }
    }),
  );

  effectIt.effect("reports a missing transcript as not-found", () =>
    Effect.gen(function* () {
      const reason = yield* readSubagentTranscript({
        configDir,
        sessionId: SESSION_ID,
        agentId: "synthetic0absent1",
      }).pipe(
        Effect.flip,
        Effect.map((error) => error.reason),
      );
      assert.equal(reason, "not-found");
    }),
  );

  effectIt.effect("refuses a transcript that symlinks outside the config dir", () =>
    Effect.gen(function* () {
      // A "not-found" here would mean the symlink was never followed and the
      // containment check went untested.
      const reason = yield* readSubagentTranscript({
        configDir,
        sessionId: SESSION_ID,
        agentId: ESCAPE_AGENT_ID,
      }).pipe(
        Effect.flip,
        Effect.map((error) => error.reason),
      );
      assert.equal(reason, "outside-root");
    }),
  );
});
