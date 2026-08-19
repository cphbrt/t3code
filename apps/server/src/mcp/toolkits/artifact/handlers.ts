import { CommandId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ArtifactToolkit, ShowChrisError } from "./tools.ts";

/**
 * Claude batches parallel tool calls, so two `show_chris` calls can land in the
 * same millisecond. A time-only command id would make the second collide with
 * the first in the engine's command-receipt dedupe, which replays the first
 * receipt — reporting success while silently dropping the second file. The
 * counter makes the id unique per process regardless of clock resolution.
 */
let showChrisCallOrdinal = 0;

const RECORD_CONFIRMATION =
  "Recorded. Chris will find it with the other things you have made for him, and will open it when he gets to it.";

const optionOnNotFound = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<Option.Option<A>, PlatformError.PlatformError, R> =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(Option.none<A>()) : Effect.fail(error),
    }),
  );

/**
 * Records a file the agent made for the user against the agent's own thread.
 *
 * The path is validated here, on the machine the agent wrote it on, because
 * that is the only machine that can answer the question. Whether the person
 * reading can reach it is a client-side concern and deliberately invisible
 * to the agent: this tool behaves identically wherever the client happens
 * to be.
 */
export const showChris = Effect.fn("ArtifactToolkit.show_chris")(function* (params: {
  readonly path: string;
}) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("artifact")) {
    return yield* new ShowChrisError({
      reason: "capability-unavailable",
      message: "This session's T3 Code credential may not record files for Chris.",
    });
  }

  const path = yield* Path.Path;
  const rawPath = params.path.trim();
  if (rawPath === "" || !path.isAbsolute(rawPath)) {
    return yield* new ShowChrisError({
      reason: "invalid-path",
      message: `'${params.path}' is not an absolute path. Pass the full path to the file.`,
    });
  }

  // Normalize after the absolute check so `/a/b/../c` and `/a/c` record as one
  // path, and the row matches what a later open resolves to.
  const requestedPath = path.resolve(rawPath);

  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* optionOnNotFound(fileSystem.stat(requestedPath)).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("show_chris could not stat the requested path", {
        path: requestedPath,
        cause,
      }).pipe(
        Effect.andThen(
          Effect.fail(
            new ShowChrisError({
              reason: "not-found",
              message: `T3 Code could not read '${requestedPath}'.`,
            }),
          ),
        ),
      ),
    ),
  );
  if (Option.isNone(info)) {
    return yield* new ShowChrisError({
      reason: "not-found",
      message: `Nothing exists at '${requestedPath}'. Write the file first, then call this.`,
    });
  }
  if (info.value.type !== "File") {
    return yield* new ShowChrisError({
      reason: "not-a-file",
      message: `'${requestedPath}' is not a file. Pass the path to a single file.`,
    });
  }

  const engine = yield* OrchestrationEngineService;
  const millis = yield* Clock.currentTimeMillis;
  showChrisCallOrdinal += 1;
  yield* engine
    .dispatch({
      type: "thread.artifact.record",
      commandId: CommandId.make(
        `artifact:${invocation.providerSessionId}:${millis}:${showChrisCallOrdinal}`,
      ),
      threadId: invocation.threadId,
      path: requestedPath,
    })
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning("show_chris record rejected", {
          threadId: invocation.threadId,
          error,
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new ShowChrisError({
                reason: "rejected",
                message: `T3 Code refused to record this file: ${error.message}`,
              }),
            ),
          ),
        ),
      ),
    );

  return { path: requestedPath, message: RECORD_CONFIRMATION };
});

export const ArtifactToolkitHandlersLive = ArtifactToolkit.toLayer({
  show_chris: showChris,
});
