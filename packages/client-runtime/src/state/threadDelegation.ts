import type { ThreadId } from "@t3tools/contracts";

/**
 * The shape any client's thread row must expose to be nested. Deliberately
 * minimal: `parentThreadId` is optional on the wire, and older servers omit
 * it entirely, so every consumer here treats "absent" and "no parent" alike.
 */
export interface DelegatableThread {
  readonly id: ThreadId;
  readonly parentThreadId?: ThreadId | null | undefined;
}

export interface DelegationTreeNode<TThread extends DelegatableThread> {
  readonly thread: TThread;
  /**
   * Threads this one spawned, in the order the caller supplied them, each with
   * its own children. A delegated agent can delegate again, so the structure
   * has to nest as deep as the delegation does.
   */
  readonly children: ReadonlyArray<DelegationTreeNode<TThread>>;
  /**
   * The spawned threads that have settled, held apart from `children` so a
   * client can hide them behind their own disclosure. Same order as `children`.
   */
  readonly settledChildren: ReadonlyArray<DelegationTreeNode<TThread>>;
}

/**
 * Tells the tree builder which threads count as settled. Callers own the
 * predicate because settlement depends on server capabilities and auto-settle
 * settings the sidebar has already resolved.
 */
export interface DelegationTreeOptions<TThread extends DelegatableThread> {
  readonly isSettled?: (thread: TThread) => boolean;
  /**
   * Threads that stay top-level even when their parent is present. The sidebar
   * uses this for pins: a pin is an explicit "keep this in view", which outranks
   * the implicit grouping nesting provides, and a nested pin would lose its
   * shelf, its place in the shelf's count, and its pin glyph.
   */
  readonly isRoot?: (thread: TThread) => boolean;
}

/**
 * Arranges an already-sorted thread list into parents each followed by the
 * threads their agents spawned, recursively.
 *
 * The caller's ordering is preserved for parents, so whatever activity or pin
 * ordering the sidebar applied still decides where a family appears. Children
 * are attached in that same order beneath their parent rather than competing
 * with it, because a delegated thread is part of its parent's work, not a
 * separate entry in the list.
 *
 * A child whose parent is not in the list — filtered out, archived, on another
 * project, or deleted — is returned as a root rather than dropped. Nesting is
 * presentation; losing a live thread because its parent went away would not be.
 *
 * With `isSettled`, a settled child is still attached to its parent but lands
 * in `settledChildren` instead of `children`. That is what keeps a settled
 * delegated thread under the thread that started it rather than reclassified
 * into a flat shelf where its parentage is invisible. A settled thread whose
 * parent is absent is still a root, so it can fall back to that flat shelf.
 */
export function buildThreadDelegationTree<TThread extends DelegatableThread>(
  threads: ReadonlyArray<TThread>,
  options: DelegationTreeOptions<TThread> = {},
): ReadonlyArray<DelegationTreeNode<TThread>> {
  const isSettled = options.isSettled;
  const isRoot = options.isRoot;
  const present = new Set(threads.map((thread) => thread.id));
  const childrenByParent = new Map<ThreadId, TThread[]>();
  const nested = new Set<ThreadId>();

  for (const thread of threads) {
    const parentThreadId = thread.parentThreadId;
    // A thread naming itself as parent would nest under itself and vanish from
    // the list; treat it as a root, the same as an unknown parent or a thread
    // the caller pinned to the top level.
    if (
      !parentThreadId ||
      parentThreadId === thread.id ||
      !present.has(parentThreadId) ||
      (isRoot !== undefined && isRoot(thread))
    ) {
      continue;
    }
    nested.add(thread.id);
    const existing = childrenByParent.get(parentThreadId);
    if (existing) {
      existing.push(thread);
    } else {
      childrenByParent.set(parentThreadId, [thread]);
    }
  }

  // Expanding a thread twice would recurse forever on a parentage cycle
  // (A parents B parents A). Every thread is expanded at most once, so the
  // recursion always terminates.
  const expanded = new Set<ThreadId>();

  const toNode = (thread: TThread): DelegationTreeNode<TThread> => {
    expanded.add(thread.id);
    const children: DelegationTreeNode<TThread>[] = [];
    const settledChildren: DelegationTreeNode<TThread>[] = [];
    for (const child of childrenByParent.get(thread.id) ?? []) {
      if (expanded.has(child.id)) continue;
      const node = toNode(child);
      if (isSettled !== undefined && isSettled(child)) {
        settledChildren.push(node);
      } else {
        children.push(node);
      }
    }
    return { thread, children, settledChildren };
  };

  // Roots first, then anything still unplaced. A parentage cycle has no root,
  // so its members would otherwise be filtered out of the sidebar entirely —
  // the exact loss the absent-parent rule exists to prevent. The second pass
  // promotes the first cycle member in list order to a root and hangs the rest
  // of the cycle beneath it.
  const nodes: DelegationTreeNode<TThread>[] = [];
  for (const thread of threads) {
    if (nested.has(thread.id)) continue;
    nodes.push(toNode(thread));
  }
  for (const thread of threads) {
    if (expanded.has(thread.id)) continue;
    nodes.push(toNode(thread));
  }
  return nodes;
}

