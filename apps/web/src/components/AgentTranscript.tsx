/**
 * Per-subagent transcript: the Agents surface's drill-down.
 *
 * The main thread deliberately shows only the main agent's work, so a
 * subagent's own commentary, thinking, tool calls and diffs have nowhere else
 * to be read. This surface renders them at the same fidelity, from whichever
 * source has them (see AgentTranscript.logic.ts for the merge policy).
 *
 * It is deliberately NOT the chat timeline: that component owns a virtualized
 * list, a reading anchor, a minimap and two private contexts, and its row
 * components are unexported. What is genuinely shared is the text renderer
 * (ChatMarkdown) and the diff pipeline (buildToolFileRenderablePatch →
 * getRenderablePatch → FileDiff); the row chrome mirrors the work log's visual
 * language without importing it.
 */
import { useAtomValue } from "@effect/atom-react";
import { FileDiff } from "@pierre/diffs/react";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  isTerminalSubagentStatus,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, OrchestrationThreadActivity, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AlertTriangle, ArrowLeft, Brain, ChevronRight, MessageSquare, Wrench } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import {
  buildToolFileRenderablePatch,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "~/lib/diffRendering";
import { orchestrationEnvironment } from "~/state/orchestration";
import { DiffWordWrapToggle, diffOverflowMode } from "./diffs/DiffWordWrapToggle";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Button } from "~/components/ui/button";
import ChatMarkdown from "./ChatMarkdown";
import {
  agentPersistedTranscript,
  diskTranscriptRows,
  formatToolPayload,
  formatToolResult,
  resolveAgentTranscriptSource,
  transcriptRecoveryLossNotice,
  transcriptRedactedThinkingNotice,
  transcriptUnavailableNotice,
  type AgentTranscriptRow,
} from "./AgentTranscript.logic";

const EMPTY_NOTICES: ReadonlyArray<string> = [];

interface TranscriptChrome {
  readonly markdownCwd: string | undefined;
  readonly workspaceRoot: string | undefined;
  readonly resolvedTheme: "light" | "dark";
}

function ToolFileChangesList({
  row,
  chrome,
  wordWrap,
}: {
  row: AgentTranscriptRow;
  chrome: TranscriptChrome;
  wordWrap: boolean;
}) {
  if (!row.fileChanges) return null;
  const overflow = diffOverflowMode(wordWrap);
  return (
    <div className="mt-1.5 space-y-1.5">
      {row.fileChanges.map((change, index) => {
        const changeKey = `${change.kind}:${change.previousPath ?? ""}:${change.path}`;
        const renderable = getRenderablePatch(
          buildToolFileRenderablePatch(change, chrome.workspaceRoot),
          `agent-transcript:${row.id}:${index}`,
        );
        if (renderable?.kind === "files") {
          return renderable.files.map((fileDiff) => (
            <FileDiff
              key={`${changeKey}:${resolveFileDiffPath(fileDiff)}`}
              fileDiff={fileDiff}
              options={{
                collapsed: false,
                diffStyle: "unified",
                overflow,
                theme: resolveDiffThemeName(chrome.resolvedTheme),
              }}
            />
          ));
        }
        return renderable?.kind === "raw" ? (
          <pre
            key={changeKey}
            className="whitespace-pre-wrap break-words font-mono text-[.7rem] leading-relaxed text-muted-foreground select-text"
          >
            {renderable.text}
          </pre>
        ) : null;
      })}
    </div>
  );
}

/**
 * One tool call: a heading line that expands to the recorded input, result and
 * any applied patch.
 *
 * Rows collapse by default so a wall of command output does not bury the
 * narration — but a row carrying a patch opens, matching the chat timeline's
 * treatment of a File change and the rule that semantic activity stays visible
 * rather than hidden behind a summary.
 */
