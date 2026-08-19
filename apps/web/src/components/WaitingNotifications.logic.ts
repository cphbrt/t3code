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
  /** Shell-row count; a rise is what makes an artifact worth announcing. */
  readonly unreadArtifactCount: number;
}

/**
 * Everything remembered about a thread between passes. One record rather than
 * two maps, so the silent-seeding rule covers both signals identically: a
 * thread key absent from the previous map is new, and new threads never notify.
 */
export interface WaitingNotificationObservation {
  readonly kind: WaitingNotificationKind | null;
  readonly unreadArtifactCount: number;
}

export type WaitingNotificationEmission =
  | {
      readonly threadKey: string;
      readonly reason: "waiting";
      readonly kind: WaitingNotificationKind;
    }
  | { readonly threadKey: string; readonly reason: "artifacts"; readonly newArtifactCount: number };

export interface WaitingNotificationPlanInput {
  readonly candidates: readonly WaitingNotificationCandidate[];
  /** What each thread was last observed as. */
  readonly previousObservations: ReadonlyMap<string, WaitingNotificationObservation>;
  readonly enabled: boolean;
  readonly appFocused: boolean;
}

export interface WaitingNotificationPlan {
  readonly emissions: readonly WaitingNotificationEmission[];
  readonly nextObservations: ReadonlyMap<string, WaitingNotificationObservation>;
}

/**
 * Decide which threads just ENTERED a waiting state, or just received a file
 * an agent made for the user, and deserve a banner.
 *
 * Three invariants carry the whole design:
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
 * 3. At most one banner per thread per pass. Banners are tagged by thread, so
 *    a second one for the same thread would silently replace the first rather
 *    than sit beside it. When both signals land together the waiting state
 *    wins: it means the agent has stopped and cannot continue without the
 *    user, whereas an artifact is durable and keeps its unread dot and badge
 *    until it is opened. By invariant 1 the artifact count still advances, so
 *    the skipped artifact is dropped rather than deferred to a later pass.
 */
export function planWaitingNotifications(
  input: WaitingNotificationPlanInput,
): WaitingNotificationPlan {
  const nextObservations = new Map<string, WaitingNotificationObservation>();
  const emissions: WaitingNotificationEmission[] = [];
  const suppressed = !input.enabled || input.appFocused;

  for (const candidate of input.candidates) {
    nextObservations.set(candidate.threadKey, {
      kind: candidate.kind,
      unreadArtifactCount: candidate.unreadArtifactCount,
    });
    const previous = input.previousObservations.get(candidate.threadKey);
    if (suppressed || candidate.snoozed || previous === undefined) {
      continue;
    }
    if (candidate.kind !== null && previous.kind !== candidate.kind) {
      emissions.push({ threadKey: candidate.threadKey, reason: "waiting", kind: candidate.kind });
      continue;
    }
    // Only a rise counts. Reading one (or opening the thread) lowers the count
    // and must stay silent, and a coalesced rise of three is one banner.
    if (candidate.unreadArtifactCount > previous.unreadArtifactCount) {
      emissions.push({
        threadKey: candidate.threadKey,
        reason: "artifacts",
        newArtifactCount: candidate.unreadArtifactCount - previous.unreadArtifactCount,
      });
    }
  }

  return { emissions, nextObservations };
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

/**
 * Same shape for artifacts: the title says what arrived, the body says which
 * thread. The count is the rise since the last pass, so a burst reads as one
 * honest number rather than as one banner per file.
 */
export function artifactNotificationContent(
  newArtifactCount: number,
  threadTitle: string,
): WaitingNotificationContent {
  return {
    title: newArtifactCount > 1 ? `${newArtifactCount} new artifacts` : "New artifact",
    body: threadTitle,
  };
}
