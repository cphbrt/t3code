import { CommandId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadToolkit } from "./tools.ts";

const SETTLE_CONFIRMATION =
  "Recorded. This thread will settle in the CPH Code sidebar when the current turn completes cleanly, and will stay active if the turn ends badly or the user sends another message first.";

export const settleThread = Effect.fn("ThreadToolkit.settle_thread")(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("settle")) {
    return yield* Effect.fail({
      _tag: "ThreadSettleError" as const,
      reason: "capability-unavailable" as const,
      message: "This session's T3 Code credential may not settle its thread.",
    });
  }
  const engine = yield* OrchestrationEngineService;
  // The provider session is single-threaded and the decider is idempotent on
  // repeats, so a per-millisecond id is enough to avoid the engine's
  // command-receipt dedupe collapsing two genuine calls into one.
  const millis = yield* Clock.currentTimeMillis;
  yield* engine
    .dispatch({
      type: "thread.self-settle.request",
      commandId: CommandId.make(`self-settle:${invocation.providerSessionId}:${millis}`),
      threadId: invocation.threadId,
    })
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning("agent self-settle request rejected", {
          threadId: invocation.threadId,
          error,
        }).pipe(
          Effect.andThen(
            Effect.fail({
              _tag: "ThreadSettleError" as const,
              reason: "rejected" as const,
              message: `T3 Code refused to settle this thread: ${error.message}`,
            }),
          ),
        ),
      ),
    );
  return { threadId: invocation.threadId, message: SETTLE_CONFIRMATION };
});

export const ThreadToolkitHandlersLive = ThreadToolkit.toLayer({
  settle_thread: settleThread,
});
