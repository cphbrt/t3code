"use client";

/**
 * Lets global actions such as the command palette reach the active chat
 * layout without lifting transient, thread-local presentation state.
 */
export type ChatLayoutAction = "toggle-reading-focus";

const EVENT_NAME = "t3code:chat-layout-action";

export function dispatchChatLayoutAction(action: ChatLayoutAction): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ChatLayoutAction>(EVENT_NAME, { detail: action }));
}

export function subscribeChatLayoutAction(
  listener: (action: ChatLayoutAction) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<ChatLayoutAction>).detail;
    if (detail === "toggle-reading-focus") listener(detail);
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
