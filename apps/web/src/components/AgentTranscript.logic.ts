/**
 * Row derivation for the per-subagent transcript surface.
 *
 * Two sources produce the same row shape on purpose. Persisted rows are the
 * attributed thread activities the main timeline hides (`agent.message`,
 * `agent.reasoning`, `peer.message`, and `tool.*` carrying `payload.agentId`);
 * recovered rows come from the `orchestration.getSubagentTranscript` RPC,
 * whose entries the server already shapes like activity payloads. Everything
 * here is pure so the merge policy can be tested without rendering or a
 * websocket.
 *
 * The disk source has no equivalent of the `peer.message` row: the harness
 * writes nothing to a subagent's JSONL when a message is injected into it, so
 * a recovered transcript simply cannot show one.
 */
import type {
  OrchestrationSubagentTranscriptEntry,
  OrchestrationThreadActivity,
  ToolFileChange,
} from "@t3tools/contracts";

export type AgentTranscriptRowKind = "user_message" | "assistant_message" | "reasoning" | "tool";

export interface AgentTranscriptRow {
  readonly id: string;
  readonly createdAt: string | null;
  readonly kind: AgentTranscriptRowKind;
  /** One-line heading; the tool name for tool rows. */
  readonly summary: string;
  /**
   * Overrides a message row's heading. Absent means the launch prompt's
   * default, so a row that is NOT the launch prompt has to say what it is.
   */
  readonly label?: string;
  /** Message/thinking body, rendered whole. */
  readonly text?: string;
  readonly toolName?: string;
  readonly input?: unknown;
  readonly result?: unknown;
  readonly status?: "inProgress" | "completed" | "failed" | "declined";
  readonly failed?: boolean;
  readonly fileChanges?: ReadonlyArray<ToolFileChange>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const ROW_STATUSES = new Set(["inProgress", "completed", "failed", "declined"]);

function asStatus(value: unknown): AgentTranscriptRow["status"] {
  return typeof value === "string" && ROW_STATUSES.has(value)
    ? (value as NonNullable<AgentTranscriptRow["status"]>)
    : undefined;
}

function asFileChanges(value: unknown): ReadonlyArray<ToolFileChange> | undefined {
  if (!Array.isArray(value)) return undefined;
  const changes = value.filter((candidate): candidate is ToolFileChange => {
    const change = asRecord(candidate);
    return (
      change !== undefined &&
      typeof change.path === "string" &&
      typeof change.diff === "string" &&
      (change.kind === "add" || change.kind === "delete" || change.kind === "update")
    );
  });
  return changes.length > 0 ? changes : undefined;
}

/** Claude records a failed call on the tool_result block itself. */
function resultIsError(result: unknown): boolean {
  return asRecord(result)?.is_error === true;
}

/** True when this activity is owned by the given subagent. */
export function activityBelongsToAgent(
  activity: OrchestrationThreadActivity,
  agentId: string,
): boolean {
  const payload = asRecord(activity.payload);
  return typeof payload?.agentId === "string" && payload.agentId === agentId;
}

/**
 * Lifecycle order for rows that cannot be told apart by time.
 *
 * `sequence` is null on every persisted activity and a tool's `updated` and
 * `completed` routinely share a millisecond, which left the sort falling
 * through to a UUID comparison — a coin flip that put `completed` first about
 * half the time. Ranking the stages makes the order deterministic.
 */
const TOOL_LIFECYCLE_RANK: Readonly<Record<string, number>> = {
  "tool.started": 0,
  "tool.updated": 1,
  "tool.completed": 2,
};

function compareActivities(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  const leftSequence = left.sequence ?? Number.MAX_SAFE_INTEGER;
  const rightSequence = right.sequence ?? Number.MAX_SAFE_INTEGER;
  if (leftSequence !== rightSequence) return leftSequence - rightSequence;
  if (left.createdAt !== right.createdAt) return left.createdAt.localeCompare(right.createdAt);
  const leftRank = TOOL_LIFECYCLE_RANK[left.kind];
  const rightRank = TOOL_LIFECYCLE_RANK[right.kind];
  // Only between two tool stages: ranking anything else would reorder rows
  // this tiebreak knows nothing about.
  if (leftRank !== undefined && rightRank !== undefined && leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return left.id.localeCompare(right.id);
}

/**
 * Tool name and one-line label for a row.
 *
 * `data` is the rich source but does not always survive the wire: a
 * `tool.started` row is persisted with `itemType`/`detail` only (ingestion
 * drops its `data`), so a name taken from `data` alone would leave the row
 * called "Tool call started". `detail` is written by the adapter as
 * `<ToolName>: <arguments>` and IS carried on every lifecycle stage, so it is
 * the reliable fallback. Agent-tool rows carry a bare human description with
 * no prefix; those keep the description as the label and take their name from
 * `data` when it is there.
 */
const TOOL_DETAIL_PREFIX = /^([A-Za-z0-9_.:-]{1,64}): ([\s\S]*)$/;

/** Argument fields worth showing beside a tool name, most specific first. */
const TOOL_TARGET_PATH_FIELDS = ["file_path", "path", "notebook_path"] as const;
const TOOL_TARGET_TEXT_FIELDS = [
  "command",
  "cmd",
  "pattern",
  "query",
  "url",
  "skill",
  "description",
  "prompt",
  "name",
] as const;

function basename(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

function firstLine(value: string): string {
  const trimmed = value.trim();
  return (trimmed.split("\n", 1)[0] ?? trimmed).trim();
}

function truncateLabel(value: string, max = 96): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/** Salient argument for the heading, from a parsed input object. */
function toolTargetFromInput(input: unknown): string | undefined {
  const record = asRecord(input);
  if (!record) {
    return typeof input === "string" && input.length > 0 ? firstLine(input) : undefined;
  }
  for (const field of TOOL_TARGET_PATH_FIELDS) {
    const value = asText(record[field]);
    if (value) return basename(value);
  }
  for (const field of TOOL_TARGET_TEXT_FIELDS) {
    const value = asText(record[field]);
    if (value) return firstLine(value);
  }
  return undefined;
}

/** Matches one JSON string field in raw text, escapes intact. */
const RAW_JSON_FIELD_PATTERNS: ReadonlyArray<readonly [string, RegExp, boolean]> = [
  ...TOOL_TARGET_PATH_FIELDS.map(
    (field) => [field, new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`), true] as const,
  ),
  ...TOOL_TARGET_TEXT_FIELDS.map(
    (field) => [field, new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`), false] as const,
  ),
];

function unescapeJsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/**
 * Salient argument scanned straight out of raw JSON text.
 *
 * Details are capped at 180 characters server-side, which cuts most
 * file-change arguments mid-object — three quarters of them do not parse. The
 * salient field leads the object, so it survives the cut even when the JSON
 * does not, and finding it here is what keeps an Edit row from being headed
 * with a JSON fragment.
 */
function toolTargetFromRawJson(text: string): string | undefined {
  for (const [, pattern, isPath] of RAW_JSON_FIELD_PATTERNS) {
    const match = pattern.exec(text);
    const value = match?.[1];
    if (value !== undefined && value.length > 0) {
      const decoded = unescapeJsonString(value);
      return isPath ? basename(decoded) : firstLine(decoded);
    }
  }
  return undefined;
}

/** Same, from the `<ToolName>: <arguments>` tail, which may be JSON or raw text. */
function toolTargetFromDetailTail(tail: string): string | undefined {
  const trimmed = tail.trim();
  if (trimmed.startsWith("{")) {
    try {
      return toolTargetFromInput(JSON.parse(trimmed) as unknown);
    } catch {
      return toolTargetFromRawJson(trimmed) ?? firstLine(trimmed);
    }
  }
  return trimmed.length > 0 ? firstLine(trimmed) : undefined;
}

export interface ToolRowIdentity {
  /** Tool name when one could be determined; absent for unlabeled rows. */
  readonly toolName?: string;
  /** One-line heading, e.g. `Read · README.md`. */
  readonly label: string;
}

export function deriveToolRowIdentity(input: {
  readonly data: Record<string, unknown> | undefined;
  readonly detail: string | undefined;
  readonly fallback: string;
}): ToolRowIdentity {
  const detailMatch = input.detail ? TOOL_DETAIL_PREFIX.exec(input.detail) : null;
  const toolName = asText(input.data?.toolName) ?? (detailMatch ? detailMatch[1] : undefined);
  const target =
    (input.data && "input" in input.data ? toolTargetFromInput(input.data.input) : undefined) ??
    (detailMatch ? toolTargetFromDetailTail(detailMatch[2] ?? "") : undefined) ??
    (input.detail && !detailMatch ? firstLine(input.detail) : undefined);

  const label = toolName
    ? target
      ? `${toolName} · ${target}`
      : toolName
    : (target ?? input.fallback);
  return { ...(toolName ? { toolName } : {}), label: truncateLabel(label) };
}

/**
 * Coalescing key for one tool call.
 *
 * Persisted tool rows carry no per-call identifier: ingestion writes only
 * `itemType`/`detail`/`data`/`fileChanges` (plus attribution), the projection
 * has no provider item id column, and the only id on the wire —
 * `data.result.tool_use_id` — exists solely on the completion, so it cannot
 * match the call that opened. What IS stable is `detail`: every stage renders
 * the same `summarizeToolRequest(name, input)` string under the same
 * truncation, so it identifies the call across `started`/`updated`/
 * `completed`. `data` is the fallback for rows that carry no detail.
 */
function toolCallKey(input: {
  readonly detail: string | undefined;
  readonly toolName: string | undefined;
  readonly data: Record<string, unknown> | undefined;
  readonly activityId: string;
}): string | null {
  if (input.detail) return `d\0${input.detail}`;
  if (input.toolName === undefined && input.data === undefined) {
    // Nothing identifies this call. Coalescing on an empty key would fuse
    // every one of the agent's tool rows into a single row, which is far
    // worse than not coalescing — so opt out for this row.
    return null;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(input.data?.input) ?? "";
  } catch {
    serialized = "";
  }
  return `n\0${input.toolName ?? ""}\0${serialized}`;
}

type MutableRow = {
  -readonly [K in keyof AgentTranscriptRow]: AgentTranscriptRow[K];
};

export interface AgentPersistedTranscript {
  readonly rows: ReadonlyArray<AgentTranscriptRow>;
  /**
   * True when this agent's own narration was persisted. Narration is what
   * distinguishes a thread recorded by the current server from a pre-feature
   * one whose conversation only survives on disk.
   */
  readonly hasNarration: boolean;
}

/**
 * Derives one agent's rows from the thread activities the client already
 * holds. Tool lifecycle rows collapse into a single row per call so an
 * `updated` tick and its `completed` do not read as two invocations.
 *
 * `agentSettled` closes out calls whose completion never arrived: a finished
 * agent has no process left to finish them, so they must not keep claiming to
 * be running. They render with an unknown outcome instead.
 */
export function agentPersistedTranscript(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  agentId: string,
  options?: { readonly agentSettled?: boolean },
): AgentPersistedTranscript {
  const owned = activities
    .filter((activity) => activityBelongsToAgent(activity, agentId))
    .toSorted(compareActivities);

  const rows: MutableRow[] = [];
  const openToolRows = new Map<string, MutableRow>();
  // Calls that already reached a result. A stage arriving after one folds back
  // into its row instead of opening a duplicate.
  const resolvedToolRows = new Map<string, MutableRow>();
  // Highest lifecycle stage each row has absorbed, so an out-of-order earlier
  // stage cannot walk a finished call's status backwards.
  const rowStage = new Map<MutableRow, number>();
  let hasNarration = false;

  for (const activity of owned) {
    const payload = asRecord(activity.payload);
    if (!payload) continue;

    if (activity.kind === "agent.message" || activity.kind === "agent.reasoning") {
      hasNarration = true;
      const text = asText(payload.detail);
      rows.push({
        id: activity.id,
        createdAt: activity.createdAt,
        kind: activity.kind === "agent.reasoning" ? "reasoning" : "assistant_message",
        summary: activity.summary,
        ...(text !== undefined ? { text } : {}),
      });
      continue;
    }

    // A message the parent agent sent into this subagent's lane mid-run.
    // Rendered as a prompt because that is what it is — an instruction from
    // outside that the agent's next reply answers. The row carries no status:
    // the send is all the harness reports, so there is nothing here that could
    // honestly claim the agent received it (the server label says "sent").
    //
    // Deliberately not counted as narration: this row comes from the send, not
    // from the agent, so a subagent that predates narration persistence must
    // still fall through to the disk read for its own conversation.
    if (activity.kind === "peer.message") {
      const text = asText(payload.detail);
      rows.push({
        id: activity.id,
        createdAt: activity.createdAt,
        kind: "user_message",
        summary: activity.summary,
        // Without this the row heads with the launch prompt's "Prompt" and is
        // indistinguishable from it. "Sent" over "received" for the same
        // reason the server label says sent: the delivery is never reported.
        label: "Sent from main thread",
        ...(text !== undefined ? { text } : {}),
      });
      continue;
    }

    if (
      activity.kind !== "tool.started" &&
      activity.kind !== "tool.updated" &&
      activity.kind !== "tool.completed"
    ) {
      continue;
    }

    const data = asRecord(payload.data);
    const detail = asText(payload.detail);
    const identity = deriveToolRowIdentity({ data, detail, fallback: activity.summary });
    const input = data?.input;
    const result = data?.result;
    const key = toolCallKey({
      detail,
      toolName: identity.toolName,
      data,
      activityId: activity.id,
    });
    const status =
      asStatus(payload.status) ?? (activity.kind === "tool.completed" ? "completed" : undefined);
    const failed = status === "failed" || status === "declined" || resultIsError(result);
    const fileChanges = asFileChanges(payload.fileChanges);

    const stage = TOOL_LIFECYCLE_RANK[activity.kind] ?? 0;
    const resolvesCall = result !== undefined || activity.kind === "tool.completed";
    // A `tool.started` always begins a new invocation; any later stage for a
    // key that already resolved belongs to that call, however it got ordered.
    const existing =
      key === null
        ? undefined
        : (openToolRows.get(key) ??
          (activity.kind === "tool.started" ? undefined : resolvedToolRows.get(key)));

    if (existing && key !== null) {
      const seenStage = rowStage.get(existing) ?? -1;
      if (result !== undefined) existing.result = result;
      if (failed) existing.failed = true;
      if (fileChanges) existing.fileChanges = fileChanges;
      // A later stage often carries the richer payload (started has no data
      // at all), so let it improve the heading it opened with.
      if (identity.toolName && !existing.toolName) existing.toolName = identity.toolName;
      if (identity.label.length > existing.summary.length) existing.summary = identity.label;
      // Status only ever moves forward: an `updated` that sorted behind its
      // own `completed` must not put a finished call back into "running".
      if (status && stage >= seenStage) existing.status = status;
      if (stage > seenStage) rowStage.set(existing, stage);
      if (resolvesCall) {
        openToolRows.delete(key);
        resolvedToolRows.set(key, existing);
      }
      continue;
    }

    const row: MutableRow = {
      id: activity.id,
      createdAt: activity.createdAt,
      kind: "tool",
      summary: identity.label,
      ...(identity.toolName ? { toolName: identity.toolName } : {}),
      ...(input !== undefined ? { input } : {}),
      ...(result !== undefined ? { result } : {}),
      ...(status ? { status } : {}),
      ...(failed ? { failed: true } : {}),
      ...(fileChanges ? { fileChanges } : {}),
    };
    rows.push(row);
    rowStage.set(row, stage);
    if (key !== null) {
      // Registered either way: a row opened by an `updated` that already
      // carried a result used to be tracked by neither map, which is how a
      // late stage found nothing and duplicated it.
      if (resolvesCall) {
        resolvedToolRows.set(key, row);
      } else {
        openToolRows.set(key, row);
      }
    }
  }

  if (options?.agentSettled === true) {
    // Unconditional over every rendered row, not just the ones still tracked:
    // a settled agent has no process left to finish anything, so no row may
    // claim to be running regardless of how it was registered.
    for (const row of rows) {
      if (row.kind === "tool" && row.status === "inProgress") {
        delete row.status;
      }
    }
  }

  return { rows, hasNarration };
}

/** Recovered on-disk entries, mapped onto the shared row shape. */
export function diskTranscriptRows(
  entries: ReadonlyArray<OrchestrationSubagentTranscriptEntry>,
): ReadonlyArray<AgentTranscriptRow> {
  return entries.map((entry): AgentTranscriptRow => {
    if (entry.kind === "tool.completed") {
      const data = asRecord(entry.data);
      // The server already labels a recovered row with the same
      // `summarizeToolRequest` line the adapter writes ("Bash: ls -la", or an
      // agent tool's description). Prefer it over rebuilding a poorer one.
      const identity = deriveToolRowIdentity({
        data,
        detail: entry.summary,
        fallback: entry.summary,
      });
      return {
        id: entry.id,
        createdAt: entry.createdAt,
        kind: "tool",
        summary: identity.label,
        ...(identity.toolName ? { toolName: identity.toolName } : {}),
        ...(data && "input" in data ? { input: data.input } : {}),
        ...(data && "result" in data ? { result: data.result } : {}),
        ...(entry.status ? { status: entry.status } : {}),
        ...(entry.status === "failed" || entry.tone === "error" ? { failed: true } : {}),
        ...(entry.fileChanges && entry.fileChanges.length > 0
          ? { fileChanges: entry.fileChanges }
          : {}),
      };
    }
    return {
      id: entry.id,
      createdAt: entry.createdAt,
      kind:
        entry.kind === "reasoning"
          ? "reasoning"
          : entry.kind === "user_message"
            ? "user_message"
            : "assistant_message",
      summary: entry.summary,
      ...(entry.text ? { text: entry.text } : {}),
    };
  });
}

/**
 * Which source the surface should render.
 *
 * Persisted narration means the whole conversation is already on the client,
 * so the disk read is skipped entirely — and a live agent keeps updating
 * through the ordinary activity stream. Without narration the agent predates
 * narration persistence, so the on-disk transcript is fetched once on open.
 */
export function resolveAgentTranscriptSource(
  persisted: AgentPersistedTranscript,
): "persisted" | "disk" {
  return persisted.hasNarration ? "persisted" : "disk";
}

const TRANSCRIPT_UNAVAILABLE_NOTICES: Record<string, string> = {
  "provider-unsupported": "This provider does not keep a full transcript for subagents.",
  "session-unknown": "This thread's provider session is no longer recorded.",
  "invalid-agent-id": "This subagent's id is not a transcript id.",
  "root-unavailable": "The provider's transcript folder is unavailable.",
  "not-found": "No stored transcript remains for this subagent.",
  "outside-root": "The stored transcript resolved outside the provider's folder.",
  "not-regular-file": "The stored transcript is not a readable file.",
  "changed-during-read": "The stored transcript changed while being read.",
  "transcript-too-large": "The stored transcript is too large to load.",
  "read-failed": "The stored transcript could not be read.",
};

/**
 * One quiet line when a recovered transcript is not lossless. The server
 * reports these rather than letting a client infer completeness, so say how
 * much is missing instead of silently showing less.
 */
export function transcriptRecoveryLossNotice(input: {
  readonly droppedRecords: number;
  readonly skippedLines: number;
  /**
   * Accepted but deliberately unused: encrypted reasoning is not content we
   * failed to render, so it gets its own notice rather than being counted as
   * a loss. Taking the whole result object here keeps callers from having to
   * know that. Absent when talking to a server that predates the count.
   */
  readonly redactedThinking?: number | undefined;
}): string | null {
  const count = (value: number | undefined): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  const droppedRecords = count(input.droppedRecords);
  const skippedLines = count(input.skippedLines);

  const parts: string[] = [];
  if (droppedRecords > 0) {
    parts.push(`${droppedRecords} ${droppedRecords === 1 ? "step" : "steps"} could not be shown`);
  }
  if (skippedLines > 0) {
    parts.push(`${skippedLines} unreadable ${skippedLines === 1 ? "line" : "lines"} were skipped`);
  }
  return parts.length === 0 ? null : `${parts.join(" and ")}.`;
}

/**
 * One quiet line for reasoning the provider stored signature-only. Separate
 * from the recovery-loss notice on purpose: nothing was lost on our side and
 * nothing can be recovered, so it must not read as a failure to render.
 *
 * Redaction is all-or-nothing per transcript in practice, so the usual shape
 * is a transcript with no reasoning rows at all — the copy says that plainly
 * rather than making the reader total up steps against an empty view. The
 * counted form is the fallback for a mixed transcript.
 */
export function transcriptRedactedThinkingNotice(input: {
  readonly redactedThinking: number | undefined;
  readonly reasoningRowCount: number;
}): string | null {
  const { redactedThinking } = input;
  if (typeof redactedThinking !== "number" || !Number.isFinite(redactedThinking)) {
    return null;
  }
  const count = Math.trunc(redactedThinking);
  if (count <= 0) return null;
  if (input.reasoningRowCount <= 0) {
    return "This agent's reasoning was kept encrypted by the provider and cannot be shown.";
  }
  return count === 1
    ? "1 reasoning step was kept encrypted by the provider and cannot be shown."
    : `${count} reasoning steps were kept encrypted by the provider and cannot be shown.`;
}

/** One quiet line explaining why a full transcript is not available. */
export function transcriptUnavailableNotice(reason: string | undefined): string {
  return (
    (reason === undefined ? undefined : TRANSCRIPT_UNAVAILABLE_NOTICES[reason]) ??
    "The full transcript could not be loaded."
  );
}

/** Stable, readable serialization of a tool argument or result blob. */
export function formatToolPayload(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.length > 0 ? value : null;
  try {
    return JSON.stringify(value, null, 2) ?? null;
  } catch {
    return null;
  }
}

/** Claude tool results wrap their text in a content block; unwrap for display. */
export function formatToolResult(value: unknown): string | null {
  const record = asRecord(value);
  const content = record?.content;
  if (typeof content === "string") return content.length > 0 ? content : null;
  if (Array.isArray(content)) {
    const text = content
      .map((block) => asText(asRecord(block)?.text))
      .filter((part): part is string => part !== undefined)
      .join("\n");
    if (text.length > 0) return text;
  }
  return formatToolPayload(value);
}
