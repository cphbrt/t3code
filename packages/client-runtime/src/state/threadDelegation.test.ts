import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadDelegationTree,
  collectDelegatedThreads,
  findDelegationRootOf,
  flattenThreadDelegationTree,
  type DelegatableThread,
  type DelegationRow,
} from "./threadDelegation.ts";

const thread = (id: string, parentThreadId?: string) => ({
  id: ThreadId.make(id),
  ...(parentThreadId ? { parentThreadId: ThreadId.make(parentThreadId) } : {}),
});

/** Marks ids as settled so a test can state the classification inline. */
const settledIn =
  (...ids: readonly string[]) =>
  (candidate: DelegatableThread) =>
    ids.includes(candidate.id);

/** Compact render-order assertion: thread ids, dividers as `divider(parent,n)`. */
const describeRows = (rows: ReadonlyArray<DelegationRow<DelegatableThread>>) =>
  rows.map((row) =>
    row.kind === "thread"
      ? `${row.thread.id}@${row.depth}`
      : `divider(${row.thread.id},${row.count})@${row.depth}`,
  );

describe("buildThreadDelegationTree", () => {
  it("nests a spawned thread under the thread that spawned it", () => {
    const nodes = buildThreadDelegationTree([thread("parent"), thread("child", "parent")]);

    expect(nodes.map((node) => node.thread.id)).toEqual(["parent"]);
    expect(nodes[0]?.children.map((child) => child.thread.id)).toEqual(["child"]);
  });

  it("leaves a hand-off at the top level beside its spawner's teammate", () => {
    // The two delegations differ exactly here. A teammate carries a parent and
    // nests; a hand-off carries none, because it is genuinely the user's
    // sibling thread, so it keeps its own place in the activity order.
    const nodes = buildThreadDelegationTree([
      thread("parent"),
      thread("teammate", "parent"),
      thread("hand-off"),
    ]);

    expect(nodes.map((node) => node.thread.id)).toEqual(["parent", "hand-off"]);
    expect(nodes[0]?.children.map((child) => child.thread.id)).toEqual(["teammate"]);
    expect(nodes[1]?.children).toEqual([]);
  });

  it("keeps the caller's ordering for parents", () => {
    // Activity and pin ordering are decided before this runs; nesting must not
    // reorder the families themselves.
    const nodes = buildThreadDelegationTree([
      thread("second"),
      thread("first"),
      thread("child", "first"),
    ]);

    expect(nodes.map((node) => node.thread.id)).toEqual(["second", "first"]);
  });

  it("keeps a thread whose parent is absent from the list", () => {
    // The parent may be archived, filtered out, or on another project. Dropping
    // the child would hide a live thread from the sidebar entirely.
    const nodes = buildThreadDelegationTree([thread("orphan", "missing-parent")]);

    expect(nodes.map((node) => node.thread.id)).toEqual(["orphan"]);
    expect(nodes[0]?.children).toEqual([]);
  });

  it("treats a thread naming itself as its own parent as a root", () => {
    const nodes = buildThreadDelegationTree([thread("loop", "loop")]);

    expect(nodes.map((node) => node.thread.id)).toEqual(["loop"]);
    expect(nodes[0]?.children).toEqual([]);
  });

  it("gathers several children under one parent in list order", () => {
    const nodes = buildThreadDelegationTree([
      thread("parent"),
      thread("child-a", "parent"),
      thread("child-b", "parent"),
    ]);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.children.map((child) => child.thread.id)).toEqual(["child-a", "child-b"]);
  });

  it("leaves threads without parents untouched", () => {
    const nodes = buildThreadDelegationTree([thread("a"), thread("b")]);

    expect(nodes.map((node) => node.thread.id)).toEqual(["a", "b"]);
    expect(nodes.every((node) => node.children.length === 0)).toBe(true);
  });

  it("nests a grandchild under its own parent, not the grandparent", () => {
    const nodes = buildThreadDelegationTree([
      thread("root"),
      thread("child", "root"),
      thread("grandchild", "child"),
    ]);

    expect(nodes).toHaveLength(1);
    const child = nodes[0]?.children[0];
    expect(child?.thread.id).toBe("child");
    expect(child?.children.map((node) => node.thread.id)).toEqual(["grandchild"]);
  });

  it("keeps every thread in a parentage cycle rather than hanging or dropping them", () => {
    // Only reachable from malformed or raced data. An infinite recursion would
    // take the whole sidebar down, and a cycle has no root, so filtering nested
    // threads out would make both threads vanish.
    const nodes = buildThreadDelegationTree([thread("a", "b"), thread("b", "a")]);

    expect(nodes.map((node) => node.thread.id)).toEqual(["a"]);
    expect(nodes[0]?.children.map((node) => node.thread.id)).toEqual(["b"]);
  });

  it("keeps a thread the caller declares a root at the top level", () => {
    // The sidebar passes pins here. Nothing server-side stops a spawned child
    // from being pinned, and nesting it would take away its shelf, its place
    // in that shelf's count, and its pin glyph.
    const nodes = buildThreadDelegationTree([thread("parent"), thread("pinned", "parent")], {
      isRoot: (candidate) => candidate.id === "pinned",
    });

    expect(nodes.map((node) => node.thread.id)).toEqual(["parent", "pinned"]);
    expect(nodes[0]?.children).toEqual([]);
  });

  it("keeps a root-declared thread's own children nested under it", () => {
    const nodes = buildThreadDelegationTree(
      [thread("parent"), thread("pinned", "parent"), thread("grandchild", "pinned")],
      { isRoot: (candidate) => candidate.id === "pinned" },
    );

    expect(nodes.map((node) => node.thread.id)).toEqual(["parent", "pinned"]);
    expect(nodes[1]?.children.map((node) => node.thread.id)).toEqual(["grandchild"]);
  });

  it("still groups a root-declared thread's settled children behind its divider", () => {
    const nodes = buildThreadDelegationTree(
      [thread("parent"), thread("pinned", "parent"), thread("done", "pinned")],
      { isRoot: (candidate) => candidate.id === "pinned", isSettled: settledIn("done") },
    );

    expect(nodes[1]?.settledChildren.map((node) => node.thread.id)).toEqual(["done"]);
  });

  it("nests normally without an isRoot predicate", () => {
    const nodes = buildThreadDelegationTree([thread("parent"), thread("child", "parent")]);

    expect(nodes.map((node) => node.thread.id)).toEqual(["parent"]);
  });

  describe("settled children", () => {
    it("holds a settled child apart from its active siblings", () => {
      const nodes = buildThreadDelegationTree(
        [thread("parent"), thread("working", "parent"), thread("done", "parent")],
        { isSettled: settledIn("done") },
      );

      expect(nodes[0]?.children.map((node) => node.thread.id)).toEqual(["working"]);
      expect(nodes[0]?.settledChildren.map((node) => node.thread.id)).toEqual(["done"]);
    });

    it("keeps a settled child attached to a parent that is itself settled", () => {
      const nodes = buildThreadDelegationTree([thread("parent"), thread("child", "parent")], {
        isSettled: settledIn("parent", "child"),
      });

      expect(nodes.map((node) => node.thread.id)).toEqual(["parent"]);
      expect(nodes[0]?.settledChildren.map((node) => node.thread.id)).toEqual(["child"]);
    });

    it("leaves a settled thread whose parent is absent as a root", () => {
      // This is the fallback that keeps the flat Settled shelf honest: with no
      // parent to nest under, the thread has to remain a top-level row.
      const nodes = buildThreadDelegationTree([thread("orphan", "gone")], {
        isSettled: settledIn("orphan"),
      });

      expect(nodes.map((node) => node.thread.id)).toEqual(["orphan"]);
      expect(nodes[0]?.settledChildren).toEqual([]);
    });

    it("attaches a settled grandchild to its own parent's settled group", () => {
      const nodes = buildThreadDelegationTree(
        [thread("root"), thread("child", "root"), thread("grandchild", "child")],
        { isSettled: settledIn("grandchild") },
      );

      const child = nodes[0]?.children[0];
      expect(nodes[0]?.settledChildren).toEqual([]);
      expect(child?.settledChildren.map((node) => node.thread.id)).toEqual(["grandchild"]);
    });

    it("classifies nothing as settled without a predicate", () => {
      const nodes = buildThreadDelegationTree([thread("parent"), thread("child", "parent")]);

      expect(nodes[0]?.settledChildren).toEqual([]);
      expect(nodes[0]?.children.map((node) => node.thread.id)).toEqual(["child"]);
    });
  });
});

