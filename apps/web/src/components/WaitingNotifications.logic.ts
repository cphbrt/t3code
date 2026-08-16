import type { SidebarThreadSummary } from "../types";
import { hasUnseenCompletion, resolveSidebarThreadStatus } from "./Sidebar.logic";

/**
 * The attention states worth an ephemeral OS notification: the agent stopped
 * and the thread is now waiting on the user. Deliberately the same vocabulary
 * as the sidebar status pill, because the notification and the pill must never
 * disagree about whether a thread needs attention.
 */
export type WaitingNotificationKind = "approval" | "input" | "interrupted" | "failed" | "completed";

/** Exactly the fields the sidebar status resolvers read, plus the client's visit stamp. */
export type WaitingNotificationThreadInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestTurn"
  | "session"
  | "backgroundLiveness"
> & { readonly lastVisitedAt?: string | undefined };

/**
 * Reuses the sidebar's own status ladder (interrupted > approval > input >
 * working > failed > background liveness) and adds the one state it expresses
 * separately: a resting thread whose completion the user has not seen yet.
 * Live work resolves to null — nothing is waiting on anyone.
 */
export function resolveWaitingNotificationKind(
  thread: WaitingNotificationThreadInput,
): WaitingNotificationKind | null {
  switch (resolveSidebarThreadStatus(thread)) {
    case "approval":
      return "approval";
    case "input":
      return "input";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
    case "working":
    case "monitoring":
      return null;
    case "ready":
      return hasUnseenCompletion(thread) ? "completed" : null;
  }
}

export interface WaitingNotificationCandidate {
  readonly threadKey: string;
  /** Current waiting state, or null when nothing is waiting on the user. */
  readonly kind: WaitingNotificationKind | null;
  /** Effectively snoozed — already false when the thread raised its hand. */
  readonly snoozed: boolean;
}

export interface WaitingNotificationEmission {
  readonly threadKey: string;
  readonly kind: WaitingNotificationKind;
}

export interface WaitingNotificationPlanInput {
  readonly candidates: readonly WaitingNotificationCandidate[];
  /** The waiting state each thread was last observed in. */
  readonly previousKinds: ReadonlyMap<string, WaitingNotificationKind | null>;
  readonly enabled: boolean;
  readonly appFocused: boolean;
}

export interface WaitingNotificationPlan {
  readonly emissions: readonly WaitingNotificationEmission[];
  readonly nextKinds: ReadonlyMap<string, WaitingNotificationKind | null>;
}

/**
 * Decide which threads just ENTERED a waiting state and deserve a banner.
 *
 * Two invariants carry the whole design:
 *
 * 1. Observed state always advances, even when nothing is emitted. Suppressing
 *    a notification must never defer it — otherwise every state change made
 *    while the app was focused (or the setting was off) would fire the moment
 *    the app lost focus.
 * 2. A thread seen for the first time is seeded silently. That is what keeps a
 *    fresh page load, a newly connected environment, and a brand-new thread
 *    from producing a burst of "completed" banners for work the user already
 *    knows about. Threads that vanish are dropped, so a thread that comes back
 *    is seeded again rather than compared against a stale state.
 */
export function planWaitingNotifications(
  input: WaitingNotificationPlanInput,
): WaitingNotificationPlan {
  const nextKinds = new Map<string, WaitingNotificationKind | null>();
  const emissions: WaitingNotificationEmission[] = [];
  const suppressed = !input.enabled || input.appFocused;

  for (const candidate of input.candidates) {
    nextKinds.set(candidate.threadKey, candidate.kind);
    if (suppressed || candidate.kind === null || candidate.snoozed) {
      continue;
    }
    if (!input.previousKinds.has(candidate.threadKey)) {
      continue;
    }
    if (input.previousKinds.get(candidate.threadKey) === candidate.kind) {
      continue;
    }
    emissions.push({ threadKey: candidate.threadKey, kind: candidate.kind });
  }

  return { emissions, nextKinds };
}

export interface WaitingNotificationContent {
  readonly title: string;
  readonly body: string;
}

const WAITING_NOTIFICATION_TITLES: Record<WaitingNotificationKind, string> = {
  approval: "Pending approval",
  input: "Awaiting input",
  interrupted: "Interrupted",
  failed: "Agent error",
  completed: "Turn completed",
};

/** Title carries the state, body carries the thread. Nothing else is exposed. */
export function waitingNotificationContent(
  kind: WaitingNotificationKind,
  threadTitle: string,
): WaitingNotificationContent {
  return { title: WAITING_NOTIFICATION_TITLES[kind], body: threadTitle };
}
