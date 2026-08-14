import { create } from "zustand";

import {
  clearReadingFocusThread,
  enableReadingFocusThread,
  toggleReadingFocusThread,
} from "../ChatView.logic";

interface ChatSessionUiState {
  readonly readingFocusThreadKeys: ReadonlySet<string>;
  readonly toggleReadingFocus: (threadKey: string) => void;
  readonly enableReadingFocus: (threadKey: string) => void;
  readonly clearReadingFocus: (threadKey: string) => void;
}

export const useChatSessionUiStore = create<ChatSessionUiState>((set) => ({
  readingFocusThreadKeys: new Set(),
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
}));