describe("collectDelegatedThreads", () => {
  it("reports every thread a parent claimed, settled or not, at any depth", () => {
    const nodes = buildThreadDelegationTree(
      [
        thread("root"),
        thread("child", "root"),
        thread("grandchild", "child"),
        thread("settled-child", "root"),
        thread("orphan", "gone"),
      ],
      { isSettled: settledIn("settled-child") },
    );

    expect(
      collectDelegatedThreads(nodes)
        .map((entry) => entry.id)
        .toSorted(),
    ).toEqual(["child", "grandchild", "settled-child"]);
  });

  it("reports nothing when no thread has a present parent", () => {
    expect(collectDelegatedThreads(buildThreadDelegationTree([thread("a"), thread("b")]))).toEqual(
      [],
    );
  });
});

describe("findDelegationRootOf", () => {
  const nodes = () =>
    buildThreadDelegationTree(
      [
        thread("root"),
        thread("child", "root"),
        thread("grandchild", "child"),
        thread("settled-grandchild", "child"),
        thread("elsewhere"),
      ],
      { isSettled: settledIn("settled-grandchild") },
    );

  it("returns a root for itself", () => {
    expect(findDelegationRootOf(nodes(), ThreadId.make("root"))?.id).toBe("root");
    expect(findDelegationRootOf(nodes(), ThreadId.make("elsewhere"))?.id).toBe("elsewhere");
  });

  it("walks up from a nested thread to the root that renders it", () => {
    expect(findDelegationRootOf(nodes(), ThreadId.make("child"))?.id).toBe("root");
    expect(findDelegationRootOf(nodes(), ThreadId.make("grandchild"))?.id).toBe("root");
  });

  it("finds a thread behind a settled divider", () => {
    expect(findDelegationRootOf(nodes(), ThreadId.make("settled-grandchild"))?.id).toBe("root");
  });

  it("returns null with no open thread or an unknown one", () => {
    expect(findDelegationRootOf(nodes(), null)).toBeNull();
    expect(findDelegationRootOf(nodes(), undefined)).toBeNull();
    expect(findDelegationRootOf(nodes(), ThreadId.make("stranger"))).toBeNull();
  });
});

