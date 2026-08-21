import {
  type EnvironmentId,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * What a `t3-code` credential is allowed to do. "preview" drives the
 * collaborative browser; "settle" lets the thread's own agent park its thread
 * once the turn lands cleanly; "usage" lets it read its own provider account's
 * usage-limit status; "artifact" lets it hand the user a file it has made;
 * "spawn" lets it delegate work to another thread — either a sibling the user
 * follows or a teammate it can exchange messages with.
 */
export type McpCapability = "preview" | "settle" | "usage" | "artifact" | "spawn";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

/**
 * Guards the preview capability specifically: its refusal is
 * `PreviewAutomationUnavailableError`, so the argument stays narrowed to the
 * capability that error can describe. Other capabilities check
 * `invocation.capabilities` directly and fail with their own tool's error.
 */
export const requireMcpCapability = Effect.fn("mcp.requireCapability")(function* (
  capability: Extract<McpCapability, "preview">,
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    return yield* new PreviewAutomationUnavailableError({
      capability,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  }
  return invocation;
});
