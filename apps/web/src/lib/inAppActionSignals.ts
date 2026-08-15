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
