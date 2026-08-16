import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { DiffWordWrapToggle, diffOverflowMode } from "./DiffWordWrapToggle";

describe("diffOverflowMode", () => {
  it("maps wrap state onto the renderer's overflow option", () => {
    expect(diffOverflowMode(true)).toBe("wrap");
    expect(diffOverflowMode(false)).toBe("scroll");
  });

  it("defaults to the renderer's own clipping when off", () => {
    // Both transcripts start unwrapped, so this is what an untouched diff gets.
    expect(diffOverflowMode(false)).toBe("scroll");
  });
});

describe("DiffWordWrapToggle", () => {
  it("labels the action it will perform, not the current state", () => {
    expect(
      renderToStaticMarkup(<DiffWordWrapToggle wordWrap={false} onToggle={() => {}} />),
    ).toContain("Wrap long lines");
    expect(renderToStaticMarkup(<DiffWordWrapToggle wordWrap onToggle={() => {}} />)).toContain(
      "Unwrap long lines",
    );
  });

  it("reports its pressed state for assistive tech", () => {
    expect(renderToStaticMarkup(<DiffWordWrapToggle wordWrap onToggle={() => {}} />)).toContain(
      'aria-pressed="true"',
    );
    expect(
      renderToStaticMarkup(<DiffWordWrapToggle wordWrap={false} onToggle={() => {}} />),
    ).toContain('aria-pressed="false"');
  });
});
