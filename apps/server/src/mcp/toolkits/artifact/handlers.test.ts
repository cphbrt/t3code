import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";

import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { showChris } from "./handlers.ts";

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

const recordingEngine = (dispatched: OrchestrationCommand[]) =>
  makeEngine((command) =>
    Effect.sync(() => {
      dispatched.push(command);
      return { sequence: 1 };
    }),
  );

// A real temp file, because the whole point of the validation is that it
// answers a question about the machine the agent wrote the file on.
const withTempFile = <A, E, R>(
  name: string,
  use: (path: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Error, R | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const filePath = `${directory}/${name}`;
    yield* fileSystem.writeFileString(filePath, "# synthetic artifact\n");
    return yield* use(filePath);
  }).pipe(Effect.scoped, Effect.orDie) as Effect.Effect<A, E, R | FileSystem.FileSystem>;

it.layer(NodeServices.layer)("show_chris handler", (it) => {
  it.effect("records an existing absolute file against the credential's own thread", () =>
    withTempFile("review.md", (filePath) =>
      Effect.gen(function* () {
        const dispatched: OrchestrationCommand[] = [];
        const result = yield* showChris({ path: filePath }).pipe(
          Effect.provideService(OrchestrationEngineService, recordingEngine(dispatched)),
          Effect.provideService(McpInvocationContext.McpInvocationContext, makeScope(["artifact"])),
        );

        expect(dispatched).toHaveLength(1);
        const command = dispatched[0];
        if (command?.type !== "thread.artifact.record") {
          throw new Error(`expected thread.artifact.record, received ${String(command?.type)}`);
        }
        expect(command.threadId).toBe(THREAD_ID);
        expect(command.path).toBe(filePath);
        expect(result.path).toBe(filePath);
      }),
    ),
  );

  it.effect("trims the requested path before recording it", () =>
    withTempFile("shot.png", (filePath) =>
      Effect.gen(function* () {
        const dispatched: OrchestrationCommand[] = [];
        yield* showChris({ path: `  ${filePath}  ` }).pipe(
          Effect.provideService(OrchestrationEngineService, recordingEngine(dispatched)),
          Effect.provideService(McpInvocationContext.McpInvocationContext, makeScope(["artifact"])),
        );

        const command = dispatched[0];
        if (command?.type !== "thread.artifact.record") {
          throw new Error("expected thread.artifact.record");
        }
        expect(command.path).toBe(filePath);
      }),
    ),
  );

  it.effect("gives two same-instant calls distinct command ids", () =>
    withTempFile("review.md", (filePath) =>
      Effect.gen(function* () {
        // Claude batches parallel tool calls. A time-only command id would make
        // the second collide with the first under the engine's receipt dedupe,
        // replaying the first receipt and silently dropping the second file.
        const dispatched: OrchestrationCommand[] = [];
        const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.provideService(OrchestrationEngineService, recordingEngine(dispatched)),
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              makeScope(["artifact"]),
            ),
          );

        // TestClock never advances on its own, so both calls read the same
        // millisecond — the exact condition that used to collide.
        yield* provide(showChris({ path: filePath })).pipe(Effect.provide(TestClock.layer()));
        yield* provide(showChris({ path: filePath })).pipe(Effect.provide(TestClock.layer()));

        expect(dispatched).toHaveLength(2);
        const ids = dispatched.map((command) => command.commandId);
        expect(new Set(ids).size, `command ids must be distinct: ${ids.join(", ")}`).toBe(2);
      }),
    ),
  );

  it.effect("normalizes a path with traversal segments before recording", () =>
    withTempFile("review.md", (filePath) =>
      Effect.gen(function* () {
        const dispatched: OrchestrationCommand[] = [];
        const directory = filePath.slice(0, filePath.lastIndexOf("/"));
        yield* showChris({ path: `${directory}/./sub/../review.md` }).pipe(
          Effect.provideService(OrchestrationEngineService, recordingEngine(dispatched)),
          Effect.provideService(McpInvocationContext.McpInvocationContext, makeScope(["artifact"])),
        );

        const command = dispatched[0];
        if (command?.type !== "thread.artifact.record") {
          throw new Error("expected thread.artifact.record");
        }
        // One path per file, and it matches what a later open resolves to.
        expect(command.path).toBe(filePath);
      }),
    ),
  );

  it.effect("refuses a credential without the artifact capability", () =>
    Effect.gen(function* () {
      const dispatched: OrchestrationCommand[] = [];
      const error = yield* showChris({ path: "/tmp/example/review.md" }).pipe(
        Effect.provideService(OrchestrationEngineService, recordingEngine(dispatched)),
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          makeScope(["preview", "settle", "usage"]),
        ),
        Effect.flip,
      );

      expect(error._tag).toBe("ShowChrisError");
      expect(error.reason).toBe("capability-unavailable");
      expect(dispatched).toHaveLength(0);
    }),
  );

  it.effect("refuses a relative path and says so", () =>
    Effect.gen(function* () {
      const dispatched: OrchestrationCommand[] = [];
      const error = yield* showChris({ path: "docs/review.md" }).pipe(
        Effect.provideService(OrchestrationEngineService, recordingEngine(dispatched)),
        Effect.provideService(McpInvocationContext.McpInvocationContext, makeScope(["artifact"])),
        Effect.flip,
      );

      expect(error.reason).toBe("invalid-path");
      expect(error.message).toContain("docs/review.md");
      expect(dispatched).toHaveLength(0);
    }),
  );

  it.effect("refuses a path with nothing at it", () =>
    Effect.gen(function* () {
      const dispatched: OrchestrationCommand[] = [];
      const error = yield* showChris({
        path: "/tmp/t3-artifact-does-not-exist/review.md",
      }).pipe(
        Effect.provideService(OrchestrationEngineService, recordingEngine(dispatched)),
        Effect.provideService(McpInvocationContext.McpInvocationContext, makeScope(["artifact"])),
        Effect.flip,
      );

      expect(error.reason).toBe("not-found");
      expect(dispatched).toHaveLength(0);
    }),
  );

  it.effect("refuses a directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const dispatched: OrchestrationCommand[] = [];
      const error = yield* showChris({ path: directory }).pipe(
        Effect.provideService(OrchestrationEngineService, recordingEngine(dispatched)),
        Effect.provideService(McpInvocationContext.McpInvocationContext, makeScope(["artifact"])),
        Effect.flip,
      );

      expect(error.reason).toBe("not-a-file");
      expect(dispatched).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("surfaces the orchestrator's own refusal message to the agent", () =>
    withTempFile("review.md", (filePath) =>
      Effect.gen(function* () {
        const error = yield* showChris({ path: filePath }).pipe(
          Effect.provideService(
            OrchestrationEngineService,
            makeEngine(() =>
              Effect.fail(
                new OrchestrationCommandInvariantError({
                  commandType: "thread.artifact.record",
                  detail: "thread is gone",
                }),
              ),
            ),
          ),
          Effect.provideService(McpInvocationContext.McpInvocationContext, makeScope(["artifact"])),
          Effect.flip,
        );

        expect(error.reason).toBe("rejected");
        // The TaggedErrorClass choice is what keeps this readable instead of
        // collapsing to "internal server error" at the MCP boundary.
        expect(error.message).toContain("thread is gone");
      }),
    ),
  );
});
