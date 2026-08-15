import { describe, expect, it } from "vite-plus/test";

import { inAppShortcutForEvent, markInAppShortcut } from "./inAppActionSignals";

describe("in-app shortcut signals", () => {
  it("retains only the semantic action attached to a particular event", () => {
    const event = {};
    const otherEvent = {};

    markInAppShortcut(event, { action: "terminal.toggle", shortcut: "⌘J" });

    expect(inAppShortcutForEvent(event)).toEqual({
      action: "terminal.toggle",
      shortcut: "⌘J",
    });
    expect(inAppShortcutForEvent(otherEvent)).toBeNull();
  });
});
