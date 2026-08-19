import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";
import { useThreadShells } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { useRightPanelStore } from "../rightPanelStore";
import {
  artifactNotificationContent,
  planWaitingNotifications,
  resolveWaitingNotificationKind,
  waitingNotificationContent,
  type WaitingNotificationCandidate,
  type WaitingNotificationObservation,
} from "./WaitingNotifications.logic";

/**
 * Banners are a nudge, not an inbox: each one closes itself so nothing piles
 * up in Notification Center for the user to clear later.
 */
const WAITING_NOTIFICATION_VISIBLE_MS = 6_000;

export function requestWaitingNotificationPermission(): void {
  if (typeof Notification === "undefined" || Notification.permission !== "default") {
    return;
  }
  void Notification.requestPermission().catch(() => undefined);
}

function canShowNotifications(): boolean {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

function showWaitingNotification(input: {
  readonly tag: string;
  readonly title: string;
  readonly body: string;
  readonly onActivate: () => void;
}): void {
  let notification: Notification;
  try {
    // One tag per thread, so a newer state for the same thread replaces the
    // older banner instead of stacking beside it.
    notification = new Notification(input.title, { body: input.body, tag: input.tag });
  } catch {
    // Some browsers only allow construction from a service worker.
    return;
  }
  const dismissTimer = window.setTimeout(() => {
    notification.close();
  }, WAITING_NOTIFICATION_VISIBLE_MS);
  notification.addEventListener(
    "close",
    () => {
      window.clearTimeout(dismissTimer);
    },
    { once: true },
  );
  notification.addEventListener(
    "click",
    () => {
      input.onActivate();
      notification.close();
    },
    { once: true },
  );
}

/**
 * Ephemeral OS notifications for threads that just started waiting on the
 * user, shown only while the app does not have focus.
 *
 * Mounted once for the whole app. It holds no React state: the only thing it
 * remembers between thread-shell updates is the waiting state each thread was
 * last observed in, which lives in a ref so recording an observation never
 * re-renders anything.
 */
export function WaitingNotifications() {
  const enabled = useClientSettings((settings) => settings.waitingNotificationsEnabled);
  const settingsHydrated = useClientSettingsHydrated();
  const threads = useThreadShells();
  const threadLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const navigate = useNavigate();
  const observedRef = useRef<ReadonlyMap<string, WaitingNotificationObservation>>(new Map());
  const requestedPermissionRef = useRef(false);

  useEffect(() => {
    // Until client settings hydrate, `enabled` is only the schema default.
    // Waiting also means the first observation after hydration seeds silently.
    if (!settingsHydrated) {
      return;
    }

    const now = new Date().toISOString();
    const refsByThreadKey = new Map<string, ScopedThreadRef>();
    const titlesByThreadKey = new Map<string, string>();
    const candidates: WaitingNotificationCandidate[] = [];

    for (const thread of threads) {
      if (thread.archivedAt !== null) {
        continue;
      }
      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
      const threadKey = scopedThreadKey(threadRef);
      refsByThreadKey.set(threadKey, threadRef);
      titlesByThreadKey.set(threadKey, thread.title);
      candidates.push({
        threadKey,
        kind: resolveWaitingNotificationKind({
          ...thread,
          lastVisitedAt: threadLastVisitedAtById[threadKey],
        }),
        // effectiveSnoozed already reports false once a snoozed thread raises
        // its hand, so a break-through state still notifies.
        snoozed: effectiveSnoozed(thread, { now }),
        unreadArtifactCount: thread.unreadArtifactCount,
      });
    }

    const plan = planWaitingNotifications({
      candidates,
      previousObservations: observedRef.current,
      enabled,
      appFocused: document.hasFocus(),
    });
    observedRef.current = plan.nextObservations;

    if (plan.emissions.length === 0) {
      return;
    }
    if (!canShowNotifications()) {
      // Ask once, on the first turn that would have notified. A denied prompt
      // leaves the feature silently off.
      if (!requestedPermissionRef.current) {
        requestedPermissionRef.current = true;
        requestWaitingNotificationPermission();
      }
      return;
    }

    for (const emission of plan.emissions) {
      const threadRef = refsByThreadKey.get(emission.threadKey);
      const threadTitle = titlesByThreadKey.get(emission.threadKey);
      if (!threadRef || threadTitle === undefined) {
        continue;
      }
      const content =
        emission.reason === "waiting"
          ? waitingNotificationContent(emission.kind, threadTitle)
          : artifactNotificationContent(emission.newArtifactCount, threadTitle);
      showWaitingNotification({
        tag: emission.threadKey,
        title: content.title,
        body: content.body,
        onActivate: () => {
          window.focus();
          void window.desktopBridge?.revealWindow?.();
          // Land on what the banner was about: an artifact banner opens the
          // surface holding it, so the click finishes the errand.
          if (emission.reason === "artifacts") {
            useRightPanelStore.getState().open(threadRef, "artifacts");
          }
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(threadRef),
          });
        },
      });
    }
  }, [enabled, navigate, settingsHydrated, threadLastVisitedAtById, threads]);

  return null;
}
