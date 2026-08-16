/**
 * Per-diff wrap control, shared by every surface that renders a diff inline
 * inside a denser reading column: the chat transcript's File change cell and
 * the subagent transcript's tool rows.
 *
 * Wrapping is scoped to the cell that owns it, so this deliberately does not
 * touch the global `wordWrap` client preference the diff panel and pull
 * request code tab read. That setting is a default for surfaces showing one
 * file at a time; a transcript interleaves prose edits that only read wrapped
 * with code edits that read best exactly as written, so binding them together
 * would make every fix for one a regression for the other.
 */
import { TextWrapIcon } from "lucide-react";

import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Maps a cell's wrap state onto the `@pierre/diffs` overflow option. */
export function diffOverflowMode(wordWrap: boolean): "wrap" | "scroll" {
  return wordWrap ? "wrap" : "scroll";
}

/**
 * Uses the same icon and ghost toggle the diff panel and pull request code tab
 * use for wrapping, sized down for denser transcript chrome.
 */
export function DiffWordWrapToggle({
  wordWrap,
  onToggle,
}: {
  wordWrap: boolean;
  onToggle: (pressed: boolean) => void;
}) {
  const label = wordWrap ? "Unwrap long lines" : "Wrap long lines";
  return (
    <div className="flex justify-end">
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              aria-label={label}
              variant="ghost"
              size="xs"
              className="-me-1"
              pressed={wordWrap}
              onPressedChange={(pressed) => {
                onToggle(Boolean(pressed));
              }}
            />
          }
        >
          <TextWrapIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </div>
  );
}
