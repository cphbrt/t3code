// @effect-diagnostics nodeBuiltinImport:off
/**
 * Read-only recovery of a subagent's transcript from the provider's on-disk
 * record, for the Agents surface's per-subagent transcript view.
 *
 * Subagents that ran before narration persistence existed (or whose activity
 * rows have aged out) still have a complete conversation on disk: the Claude
 * harness writes every subagent to
 * `<configDir>/projects/<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl`.
 * This module resolves that file for a thread, converts it into rows shaped
 * like the activity payloads clients already render, and never trusts the
 * client-supplied `agentId` beyond a strict id check plus realpath containment.
 *
 * We parse the JSONL ourselves rather than calling the SDK's
 * `getSubagentMessages`, for two reasons that both matter here:
 *   - the SDK resolves its config dir from `process.env.CLAUDE_CONFIG_DIR` at
 *     call time, so reading a provider instance's custom `homePath` through it
 *     would mean mutating process-global env under concurrent requests;
 *   - the SDK's normalizer drops each record's top-level `toolUseResult`, which
 *     is where command output and edit patches live.
 *
 * Containment rules follow `workflowScriptQuery.ts`: realpath the leaf, verify
 * it is under the config dir's `projects` root, then open once and validate the
 * opened inode rather than re-checking the path.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  ClaudeSettings,
  defaultInstanceIdForDriver,
  OrchestrationGetSubagentTranscriptError,
  type ServerSettings,
  type ThreadId,
  type CanonicalItemType,
  type OrchestrationSubagentTranscriptEntry,
  type OrchestrationSubagentTranscriptUsage,
  type ToolFileChange,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { resolveClaudeConfigDirPath } from "../provider/Drivers/ClaudeSkills.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

/**
 * Generous read cap. Real subagent transcripts observed on disk run a few MB
 * for several hundred messages, so this keeps whole transcripts intact while
 * bounding the websocket payload. Past the cap we return what we have with
 * `truncated`, rather than failing a view the user explicitly opened.
 */
const TRANSCRIPT_BYTE_CAP = 4 * 1024 * 1024;

/** Beyond this a transcript is pathological; refuse instead of streaming megabytes. */
const TRANSCRIPT_HARD_CEILING = 64 * 1024 * 1024;

/** Subagent ids are short opaque tokens; anything else must never reach the filesystem. */
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Session ids are harness-minted UUIDs and become a path segment. */
const SESSION_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const CLAUDE_DRIVER_KIND = "claudeAgent";

function failure(
  reason: OrchestrationGetSubagentTranscriptError["reason"],
  agentId: string,
  cause?: unknown,
) {
  return new OrchestrationGetSubagentTranscriptError({
    reason,
    agentId,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Pull the harness session id out of a thread's opaque resume cursor. The
 * cursor shape is owned by the Claude adapter (`{ threadId, resume, ... }`);
 * older cursors spelled the same value `sessionId`.
 */
export function readClaudeSessionIdFromResumeCursor(resumeCursor: unknown): string | undefined {
  const cursor = readRecord(resumeCursor);
  if (!cursor) return undefined;
  const candidate = readString(cursor.resume) ?? readString(cursor.sessionId);
  return candidate && SESSION_ID_PATTERN.test(candidate) ? candidate : undefined;
}

// Classification mirrors the Claude adapter's live ingestion so a recovered row
// lands on the same renderer as a persisted one. Kept local rather than
// imported: the adapter's copy is module-private and belongs to the streaming
// path, and this read-only path must not grow a dependency on it.
function classifyToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("agent") || normalized === "task" || normalized.includes("sub-agent")) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) return "mcp_tool_call";
  if (normalized.includes("websearch") || normalized.includes("web search")) return "web_search";
  if (normalized.includes("image")) return "image_view";
  return "dynamic_tool_call";
}

function structuredPatchText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const hunks: string[] = [];
  for (const candidate of value) {
    const hunk = readRecord(candidate);
    if (
      !hunk ||
      typeof hunk.oldStart !== "number" ||
      typeof hunk.oldLines !== "number" ||
      typeof hunk.newStart !== "number" ||
      typeof hunk.newLines !== "number" ||
      !Array.isArray(hunk.lines) ||
      !hunk.lines.every((line) => typeof line === "string")
    ) {
      continue;
    }
    hunks.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      ...(hunk.lines as ReadonlyArray<string>),
    );
  }
  return hunks.length > 0 ? hunks.join("\n") : undefined;
}

