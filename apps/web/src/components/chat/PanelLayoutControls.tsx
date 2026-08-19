import {
  BookOpenIcon,
  Maximize2Icon,
  Minimize2Icon,
  PanelBottomIcon,
  PanelRightIcon,
} from "lucide-react";
import { memo } from "react";

import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface PanelLayoutControlsProps {
  readingFocusAvailable?: boolean;
  readingFocus?: boolean;
  readingFocusShortcutLabel?: string | null;
  showTerminalControl?: boolean;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalShortcutLabel: string | null;
  rightPanelAvailable: boolean;
  rightPanelOpen: boolean;
  rightPanelShortcutLabel: string | null;
  /** Running + waiting subagents in this thread; badges the right panel toggle. */
  liveAgentCount: number;
  /**
   * Unread artifacts in this thread. Shares the right panel toggle's badge:
   * both mean "the right panel has something for you", and the badge is the
   * only way to see a new artifact while the panel is closed and the app is
   * focused (which suppresses the OS notification).
   */
  unreadArtifactCount: number;
  onToggleReadingFocus?: () => void;
  onToggleTerminal: () => void;
  onToggleRightPanel: () => void;
}

export const PanelLayoutControls = memo(function PanelLayoutControls({
  readingFocusAvailable = false,
  readingFocus = false,
  readingFocusShortcutLabel = null,
  showTerminalControl = true,
  terminalAvailable,
  terminalOpen,
  terminalShortcutLabel,
  rightPanelAvailable,
  rightPanelOpen,
  rightPanelShortcutLabel,
  liveAgentCount,
  unreadArtifactCount,
  onToggleReadingFocus,
  onToggleTerminal,
  onToggleRightPanel,
}: PanelLayoutControlsProps) {
  // One badge for the whole affordance: it counts everything in the right
  // panel wanting attention. The number alone cannot say which kind, so the
  // label and tooltip always enumerate the signals separately.
  const badgeCount = liveAgentCount + unreadArtifactCount;
  const badgeDetail = [
    liveAgentCount > 0
      ? `${liveAgentCount} ${liveAgentCount === 1 ? "agent" : "agents"} working`
      : null,
    unreadArtifactCount > 0
      ? `${unreadArtifactCount} new ${unreadArtifactCount === 1 ? "file" : "files"}`
      : null,
  ].filter((entry): entry is string => entry !== null);
  return (
    <div
      className="flex h-full shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
      data-panel-layout-controls
    >
      {onToggleReadingFocus ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0 [-webkit-app-region:no-drag]"
                pressed={readingFocus}
                onPressedChange={onToggleReadingFocus}
                aria-label={readingFocus ? "Show composer" : "Focus on transcript"}
                variant="ghost"
                size="sm"
                disabled={!readingFocusAvailable}
                data-chat-reading-focus-toggle
                data-app-action="chat.readingFocus.toggle"
              >
                <BookOpenIcon className="size-3.5" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {readingFocusAvailable
              ? `${readingFocus ? "Show composer" : "Focus on transcript"}${
                  readingFocusShortcutLabel ? ` (${readingFocusShortcutLabel})` : ""
                }`
              : "Reading focus is available after the thread has messages"}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {showTerminalControl ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0 [-webkit-app-region:no-drag]"
                pressed={terminalOpen}
                onPressedChange={onToggleTerminal}
                aria-label="Toggle terminal drawer"
                variant="ghost"
                size="sm"
                disabled={!terminalAvailable}
                data-app-action="terminal.toggle"
              >
                <PanelBottomIcon className="size-4" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {terminalAvailable
              ? `Toggle terminal drawer${terminalShortcutLabel ? ` (${terminalShortcutLabel})` : ""}`
              : "Terminal drawer is unavailable"}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              className="shrink-0 [-webkit-app-region:no-drag]"
              pressed={rightPanelOpen}
              onPressedChange={onToggleRightPanel}
              aria-label={
                badgeDetail.length > 0
                  ? `Toggle right panel, ${badgeDetail.join(", ")}`
                  : "Toggle right panel"
              }
              variant="ghost"
              size="sm"
              disabled={!rightPanelAvailable}
              data-app-action="rightPanel.toggle"
            >
              <PanelRightIcon className="size-4" />
              {badgeCount > 0 ? (
                <span
                  aria-hidden
                  className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-[9px] font-semibold tabular-nums text-white"
                >
                  {badgeCount}
                </span>
              ) : null}
            </Toggle>
          }
        />
        <TooltipPopup side="bottom">
          {rightPanelAvailable
            ? `Toggle right panel${rightPanelShortcutLabel ? ` (${rightPanelShortcutLabel})` : ""}${
                badgeDetail.length > 0 ? ` · ${badgeDetail.join(" · ")}` : ""
              }`
            : "Right panel is unavailable"}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
});

export const RightPanelMaximizeControl = memo(function RightPanelMaximizeControl({
  maximized,
  onToggle,
}: {
  maximized: boolean;
  onToggle: () => void;
}) {
  const label = maximized ? "Restore panel size" : "Maximize panel";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={maximized}
            onPressedChange={onToggle}
            aria-label={label}
            variant="ghost"
            size="sm"
          >
            {maximized ? (
              <Minimize2Icon className="size-4" />
            ) : (
              <Maximize2Icon className="size-4" />
            )}
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
});
