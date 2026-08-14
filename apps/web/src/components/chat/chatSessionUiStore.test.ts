import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useChatSessionUiStore } from "./chatSessionUiStore";

describe("chat session UI state", () => {
  beforeEach(() => {
    useChatSessionUiStore.setState({ readingFocusThreadKeys: new Set() });
  });

  it("keeps reading focus across component lifetimes", () => {
    useChatSessionUiStore.getState().enableReadingFocus("thread-a");

    expect(useChatSessionUiStore.getState().readingFocusThreadKeys.has("thread-a")).toBe(true);

    useChatSessionUiStore.getState().clearReadingFocus("thread-a");
    expect(useChatSessionUiStore.getState().readingFocusThreadKeys.has("thread-a")).toBe(false);
  });
});
