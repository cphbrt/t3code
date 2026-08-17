import { describe, expect, it } from "vite-plus/test";

import {
  inAppShortcutForEvent,
  markInAppShortcut,
  reportInAppShortcut,
  setInAppShortcutReporter,
  type InAppShortcutReport,
} from "./inAppActionSignals";

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

describe("explicit shortcut reporting", () => {
  it("delivers reports to the installed sink", () => {
    const reports: InAppShortcutReport[] = [];
    const uninstall = setInAppShortcutReporter((report) => reports.push(report));

    reportInAppShortcut({ action: "chat.readingFocus.enable", shortcut: "Esc" });

    expect(reports).toEqual([{ action: "chat.readingFocus.enable", shortcut: "Esc" }]);
    uninstall();
  });

  it("drops reports when no sink is installed", () => {
    const reports: InAppShortcutReport[] = [];
    const uninstall = setInAppShortcutReporter((report) => reports.push(report));
    uninstall();

    reportInAppShortcut({ action: "chat.readingFocus.enable", shortcut: "Esc" });

    expect(reports).toEqual([]);
  });

  it("uninstalling a superseded sink leaves the current one installed", () => {
    const first: InAppShortcutReport[] = [];
    const second: InAppShortcutReport[] = [];
    const uninstallFirst = setInAppShortcutReporter((report) => first.push(report));
    const uninstallSecond = setInAppShortcutReporter((report) => second.push(report));

    uninstallFirst();
    reportInAppShortcut({ action: "chat.readingFocus.enable" });

    expect(first).toEqual([]);
    expect(second).toEqual([{ action: "chat.readingFocus.enable" }]);
    uninstallSecond();
  });
});
