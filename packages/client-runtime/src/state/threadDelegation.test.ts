import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadDelegationTree, flattenThreadDelegationTree } from "./threadDelegation.ts";

const thread = (id: string, parentThreadId?: string) => ({
  id: ThreadId.make(id),
  ...(parentThreadId ? { parentThreadId: ThreadId.make(parentThreadId) } : {}),
});

describe("buildThreadDelegationTree", () => {
  it("nests a spawned thread under the thread that spawned it", () => {
    const nodes = buildThreadDelegationTree([thread("parent"), thread("child", "parent")]);

    expect(nodes.map((node) => node.thread.id)).toEqual(["parent"]);
    expect(nodes[0]?.children.map((child) => child.id)).toEqual(["child"]);
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
    expect(nodes[0]?.children.map((child) => child.id)).toEqual(["teammate"]);
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
    expect(nodes[0]?.children.map((child) => child.id)).toEqual(["child-a", "child-b"]);
  });

  it("leaves threads without parents untouched", () => {
    const nodes = buildThreadDelegationTree([thread("a"), thread("b")]);

    expect(nodes.map((node) => node.thread.id)).toEqual(["a", "b"]);
    expect(nodes.every((node) => node.children.length === 0)).toBe(true);
  });
});

describe("flattenThreadDelegationTree", () => {
  it("renders each parent immediately followed by its children", () => {
    const flattened = flattenThreadDelegationTree(
      buildThreadDelegationTree([thread("first"), thread("second"), thread("child", "first")]),
    );

    expect(flattened.map((entry) => entry.id)).toEqual(["first", "child", "second"]);
  });
});
