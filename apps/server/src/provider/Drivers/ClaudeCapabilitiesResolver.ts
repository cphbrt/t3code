/**
 * ClaudeCapabilitiesResolver — decides how one status check gets its Claude
 * account metadata and plan-usage numbers.
 *
 * There are two ways to read them. The subprocess probe
 * (`probeClaudeCapabilities`) spawns a promptless Claude Agent SDK session and
 * reads its initialization result plus usage. The live-session read asks a
 * session this instance is already running, over the control protocol.
 *
 * Both cost exactly one `GET /api/oauth/usage` against Anthropic — the CLI
 * makes that call for either path and caches nothing — so choosing between them
 * never changes how many requests we send, only whether we spawn a process to
 * send it. This module owns that choice, and owns nothing about *when* a check
 * happens: the rate policy lives with the callers (the demand-gated refresh
 * tick and `mcp/ProviderUsageStatus`), deliberately not here.
 *
 * @module provider/Drivers/ClaudeCapabilitiesResolver
 */
import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { ClaudeCapabilitiesProbe } from "../Layers/ClaudeProvider.ts";

export interface ClaudeCapabilitiesResolverInput {
  /** Spawn-a-subprocess probe. Resolves `undefined` when it fails or times out. */
  readonly probe: Effect.Effect<ClaudeCapabilitiesProbe | undefined>;
  /**
   * Plan usage from a session this instance already has running. Resolves
   * `undefined` when nothing live can answer.
   */
  readonly readPlanUsage: () => Effect.Effect<SDKControlGetUsageResponse | undefined>;
  /** Whether a turn is in flight on this instance right now. */
  readonly hasActiveWork: Effect.Effect<boolean>;
}

/**
 * Build the `resolveCapabilities` callback `checkClaudeProviderStatus` takes.
 *
 * While a turn is in flight the instance already owns a running subprocess, so
 * the usage read rides it and the check spawns nothing — the same shape as
 * Codex, which reads its rate limits over the app-server client it already has.
 * That shortcut reuses the account fields and slash commands from the last
 * successful probe, restamping `probedAt` because the numbers themselves are
 * fresh.
 *
 * It is gated on an active turn rather than on any open session so that the
 * reused metadata cannot go stale for the life of the app: an idle check still
 * takes the full probe, which bounds how long a retained slash-command or auth
 * reading survives by the length of a turn.
 *
 * When the probe fails, the last successful reading is served instead of
 * nothing. A failed probe tells us nothing new about the account, and reporting
 * the last thing it did tell us beats flipping an authenticated provider to
 * "auth unknown" until the next check.
 */
export const makeClaudeCapabilitiesResolver = (input: ClaudeCapabilitiesResolverInput) =>
  Effect.gen(function* () {
    const lastCapabilitiesRef = yield* Ref.make<ClaudeCapabilitiesProbe | undefined>(undefined);

    return Effect.gen(function* () {
      const retained = yield* Ref.get(lastCapabilitiesRef);
      if (retained && (yield* input.hasActiveWork)) {
        const usage = yield* input.readPlanUsage();
        if (usage) {
          const probedAt = DateTime.formatIso(yield* DateTime.now);
          return { ...retained, usage, probedAt } satisfies ClaudeCapabilitiesProbe;
        }
      }
      const probed = yield* input.probe;
      if (probed) {
        yield* Ref.set(lastCapabilitiesRef, probed);
        return probed;
      }
      return retained;
    });
  });
