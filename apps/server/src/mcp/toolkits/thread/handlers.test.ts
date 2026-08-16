import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { settleThread } from "./handlers.ts";

const THREAD_ID = ThreadId.make("thread-1");

const makeScope = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("claude"),
  capabilities: new Set(capabilities),
  issuedAt: 0,
});

const makeEngine = (
  dispatch: OrchestrationEngineService["Service"]["dispatch"],
): OrchestrationEngineService["Service"] =>
  ({
    dispatch,
    readEvents: () => {
      throw new Error("unused");
    },
    streamDomainEvents: undefined as never,
    latestSequence: Effect.succeed(0),
  }) as OrchestrationEngineService["Service"];

it.effect("dispatches an internal self-settle request scoped to the credential's thread", () =>
  Effect.gen(function* () {
    const dispatched: OrchestrationCommand[] = [];
    const result = yield* settleThread().pipe(
      Effect.provideService(
        OrchestrationEngineService,
        makeEngine((command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: 1 };
          }),
        ),
      ),
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        makeScope(["preview", "settle"]),
      ),
    );

    expect(dispatched).toHaveLength(1);
    const command = dispatched[0];
    expect(command?.type).toBe("thread.self-settle.request");
    // The thread never comes from tool arguments; only the credential names it.
    expect(command && "threadId" in command ? command.threadId : null).toBe(THREAD_ID);
    expect(result.threadId).toBe(THREAD_ID);
    expect(result.message).toContain("completes cleanly");
  }),
);

it.effect("reports a rejected settle instead of claiming success", () =>
  Effect.gen(function* () {
    const error = yield* settleThread().pipe(
      Effect.provideService(
        OrchestrationEngineService,
        makeEngine(() =>
          Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: "thread.self-settle.request",
              detail: "thread thread-1 is archived",
            }),
          ),
        ),
      ),
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        makeScope(["preview", "settle"]),
      ),
      Effect.flip,
    );
    expect(error.reason).toBe("rejected");
    expect(error.message).toContain("archived");
  }),
);

it.effect("refuses a credential without the settle capability", () =>
  Effect.gen(function* () {
    const error = yield* settleThread().pipe(
      Effect.provideService(
        OrchestrationEngineService,
        makeEngine(() => {
          throw new Error("must not dispatch");
        }),
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, makeScope(["preview"])),
      Effect.flip,
    );
    expect(error.reason).toBe("capability-unavailable");
  }),
);
