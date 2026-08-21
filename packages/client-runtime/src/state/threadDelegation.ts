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
  /** Threads this one spawned, in the order the caller supplied them. */
  readonly children: ReadonlyArray<TThread>;
}

/**
 * Arranges an already-sorted thread list into parents each followed by the
 * threads their agents spawned.
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
 */
export function buildThreadDelegationTree<TThread extends DelegatableThread>(
  threads: ReadonlyArray<TThread>,
): ReadonlyArray<DelegationTreeNode<TThread>> {
  const present = new Set(threads.map((thread) => thread.id));
  const childrenByParent = new Map<ThreadId, TThread[]>();

  for (const thread of threads) {
    const parentThreadId = thread.parentThreadId;
    // A thread naming itself as parent would nest under itself and vanish from
    // the list; treat it as a root, the same as an unknown parent.
    if (!parentThreadId || parentThreadId === thread.id || !present.has(parentThreadId)) {
      continue;
    }
    const existing = childrenByParent.get(parentThreadId);
    if (existing) {
      existing.push(thread);
    } else {
      childrenByParent.set(parentThreadId, [thread]);
    }
  }

  const nested = new Set(
    Array.from(childrenByParent.values()).flatMap((children) => children.map((child) => child.id)),
  );

  return threads
    .filter((thread) => !nested.has(thread.id))
    .map((thread) => ({
      thread,
      children: childrenByParent.get(thread.id) ?? [],
    }));
}

/**
 * Flattens the tree back to a render order: each parent immediately followed by
 * its children. Clients that cannot indent still show a delegated thread next
 * to the thread it belongs to rather than scattered by timestamp.
 */
export function flattenThreadDelegationTree<TThread extends DelegatableThread>(
  nodes: ReadonlyArray<DelegationTreeNode<TThread>>,
): ReadonlyArray<TThread> {
  return nodes.flatMap((node) => [node.thread, ...node.children]);
}
