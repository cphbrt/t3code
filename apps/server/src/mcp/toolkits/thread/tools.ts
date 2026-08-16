import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, OrchestrationEngineService];

export const ThreadSettleError = Schema.TaggedStruct("ThreadSettleError", {
  // capability-unavailable: this credential may not settle. rejected: the
  // orchestrator refused, e.g. the thread is archived.
  reason: Schema.Literals(["capability-unavailable", "rejected"]),
  message: Schema.String,
});

export const ThreadSettleResult = Schema.Struct({
  threadId: Schema.String,
  message: Schema.String,
});

/**
 * The thread identity is taken from the credential the provider session was
 * launched with, never from arguments — an agent can only ever settle the
 * thread it is running in.
 *
 * `reason` is deliberately the tool's only parameter, and it is advisory: the
 * server never reads it, but the agent's stated reason lands in the transcript
 * next to the call. It is also load-bearing for a different reason.
 * `Schema.Struct({})` compiles to `{anyOf:[{type:"object"},{type:"array"}]}`,
 * which is not a legal MCP `inputSchema`, and one illegal tool poisons the
 * whole `tools/list` response: the client reports `t3-code` as connected and
 * then exposes NONE of its tools, silently taking the preview toolkit down
 * with it. A parameterless tool here is not an option.
 */
export const ThreadSettleTool = Tool.make("settle_thread", {
  description:
    "Settle this thread in the CPH Code sidebar once the current turn completes cleanly. Call this only when the user asked you to settle the thread on successful completion, and call it as the last thing you do in the turn. Settling is deferred: it happens when this turn ends, not immediately. If the turn ends with an error or is interrupted, or the user sends another message first, the thread will not settle. Settling only parks the thread in the sidebar; it does not delete or archive anything, and the user can un-settle it. It always acts on your own thread; there is no way to name another one.",
  parameters: Schema.Struct({
    reason: Schema.optional(
      Schema.String.annotate({
        description:
          "Optional short note for the transcript explaining why you are settling. Not interpreted by T3 Code.",
      }),
    ),
  }),
  success: ThreadSettleResult,
  failure: ThreadSettleError,
  dependencies,
})
  .annotate(Tool.Title, "Settle this thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ThreadToolkit = Toolkit.make(ThreadSettleTool);

/**
 * Both providers need telling that this tool exists, not just that it is
 * offered. A tool description alone is not enough: a live Sonnet turn asked to
 * "reply with one word, then settle your thread" answered "Settled." without
 * calling anything. Codex reads this through its developer instructions and
 * Claude through the appended system prompt, so keep the wording here, shared,
 * rather than drifting apart in two adapters.
 */
export const T3_CODE_SETTLE_TOOL_INSTRUCTIONS = `## Settling your own thread

The \`t3-code\` MCP server exposes \`settle_thread\`, which parks this thread in the T3 Code sidebar once the current turn completes cleanly. When the user asks you to settle, park, or finish with this thread on success, call it — that request is about this tool, not about your wording. Call it as the last thing you do in the turn, and never claim a thread is settled without calling it.

Settling is deferred, not immediate: an errored or interrupted turn, or a new user message arriving first, leaves the thread active. It parks the thread and nothing more — no deletion, no archiving, and the user can un-settle it. Do not call it to signal that you are finished, to end a turn early, or on your own initiative.`;
