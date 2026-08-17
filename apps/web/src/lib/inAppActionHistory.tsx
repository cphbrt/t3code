import { useEffect, useRef } from "react";
import * as DateTime from "effect/DateTime";

import type { InAppActionHistoryInput } from "@t3tools/contracts";

import { serverEnvironment } from "../state/server";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import { inAppShortcutForEvent, setInAppShortcutReporter } from "./inAppActionSignals";
import { randomUUID } from "./utils";

const ACTIONABLE_SELECTOR = [
  "[data-app-action]",
  "a[href]",
  "button",
  "[role='button']",
  "[role='menuitem']",
  "[role='option']",
  "[role='tab']",
  "[role='treeitem']",
].join(",");

interface MouseActionDescription {
  readonly action: string;
  readonly target?: string;
  readonly label?: string;
}

function bounded(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 512) : undefined;
}

function safeUrlTarget(rawHref: string): string | undefined {
  try {
    const url = new URL(rawHref, window.location.href);
    return bounded(
      url.origin === window.location.origin ? url.pathname : `${url.origin}${url.pathname}`,
    );
  } catch {
    return undefined;
  }
}

export function currentInAppRoute(location = window.location): string {
  if (location.hash.startsWith("#/")) {
    return location.hash.slice(1).split(/[?#]/, 1)[0] || "/";
  }
  return location.pathname;
}

export function describeMouseAction(target: EventTarget | null): MouseActionDescription | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>(ACTIONABLE_SELECTOR);
  if (!element || element.matches(":disabled,[aria-disabled='true']")) return null;

  const explicitAction = bounded(element.dataset.appAction);
  const explicitTarget = bounded(element.dataset.appActionTarget);
  const label = bounded(
    element.dataset.appActionLabel ??
      element.getAttribute("aria-label") ??
      element.getAttribute("title") ??
      element.textContent,
  );
  if (explicitAction) {
    return {
      action: explicitAction,
      ...(explicitTarget ? { target: explicitTarget } : {}),
      ...(label ? { label } : {}),
    };
  }

  if (element instanceof HTMLAnchorElement) {
    const href = safeUrlTarget(element.href);
    return {
      action: element.origin === window.location.origin ? "navigation.open" : "external.open",
      ...(href ? { target: href } : {}),
      ...(label ? { label } : {}),
    };
  }

  const targetName = bounded(element.dataset.testid ?? element.dataset.slot ?? element.id);
  return {
    action: `${element.getAttribute("role") ?? element.tagName.toLowerCase()}.activate`,
    ...(targetName ? { target: targetName } : {}),
    ...(label ? { label } : {}),
  };
}

function resolveClientKind(): InAppActionHistoryInput["clientKind"] {
  return window.desktopBridge ? "desktop-renderer" : "web";
}

export function InAppActionHistoryRecorder() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const recordAction = useAtomCommand(serverEnvironment.recordInAppAction, {
    reportDefect: false,
    reportFailure: false,
  });
  const environmentIdRef = useRef(primaryEnvironmentId);
  const recordActionRef = useRef(recordAction);
  environmentIdRef.current = primaryEnvironmentId;
  recordActionRef.current = recordAction;

  useEffect(() => {
    const persist = (
      input: Omit<InAppActionHistoryInput, "eventId" | "occurredAt" | "clientKind">,
    ) => {
      const environmentId = environmentIdRef.current;
      if (environmentId === null) return;
      void recordActionRef.current({
        environmentId,
        input: {
          ...input,
          eventId: randomUUID(),
          occurredAt: DateTime.makeUnsafe(Date.now()),
          clientKind: resolveClientKind(),
        },
      });
    };

    // Actions that run without consuming their key are invisible to the
    // `defaultPrevented` rule below, so they announce themselves instead. The
    // rule itself stays as strict as it was: this is a second, explicit door,
    // not a wider one.
    const uninstallReporter = setInAppShortcutReporter((report) => {
      const routeBefore = currentInAppRoute();
      window.setTimeout(() => {
        persist({
          source: "shortcut",
          action: report.action,
          ...(report.shortcut ? { shortcut: report.shortcut } : {}),
          routeBefore,
          routeAfter: currentInAppRoute(),
        });
      }, 0);
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.isTrusted) return;
      const routeBefore = currentInAppRoute();
      // A task, not a microtask: trusted-event dispatch performs microtask
      // checkpoints between listeners, so a microtask queued from this
      // capture listener would run before the app's shortcut handlers have
      // prevented the event and marked the invocation.
      window.setTimeout(() => {
        if (!event.defaultPrevented) return;
        const invocation = inAppShortcutForEvent(event);
        if (invocation === null) return;
        persist({
          source: "shortcut",
          action: invocation.action,
          shortcut: invocation.shortcut,
          routeBefore,
          routeAfter: currentInAppRoute(),
        });
      }, 0);
    };

    const onClick = (event: MouseEvent) => {
      // Command lists execute keyboard selections (Enter on a highlighted
      // item) by synthesizing an untrusted detail-0 click on the item.
      // Those are real user actions, so accept them — but only on controls
      // that carry an explicit semantic name, keeping other programmatic
      // clicks out of the history.
      const keyboardActivation =
        event.detail === 0 &&
        event.target instanceof Element &&
        event.target.closest("[data-app-action]") !== null;
      if (!event.isTrusted && !keyboardActivation) return;
      const description = describeMouseAction(event.target);
      if (description === null) return;
      const routeBefore = currentInAppRoute();
      window.setTimeout(() => {
        persist({
          source: event.detail > 0 ? "mouse" : "shortcut",
          ...description,
          routeBefore,
          routeAfter: currentInAppRoute(),
        });
      }, 0);
    };

    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("click", onClick, true);
    return () => {
      uninstallReporter();
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("click", onClick, true);
    };
  }, []);

  return null;
}
