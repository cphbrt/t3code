import { ThreadId } from "@t3tools/contracts";
import {
  buildThreadDelegationTree,
  flattenThreadDelegationTree,
} from "@t3tools/client-runtime/state/thread-delegation";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SidebarNestedSettledDivider } from "./Sidebar";
import {
  DELEGATION_INDENT_MAX_LEVELS,
  DELEGATION_INDENT_REM_PER_LEVEL,
  delegationIndentStyle,
  resolveSidebarRowSection,
  type SidebarRowSection,
} from "./Sidebar.logic";

const renderDivider = (props: {
  count: number;
  expanded: boolean;
  depth?: number;
  testId?: string;
}) =>
  renderToStaticMarkup(
    <SidebarNestedSettledDivider
      count={props.count}
      expanded={props.expanded}
      depth={props.depth ?? 1}
      testId={props.testId ?? "sidebar-nested-settled-toggle-parent"}
      onToggle={() => {}}
    />,
  );

describe("delegationIndentStyle", () => {
  it("leaves a root row's geometry untouched", () => {
    // Every non-delegated row in the sidebar goes through this. Returning a
    // style at depth 0 would change the layout of threads that have nothing to
    // do with delegation.
    expect(delegationIndentStyle(0)).toBeUndefined();
    expect(delegationIndentStyle(-1)).toBeUndefined();
  });

  it("indents one step per delegation hop", () => {
    expect(delegationIndentStyle(1)).toEqual({
      marginLeft: `${DELEGATION_INDENT_REM_PER_LEVEL}rem`,
    });
    expect(delegationIndentStyle(2)).toEqual({
      marginLeft: `${2 * DELEGATION_INDENT_REM_PER_LEVEL}rem`,
    });
  });

  it("caps the indent so a long delegation chain cannot push a row off the edge", () => {
    const capped = `${DELEGATION_INDENT_MAX_LEVELS * DELEGATION_INDENT_REM_PER_LEVEL}rem`;

    expect(delegationIndentStyle(DELEGATION_INDENT_MAX_LEVELS)).toEqual({ marginLeft: capped });
    expect(delegationIndentStyle(DELEGATION_INDENT_MAX_LEVELS + 40)).toEqual({
      marginLeft: capped,
    });
  });
});

describe("SidebarNestedSettledDivider", () => {
  it("carries the count while undisclosed so a closed group still says its size", () => {
    const html = renderDivider({ count: 3, expanded: false });

    expect(html).toContain("Settled (3)");
    expect(html).toContain('aria-expanded="false"');
  });

  it("drops the count once disclosed, matching the shelf headers", () => {
    const html = renderDivider({ count: 3, expanded: true });

    expect(html).toContain(">Settled<");
    expect(html).not.toContain("Settled (3)");
    expect(html).toContain('aria-expanded="true"');
  });

  it("rotates the chevron only while disclosed", () => {
    expect(renderDivider({ count: 1, expanded: true })).toContain("rotate-180");
    expect(renderDivider({ count: 1, expanded: false })).not.toContain("rotate-180");
  });

  it("indents to its child depth and carries the child rows' connecting rule", () => {
    const html = renderDivider({ count: 1, expanded: false, depth: 1 });

    expect(html).toContain(`margin-left:${DELEGATION_INDENT_REM_PER_LEVEL}rem`);
    expect(html).toContain("border-l");
  });

  it("indents deeper for a grandchild's divider", () => {
    const html = renderDivider({ count: 1, expanded: false, depth: 2 });

    expect(html).toContain(`margin-left:${2 * DELEGATION_INDENT_REM_PER_LEVEL}rem`);
  });

  it("keeps range selection from treating the divider as a thread row", () => {
    // Shift-range-select and the click-to-clear handler both key off these
    // attributes; a divider is chrome, so it must be selection-safe and must
    // not look like a thread item.
    const html = renderDivider({ count: 1, expanded: false });

    expect(html).toContain("data-thread-selection-safe");
    expect(html).not.toContain("data-thread-item");
  });

  it("gives each parent its own test id so per-parent disclosure is addressable", () => {
    expect(renderDivider({ count: 1, expanded: false, testId: "x-parent-a" })).toContain(
      'data-testid="x-parent-a"',
    );
  });

  it("has no animation that repaints continuously", () => {
    // Sidebar rows sit in a list users scroll all day; only the chevron's
    // discrete transform transition is allowed.
    const html = renderDivider({ count: 2, expanded: true });

    expect(html).not.toContain("animate-");
    expect(html).toContain("transition-transform");
  });
});

// ── Row section derivation ───────────────────────────────────────────
// Driven through the real tree rather than hand-fed depths: the bug these
// cover was a depth >= 2 case, and only the flattener decides which rows exist
// at which depth once a divider is opened.

const thread = (id: string, parentThreadId?: string) => ({
  id: ThreadId.make(id),
  ...(parentThreadId ? { parentThreadId: ThreadId.make(parentThreadId) } : {}),
});

/**
 * Renders a shelf the way Sidebar does — build, flatten, then resolve each
 * thread row's section — and reports what treatment every row would wear.
 */
