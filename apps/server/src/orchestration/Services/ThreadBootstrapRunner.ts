import {
  CommandId,
  EventId,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import { projectSetupScriptCompatibilityDetail } from "../../project/projectSetupScriptCompatibility.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as OrchestrationEngine from "./OrchestrationEngine.ts";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export type ThreadTurnStartCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

/**
 * Runs the multi-step preamble a `thread.turn.start` can carry: create the
 * thread, cut a git worktree off a base ref, record the resolved worktree on
 * the thread, launch the project setup script, then start the turn itself.
 *
 * This lives in a service rather than in the WebSocket handler because two
 * callers need it: the client's `dispatchCommand`, and the `spawn_thread` MCP
 * tool an agent uses to delegate work into another repository's worktree. A
 * spawned thread must be indistinguishable from one the user started by hand,
 * which is only guaranteed while both go through this same code.
 *
 * Failure after the thread exists deletes it again, so a failed bootstrap
 * never leaves an empty thread behind in the sidebar.
 */
export interface ThreadBootstrapRunnerShape {
  readonly dispatchBootstrapTurnStart: (
    command: ThreadTurnStartCommand,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
}

export class ThreadBootstrapRunner extends Context.Service<
  ThreadBootstrapRunner,
  ThreadBootstrapRunnerShape
>()("t3/orchestration/Services/ThreadBootstrapRunner") {}

export const layer = Layer.effect(
  ThreadBootstrapRunner,
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
    const crypto = yield* Crypto.Crypto;

    const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
      isOrchestrationDispatchCommandError(cause)
        ? cause
        : new OrchestrationDispatchCommandError({
            message: cause instanceof Error ? cause.message : fallbackMessage,
            cause,
          });

    const randomUUID = crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) =>
        toDispatchCommandError(cause, "Failed to generate orchestration command identifier."),
      ),
    );
    const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
    const serverCommandId = (tag: string) =>
      randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

    const refreshGitStatus = (cwd: string) =>
      vcsStatusBroadcaster
        .refreshStatus(cwd)
        .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

    const appendSetupScriptActivity = (input: {
      readonly threadId: ThreadId;
      readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
      readonly summary: string;
      readonly createdAt: string;
      readonly payload: Record<string, unknown>;
      readonly tone: "info" | "error";
    }) =>
      Effect.all({
        commandId: serverCommandId("setup-script-activity"),
        activityId: serverEventId,
      }).pipe(
        Effect.flatMap(({ commandId, activityId }) =>
          orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId,
            threadId: input.threadId,
            activity: {
              id: activityId,
              tone: input.tone,
              kind: input.kind,
              summary: input.summary,
              payload: input.payload,
              turnId: null,
              createdAt: input.createdAt,
            },
            createdAt: input.createdAt,
          }),
        ),
      );

    const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
      const error = Cause.squash(cause);
      return isOrchestrationDispatchCommandError(error)
        ? error
        : new OrchestrationDispatchCommandError({
            message:
              error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
            cause,
          });
    };

    const dispatchBootstrapTurnStart = (command: ThreadTurnStartCommand) =>
      Effect.gen(function* () {
        const bootstrap = command.bootstrap;
        const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
        let createdThread = false;
        const targetProjectId = bootstrap?.createThread?.projectId;
        const targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
        let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

        const cleanupCreatedThread = () =>
          createdThread
            ? serverCommandId("bootstrap-thread-delete").pipe(
                Effect.flatMap((commandId) =>
                  orchestrationEngine.dispatch({
                    type: "thread.delete",
                    commandId,
                    threadId: command.threadId,
                  }),
                ),
                Effect.ignoreCause({ log: true }),
              )
            : Effect.void;

        const recordSetupScriptLaunchFailure = (input: {
          readonly error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError;
          readonly requestedAt: string;
          readonly worktreePath: string;
        }) => {
          const detail = projectSetupScriptCompatibilityDetail(input.error);
          return appendSetupScriptActivity({
            threadId: command.threadId,
            kind: "setup-script.failed",
            summary: "Setup script failed to start",
            createdAt: input.requestedAt,
            payload: {
              detail,
              worktreePath: input.worktreePath,
            },
            tone: "error",
          }).pipe(
            Effect.ignoreCause({ log: false }),
            Effect.flatMap(() =>
              Effect.logWarning("bootstrap turn start failed to launch setup script", {
                threadId: command.threadId,
                worktreePath: input.worktreePath,
                detail,
              }),
            ),
          );
        };

        const recordSetupScriptStarted = (input: {
          readonly requestedAt: string;
          readonly worktreePath: string;
          readonly scriptId: string;
          readonly scriptName: string;
          readonly terminalId: string;
        }) =>
          Effect.gen(function* () {
            const startedAt = yield* nowIso;
            const payload = {
              scriptId: input.scriptId,
              scriptName: input.scriptName,
              terminalId: input.terminalId,
              worktreePath: input.worktreePath,
            };
            yield* Effect.all([
              appendSetupScriptActivity({
                threadId: command.threadId,
                kind: "setup-script.requested",
                summary: "Starting setup script",
                createdAt: input.requestedAt,
                payload,
                tone: "info",
              }),
              appendSetupScriptActivity({
                threadId: command.threadId,
                kind: "setup-script.started",
                summary: "Setup script started",
                createdAt: startedAt,
                payload,
                tone: "info",
              }),
            ]).pipe(
              Effect.asVoid,
              Effect.catch((error) =>
                Effect.logWarning(
                  "bootstrap turn start launched setup script but failed to record setup activity",
                  {
                    threadId: command.threadId,
                    worktreePath: input.worktreePath,
                    scriptId: input.scriptId,
                    terminalId: input.terminalId,
                    detail: error.message,
                  },
                ),
              ),
            );
          });

        const runSetupProgram = () =>
          Effect.gen(function* () {
            if (!bootstrap?.runSetupScript || !targetWorktreePath) {
              return;
            }
            const worktreePath = targetWorktreePath;
            const requestedAt = yield* nowIso;
            yield* projectSetupScriptRunner
              .runForThread({
                threadId: command.threadId,
                ...(targetProjectId ? { projectId: targetProjectId } : {}),
                ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
                worktreePath,
              })
              .pipe(
                Effect.matchEffect({
                  onFailure: (error) =>
                    recordSetupScriptLaunchFailure({
                      error,
                      requestedAt,
                      worktreePath,
                    }),
                  onSuccess: (setupResult) => {
                    if (setupResult.status !== "started") {
                      return Effect.void;
                    }
                    return recordSetupScriptStarted({
                      requestedAt,
                      worktreePath,
                      scriptId: setupResult.scriptId,
                      scriptName: setupResult.scriptName,
                      terminalId: setupResult.terminalId,
                    });
                  },
                }),
              );
          });

        const bootstrapProgram = Effect.gen(function* () {
          if (bootstrap?.createThread) {
            yield* orchestrationEngine.dispatch({
              type: "thread.create",
              commandId: yield* serverCommandId("bootstrap-thread-create"),
              threadId: command.threadId,
              projectId: bootstrap.createThread.projectId,
              title: bootstrap.createThread.title,
              modelSelection: bootstrap.createThread.modelSelection,
              runtimeMode: bootstrap.createThread.runtimeMode,
              interactionMode: bootstrap.createThread.interactionMode,
              branch: bootstrap.createThread.branch,
              worktreePath: bootstrap.createThread.worktreePath,
              createdAt: bootstrap.createThread.createdAt,
            });
            createdThread = true;
          }

          if (bootstrap?.prepareWorktree) {
            let worktreeBaseRef = bootstrap.prepareWorktree.baseBranch;
            // "Start from origin" is a stored default; repos without an
            // origin remote fall back to the local base branch instead of
            // failing the whole bootstrap on `git fetch origin`.
            const startFromOrigin =
              bootstrap.prepareWorktree.startFromOrigin === true &&
              (yield* gitWorkflow.remoteExists({
                cwd: bootstrap.prepareWorktree.projectCwd,
                remoteName: "origin",
              }));
            if (startFromOrigin) {
              yield* gitWorkflow.fetchRemote({
                cwd: bootstrap.prepareWorktree.projectCwd,
                remoteName: "origin",
              });
              const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
                cwd: bootstrap.prepareWorktree.projectCwd,
                refName: bootstrap.prepareWorktree.baseBranch,
                fallbackRemoteName: "origin",
              });
              worktreeBaseRef = resolvedRemoteBase.commitSha;
            }
            const worktree = yield* gitWorkflow.createWorktree({
              cwd: bootstrap.prepareWorktree.projectCwd,
              refName: worktreeBaseRef,
              newRefName: bootstrap.prepareWorktree.branch,
              baseRefName: bootstrap.prepareWorktree.baseBranch,
              path: null,
            });
            targetWorktreePath = worktree.worktree.path;
            yield* orchestrationEngine.dispatch({
              type: "thread.meta.update",
              commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
              threadId: command.threadId,
              branch: worktree.worktree.refName,
              worktreePath: targetWorktreePath,
            });
            yield* refreshGitStatus(targetWorktreePath);
          }

          yield* runSetupProgram();

          return yield* orchestrationEngine.dispatch(finalTurnStartCommand);
        });

        return yield* bootstrapProgram.pipe(
          Effect.catchCause((cause) => {
            const dispatchError = toBootstrapDispatchCommandCauseError(cause);
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.fail(dispatchError);
            }
            return cleanupCreatedThread().pipe(Effect.flatMap(() => Effect.fail(dispatchError)));
          }),
        );
      });

    return ThreadBootstrapRunner.of({ dispatchBootstrapTurnStart });
  }),
);
