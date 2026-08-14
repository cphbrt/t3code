import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PanelLayoutControls } from "./PanelLayoutControls";

describe("PanelLayoutControls", () => {
  it("keeps unavailable panel tooltip triggers interactive", () => {
    const markup = renderToStaticMarkup(
      <PanelLayoutControls
        showTerminalControl
        terminalAvailable={false}
        terminalOpen={false}
        terminalShortcutLabel={null}
        rightPanelAvailable={false}
        rightPanelOpen={false}
        rightPanelShortcutLabel={null}
        liveAgentCount={0}
        onToggleTerminal={() => {}}
        onToggleRightPanel={() => {}}
      />,
    );

    expect(markup.match(/data-slot="tooltip-trigger"/g)).toHaveLength(2);
    expect(markup.match(/data-slot="tooltip-trigger"[^>]*><button[^>]*disabled=""/g)).toHaveLength(
      2,
    );
  });
});

function renderControls(readingFocus: boolean, readingFocusAvailable = true): string {
  return renderToStaticMarkup(
    <PanelLayoutControls
      readingFocusAvailable={readingFocusAvailable}
      readingFocus={readingFocus}
      readingFocusShortcutLabel="⌘⌥R"
      terminalAvailable
      terminalOpen={false}
      terminalShortcutLabel="⌘J"
      rightPanelAvailable
      rightPanelOpen={false}
      rightPanelShortcutLabel="⌘⌥B"
      liveAgentCount={0}
      onToggleReadingFocus={() => {}}
      onToggleTerminal={() => {}}
      onToggleRightPanel={() => {}}
    />,
  );
}

describe("PanelLayoutControls reading focus", () => {
  it("renders the transcript focus action before the panel toggles", () => {
    const markup = renderControls(false);

    expect(markup).toContain('data-chat-reading-focus-toggle="true"');
    expect(markup).toContain('aria-label="Focus on transcript"');
    expect(markup.indexOf("Focus on transcript")).toBeLessThan(
      markup.indexOf("Toggle terminal drawer"),
    );
  });

  it("exposes the reverse action while reading focus is active", () => {
    const markup = renderControls(true);

    expect(markup).toContain('aria-label="Show composer"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("data-pressed");
  });

  it("disables reading focus before the thread has messages", () => {
    const markup = renderControls(false, false);

    expect(markup).toContain("disabled");
  });
});
