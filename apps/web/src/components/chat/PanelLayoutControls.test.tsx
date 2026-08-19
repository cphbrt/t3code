import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PanelLayoutControls } from "./PanelLayoutControls";

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
      unreadArtifactCount={0}
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

function renderBadge(liveAgentCount: number, unreadArtifactCount: number): string {
  return renderToStaticMarkup(
    <PanelLayoutControls
      terminalAvailable
      terminalOpen={false}
      terminalShortcutLabel="⌘J"
      rightPanelAvailable
      rightPanelOpen={false}
      rightPanelShortcutLabel="⌘⌥B"
      liveAgentCount={liveAgentCount}
      unreadArtifactCount={unreadArtifactCount}
      onToggleTerminal={() => {}}
      onToggleRightPanel={() => {}}
    />,
  );
}

describe("PanelLayoutControls right-panel badge", () => {
  it("stays bare when nothing wants attention", () => {
    const markup = renderBadge(0, 0);

    expect(markup).toContain('aria-label="Toggle right panel"');
    expect(markup).not.toContain("agents working");
    expect(markup).not.toContain("new file");
    expect(markup).not.toContain("rounded-full bg-info");
  });

  it("badges unread artifacts even with no agents running", () => {
    // The panel being closed while the app is focused suppresses the OS
    // notification, so this badge is the only signal a file arrived.
    const markup = renderBadge(0, 2);

    expect(markup).toContain('aria-label="Toggle right panel, 2 new files"');
    expect(markup).toContain(">2</span>");
  });

  it("names both signals separately rather than leaving the count ambiguous", () => {
    const markup = renderBadge(2, 1);

    // The badge itself can only carry one number, so the accessible name is
    // what disambiguates it. (The tooltip carries the same breakdown, but
    // base-ui renders popups lazily, so static markup cannot see it.)
    expect(markup).toContain('aria-label="Toggle right panel, 2 agents working, 1 new file"');
    expect(markup).toContain(">3</span>");
  });

  it("keeps the agent-only wording unchanged", () => {
    const markup = renderBadge(1, 0);

    expect(markup).toContain('aria-label="Toggle right panel, 1 agent working"');
    expect(markup).not.toContain("new file");
  });
});