function fullReplacementPatch(original: string, updated: string): string {
  const oldLines = original.length === 0 ? [] : original.replace(/\n$/, "").split("\n");
  const newLines = updated.length === 0 ? [] : updated.replace(/\n$/, "").split("\n");
  return [
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}

/**
 * Derive applied file changes from an edit tool's recorded result, matching
 * the live adapter's derivation so recovered diffs render identically.
 */
function toolFileChanges(
  toolName: string,
  input: unknown,
  result: Record<string, unknown> | undefined,
): ReadonlyArray<ToolFileChange> | undefined {
  if (!result || (toolName !== "Edit" && toolName !== "Write" && toolName !== "NotebookEdit")) {
    return undefined;
  }
  const inputRecord = readRecord(input);
  const gitPatch = readString(readRecord(result.gitDiff)?.patch);
  const structuredPatch = structuredPatchText(result.structuredPatch);

  if (toolName === "NotebookEdit") {
    const path = readString(result.notebook_path) ?? readString(inputRecord?.notebook_path);
    const original = typeof result.original_file === "string" ? result.original_file : undefined;
    const updated = typeof result.updated_file === "string" ? result.updated_file : undefined;
    if (!path || original === undefined || updated === undefined || original === updated) {
      return undefined;
    }
    return [{ path, kind: "update", diff: fullReplacementPatch(original, updated) }];
  }

  const path =
    readString(result.filePath) ??
    readString(inputRecord?.file_path) ??
    readString(inputRecord?.path);
  const diff = gitPatch ?? structuredPatch;
  if (!path || !diff) return undefined;
  return [
    { path, kind: toolName === "Write" && result.type === "create" ? "add" : "update", diff },
  ];
}

function readUsage(
  message: Record<string, unknown>,
): OrchestrationSubagentTranscriptUsage | undefined {
  const usage = readRecord(message.usage);
  if (!usage) return undefined;
  const inputTokens = readCount(usage.input_tokens);
  const outputTokens = readCount(usage.output_tokens);
  const cacheCreationInputTokens = readCount(usage.cache_creation_input_tokens);
  const cacheReadInputTokens = readCount(usage.cache_read_input_tokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheCreationInputTokens === undefined &&
    cacheReadInputTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
  };
}

/**
 * Summaries land in a trimmed-non-empty wire field, so every producer runs
 * through here: slicing a long line can otherwise leave trailing whitespace
 * that fails encoding at the RPC boundary.
 */
function summarize(text: string, fallback: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return fallback;
  const firstLine = (trimmed.split("\n", 1)[0] ?? trimmed).trim();
  if (firstLine.length === 0) return fallback;
  return firstLine.length <= 200 ? firstLine : `${firstLine.slice(0, 197).trimEnd()}...`;
}

/**
 * One-line label for a tool row, mirroring the adapter's live labelling: the
 * command for shell tools, the human description for agent tools, otherwise
 * the serialized input. The untruncated input always rides along in `data`.
 */
function summarizeToolRequest(toolName: string, input: unknown): string {
  const record = readRecord(input);
  const command = readString(record?.command) ?? readString(record?.cmd);
  if (command) return summarize(`${toolName}: ${command}`, toolName);

  if (classifyToolItemType(toolName) === "collab_agent_tool_call") {
    const label = readString(record?.description) ?? readString(record?.prompt);
    if (label) return summarize(label, toolName);
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(input) ?? "";
  } catch {
    serialized = "";
  }
  return summarize(`${toolName}: ${serialized}`, toolName);
}

interface TranscriptRecord {
  /** Position in the file; the append order the harness wrote. */
  readonly index: number;
  /** Record uuid, or a synthesized stand-in so every row has a stable id. */
  readonly id: string;
  readonly type: string;
  readonly timestamp: string | undefined;
  readonly message: Record<string, unknown> | undefined;
  readonly toolUseResult: Record<string, unknown> | undefined;
}

interface ParsedTranscript {
  readonly records: ReadonlyArray<TranscriptRecord>;
  /** Lines that were not parseable JSON objects — a torn write or the byte cap. */
  readonly skippedLines: number;
}

/**
 * Parse every record in the file, whatever its type.
 *
 * Non-conversational records (the harness writes `attachment` rows straight
 * after the launch prompt, and may add types this build has never seen) are
 * kept rather than filtered: they carry timestamps that keep neighbouring rows
 * correctly ordered, and dropping them used to strand everything written
 * before them.
 */
function parseTranscriptRecords(contents: string): ParsedTranscript {
  const records: TranscriptRecord[] = [];
  let skippedLines = 0;
  let index = -1;
  for (const line of contents.split("\n")) {
    if (line.trim().length === 0) continue;
    index += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A partial trailing line (byte cap) or a torn write must not fail the view.
      skippedLines += 1;
      continue;
    }
    const record = readRecord(parsed);
    if (!record) {
      skippedLines += 1;
      continue;
    }
    const message = readRecord(record.message);
    records.push({
      index,
      id: readString(record.uuid) ?? `line-${index}`,
      type: typeof record.type === "string" ? record.type : "unknown",
      timestamp: readString(record.timestamp),
      message,
      // On disk the rich result sidecar is a sibling of `message`, not a field
      // inside it; the SDK's own message shape spells it `tool_use_result`.
      toolUseResult: readRecord(record.toolUseResult) ?? readRecord(message?.tool_use_result),
    });
  }
  return { records, skippedLines };
}

