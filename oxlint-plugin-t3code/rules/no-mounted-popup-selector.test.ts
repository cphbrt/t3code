import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-mounted-popup-selector");

describe("t3code/no-mounted-popup-selector", () => {
  rule.valid(
    "allows querying for slots that are not popups",
    `const row = document.querySelector('[data-slot="sidebar-inset"]');`,
  );

  rule.valid(
    "allows the visibility helper itself to query for popup slots",
    `export function isFloatingLayerVisible(selector: string): boolean {
       return [...document.querySelectorAll(selector)].some((element) => element.checkVisibility());
     }
     const OPEN_LAYERS = '[data-slot="menu-popup"]';
     export function hasLayer() {
       return isFloatingLayerVisible(OPEN_LAYERS);
     }`,
  );

  rule.valid(
    "allows selector constants that are never queried directly",
    `const LAYERS = ['[data-slot="dialog"]', '[data-slot="menu-popup"]'].join(",");
     export const check = () => isFloatingLayerVisible(LAYERS);`,
  );

  rule.valid(
    "allows querying with an unrelated selector constant",
    `const ROWS = '[data-thread-row]';
     const first = document.querySelector(ROWS);`,
  );

  rule.invalid(
    "reports an inline popup slot selector",
    `const open = document.querySelector('[data-slot="menu-popup"]') !== null;`,
    (output) => {
      assert.match(output, /isFloatingLayerVisible/);
    },
  );

  rule.invalid(
    "reports a dialog slot selector",
    `const blocked = Boolean(document.querySelector('[data-slot="dialog"]'));`,
  );

  rule.invalid(
    "reports a joined selector list resolved through a constant",
    `const LAYERS = ['[data-slot="dialog"]', '[data-slot="popover-popup"]'].join(",");
     function shouldTypeToFocus() {
       if (document.querySelector(LAYERS)) return false;
       return true;
     }`,
  );

  rule.invalid(
    "reports a constant declared after the query that uses it",
    `function shouldTypeToFocus() {
       return document.querySelector(LAYERS) === null;
     }
     const LAYERS = '[data-slot="combobox-popup"]';`,
  );

  rule.invalid(
    "reports querySelectorAll without a visibility check",
    `const LAYERS = '[data-slot="menu-popup"]';
     const layers = document.querySelectorAll(LAYERS);`,
  );
});
