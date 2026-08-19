/**
 * ClaudeAdapter — shape type for the Claude provider adapter.
 *
 * Historically this module exposed a `Context.Service` tag so consumers
 * could inject the adapter through the Effect layer graph. The driver
 * model ({@link ../Drivers/ClaudeDriver}) bundles one adapter per
 * instance as a captured closure instead, so the tag is gone — we only
 * retain the shape interface as a naming anchor for the driver bundle.
 *
 * @module ClaudeAdapter
 */
import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type * as Effect from "effect/Effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * ClaudeAdapterShape — per-instance Claude adapter contract. Carries
 * a branded driver kind as the nominal discriminant.
 */
export interface ClaudeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  /**
   * Read plan usage over the control protocol of a session this instance
   * already has running, so the provider status check does not have to spawn a
   * probe subprocess just to ask.
   *
   * Resolves `undefined` when no live session can answer — none open, none
   * whose runtime exposes the call, or the call failed or timed out — and the
   * caller falls back to the subprocess probe. This is a Claude-only addition
   * because the shortcut is Claude-shaped: Codex's status probe already reads
   * rate limits over its existing app-server client.
   */
  readonly readPlanUsage: () => Effect.Effect<SDKControlGetUsageResponse | undefined>;
}