/**
 * Put records in reading order.
 *
 * Append order is already chronological in practice, so this only re-sorts on
 * recorded timestamps, using file position as the tiebreak. Records written
 * without a timestamp inherit the last one seen so they stay beside the record
 * they belong to instead of sorting to the front.
 *
 * Deliberately NOT a `parentUuid` spine walk. Parallel tool calls fork the
 * parent chain — two `tool_use` records share a parent and their results come
 * back interleaved — so following a single parent per record silently drops
 * every branch but one. Nothing recorded is excluded here; if a future change
 * wants to hide superseded retries it must count what it removes.
 */
function orderRecords(records: ReadonlyArray<TranscriptRecord>): ReadonlyArray<TranscriptRecord> {
  let lastSeen = "";
  const keyed = records.map((record) => {
    if (record.timestamp) lastSeen = record.timestamp;
    return { record, sortKey: record.timestamp ?? lastSeen };
  });
  return keyed
    .toSorted((left, right) =>
      left.sortKey === right.sortKey
        ? left.record.index - right.record.index
        : left.sortKey < right.sortKey
          ? -1
          : 1,
    )
    .map((entry) => entry.record);
}

type MutableEntry = {
  -readonly [K in keyof OrchestrationSubagentTranscriptEntry]: OrchestrationSubagentTranscriptEntry[K];
};

interface ConvertedTranscript {
  readonly entries: ReadonlyArray<OrchestrationSubagentTranscriptEntry>;
  /**
   * Conversational records that produced no row and updated none. Normally
   * zero: it exists so that losing a record can never be silent.
   */
  readonly droppedRecords: number;
  /**
   * Thinking steps the provider persisted as signature-only. Unrecoverable at
   * the source rather than lost here, so they are counted apart from
   * `droppedRecords`.
   */
  readonly redactedThinking: number;
}

/**
 * Convert transcript records into renderable rows, pairing each `tool_use`
 * with the `tool_result` that answers it into a single row carrying input,
 * result, status and (where the harness recorded enough) file changes.
 *
 * Pairing is by `tool_use_id` through a map, so parallel calls whose results
 * come back out of order still land on their own call.
 */
