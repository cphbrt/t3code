/**
 * Artifacts right-panel surface: the files agents made for the user, recorded
 * against this thread. Only the path is recorded; the file itself stays where
 * the agent wrote it and is opened from this machine when the user asks.
 *
 * Presentation rules (from the feature design):
 * - Nothing here opens itself. A row opens only when the user activates it.
 * - Order is chronological and nothing else. Starring highlights in place and
 *   must never reorder the list; the sort toggle is the only reordering input.
 * - A failed open ("the file is gone") stays on its own row rather than in a
 *   toast the user can miss.
 * - Static rows: relative times are computed at render, never on a ticking
 *   timer, so a quiet panel costs nothing to keep open.
 * - An artifact's path is on the environment host, so opening it is only
 *   possible from a desktop client running on that same machine. When it is
 *   not, the list still renders in full and read/starred still work; only
 *   opening goes away, and the panel says why.
 */
import type { DesktopOpenPathOutcome, OrchestrationThreadArtifact } from "@t3tools/contracts";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Inbox, Star } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

export type ArtifactSortOrder = "newest" | "oldest";

/**
 * Whether this client can open the artifact files at all.
 *
 * - `openable`: a desktop client on the same machine as the environment.
 * - `needs-desktop-app`: the environment is this machine, but the client is a
 *   plain browser, which cannot open a file on it.
 * - `remote-environment`: the environment is another machine entirely.
 *
 * The caller resolves this; `remote-environment` wins when both apply, since
 * it is the blocker the desktop app would not lift.
 */
export type ArtifactReachability = "openable" | "needs-desktop-app" | "remote-environment";

/**
 * Deliberately stricter than "is this environment local". A desktop-local
 * secondary — the parallel WSL backend, whose connection id starts with
 * `local:` — is the same physical machine but a different filesystem
 * namespace, so an absolute path inside it is not one this host can open.
 * Requiring the primary target also closes the CLI-served case, where
 * "primary" means the origin that served the page rather than this hardware:
 * the desktop app's primary backend is one it spawned itself.
 */
export function resolveArtifactReachability(input: {
  readonly isDesktopClient: boolean;
  readonly isPrimaryEnvironment: boolean;
}): ArtifactReachability {
  if (!input.isDesktopClient) return "needs-desktop-app";
  return input.isPrimaryEnvironment ? "openable" : "remote-environment";
}

/**
 * Row-level failure copy. "The file is gone" is its own sentence because it is
 * the one the user can act on — the agent wrote something into a place that no
 * longer holds it — and it must not read like a launcher problem.
 */
export function artifactOpenFailureMessage(outcome: DesktopOpenPathOutcome): string | null {
  switch (outcome) {
    case "opened":
      return null;
    case "missing":
      return "That file is no longer on disk.";
    case "invalid-path":
      return "That file was recorded with a path this machine cannot open.";
    case "launch-failed":
      return "Nothing on this machine would open that file.";
    case "unsupported-platform":
      return "This machine cannot open files from here.";
  }
}

const UNREACHABLE_NOTICE: Record<Exclude<ArtifactReachability, "openable">, string> = {
  "needs-desktop-app":
    "These files are on this machine, but a browser tab cannot open them. Use the desktop app to open them.",
  "remote-environment":
    "These files are on the machine running this thread. Opening artifacts from a remote environment is not supported yet.",
};

