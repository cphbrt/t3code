import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

// Base UI leaves a popup mounted in its portal after it closes, so finding one
// of these slots says nothing about whether a layer is on screen. Code that
// treats a match as "a layer is open" stops working for the rest of the session
// the first time any menu opens and closes.
const POPUP_SLOT_PATTERN = /\[data-slot="[^"]*(?:popup|dialog)[^"]*"\]/u;

const QUERY_METHODS = new Set(["querySelector", "querySelectorAll"]);

// The one function allowed to ask the DOM this question, and the answer every
// other caller should be using.
const VISIBILITY_HELPER = "isFloatingLayerVisible";

const MESSAGE = `A closed Base UI popup stays mounted, so this matches layers that are not on screen. Use ${VISIBILITY_HELPER} from lib/floatingLayer to ask whether one is actually visible.`;

// Selector lists are written as literals, arrays of literals, or a `.join(",")`
// of either, so look for a popup slot anywhere inside the expression rather
// than trying to evaluate it.
const namesPopupSlot = (node: unknown): boolean => {
  if (Array.isArray(node)) return node.some((item) => namesPopupSlot(item));
  if (typeof node !== "object" || node === null) return false;

  const candidate = node as { type?: unknown; value?: unknown };
  if (candidate.type === "Literal" && typeof candidate.value === "string") {
    return POPUP_SLOT_PATTERN.test(candidate.value);
  }

  // `parent` walks back up the tree; following it would never terminate.
  return Object.entries(node).some(([key, value]) => key !== "parent" && namesPopupSlot(value));
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow querying for Base UI popup slots to decide whether a floating layer is open; a closed popup stays mounted.",
    },
  },
  createOnce(context) {
    // A selector list is usually a module-level const, so the call site passes
    // an identifier rather than the literal. Resolve both, and only at the end
    // of the file, so a const declared after its use still resolves.
    let popupSelectorNames = new Set<string>();
    let candidates: Array<{ node: ESTree.Node; name: string | null }> = [];
    const functionNames: Array<string | null> = [];

    const enterFunction = (node: { id?: { name?: string } | null }) => {
      functionNames.push(node.id?.name ?? null);
    };
    const exitFunction = () => {
      functionNames.pop();
    };

    return {
      before() {
        popupSelectorNames = new Set();
        candidates = [];
        functionNames.length = 0;
      },
      FunctionDeclaration: enterFunction,
      "FunctionDeclaration:exit": exitFunction,
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier") return;
        if (node.init && namesPopupSlot(node.init)) popupSelectorNames.add(node.id.name);
      },
      CallExpression(node) {
        if (functionNames.includes(VISIBILITY_HELPER)) return;

        const callee = unwrapExpression(node.callee);
        if (Option.isNone(callee) || callee.value.type !== "MemberExpression") return;

        const method = getPropertyName(callee.value.property);
        if (Option.isNone(method) || !QUERY_METHODS.has(method.value)) return;

        const [argument] = node.arguments;
        if (argument === undefined) return;

        if (namesPopupSlot(argument)) {
          candidates.push({ node, name: null });
          return;
        }

        const selector = unwrapExpression(argument);
        if (Option.isSome(selector) && selector.value.type === "Identifier") {
          candidates.push({ node, name: selector.value.name });
        }
      },
      "Program:exit"() {
        for (const candidate of candidates) {
          if (candidate.name !== null && !popupSelectorNames.has(candidate.name)) continue;
          context.report({ node: candidate.node, message: MESSAGE });
        }
      },
    };
  },
});
