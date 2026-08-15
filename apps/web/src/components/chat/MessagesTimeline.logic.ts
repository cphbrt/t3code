import * as Equal from "effect/Equal";
import {
  workEntryIndicatesToolNeutralStatus,
  workLogEntryIsCommand,
  type TimelineEntry,
  type TurnPlanEntry,
  type WorkLogEntry,
} from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { type MessageId, type OrchestrationLatestTurn, type TurnId } from "@t3tools/contracts";

export const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
// Container-relative so the rail shrinks with the timeline pane (e.g. when the
// terminal drawer is open) instead of sizing to the window and spilling over
// siblings. The 9rem reserve keeps the step buttons, which extend ~4rem past
// each rail end, inside the pane.
export const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100% - 9rem)";
export const TIMELINE_CONTENT_MAX_WIDTH = 768;
export const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;

export interface TimelineScrollGeometry {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export interface TimelineScrollTarget extends TimelineScrollGeometry {
  scrollTo(options: { top: number }): void;
}

export interface TimelineReadingAnchor {
  readonly rowId: string;
  /** The row's top edge relative to the viewport's top edge. */
  readonly viewOffset: number;
}

export interface TimelineRenderedRowGeometry {
  readonly rowId: string;
  readonly top: number;
  readonly bottom: number;
}

/** Capture the first visible semantic row instead of a layout-dependent scrollTop. */
export function resolveTimelineReadingAnchor(
  rows: ReadonlyArray<TimelineRenderedRowGeometry>,
  viewport: { readonly top: number; readonly bottom: number },
): TimelineReadingAnchor | null {
  if (![viewport.top, viewport.bottom].every(Number.isFinite)) {
    return null;
  }
  for (const row of rows) {
    if (![row.top, row.bottom].every(Number.isFinite)) {
      continue;
    }
    if (row.bottom <= viewport.top || row.top >= viewport.bottom) {
      continue;
    }
    return { rowId: row.rowId, viewOffset: row.top - viewport.top };
  }
  return null;
}

export function resolveTimelineReadingAnchorScrollTop(input: {
  readonly scrollTop: number;
  readonly viewportTop: number;
  readonly rowTop: number;
  readonly viewOffset: number;
}): number | null {
  if (!Object.values(input).every(Number.isFinite)) {
    return null;
  }
  return input.scrollTop + input.rowTop - input.viewportTop - input.viewOffset;
}

export function resolveTimelineInitialScrollIndex(
  rows: ReadonlyArray<{ readonly id: string }>,
  anchor: TimelineReadingAnchor | null,
): { readonly index: number; readonly viewOffset: number } | null {
  if (!anchor || !Number.isFinite(anchor.viewOffset)) {
    return null;
  }
  const index = rows.findIndex((row) => row.id === anchor.rowId);
  return index === -1 ? null : { index, viewOffset: anchor.viewOffset };
}

export const TIMELINE_END_EPSILON_PX = 1;

export function resolveTimelineIsAtEnd(
  geometry: TimelineScrollGeometry | undefined,
): boolean | undefined {
  if (!geometry) {
    return undefined;
  }
  const { scrollTop, scrollHeight, clientHeight } = geometry;
  if (![scrollTop, scrollHeight, clientHeight].every(Number.isFinite)) {
    return undefined;
  }
  return scrollHeight - clientHeight - scrollTop <= TIMELINE_END_EPSILON_PX;
}

export function reconcileTimelineScrollToEnd(target: TimelineScrollTarget | undefined): boolean {
  if (!target || resolveTimelineIsAtEnd(target) !== false) {
    return false;
  }
  target.scrollTo({ top: target.scrollHeight });
  return true;
}

export function shouldPreserveAssistantLineBreaks(text: string): boolean {
  return /^★ Insight(?:\s|─)/mu.test(text);
}

export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * TIMELINE_MINIMAP_ITEM_SPACING);
  // The rail never becomes its own scroll surface. Percentage-positioned
  // landmarks compress inside this container cap as the conversation grows.
  return `min(${naturalHeight}px, ${TIMELINE_MINIMAP_MAX_HEIGHT_CSS})`;
}

export function resolveTimelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) {
    return 0;
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export interface TimelineMinimapTickMetrics {
  readonly width: number;
  readonly height: number;
  readonly offsetY: number;
}

/** Dock-style visual falloff around the tick nearest the pointer or keyboard focus. */
export function resolveTimelineMinimapTickMetrics(
  index: number,
  activeIndex: number | null,
): TimelineMinimapTickMetrics {
  if (activeIndex === null) {
    return { width: 8, height: 2, offsetY: 0 };
  }

  const delta = index - activeIndex;
  const direction = Math.sign(delta);
  switch (Math.abs(delta)) {
    case 0:
      return { width: 32, height: 5, offsetY: 0 };
    case 1:
      return { width: 24, height: 4, offsetY: direction * 6 };
    case 2:
      return { width: 18, height: 3, offsetY: direction * 10 };
    case 3:
      return { width: 12, height: 2, offsetY: direction * 12 };
    default:
      // Keep the far halves displaced instead of snapping them back into
      // place, which preserves landmark ordering around the magnified window.
      return { width: 8, height: 2, offsetY: direction * 12 };
  }
}

export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null;
  }
  if (input.itemCount === 1) {
    return 0;
  }

  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}

