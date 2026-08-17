import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProviderUsageStatus from "../../ProviderUsageStatus.ts";
import { UsageStatusError, UsageToolkit } from "./tools.ts";

/**
 * The provider instance is taken from the credential the provider session was
 * launched with, never from arguments — an agent can only ever read the usage
 * status of the account it is itself running on.
 *
 * Refusal is checked here rather than through `requireMcpCapability`, which is
 * narrowed to "preview" because it fails with `PreviewAutomationUnavailableError`.
 * A usage tool must not surface a preview error.
 */
export const usageStatus = Effect.fn("UsageToolkit.usage_status")(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("usage")) {
    return yield* new UsageStatusError({
      reason: "capability-unavailable",
      message: "This session's T3 Code credential may not read provider usage status.",
    });
  }
  const usage = yield* ProviderUsageStatus.ProviderUsageStatus;
  const reading = yield* usage.read(invocation.providerInstanceId);
  if (!reading) {
    return yield* new UsageStatusError({
      reason: "provider-unknown",
      message: `T3 Code has no provider snapshot for instance '${invocation.providerInstanceId}'.`,
    });
  }
  return {
    provider: reading.provider,
    // Absent stays absent: an agent must be able to tell "no limit data was
    // ever observed" from "observed, and you are fine".
    ...(reading.usageLimit ? { usageLimit: reading.usageLimit } : {}),
    ...(reading.quota ? { quota: reading.quota } : {}),
    stale: reading.stale,
  };
});

export const UsageToolkitHandlersLive = UsageToolkit.toLayer({
  usage_status: usageStatus,
});
