import { create } from "zustand";

import {
  clearReadingFocusThread,
  enableReadingFocusThread,
  toggleReadingFocusThread,
} from "../ChatView.logic";
import type { TimelineReadingAnchor } from "./MessagesTimeline.logic";

interface ChatSessionUiState {
  readonly readingFocusThreadKeys: ReadonlySet<string>;
  readonly timelineReadingAnchorByThreadKey: Readonly<Record<string, TimelineReadingAnchor>>;
  readonly toggleReadingFocus: (threadKey: string) => void;
  readonly enableReadingFocus: (threadKey: string) => void;
  readonly clearReadingFocus: (threadKey: string) => void;
  readonly setTimelineReadingAnchor: (
    threadKey: string,
    anchor: TimelineReadingAnchor | null,
  ) => void;
}

export const useChatSessionUiStore = create<ChatSessionUiState>((set) => ({
  readingFocusThreadKeys: new Set(),
  timelineReadingAnchorByThreadKey: {},
  toggleReadingFocus: (threadKey) =>
    set((state) => ({
      readingFocusThreadKeys: toggleReadingFocusThread(state.readingFocusThreadKeys, threadKey),
    })),
  enableReadingFocus: (threadKey) =>
    set((state) => ({
      readingFocusThreadKeys: enableReadingFocusThread(state.readingFocusThreadKeys, threadKey),
    })),
  clearReadingFocus: (threadKey) =>
    set((state) => ({
      readingFocusThreadKeys: clearReadingFocusThread(state.readingFocusThreadKeys, threadKey),
    })),
  setTimelineReadingAnchor: (threadKey, anchor) =>
    set((state) => {
      const current = state.timelineReadingAnchorByThreadKey[threadKey];
      if (
        (anchor === null && current === undefined) ||
        (anchor !== null &&
          current?.rowId === anchor.rowId &&
          current.viewOffset === anchor.viewOffset)
      ) {
        return state;
      }
      const next = { ...state.timelineReadingAnchorByThreadKey };
      if (anchor === null) {
        delete next[threadKey];
      } else {
        next[threadKey] = anchor;
      }
      return { timelineReadingAnchorByThreadKey: next };
    }),
}));