export function resolveTimelineMinimapHasPersistentGutter(viewportWidth: number): boolean {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return false;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return sideGutter >= TIMELINE_MINIMAP_PERSISTENT_GUTTER;
}

export const TIMELINE_MINIMAP_HIT_STRIP_LEFT = 12;
export const TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;
export const TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH = "22rem";

/**
 * The minimap overlays the viewport's left edge while the content column is
 * centered, so the side gutter between them shrinks under browser zoom or a
 * narrow pane. A fixed-width hover strip would then sit on top of the message
 * text and swallow its pointer events. Cap the strip's width so it never
 * extends past the gutter into the content column; 0 disables the strip.
 */
export function resolveTimelineMinimapHitStripWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return 0;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return Math.max(
    0,
    Math.min(
      TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH,
      Math.floor(sideGutter) - TIMELINE_MINIMAP_HIT_STRIP_LEFT,
    ),
  );
}

/**
 * Once the preview is open, keep the full preview and the space leading to it
 * interactive. The collapsed strip remains gutter-capped so it cannot block
 * selecting message text.
 */
export function resolveTimelineMinimapInteractiveWidth(
  collapsedWidth: number,
  expanded: boolean,
): number | string {
  return expanded ? TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH : collapsedWidth;
}

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  updatedAt: string;
  streaming: boolean;
}

export type TimelineLatestTurn = Pick<
  OrchestrationLatestTurn,
  "turnId" | "state" | "startedAt" | "completedAt"
> & { readonly assistantMessageId?: MessageId | null };

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showAssistantMeta: boolean;
      assistantCompletionLabel?: "Interrupted" | undefined;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      kind: "turn-plan";
      id: string;
      createdAt: string;
      turnPlan: TurnPlanEntry;
    }
  | { kind: "working"; id: string; createdAt: string | null };

export interface TimelineMinimapItem {
  readonly id: string;
  readonly rowIndex: number;
  readonly actor: "user" | "assistant";
  readonly previewText: string | null;
  readonly secondaryText: string | null;
}

function compactTimelineMinimapPreview(text: string | null | undefined) {
  const compact = text?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length > 0 ? compact : null;
}

function resolveFinalAssistantTextForTurn(
  rows: ReadonlyArray<MessagesTimelineRow>,
  userRowIndex: number,
) {
  let finalAssistantText: string | null = null;
  for (let index = userRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message") {
      continue;
    }
    if (row.message.role === "user") {
      break;
    }
    if (row.message.role === "assistant") {
      finalAssistantText = row.message.text ?? null;
    }
  }
  return finalAssistantText;
}

/**
 * The minimap navigates authored conversation messages, not activity chrome.
 * Tool rows, working indicators, and collapsed activity disclosures are omitted.
 */
export function deriveTimelineMinimapItems(
  rows: ReadonlyArray<MessagesTimelineRow>,
): TimelineMinimapItem[] {
  const items: TimelineMinimapItem[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message" || row.message.role === "system") {
      continue;
    }

    const actor = row.message.role;
    items.push({
      id: row.id,
      rowIndex: index,
      actor,
      previewText: compactTimelineMinimapPreview(row.message.text),
      secondaryText:
        actor === "user"
          ? compactTimelineMinimapPreview(resolveFinalAssistantTextForTurn(rows, index))
          : null,
    });
  }
  return items;
}

/** Avoid showing the rail for an ordinary one-prompt/one-response thread. */
export function shouldShowTimelineMinimap(items: ReadonlyArray<TimelineMinimapItem>): boolean {
  let userCount = 0;
  let assistantCount = 0;
  for (const item of items) {
    if (item.actor === "user") {
      userCount += 1;
    } else {
      assistantCount += 1;
    }
    if (userCount >= TIMELINE_MINIMAP_MIN_ITEMS || assistantCount >= TIMELINE_MINIMAP_MIN_ITEMS) {
      return true;
    }
  }
  return false;
}