export function toTranscriptEntries(records: ReadonlyArray<TranscriptRecord>): ConvertedTranscript {
  const entries: MutableEntry[] = [];
  const toolEntryByUseId = new Map<string, MutableEntry>();
  const toolNameByUseId = new Map<string, string>();
  const toolInputByUseId = new Map<string, unknown>();
  let droppedRecords = 0;
  let redactedThinking = 0;

  for (const record of records) {
    // Non-conversational records (attachments, and any type this build does
    // not know) carry no renderable body. They are not losses: they exist to
    // keep ordering honest.
    if (record.type !== "user" && record.type !== "assistant") continue;
    if (!record.message) {
      droppedRecords += 1;
      continue;
    }

    const content = record.message.content;
    const usage = record.type === "assistant" ? readUsage(record.message) : undefined;
    const model = record.type === "assistant" ? readString(record.message.model) : undefined;
    let usageAttached = false;
    const attachOnce = (entry: MutableEntry) => {
      if (model) entry.model = model;
      if (usage && !usageAttached) {
        entry.usage = usage;
        usageAttached = true;
      }
    };

    // The launch prompt arrives as a bare string body on the first user record.
    if (typeof content === "string") {
      entries.push({
        id: record.id,
        createdAt: record.timestamp ?? null,
        tone: "info",
        kind: record.type === "assistant" ? "assistant_message" : "user_message",
        summary: summarize(content, record.type === "assistant" ? "Assistant message" : "Prompt"),
        itemType: record.type === "assistant" ? "assistant_message" : "user_message",
        text: content,
      });
      continue;
    }
    if (!Array.isArray(content)) {
      droppedRecords += 1;
      continue;
    }

    // A record that only answers an earlier tool call updates that row instead
    // of adding one, so "contributed" is wider than "produced an entry".
    const entryCountBefore = entries.length;
    let updatedExistingRow = false;
    let hadContentFreeBlock = false;
    let blockIndex = -1;
    for (const rawBlock of content) {
      blockIndex += 1;
      const block = readRecord(rawBlock);
      if (!block) continue;
      const id = `${record.id}:${blockIndex}`;

      switch (block.type) {
        case "text": {
          const text = typeof block.text === "string" ? block.text : "";
          const entry: MutableEntry = {
            id,
            createdAt: record.timestamp ?? null,
            tone: "info",
            kind: record.type === "assistant" ? "assistant_message" : "user_message",
            summary: summarize(text, record.type === "assistant" ? "Assistant message" : "Prompt"),
            itemType: record.type === "assistant" ? "assistant_message" : "user_message",
            text,
          };
          attachOnce(entry);
          entries.push(entry);
          break;
        }

        case "thinking": {
          const text = typeof block.thinking === "string" ? block.thinking : "";
          // The harness emits thinking blocks with no text at all (7 of 19
          // rows in one real transcript). They are content-free at the source,
          // not content we lost, so they are skipped WITHOUT counting as a
          // dropped record — emitting them would inflate the entry count past
          // the number of rows a client can actually show.
          //
          // A signature alongside the empty text means the provider persisted
          // the step as signature-only: reasoning happened and its text is
          // unrecoverable, which is worth telling the reader about. No
          // signature means there was simply nothing there, so it stays
          // uncounted.
          if (text.trim().length === 0) {
            hadContentFreeBlock = true;
            if (readString(block.signature)) redactedThinking += 1;
            break;
          }
          const entry: MutableEntry = {
            id,
            createdAt: record.timestamp ?? null,
            tone: "info",
            kind: "reasoning",
            summary: summarize(text, "Thinking"),
            itemType: "reasoning",
            text,
          };
          attachOnce(entry);
          entries.push(entry);
          break;
        }

        case "tool_use": {
          const toolName = readString(block.name) ?? "tool";
          const useId = readString(block.id);
          const itemType = classifyToolItemType(toolName);
          const entry: MutableEntry = {
            id,
            createdAt: record.timestamp ?? null,
            tone: "tool",
            kind: "tool.completed",
            summary: summarizeToolRequest(toolName, block.input),
            itemType,
            status: "inProgress",
            data: { toolName, input: block.input },
          };
          attachOnce(entry);
          entries.push(entry);
          if (useId) {
            toolEntryByUseId.set(useId, entry);
            toolNameByUseId.set(useId, toolName);
            toolInputByUseId.set(useId, block.input);
          }
          break;
        }

        case "tool_result": {
          const useId = readString(block.tool_use_id);
          const isError = block.is_error === true;
          const pending = useId ? toolEntryByUseId.get(useId) : undefined;
          if (!pending || !useId) {
            // Orphan result: its call was never recorded, or the byte cap cut
            // it off. Keep it visible rather than silently dropping work.
            entries.push({
              id,
              createdAt: record.timestamp ?? null,
              tone: isError ? "error" : "tool",
              kind: "tool.completed",
              summary: "Tool result",
              itemType: "dynamic_tool_call",
              status: isError ? "failed" : "completed",
              data: { toolName: "tool", input: undefined, result: block },
            });
            break;
          }
          const toolName = toolNameByUseId.get(useId) ?? "tool";
          pending.status = isError ? "failed" : "completed";
          pending.data = { toolName, input: toolInputByUseId.get(useId), result: block };
          if (isError) pending.tone = "error";
          const changes = isError
            ? undefined
            : toolFileChanges(toolName, toolInputByUseId.get(useId), record.toolUseResult);
          if (changes) pending.fileChanges = changes;
          toolEntryByUseId.delete(useId);
          updatedExistingRow = true;
          break;
        }

        default:
          break;
      }
    }

    if (entries.length === entryCountBefore && !updatedExistingRow && !hadContentFreeBlock) {
      droppedRecords += 1;
    }
  }

  return { entries, droppedRecords, redactedThinking };
}