describe("flattenThreadDelegationTree", () => {
  it("renders each parent immediately followed by its children", () => {
    const rows = flattenThreadDelegationTree(
      buildThreadDelegationTree([thread("first"), thread("second"), thread("child", "first")]),
    );

    expect(describeRows(rows)).toEqual(["first@0", "child@1", "second@0"]);
  });

  it("deepens the indent for each delegation hop", () => {
    const rows = flattenThreadDelegationTree(
      buildThreadDelegationTree([
        thread("root"),
        thread("child", "root"),
        thread("grandchild", "child"),
      ]),
    );

    expect(describeRows(rows)).toEqual(["root@0", "child@1", "grandchild@2"]);
  });

  it("emits an undisclosed divider and none of the settled rows behind it", () => {
    const rows = flattenThreadDelegationTree(
      buildThreadDelegationTree(
        [thread("parent"), thread("done-a", "parent"), thread("done-b", "parent")],
        { isSettled: settledIn("done-a", "done-b") },
      ),
    );

    expect(describeRows(rows)).toEqual(["parent@0", "divider(parent,2)@1"]);
  });

  it("emits the settled rows once the parent's divider is disclosed", () => {
    const rows = flattenThreadDelegationTree(
      buildThreadDelegationTree(
        [thread("parent"), thread("working", "parent"), thread("done", "parent")],
        { isSettled: settledIn("done") },
      ),
      { isSettledExpanded: (candidate) => candidate.id === "parent" },
    );

    expect(describeRows(rows)).toEqual(["parent@0", "working@1", "divider(parent,1)@1", "done@1"]);
  });

  it("emits no divider for a parent with no settled children", () => {
    const rows = flattenThreadDelegationTree(
      buildThreadDelegationTree([thread("parent"), thread("child", "parent")], {
        isSettled: settledIn("nobody"),
      }),
    );

    expect(describeRows(rows)).toEqual(["parent@0", "child@1"]);
  });

  it("gives each parent its own divider rather than pooling them", () => {
    const rows = flattenThreadDelegationTree(
      buildThreadDelegationTree(
        [
          thread("root"),
          thread("child", "root"),
          thread("root-done", "root"),
          thread("child-done", "child"),
        ],
        { isSettled: settledIn("root-done", "child-done") },
      ),
      { isSettledExpanded: () => true },
    );

    // The grandchild's divider belongs to `child`, not to `root`: a settled
    // grandchild nests under its own parent.
    expect(describeRows(rows)).toEqual([
      "root@0",
      "child@1",
      "divider(child,1)@2",
      "child-done@2",
      "divider(root,1)@1",
      "root-done@1",
    ]);
  });

  it("renders the open thread even behind an undisclosed divider", () => {
    // Same exception a collapsed shelf makes: navigating into a settled
    // delegated thread must not hide its highlight or its un-settle action.
    const rows = flattenThreadDelegationTree(
      buildThreadDelegationTree(
        [thread("parent"), thread("open", "parent"), thread("other", "parent")],
        { isSettled: settledIn("open", "other") },
      ),
      { visibleThreadId: ThreadId.make("open") },
    );

    // The divider still reads as closed and `other` stays hidden: only the open
    // thread's own branch is forced through.
    expect(describeRows(rows)).toEqual(["parent@0", "divider(parent,2)@1", "open@1"]);
  });

  it("reaches an open thread nested below an undisclosed divider", () => {
    const rows = flattenThreadDelegationTree(
      buildThreadDelegationTree([thread("root"), thread("mid", "root"), thread("open", "mid")], {
        isSettled: settledIn("mid"),
      }),
      { visibleThreadId: ThreadId.make("open") },
    );

    expect(describeRows(rows)).toEqual(["root@0", "divider(root,1)@1", "mid@1", "open@2"]);
  });

  it("hides everything behind an undisclosed divider when nothing is open", () => {
    const rows = flattenThreadDelegationTree(
      buildThreadDelegationTree([thread("parent"), thread("done", "parent")], {
        isSettled: settledIn("done"),
      }),
      { visibleThreadId: null },
    );

    expect(describeRows(rows)).toEqual(["parent@0", "divider(parent,1)@1"]);
  });

  it("keeps a disclosed subtree's own settled group closed independently", () => {
    const rows = flattenThreadDelegationTree(
      buildThreadDelegationTree(
        [thread("root"), thread("child", "root"), thread("grandchild-done", "child")],
        { isSettled: settledIn("child", "grandchild-done") },
      ),
      { isSettledExpanded: (candidate) => candidate.id === "root" },
    );

    // `root` is open so `child` renders; `child` is closed so its own settled
    // grandchild stays behind its divider. Disclosure is strictly per parent.
    expect(describeRows(rows)).toEqual([
      "root@0",
      "divider(root,1)@1",
      "child@1",
      "divider(child,1)@2",
    ]);
  });
});
