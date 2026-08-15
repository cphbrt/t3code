import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useChatSessionUiStore } from "./chatSessionUiStore";

describe("chat session UI state", () => {
  beforeEach(() => {
    useChatSessionUiStore.setState({
      readingFocusThreadKeys: new Set(),
      timelineReadingAnchorByThreadKey: {},
    });
  });

  it("keeps reading focus across component lifetimes", () => {
    useChatSessionUiStore.getState().enableReadingFocus("thread-a");

    expect(useChatSessionUiStore.getState().readingFocusThreadKeys.has("thread-a")).toBe(true);

    useChatSessionUiStore.getState().clearReadingFocus("thread-a");
    expect(useChatSessionUiStore.getState().readingFocusThreadKeys.has("thread-a")).toBe(false);
  });

  it("keeps and clears independent semantic reading positions by thread", () => {
    useChatSessionUiStore
      .getState()
      .setTimelineReadingAnchor("thread-a", { rowId: "message-a", viewOffset: -320 });
    useChatSessionUiStore
      .getState()
      .setTimelineReadingAnchor("thread-b", { rowId: "message-b", viewOffset: 24 });

    expect(useChatSessionUiStore.getState().timelineReadingAnchorByThreadKey).toEqual({
      "thread-a": { rowId: "message-a", viewOffset: -320 },
      "thread-b": { rowId: "message-b", viewOffset: 24 },
    });

    useChatSessionUiStore.getState().setTimelineReadingAnchor("thread-a", null);
    expect(useChatSessionUiStore.getState().timelineReadingAnchorByThreadKey).toEqual({
      "thread-b": { rowId: "message-b", viewOffset: 24 },
    });
  });
});