interface ResolvedTranscriptFile {
  readonly filePath: string;
  readonly root: string;
}

/**
 * Locate `<projects>/<*>/<sessionId>/subagents/agent-<agentId>.jsonl` by
 * scanning the project directories under the config dir. Scanning rather than
 * re-deriving the harness's project-directory encoding keeps this correct
 * across its truncation and collision-suffix rules.
 */
const locateTranscript = Effect.fn("orchestration.locateSubagentTranscript")(function* (input: {
  readonly configDir: string;
  readonly sessionId: string;
  readonly agentId: string;
}) {
  const root = yield* Effect.tryPromise({
    try: () => NodeFSP.realpath(NodePath.join(input.configDir, "projects")),
    catch: (cause) => failure("root-unavailable", input.agentId, cause),
  });

  const projectDirs = yield* Effect.tryPromise({
    try: () => NodeFSP.readdir(root, { withFileTypes: true }),
    catch: (cause) => failure("root-unavailable", input.agentId, cause),
  });

  const leaf = `agent-${input.agentId}.jsonl`;
  for (const dirent of projectDirs) {
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
    const candidate = NodePath.join(root, dirent.name, input.sessionId, "subagents", leaf);
    const resolved = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(candidate),
      catch: () => undefined,
    }).pipe(Effect.catchCause(() => Effect.void));
    if (!resolved) continue;
    if (resolved !== root && !resolved.startsWith(`${root}${NodePath.sep}`)) {
      return yield* failure("outside-root", input.agentId);
    }
    return { filePath: resolved, root } satisfies ResolvedTranscriptFile;
  }

  return yield* failure("not-found", input.agentId);
});

/**
 * Read and convert one subagent transcript from a known config dir. Exported
 * separately from the thread-resolving entry point so the file contract can be
 * exercised against a fixture without standing up provider services.
 */