const shelfRowTreatments = (input: {
  threads: ReadonlyArray<ReturnType<typeof thread>>;
  shelfSection: SidebarRowSection;
  settled?: readonly string[];
  snoozed?: readonly string[];
  openDividers?: readonly string[];
}) => {
  const settled = input.settled ?? [];
  const snoozed = input.snoozed ?? [];
  const open = input.openDividers ?? [];
  const rows = flattenThreadDelegationTree(
    buildThreadDelegationTree(input.threads, {
      isSettled: (candidate) => settled.includes(candidate.id),
    }),
    { isSettledExpanded: (candidate) => open.includes(candidate.id) },
  );
  return rows.flatMap((row) => {
    if (row.kind !== "thread") return [];
    const section = resolveSidebarRowSection({
      shelfSection: input.shelfSection,
      delegationDepth: row.depth,
      isSettled: settled.includes(row.thread.id),
      isSnoozed: snoozed.includes(row.thread.id),
    });
    return [
      {
        id: row.thread.id,
        depth: row.depth,
        section,
        // The two things section actually drives in the row.
        variant: section === "active" || section === "pinned" ? "card" : "slim",
        action: section === "snoozed" ? "unsnooze" : section === "settled" ? "unsettle" : "settle",
      },
    ];
  });
};

describe("resolveSidebarRowSection", () => {
  it("gives a root row its shelf's section", () => {
    for (const shelfSection of ["pinned", "active", "snoozed", "settled"] as const) {
      expect(
        resolveSidebarRowSection({
          shelfSection,
          delegationDepth: 0,
          isSettled: false,
          isSnoozed: false,
        }),
      ).toBe(shelfSection);
    }
  });

  it("resolves a delegated row from its own state, whatever shelf it renders in", () => {
    for (const shelfSection of ["pinned", "active", "snoozed", "settled"] as const) {
      const at = (isSettled: boolean, isSnoozed: boolean) =>
        resolveSidebarRowSection({ shelfSection, delegationDepth: 1, isSettled, isSnoozed });

      expect(at(true, false)).toBe("settled");
      expect(at(false, true)).toBe("snoozed");
      expect(at(false, false)).toBe("active");
    }
  });

  it("never marks a delegated row pinned, because pins stay top-level", () => {
    expect(
      resolveSidebarRowSection({
        shelfSection: "pinned",
        delegationDepth: 1,
        isSettled: false,
        isSnoozed: false,
      }),
    ).toBe("active");
  });

  it("resolves the same way at every depth", () => {
    for (const delegationDepth of [1, 2, 3, 7]) {
      expect(
        resolveSidebarRowSection({
          shelfSection: "settled",
          delegationDepth,
          isSettled: false,
          isSnoozed: false,
        }),
      ).toBe("active");
    }
  });

  it("gives an active grandchild under an opened settled divider the active treatment", () => {
    // The regression: settled root -> settled child (divider opened) -> active
    // grandchild. The grandchild sits in the child's `children`, which are
    // emitted unconditionally, so it renders at depth 2 in the Settled shelf.
    // Inheriting the shelf would offer Unsettle on a thread that is working.
    const rows = shelfRowTreatments({
      threads: [thread("root"), thread("child", "root"), thread("grandchild", "child")],
      shelfSection: "settled",
      settled: ["root", "child"],
      openDividers: ["root"],
    });

    expect(rows).toEqual([
      { id: "root", depth: 0, section: "settled", variant: "slim", action: "unsettle" },
      { id: "child", depth: 1, section: "settled", variant: "slim", action: "unsettle" },
      { id: "grandchild", depth: 2, section: "active", variant: "card", action: "settle" },
    ]);
  });

  it("gives an active child of a snoozed parent the active treatment", () => {
    // The other half: a never-snoozed child renders in the Snoozed shelf under
    // its parent. Inheriting the shelf would offer Unsnooze on a thread that
    // was never snoozed.
    const rows = shelfRowTreatments({
      threads: [thread("parent"), thread("child", "parent")],
      shelfSection: "snoozed",
      snoozed: ["parent"],
    });

    expect(rows).toEqual([
      { id: "parent", depth: 0, section: "snoozed", variant: "slim", action: "unsnooze" },
      { id: "child", depth: 1, section: "active", variant: "card", action: "settle" },
    ]);
  });

  it("still gives a genuinely settled child the settled treatment", () => {
    // The fix must not swing the other way: a settled child under an active
    // parent is the case the divider exists for.
    const rows = shelfRowTreatments({
      threads: [thread("parent"), thread("done", "parent")],
      shelfSection: "active",
      settled: ["done"],
      openDividers: ["parent"],
    });

    expect(rows).toEqual([
      { id: "parent", depth: 0, section: "active", variant: "card", action: "settle" },
      { id: "done", depth: 1, section: "settled", variant: "slim", action: "unsettle" },
    ]);
  });

  it("gives a snoozed child under an active parent the unsnooze action", () => {
    const rows = shelfRowTreatments({
      threads: [thread("parent"), thread("napping", "parent")],
      shelfSection: "active",
      snoozed: ["napping"],
    });

    expect(rows[1]).toEqual({
      id: "napping",
      depth: 1,
      section: "snoozed",
      variant: "slim",
      action: "unsnooze",
    });
  });

  it("keeps a mixed family's rows each on their own treatment", () => {
    const rows = shelfRowTreatments({
      threads: [
        thread("parent"),
        thread("working", "parent"),
        thread("napping", "parent"),
        thread("done", "parent"),
        thread("under-done", "done"),
      ],
      shelfSection: "active",
      settled: ["done"],
      snoozed: ["napping"],
      openDividers: ["parent"],
    });

    expect(rows.map((row) => `${row.id}:${row.section}`)).toEqual([
      "parent:active",
      "working:active",
      "napping:snoozed",
      "done:settled",
      // Active work under a settled thread reads as active, not settled.
      "under-done:active",
    ]);
  });
});