/**
 * Every thread the tree attached under a parent, at any depth, settled or not.
 * A caller that classifies threads into shelves uses this to know which
 * threads a parent has already claimed, so the same thread cannot appear both
 * nested and again in a flat shelf.
 */
export function collectDelegatedThreads<TThread extends DelegatableThread>(
  nodes: ReadonlyArray<DelegationTreeNode<TThread>>,
): ReadonlyArray<TThread> {
  const collected: TThread[] = [];
  // Iterated in place rather than through a concatenated array: this runs on
  // every sidebar render, once per node, and the vast majority of nodes have no
  // children at all.
  const visit = (node: DelegationTreeNode<TThread>) => {
    for (const child of node.children) {
      collected.push(child.thread);
      visit(child);
    }
    for (const child of node.settledChildren) {
      collected.push(child.thread);
      visit(child);
    }
  };
  for (const node of nodes) visit(node);
  return collected;
}

/**
 * The root whose subtree contains `threadId`, or null. A shelf's collapse rule
 * has to keep the whole family the open thread sits in, not the open thread
 * alone: a nested thread is not among its shelf's roots, so matching on it
 * directly would fold away the row it needs to render under.
 */
export function findDelegationRootOf<TThread extends DelegatableThread>(
  nodes: ReadonlyArray<DelegationTreeNode<TThread>>,
  threadId: ThreadId | null | undefined,
): TThread | null {
  if (!threadId) return null;
  const contains = (node: DelegationTreeNode<TThread>): boolean =>
    node.thread.id === threadId ||
    node.children.some(contains) ||
    node.settledChildren.some(contains);
  for (const node of nodes) {
    if (contains(node)) return node.thread;
  }
  return null;
}

/** One row in the flattened render order. */
export interface DelegationRenderRow<TThread extends DelegatableThread> {
  readonly kind: "thread";
  readonly thread: TThread;
  /** 0 for a root; one more than its parent's depth for a delegated thread. */
  readonly depth: number;
}

/**
 * The disclosure row that stands between a parent and its settled children.
 * Rendered at child depth, carrying the count so a closed divider still says
 * how much is behind it.
 */
export interface DelegationSettledDividerRow<TThread extends DelegatableThread> {
  readonly kind: "settledDivider";
  readonly thread: TThread;
  readonly depth: number;
  readonly count: number;
  readonly expanded: boolean;
}

export type DelegationRow<TThread extends DelegatableThread> =
  | DelegationRenderRow<TThread>
  | DelegationSettledDividerRow<TThread>;

/**
 * Flattens the tree to a render order: each parent, then its active children,
 * then — only if the parent has settled children — a divider row, and behind
 * that the settled children themselves.
 *
 * `isSettledExpanded` decides per parent whether those settled rows are emitted
 * at all. An undisclosed subtree produces no thread rows, so the cost of a
 * parent with a long settled tail is one divider row, not a hidden list.
 *
 * `visibleThreadId` is the one exception, matching the rule a collapsed shelf
 * already follows: the open thread's row always renders, so navigating into a
 * settled delegated thread cannot hide its highlight or its un-settle action
 * behind a closed divider. Only that thread's own branch is opened; its settled
 * siblings stay hidden.
 */
export function flattenThreadDelegationTree<TThread extends DelegatableThread>(
  nodes: ReadonlyArray<DelegationTreeNode<TThread>>,
  options: {
    readonly isSettledExpanded?: (thread: TThread) => boolean;
    readonly visibleThreadId?: ThreadId | null | undefined;
  } = {},
): ReadonlyArray<DelegationRow<TThread>> {
  const isSettledExpanded = options.isSettledExpanded;
  const visibleThreadId = options.visibleThreadId ?? null;

  const containsVisible = (node: DelegationTreeNode<TThread>): boolean =>
    node.thread.id === visibleThreadId ||
    node.children.some(containsVisible) ||
    node.settledChildren.some(containsVisible);

  const rows: DelegationRow<TThread>[] = [];

  const visit = (node: DelegationTreeNode<TThread>, depth: number) => {
    rows.push({ kind: "thread", thread: node.thread, depth });
    for (const child of node.children) visit(child, depth + 1);
    if (node.settledChildren.length === 0) return;
    const expanded = isSettledExpanded !== undefined && isSettledExpanded(node.thread);
    rows.push({
      kind: "settledDivider",
      thread: node.thread,
      depth: depth + 1,
      count: node.settledChildren.length,
      expanded,
    });
    if (expanded) {
      for (const child of node.settledChildren) visit(child, depth + 1);
      return;
    }
    if (visibleThreadId === null) return;
    for (const child of node.settledChildren) {
      if (containsVisible(child)) visit(child, depth + 1);
    }
  };

  for (const node of nodes) visit(node, 0);
  return rows;
}