export const readSubagentTranscript = Effect.fn("orchestration.readSubagentTranscript")(
  function* (input: {
    readonly configDir: string;
    readonly sessionId: string;
    readonly agentId: string;
  }) {
    if (!AGENT_ID_PATTERN.test(input.agentId)) {
      return yield* failure("invalid-agent-id", input.agentId);
    }
    if (!SESSION_ID_PATTERN.test(input.sessionId)) {
      return yield* failure("session-unknown", input.agentId);
    }

    const { filePath } = yield* locateTranscript(input);

    // TOCTOU-safe read: open first, then validate the opened inode against the
    // path we resolved. Re-checking the path after open would race a swap.
    const read = yield* Effect.tryPromise({
      try: async () => {
        const handle = await NodeFSP.open(filePath, "r");
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) return { failure: "not-regular-file" as const };
          const pathStat = await NodeFSP.lstat(filePath);
          if (stat.ino !== pathStat.ino || stat.dev !== pathStat.dev) {
            return { failure: "changed-during-read" as const };
          }
          if (stat.size > TRANSCRIPT_HARD_CEILING) {
            return { failure: "transcript-too-large" as const };
          }
          const truncated = stat.size > TRANSCRIPT_BYTE_CAP;
          const buffer = Buffer.alloc(Math.min(stat.size, TRANSCRIPT_BYTE_CAP));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          let meta: Record<string, unknown> | undefined;
          try {
            const metaRaw = await NodeFSP.readFile(
              filePath.replace(/\.jsonl$/, ".meta.json"),
              "utf8",
            );
            // @effect-diagnostics-next-line preferSchemaOverJson:off - optional provider sidecar; unknown extra keys are ignored.
            meta = readRecord(JSON.parse(metaRaw));
          } catch {
            // The sidecar is optional; its absence must not fail the transcript.
          }
          return {
            contents: buffer.subarray(0, bytesRead).toString("utf8"),
            truncated,
            meta,
          };
        } finally {
          await handle.close();
        }
      },
      catch: (cause) => failure("read-failed", input.agentId, cause),
    });
    if ("failure" in read) {
      return yield* failure(read.failure, input.agentId);
    }

    const agentType = readString(read.meta?.agentType);
    const description = readString(read.meta?.description);
    const parsed = parseTranscriptRecords(read.contents);
    const converted = toTranscriptEntries(orderRecords(parsed.records));
    return {
      agentId: input.agentId,
      sessionId: input.sessionId,
      ...(agentType ? { agentType } : {}),
      ...(description ? { description } : {}),
      entries: converted.entries,
      truncated: read.truncated,
      droppedRecords: converted.droppedRecords,
      skippedLines: parsed.skippedLines,
      redactedThinking: converted.redactedThinking,
    };
  },
);

/**
 * Entry point for the `orchestration.getSubagentTranscript` RPC: resolve the
 * thread's provider session, its instance config dir and its harness session
 * id, then serve the transcript from disk.
 *
 * Codex is deliberately unimplemented here — it keeps no equivalent per-
 * subagent transcript on disk, so it reports `provider-unsupported` rather
 * than guessing at a layout.
 */
export const getSubagentTranscriptForThread = Effect.fn(
  "orchestration.getSubagentTranscriptForThread",
)(function* (input: { readonly threadId: ThreadId; readonly agentId: string }) {
  if (!AGENT_ID_PATTERN.test(input.agentId)) {
    return yield* failure("invalid-agent-id", input.agentId);
  }

  const directory = yield* ProviderSessionDirectory;
  const settingsService = yield* ServerSettingsService;

  const binding = yield* directory
    .getBinding(input.threadId)
    .pipe(Effect.mapError((cause) => failure("session-unknown", input.agentId, cause)));
  const resolved = Option.getOrUndefined(binding);
  if (!resolved) {
    return yield* failure("session-unknown", input.agentId);
  }
  if (resolved.provider !== CLAUDE_DRIVER_KIND) {
    return yield* failure("provider-unsupported", input.agentId);
  }

  const sessionId = readClaudeSessionIdFromResumeCursor(resolved.resumeCursor);
  if (!sessionId) {
    return yield* failure("session-unknown", input.agentId);
  }

  const settings = yield* settingsService.getSettings.pipe(
    Effect.mapError((cause) => failure("root-unavailable", input.agentId, cause)),
  );
  const instanceId = resolved.providerInstanceId ?? defaultInstanceIdForDriver(resolved.provider);
  const envelope = deriveProviderInstanceConfigMap(settings)[instanceId];
  const claudeSettings = resolveClaudeSettings(envelope?.config, settings);
  const configDir = yield* resolveClaudeConfigDirPath(
    claudeSettings,
    mergeProviderInstanceEnvironment(envelope?.environment),
  );

  return yield* readSubagentTranscript({ configDir, sessionId, agentId: input.agentId });
});

/**
 * Decode an instance's Claude config, falling back to the legacy
 * single-instance settings when the envelope is absent or undecodable. A bad
 * config blob must not hide a transcript that is sitting on disk.
 */
function resolveClaudeSettings(config: unknown, settings: ServerSettings): ClaudeSettings {
  if (config !== undefined) {
    try {
      return decodeClaudeSettings(config);
    } catch {
      // Fall through to the legacy mirror below.
    }
  }
  return settings.providers.claudeAgent;
}