function recordedAtMs(artifact: OrchestrationThreadArtifact): number {
  const parsed = Date.parse(artifact.recordedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Chronological order, and only chronological order. Sort is stable, so
 * artifacts recorded in the same millisecond keep their recorded order and a
 * star or a read toggle can never move a row.
 */
export function sortArtifacts(
  artifacts: readonly OrchestrationThreadArtifact[],
  order: ArtifactSortOrder,
): OrchestrationThreadArtifact[] {
  const direction = order === "newest" ? -1 : 1;
  return [...artifacts].sort(
    (left, right) => direction * (recordedAtMs(left) - recordedAtMs(right)),
  );
}

/** Last path separator index, tolerating Windows-shaped paths. */
function lastSeparatorIndex(path: string): number {
  return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
}

/**
 * Splits an absolute artifact path into the parts the row renders: the file
 * name on its own, and the parent directory pre-split into a head that may be
 * clipped and a tail that must survive, so the dimmed line middle-truncates
 * with CSS instead of a character budget that ignores the panel's width.
 */
export function splitArtifactPath(path: string): {
  fileName: string;
  parentDir: string;
  parentHead: string;
  parentTail: string;
} {
  const separator = lastSeparatorIndex(path);
  const fileName = separator < 0 ? path : path.slice(separator + 1);
  const parentDir = separator < 0 ? "" : path.slice(0, separator) || path.slice(0, 1);
  const parentSeparator = lastSeparatorIndex(parentDir);
  return parentSeparator < 0
    ? { fileName, parentDir, parentHead: "", parentTail: parentDir }
    : {
        fileName,
        parentDir,
        parentHead: parentDir.slice(0, parentSeparator),
        parentTail: parentDir.slice(parentSeparator),
      };
}

/** Dimmed parent directory: the head clips, the last segment always shows. */
function ArtifactParentPath({ path }: { path: string }) {
  const { parentDir, parentHead, parentTail } = splitArtifactPath(path);
  if (parentDir.length === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="flex min-w-0 items-baseline text-muted-foreground/70" />}
      >
        <span className="truncate">{parentHead}</span>
        <span className="shrink-0">{parentTail}</span>
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-sm break-all font-mono">
        {path}
      </TooltipPopup>
    </Tooltip>
  );
}

function ArtifactRow({
  artifact,
  openError,
  onOpen,
  onSetRead,
  onSetStarred,
}: {
  artifact: OrchestrationThreadArtifact;
  openError: string | null;
  /** Absent when this client cannot reach the file; the row still renders. */
  onOpen: ((artifact: OrchestrationThreadArtifact) => void) | null;
  onSetRead: (artifactId: string, read: boolean) => void;
  onSetStarred: (artifactId: string, starred: boolean) => void;
}) {
  const { fileName } = splitArtifactPath(artifact.path);
  const unread = artifact.readAt === null;
  const starred = artifact.starredAt !== null;
  // One shared subtree either way: an unreachable file still shows everything
  // about itself, it just is not activatable.
  const identity = (
    <>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate text-sm", unread ? "font-medium" : "font-normal")}>
          {fileName}
        </span>
        <span className="flex min-w-0 text-xs">
          <ArtifactParentPath path={artifact.path} />
        </span>
      </span>
      <span className="shrink-0 font-mono text-[.7rem] text-muted-foreground/80">
        {formatRelativeTimeLabel(artifact.recordedAt)}
      </span>
    </>
  );
  const identityClass = "flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1.5 text-left";
  return (
    <div
      className={cn("rounded-md", starred && "bg-amber-500/8 inset-ring-1 inset-ring-amber-500/20")}
    >
      <div
        className={cn(
          "flex items-center gap-1 rounded-md px-1",
          onOpen ? "hover:bg-accent/40" : null,
        )}
      >
        {onOpen ? (
          <button
            type="button"
            onClick={() => onOpen(artifact)}
            className={cn(identityClass, "cursor-pointer")}
          >
            {identity}
          </button>
        ) : (
          <div className={identityClass}>{identity}</div>
        )}
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={() => onSetRead(artifact.id, unread)}
          aria-label={unread ? `Mark ${fileName} as read` : `Mark ${fileName} as unread`}
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full",
              unread ? "bg-info" : "border border-muted-foreground/50",
            )}
          />
        </Button>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={() => onSetStarred(artifact.id, !starred)}
          aria-label={starred ? `Unstar ${fileName}` : `Star ${fileName}`}
        >
          <Star aria-hidden className={cn("size-3", starred && "fill-amber-500 text-amber-500")} />
        </Button>
      </div>
      {openError ? (
        <p className="px-2 pb-1.5 text-xs text-destructive-foreground">{openError}</p>
      ) : null}
    </div>
  );
}

export function ArtifactsPanel({
  artifacts,
  reachability,
  openErrorsByArtifactId,
  onOpen,
  onSetRead,
  onSetStarred,
}: {
  artifacts: readonly OrchestrationThreadArtifact[];
  /** Resolved by the caller; see {@link ArtifactReachability}. */
  reachability: ArtifactReachability;
  /**
   * Per-row failure text keyed by artifact id, owned by the caller that
   * attempts the open. Rows show it inline and keep showing it, because a
   * missing file is a fact about the artifact, not a transient event.
   */
  openErrorsByArtifactId?: Readonly<Record<string, string>>;
  /**
   * Opens the artifact. Ignored unless `reachability` is `openable`. The
   * caller is also what marks it read, so it can decide what a failed open
   * should leave behind.
   */
  onOpen: (artifact: OrchestrationThreadArtifact) => void;
  /** Manual read toggle from the row's unread dot. */
  onSetRead: (artifactId: string, read: boolean) => void;
  onSetStarred: (artifactId: string, starred: boolean) => void;
}) {
  const [order, setOrder] = useState<ArtifactSortOrder>("newest");
  const sorted = useMemo(() => sortArtifacts(artifacts, order), [artifacts, order]);

  if (artifacts.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Inbox aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">Nothing here yet</p>
        <p className="max-w-56 text-xs text-muted-foreground">
          When an agent makes something for you — a document, an image, a recording — it shows up
          here and waits until you open it.
        </p>
      </div>
    );
  }

  const unreadCount = artifacts.reduce(
    (count, artifact) => (artifact.readAt === null ? count + 1 : count),
    0,
  );
  const newestFirst = order === "newest";
  const unreachableNotice = reachability === "openable" ? null : UNREACHABLE_NOTICE[reachability];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 font-mono text-[.7rem] text-muted-foreground">
        <span className="tabular-nums">
          {artifacts.length} {artifacts.length === 1 ? "artifact" : "artifacts"}
        </span>
        {unreadCount > 0 ? (
          <span className="tabular-nums text-info-foreground">{unreadCount} unread</span>
        ) : null}
        <Button
          size="icon-micro"
          variant="ghost-muted"
          className="ml-auto"
          onClick={() => setOrder(newestFirst ? "oldest" : "newest")}
          aria-label={newestFirst ? "Sort oldest first" : "Sort newest first"}
        >
          {newestFirst ? (
            <ArrowDownWideNarrow aria-hidden className="size-3" />
          ) : (
            <ArrowUpNarrowWide aria-hidden className="size-3" />
          )}
        </Button>
      </header>
      {unreachableNotice ? (
        <p className="border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
          {unreachableNotice}
        </p>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5 p-2">
          {sorted.map((artifact) => (
            <ArtifactRow
              key={artifact.id}
              artifact={artifact}
              openError={openErrorsByArtifactId?.[artifact.id] ?? null}
              onOpen={reachability === "openable" ? onOpen : null}
              onSetRead={onSetRead}
              onSetStarred={onSetStarred}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