function ToolTranscriptRow({ row, chrome }: { row: AgentTranscriptRow; chrome: TranscriptChrome }) {
  const [open, setOpen] = useState(row.fileChanges !== undefined);
  // Scoped to this row and starting off, matching the chat transcript's cell:
  // a subagent's prose edit can be wrapped without touching its code edits.
  const [wordWrap, setWordWrap] = useState(false);
  const input = formatToolPayload(row.input);
  const result = formatToolResult(row.result);
  const hasDetail = input !== null || result !== null || row.fileChanges !== undefined;

  return (
    <div className="rounded-md border border-border/50 bg-card/30">
      <button
        type="button"
        onClick={() => (hasDetail ? setOpen((value) => !value) : undefined)}
        aria-expanded={hasDetail ? open : undefined}
        disabled={!hasDetail}
        className={cn(
          "flex w-full items-center gap-1.5 px-2 py-1 text-left",
          hasDetail && "cursor-pointer hover:bg-accent/40",
        )}
      >
        <Wrench
          aria-hidden
          className={cn(
            "size-3 shrink-0",
            row.failed ? "text-destructive" : "text-muted-foreground",
          )}
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-[.7rem]",
            row.failed ? "text-destructive-foreground" : "text-foreground/90",
          )}
        >
          {row.summary}
        </span>
        {row.status === "inProgress" ? (
          <span className="shrink-0 text-[.65rem] text-muted-foreground">running</span>
        ) : null}
        {hasDetail ? (
          <ChevronRight
            aria-hidden
            className={cn("size-3 shrink-0 text-muted-foreground/70", open && "rotate-90")}
          />
        ) : null}
      </button>
      {open ? (
        <div className="border-t border-border/40 px-2 py-1.5">
          {input !== null ? (
            <pre className="whitespace-pre-wrap break-words font-mono text-[.7rem] leading-relaxed text-foreground/80 select-text">
              {input}
            </pre>
          ) : null}
          {result !== null ? (
            <pre
              className={cn(
                "mt-1.5 max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-[.7rem] leading-relaxed select-text",
                row.failed ? "text-destructive-foreground" : "text-muted-foreground",
              )}
            >
              {result}
            </pre>
          ) : null}
          {row.fileChanges ? (
            <DiffWordWrapToggle wordWrap={wordWrap} onToggle={setWordWrap} />
          ) : null}
          <ToolFileChangesList row={row} chrome={chrome} wordWrap={wordWrap} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Thinking, kept visually distinct. The main timeline has no reasoning
 * treatment to borrow — its only "thinking" tone is subagent task progress —
 * so this is a purpose-built quiet block rather than a reused component.
 */
function ReasoningTranscriptRow({ row }: { row: AgentTranscriptRow }) {
  if (!row.text) return null;
  return (
    <div className="border-l-2 border-border/60 pl-2">
      <div className="flex items-center gap-1.5 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground/70">
        <Brain aria-hidden className="size-3" />
        Thinking
      </div>
      <p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground select-text">
        {row.text}
      </p>
    </div>
  );
}

function MessageTranscriptRow({
  row,
  chrome,
}: {
  row: AgentTranscriptRow;
  chrome: TranscriptChrome;
}) {
  if (!row.text) return null;
  const isPrompt = row.kind === "user_message";
  return (
    <div
      className={cn(
        isPrompt && "rounded-md border border-border/50 bg-muted/40 px-2 py-1.5",
        !isPrompt && "text-sm",
      )}
    >
      {isPrompt ? (
        <div className="mb-1 flex items-center gap-1.5 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground/70">
          <MessageSquare aria-hidden className="size-3" />
          {row.label ?? "Prompt"}
        </div>
      ) : null}
      <ChatMarkdown text={row.text} cwd={chrome.markdownCwd} className="text-sm" />
    </div>
  );
}

function TranscriptRows({
  rows,
  chrome,
}: {
  rows: ReadonlyArray<AgentTranscriptRow>;
  chrome: TranscriptChrome;
}) {
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) =>
        row.kind === "tool" ? (
          <ToolTranscriptRow key={row.id} row={row} chrome={chrome} />
        ) : row.kind === "reasoning" ? (
          <ReasoningTranscriptRow key={row.id} row={row} />
        ) : (
          <MessageTranscriptRow key={row.id} row={row} chrome={chrome} />
        ),
      )}
    </div>
  );
}

function TranscriptNotice({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-1.5 px-1 text-[.7rem] text-muted-foreground">
      <AlertTriangle aria-hidden className="mt-0.5 size-3 shrink-0" />
      <span>{text}</span>
    </p>
  );
}

