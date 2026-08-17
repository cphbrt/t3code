import {
  ProviderDriverKind,
  ServerProviderQuota,
  ServerProviderUsageLimit,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { providerQuotaRefreshMinIntervalLabel } from "../../../provider/providerQuota.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProviderUsageStatus from "../../ProviderUsageStatus.ts";

// Spelled from the constant so the agent is never quoted a cadence the server
// has stopped honouring.
const refreshInterval = providerQuotaRefreshMinIntervalLabel();

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProviderUsageStatus.ProviderUsageStatus,
];

/**
 * An `Error` subclass rather than a plain tagged struct on purpose. Effect's
 * MCP server only forwards a declared failure's own message when the failure
 * `instanceof Error`; anything else is flattened to "Tool execution failed due
 * to an internal server error." A refusal that cannot say why it refused is
 * worse than no refusal message at all.
 */
export class UsageStatusError extends Schema.TaggedErrorClass<UsageStatusError>()(
  "UsageStatusError",
  {
    // capability-unavailable: this credential may not read usage status.
    // provider-unknown: the credential names an instance the registry has no
    // snapshot for, which normally means it was reconfigured mid-session.
    reason: Schema.Literals(["capability-unavailable", "provider-unknown"]),
    message: Schema.String,
  },
) {}

export const UsageStatusResult = Schema.Struct({
  provider: ProviderDriverKind.annotate({
    description: "Driver kind of the provider instance this thread runs on.",
  }),
  usageLimit: Schema.optionalKey(
    ServerProviderUsageLimit.annotate({
      description:
        "Present only while the account is exhausted. `resetsAt` is when work can resume; `observedAt` is when that exhaustion was seen.",
    }),
  ),
  quota: Schema.optionalKey(
    ServerProviderQuota.annotate({
      description:
        "Descriptive allowance windows as last reported by the provider, stamped with the `observedAt` they were read at.",
    }),
  ),
  stale: Schema.Boolean.annotate({
    description: `True when the quota reading is missing or older than ${refreshInterval}. Not an error — it means the cached numbers are the best available right now.`,
  }),
});

/**
 * The credential pins the provider instance, so there is no way to aim this
 * at another thread's account.
 *
 * `reason` is advisory and never read by the server, but a parameterless tool
 * is not an option: `Schema.Struct({})` compiles to
 * `{anyOf:[{type:"object"},{type:"array"}]}`, which is not a legal MCP
 * `inputSchema`, and one illegal tool makes clients discard the entire
 * `tools/list` response — silently taking every other `t3-code` toolkit down
 * with it. See `toolkits/toolSchemas.test.ts`.
 */
export const UsageStatusTool = Tool.make("usage_status", {
  description: `Report the usage limits of the provider account this thread runs on, so you can pace long-running work. \`usageLimit\` appears only when the account is currently exhausted, and its \`resetsAt\` says when work can resume. \`quota.windows\` describes rolling allowance windows: each has an \`id\` (\`five_hour\`, \`seven_day\`, per-model and other provider-specific buckets — treat unfamiliar ids as ordinary windows), a human \`label\`, a \`usedPercent\` from 0 to 100, and usually a \`resetsAt\`. When both \`usageLimit\` and \`quota\` are absent, no limit data has been observed for this account — API-key billing, for example, reports no subscription windows. Every reading carries the \`observedAt\` it was taken at, and \`stale\` is true when the quota reading is missing or older than ${refreshInterval}; T3 Code asks the provider at most once per ${refreshInterval} on your behalf, so a stale answer is the best available reading rather than a failure, and calling this again immediately will not produce a fresher one.`,
  parameters: Schema.Struct({
    reason: Schema.optional(
      Schema.String.annotate({
        description:
          "Optional short note for the transcript explaining why you are checking. Not interpreted by T3 Code.",
      }),
    ),
  }),
  success: UsageStatusResult,
  failure: UsageStatusError,
  dependencies,
})
  .annotate(Tool.Title, "Check provider usage limits")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  // A stale reading makes the server re-probe the provider, which reaches the
  // provider's account servers. Nothing in the user's workspace changes, but
  // the call is not purely local.
  .annotate(Tool.OpenWorld, true);

export const UsageToolkit = Toolkit.make(UsageStatusTool);
