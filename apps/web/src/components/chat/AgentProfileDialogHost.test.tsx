import { describe, expect, it } from "vite-plus/test";

import compactComposerSource from "./CompactComposerControlsMenu.tsx?raw";
import menuSource from "../ui/menu.tsx?raw";
import traitsPickerSource from "./TraitsPicker.tsx?raw";

/**
 * The agent-profile dialog is rendered by `TraitsMenuContent`, which lives
 * inside menu popups it does not own — `TraitsPicker`'s and the compact
 * composer's. A closing menu unmounts its portal subtree, so without
 * `keepMounted` on BOTH hosts the dialog dies with the menu that opened it.
 *
 * The first shipped attempt avoided that by keeping the menu open
 * (`closeOnClick={false}`), which left the menu painted on top of the dialog
 * and obscuring the profile descriptions the dialog exists to show.
 *
 * These are source-level assertions on purpose. The invariant is about mount
 * lifetime across a real click, which the chat directory's
 * `renderToStaticMarkup` idiom cannot express: Base UI menus resolve open state
 * at runtime and their Portal renders nothing server-side, so a markup snapshot
 * can neither close a menu nor observe the dialog surviving it.
 */
describe("agent-profile dialog survives its host menu closing", () => {
  it("keeps both menu hosts mounted so the dialog outlives the menu", () => {
    // Every MenuPopup that can contain TraitsMenuContent must opt in.
    for (const [label, fileSource] of [
      ["TraitsPicker", traitsPickerSource],
      ["CompactComposerControlsMenu", compactComposerSource],
    ] as const) {
      const popupTags = fileSource.match(/<MenuPopup[^>]*>/g) ?? [];
      expect(popupTags.length, `${label} should render a MenuPopup`).toBeGreaterThan(0);
      for (const tag of popupTags) {
        expect(tag, `${label}'s MenuPopup must keepMounted`).toContain("keepMounted");
      }
    }
  });

  it("lets the row close the menu instead of pinning it open over the dialog", () => {
    // The regression this replaced: the menu stayed open and covered the
    // dialog. Closing is correct precisely because keepMounted preserves the
    // dialog.
    expect(traitsPickerSource).not.toContain("closeOnClick={false}");
  });

  it("passes keepMounted through to the menu portal, defaulting to off", () => {
    const menu = menuSource;

    // Opt-in: every other menu in the app keeps today's unmount-on-close.
    expect(menu).toContain("keepMounted = false");
    // Base UI applies `hidden` to a kept-mounted closed menu, so it is not a
    // click-blocking invisible layer — but only if the flag actually reaches
    // the portal.
    expect(menu).toContain("<MenuPrimitive.Portal keepMounted={keepMounted}>");
  });
});