/**
 * Presentational transcript: header, launch prompt, rows, notices. Pure props
 * so the merge policy and its states can be asserted without a connection.
 */
export function AgentTranscriptView({
  agent,
  agentId,
  title,
  role,
  rows,
  launchPrompt,
  chrome,
  notices,
  truncated,
  loading,
  onBack,
  onLoadFullTranscript,
}: {
  agent: RuntimeSubagent | null;
  agentId: string;
  title: string;
  role: string | null;
  rows: ReadonlyArray<AgentTranscriptRow>;
  launchPrompt: string | null;
  chrome: TranscriptChrome;
  /**
   * Quiet advisories shown under the rows. Independent and can co-occur: a
   * recovery could both drop records and hit provider-encrypted thinking.
   */
  notices: ReadonlyArray<string>;
  truncated: boolean;
  loading: boolean;
  onBack: () => void;
  /**
   * Reads this agent's transcript from the provider's own record. Offered only
   * on the persisted path, where retention may have dropped older rows; the
   * recovery path has already read it.
   */
  onLoadFullTranscript?: (() => void) | undefined;
}) {
  const modelLabel = agent ? formatSubagentModelLabel(agent.model, agent.effort) : null;
  const metadata = [
    modelLabel,
    agent?.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : null,
  ].filter((value): value is string => value !== null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-col gap-0.5 border-b border-border/60 px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <Button
            size="icon-micro"
            variant="ghost-muted"
            onClick={onBack}
            aria-label="Back to agents"
          >
            <ArrowLeft aria-hidden className="size-3" />
          </Button>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
          {role ? (
            <span className="max-w-28 shrink-0 truncate rounded-sm border border-border/60 px-1 font-mono text-[.65rem] text-muted-foreground">
              {role}
            </span>
          ) : null}
        </div>
        {onLoadFullTranscript ? (
          <button
            type="button"
            onClick={onLoadFullTranscript}
            className="ml-7 w-fit cursor-pointer rounded-sm border border-border/60 px-1 font-mono text-[.65rem] text-muted-foreground hover:text-foreground"
          >
            Load full transcript
          </button>
        ) : null}
        <div className="truncate pl-7 font-mono text-[.7rem] tabular-nums text-muted-foreground/70">
          {[agent ? agent.status : "unknown", ...metadata].join(" · ")}
        </div>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-2">
          {launchPrompt ? (
            <MessageTranscriptRow
              row={{
                id: `${agentId}:launch-prompt`,
                createdAt: null,
                kind: "user_message",
                summary: "Prompt",
                text: launchPrompt,
              }}
              chrome={chrome}
            />
          ) : null}
          <TranscriptRows rows={rows} chrome={chrome} />
          {loading ? (
            <p className="px-1 text-xs text-muted-foreground">Loading transcript…</p>
          ) : null}
          {notices.map((text) => (
            <TranscriptNotice key={text} text={text} />
          ))}
          {truncated ? (
            <TranscriptNotice text="This transcript was too long to load in full; the start is shown." />
          ) : null}
          {rows.length === 0 && launchPrompt === null && !loading && notices.length === 0 ? (
            <p className="px-1 text-xs text-muted-foreground">
              No recorded activity for this subagent.
            </p>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}

/**
 * Fetches the on-disk transcript for an agent whose narration was never
 * persisted. Mounted only when the merge policy asks for it, so opening a
 * modern agent's transcript costs no request at all.
 */
function DiskTranscript({
  environmentId,
  threadId,
  agentId,
  agent,
  title,
  role,
  fallbackRows,
  launchPrompt,
  chrome,
  onBack,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  agentId: string;
  agent: RuntimeSubagent | null;
  title: string;
  role: string | null;
  fallbackRows: ReadonlyArray<AgentTranscriptRow>;
  launchPrompt: string | null;
  chrome: TranscriptChrome;
  onBack: () => void;
}) {
  const result = useAtomValue(
    orchestrationEnvironment.subagentTranscript({
      environmentId,
      input: { threadId, agentId },
    }),
  );

  if (result._tag === "Success") {
    const rows = diskTranscriptRows(result.value.entries);
    // The recovered transcript opens with the launch prompt as its first user
    // record, so the roster's copy would be the same text twice.
    const promptFromDisk = rows[0]?.kind === "user_message";
    return (
      <AgentTranscriptView
        agent={agent}
        agentId={agentId}
        title={title}
        role={role ?? result.value.agentType ?? null}
        rows={rows}
        launchPrompt={promptFromDisk ? null : launchPrompt}
        chrome={chrome}
        notices={[
          transcriptRecoveryLossNotice(result.value),
          transcriptRedactedThinkingNotice({
            redactedThinking: result.value.redactedThinking,
            reasoningRowCount: rows.filter((row) => row.kind === "reasoning").length,
          }),
        ].filter((text): text is string => text !== null)}
        truncated={result.value.truncated}
        loading={false}
        onBack={onBack}
      />
    );
  }

  if (result._tag === "Failure") {
    const failure = Cause.squash(result.cause);
    const reason =
      typeof failure === "object" && failure !== null && "reason" in failure
        ? String((failure as { reason: unknown }).reason)
        : undefined;
    return (
      <AgentTranscriptView
        agent={agent}
        agentId={agentId}
        title={title}
        role={role}
        rows={fallbackRows}
        launchPrompt={launchPrompt}
        chrome={chrome}
        notices={[transcriptUnavailableNotice(reason)]}
        truncated={false}
        loading={false}
        onBack={onBack}
      />
    );
  }

  return (
    <AgentTranscriptView
      agent={agent}
      agentId={agentId}
      title={title}
      role={role}
      rows={fallbackRows}
      launchPrompt={launchPrompt}
      chrome={chrome}
      notices={EMPTY_NOTICES}
      truncated={false}
      loading
      onBack={onBack}
    />
  );
}

/**
 * Surface entry point. Persisted rows come from the thread activities the
 * client already holds, so a live agent's transcript updates through the
 * ordinary activity stream with no polling and no refetch.
 */
export function AgentTranscriptPanel({
  environmentId,
  threadId,
  agentId,
  agent,
  activities,
  activitiesHydrated,
  markdownCwd,
  workspaceRoot,
  resolvedTheme,
  onBack,
}: {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  agentId: string;
  agent: RuntimeSubagent | null;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  /**
   * False while the thread's detail is still loading. Its activities are an
   * empty array until then, which would read as "this agent has no persisted
   * narration" and fire a disk read whose result is thrown away a moment
   * later. Wait for the real answer instead.
   */
  activitiesHydrated: boolean;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
  resolvedTheme: "light" | "dark";
  onBack: () => void;
}) {
  const [forceDiskRead, setForceDiskRead] = useState(false);
  const agentSettled = agent !== null && isTerminalSubagentStatus(agent.status);
  const persisted = useMemo(
    () => agentPersistedTranscript(activities, agentId, { agentSettled }),
    [activities, agentId, agentSettled],
  );
  const chrome = useMemo<TranscriptChrome>(
    () => ({ markdownCwd, workspaceRoot, resolvedTheme }),
    [markdownCwd, workspaceRoot, resolvedTheme],
  );

  const title = agent?.title ?? agentId;
  const role = agent?.role ?? null;
  const launchPrompt = agent?.prompt ?? null;

  const canReadDisk = environmentId !== null && threadId !== null;
  const autoReadDisk = activitiesHydrated && resolveAgentTranscriptSource(persisted) === "disk";
  if ((forceDiskRead || autoReadDisk) && canReadDisk) {
    return (
      <DiskTranscript
        environmentId={environmentId}
        threadId={threadId}
        agentId={agentId}
        agent={agent}
        title={title}
        role={role}
        fallbackRows={persisted.rows}
        launchPrompt={launchPrompt}
        chrome={chrome}
        onBack={onBack}
      />
    );
  }

  return (
    <AgentTranscriptView
      agent={agent}
      agentId={agentId}
      title={title}
      role={role}
      rows={persisted.rows}
      launchPrompt={launchPrompt}
      chrome={chrome}
      notices={EMPTY_NOTICES}
      truncated={false}
      loading={!activitiesHydrated}
      onBack={onBack}
      {...(canReadDisk && activitiesHydrated
        ? { onLoadFullTranscript: () => setForceDiskRead(true) }
        : {})}
    />
  );
}