export function resolveTimelineMinimapStepIndex(input: {
  readonly items: ReadonlyArray<TimelineMinimapItem>;
  readonly direction: "previous" | "next";
  readonly visibleStartRowIndex: number;
  readonly visibleEndRowIndex: number;
  readonly activeItemId?: string | null;
}): number | null {
  const { items, direction, visibleStartRowIndex, visibleEndRowIndex, activeItemId } = input;
  if (items.length === 0) {
    return null;
  }

  const activeItemIndex =
    activeItemId === null || activeItemId === undefined
      ? -1
      : items.findIndex((item) => item.id === activeItemId);
  if (activeItemIndex >= 0) {
    const targetIndex = direction === "previous" ? activeItemIndex - 1 : activeItemIndex + 1;
    return targetIndex >= 0 && targetIndex < items.length ? targetIndex : null;
  }

  const visibleItemIndexes = items.flatMap((item, index) =>
    item.rowIndex >= visibleStartRowIndex && item.rowIndex <= visibleEndRowIndex ? [index] : [],
  );
  const firstVisibleItemIndex = visibleItemIndexes[0];
  const lastVisibleItemIndex = visibleItemIndexes.at(-1);
  if (firstVisibleItemIndex !== undefined && lastVisibleItemIndex !== undefined) {
    const targetIndex =
      direction === "previous" ? firstVisibleItemIndex - 1 : lastVisibleItemIndex + 1;
    return targetIndex >= 0 && targetIndex < items.length ? targetIndex : null;
  }

  const nextItemIndex = items.findIndex((item) => item.rowIndex >= visibleStartRowIndex);
  if (direction === "next") {
    return nextItemIndex >= 0 ? nextItemIndex : null;
  }
  const previousItemIndex = (nextItemIndex >= 0 ? nextItemIndex : items.length) - 1;
  return previousItemIndex >= 0 ? previousItemIndex : null;
}

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && !message.streaming) {
      lastBoundary = message.updatedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  return {
    text: hasText ? text : null,
    visible: showCopyButton && hasText && !streaming,
  };
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

/**
 * The session's running turn is authoritative when latestTurn briefly lags or
 * regresses behind it. Otherwise, the latest turn counts as unsettled while it
 * is still running (or has not recorded a completion).
 */
function deriveUnsettledTurnId(
  latestTurn: TimelineLatestTurn | null,
  runningTurnId: TurnId | null,
): TurnId | null {
  if (runningTurnId !== null) {
    return runningTurnId;
  }
  if (!latestTurn) {
    return null;
  }
  const isSettled = latestTurn.completedAt !== null && latestTurn.state !== "running";
  return isSettled ? null : latestTurn.turnId;
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestTurn?: TimelineLatestTurn | null;
  runningTurnId?: TurnId | null;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(input.timelineEntries);
  const unsettledTurnId = deriveUnsettledTurnId(
    input.latestTurn ?? null,
    input.runningTurnId ?? null,
  );

  for (const timelineEntry of input.timelineEntries) {
    if (timelineEntry.kind === "work") {
      if (
        workLogEntryIsCommand(timelineEntry.entry) ||
        !workEntryIndicatesToolNeutralStatus(timelineEntry.entry)
      ) {
        nextRows.push({
          kind: "work",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          groupedEntries: [timelineEntry.entry],
        });
      }
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    if (timelineEntry.kind === "turn-plan") {
      nextRows.push({
        kind: "turn-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        turnPlan: timelineEntry.turnPlan,
      });
      continue;
    }

    const assistantTurnStillInProgress =
      timelineEntry.message.role === "assistant" &&
      unsettledTurnId !== null &&
      timelineEntry.message.turnId === unsettledTurnId;

    const durationStart =
      durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt;

    // While the turn is still running, the latest assistant message is only
    // provisionally terminal — withhold the metadata row until the turn
    // settles so commentary doesn't flash timestamps mid-work.
    const showAssistantMeta =
      timelineEntry.message.role === "assistant" &&
      terminalAssistantMessageIds.has(timelineEntry.message.id) &&
      !assistantTurnStillInProgress;
    const assistantWasInterrupted =
      showAssistantMeta &&
      input.latestTurn?.state === "interrupted" &&
      (timelineEntry.message.turnId === input.latestTurn.turnId ||
        timelineEntry.message.id === input.latestTurn.assistantMessageId);

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart,
      showAssistantMeta,
      ...(assistantWasInterrupted ? { assistantCompletionLabel: "Interrupted" as const } : {}),
      showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: timelineEntry.message.streaming || assistantTurnStillInProgress,
      assistantTurnDiffSummary:
        timelineEntry.message.role === "assistant"
          ? input.turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? input.revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
    });
  }

  if (input.isWorking) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
    });
  }

  return nextRows;
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working":
      return a.createdAt === (b as typeof a).createdAt;

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "turn-plan": {
      const bp = b as typeof a;
      // Plans rewrite in place: compare the snapshot's identity fields so an
      // unchanged plan keeps its row reference (virtualization stability).
      return a.createdAt === bp.createdAt && a.turnPlan.plan === bp.turnPlan.plan;
    }

    case "work":
      return Equal.equals(a.groupedEntries, (b as typeof a).groupedEntries);

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.durationStart === bm.durationStart &&
        a.showAssistantMeta === bm.showAssistantMeta &&
        a.assistantCompletionLabel === bm.assistantCompletionLabel &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }
  }
}
