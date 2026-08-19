import type { OrchestrationEvent } from "@t3tools/contracts";

/**
 * Artifact events are gated behind `subscribeThread`'s `includeArtifactEvents`
 * opt-in. `OrchestrationEvent` is a closed union, so a client that predates
 * these types — notably the released iOS app — may fail to decode a frame it
 * has never seen. Only a subscriber that asks for them gets them.
 */
export const THREAD_DETAIL_ARTIFACT_EVENT_TYPES = [
  "thread.artifact-recorded",
  "thread.artifact-read-set",
  "thread.artifact-starred-set",
] as const satisfies ReadonlyArray<OrchestrationEvent["type"]>;

/**
 * Every event a per-thread subscription MAY forward. `isThreadDetailEvent`
 * in `ws.ts` decides what `subscribeThread` sends, gating the artifact types
 * on the opt-in above.
 */
export const THREAD_DETAIL_EVENT_TYPES = [
  "thread.message-sent",
  "thread.proposed-plan-upserted",
  "thread.activity-appended",
  "thread.turn-diff-completed",
  "thread.reverted",
  "thread.session-set",
  ...THREAD_DETAIL_ARTIFACT_EVENT_TYPES,
] as const satisfies ReadonlyArray<OrchestrationEvent["type"]>;

/**
 * The subset used by the thread watermark query in `ProjectionSnapshotQuery`.
 *
 * The watermark tells a client how far its live subscription must have caught
 * up before it may merge an older page, and the client PARKS the page until
 * `loadedSequence >= threadSequence` (`client-runtime/state/threads.ts`). So
 * the watermark may only count events EVERY subscriber receives: a watermark
 * naming an opt-in event a given client never gets can never be reached, and
 * that client's page parks forever behind a permanent spinner.
 *
 * Excluding artifacts costs nothing. The watermark exists to stop an older
 * page merging ahead of live deltas that could alter its content, and artifact
 * events touch only `thread.artifacts` — which is not one of the windowed
 * collections and is never paginated — so they can never alter a page.
 */
export const THREAD_DETAIL_WATERMARK_EVENT_TYPES = THREAD_DETAIL_EVENT_TYPES.filter(
  (type): type is Exclude<ThreadDetailEventType, ThreadArtifactEventType> =>
    !(THREAD_DETAIL_ARTIFACT_EVENT_TYPES as ReadonlyArray<string>).includes(type),
);

export type ThreadDetailEventType = (typeof THREAD_DETAIL_EVENT_TYPES)[number];
export type ThreadArtifactEventType = (typeof THREAD_DETAIL_ARTIFACT_EVENT_TYPES)[number];

const THREAD_DETAIL_EVENT_TYPE_SET = new Set<string>(THREAD_DETAIL_EVENT_TYPES);
const THREAD_ARTIFACT_EVENT_TYPE_SET = new Set<string>(THREAD_DETAIL_ARTIFACT_EVENT_TYPES);

export function isThreadArtifactEvent(
  event: OrchestrationEvent,
): event is Extract<OrchestrationEvent, { type: ThreadArtifactEventType }> {
  return THREAD_ARTIFACT_EVENT_TYPE_SET.has(event.type);
}

export function isThreadDetailEvent(
  event: OrchestrationEvent,
): event is Extract<OrchestrationEvent, { type: ThreadDetailEventType }> {
  return THREAD_DETAIL_EVENT_TYPE_SET.has(event.type);
}
