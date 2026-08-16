import { memo, type PointerEventHandler } from "react";
import { MicIcon, MicOffIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { DictationState } from "~/hooks/useDictation";

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

/** mm:ss for the recording timer; utterances run to minutes at most. */
export function formatDictationElapsed(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function dictationButtonLabel(state: DictationState): string {
  switch (state.status) {
    case "recording":
      return "Stop recording and transcribe";
    case "transcribing":
      return "Transcribing";
    case "idle":
      return state.availability?.available === true
        ? "Dictate"
        : (state.availability?.note ?? "Dictation is not configured");
  }
}

/**
 * Mic toggle for local dictation. Rendered only where the desktop dictation
 * bridge exists; the caller owns that check.
 */
export const ComposerDictationButton = memo(function ComposerDictationButton({
  state,
  disabled,
  preserveComposerFocusOnPointerDown = false,
  onToggle,
}: {
  state: DictationState;
  disabled: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  onToggle: () => void;
}) {
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined;
  const unavailable = state.availability?.available !== true;
  const label = dictationButtonLabel(state);
  const isRecording = state.status === "recording";
  const isTranscribing = state.status === "transcribing";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-chat-composer-dictation={state.status}
            className={cn(
              "flex shrink-0 items-center justify-center gap-1.5 rounded-full transition-colors duration-150 enabled:cursor-pointer disabled:pointer-events-none disabled:opacity-30",
              isRecording
                ? "h-9 bg-destructive/90 px-2.5 text-white sm:h-8"
                : "size-9 text-secondary-label hover:bg-foreground/8 hover:text-foreground sm:size-8",
            )}
            {...pointerFocusProps}
            disabled={disabled || unavailable || isTranscribing}
            aria-label={label}
            aria-pressed={isRecording}
            onClick={onToggle}
          >
            {isTranscribing ? (
              <Spinner className="size-4" aria-hidden="true" />
            ) : unavailable ? (
              <MicOffIcon className="size-4" aria-hidden="true" />
            ) : (
              <MicIcon
                // The shared status pulse: opacity only, and stepped rather
                // than continuous, so a recording indicator that sits on
                // screen for minutes does not repaint every frame.
                className={cn("size-4", isRecording && "animate-status-pulse")}
                aria-hidden="true"
              />
            )}
            {isRecording ? (
              <span className="text-xs font-medium tabular-nums">
                {formatDictationElapsed(state.elapsedSeconds)}
              </span>
            ) : null}
          </button>
        }
      />
      <TooltipPopup side="top">
        {isRecording ? "Stop and transcribe · Esc to cancel" : label}
      </TooltipPopup>
    </Tooltip>
  );
});
