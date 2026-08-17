export interface InAppShortcutInvocation {
  readonly action: string;
  readonly shortcut: string;
}

const shortcutInvocations = new WeakMap<object, InAppShortcutInvocation>();

export function markInAppShortcut(event: object, invocation: InAppShortcutInvocation): void {
  shortcutInvocations.set(event, invocation);
}

export function inAppShortcutForEvent(event: object): InAppShortcutInvocation | null {
  return shortcutInvocations.get(event) ?? null;
}

/**
 * An invocation announced by the code that ran it, rather than inferred from a
 * consumed keyboard event.
 */
export interface InAppShortcutReport {
  readonly action: string;
  readonly shortcut?: string;
}

type InAppShortcutReporter = (report: InAppShortcutReport) => void;

let shortcutReporter: InAppShortcutReporter | null = null;

/**
 * Installs the sink for explicitly reported shortcuts. The history recorder
 * owns this; the returned function uninstalls it.
 */
export function setInAppShortcutReporter(reporter: InAppShortcutReporter): () => void {
  shortcutReporter = reporter;
  return () => {
    if (shortcutReporter === reporter) {
      shortcutReporter = null;
    }
  };
}

/**
 * Announces a shortcut that ran without consuming its event. The passive
 * recorder keys off `defaultPrevented`, so an action that deliberately leaves
 * the key unconsumed is invisible to it and has to say so itself.
 */
export function reportInAppShortcut(report: InAppShortcutReport): void {
  shortcutReporter?.(report);
}
