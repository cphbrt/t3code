import {
  CommandId,
  MessageId,
  ThreadId,
  type ModelSelection,
  type OrchestrationThreadShell,
  type ProviderInteractionMode,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadBootstrapRunner } from "../../../orchestration/Services/ThreadBootstrapRunner.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  DEFAULT_SPAWN_DELEGATE_AS,
  MessageThreadError,
  SPAWN_LIMIT_PER_SESSION,
  SpawnThreadError,
  SpawnToolkit,
  type SpawnDelegateAs,
} from "./tools.ts";

/**
 * Spawns consumed per provider session, counted only when a spawn fully lands
 * so a refused attempt costs nothing. Keyed by `providerSessionId`, which is
 * minted per session and never reused, so entries are few and the map is left
 * to die with the process like the credential registry it shadows.
 */
const spawnCountBySession = new Map<string, number>();

/**
 * Claude batches parallel tool calls, so two spawns can land in the same
 * millisecond; a time-only command id would collide in the engine's
 * command-receipt dedupe and silently replay the first receipt. Same counter
 * dodge as `show_chris`.
 */
let spawnCallOrdinal = 0;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const HAND_OFF_CONFIRMATION =
  "Spawned. The new thread is in the sidebar and has started on the prompt. It will not report back here; the user follows it there.";

const TEAMMATE_CONFIRMATION =
  "Spawned as your teammate. It is nested under this thread and has started on the prompt. It already knows how to reach you and needs no id from you, so ask in the prompt for whatever you need back. To send it more context later, call message_thread with the threadId returned here.";

/**
 * Appended to a teammate's opening message, and only a teammate's.
 *
 * A spawned agent otherwise cannot tell it was delegated to: the prompt reads
 * like any other, and nothing in its context names the thread that started it.
 * Claude sessions make this actively worse, because their own peer-messaging
 * tooling lists unrelated sessions and invites picking one — a live Claude turn
 * declined to report back at all rather than guess an id, which was the right
 * call and the wrong outcome.
 *
 * So the delegation is stated in the one place the agent is guaranteed to read,
 * and the parent is deliberately NOT identified by id: `message_thread` with no
 * `threadId` routes upward on its own, and an id the agent never has to handle
 * is an id it cannot get wrong.
 *
 * A hand-off gets none of this, because there is nothing true to say: it has no
 * reply channel, and telling it otherwise would produce a refusal it cannot
 * act on.
 */
const DELEGATION_PREAMBLE = `

---

You are working on behalf of another T3 Code thread, which delegated this task to you and cannot see your transcript.

To report back — a result, an answer, a blocker, or a question — call the \`message_thread\` tool on the \`t3-code\` MCP server with a \`message\` and **no** \`threadId\`. That routes to the thread that started you; T3 Code knows which one it is. Never pass a \`threadId\` you guessed or inferred from a session list, and do not use your own harness's peer- or session-messaging tools for this — they do not reach that thread.

Your reply arrives as that thread's next turn, so there is nothing to wait for here: finish your work and send one message when you have something worth reporting.`;

/**
 * Creates a sibling top-level thread and starts its first turn.
 *
 * Everything not passed as an argument is inherited from the parent thread —
 * provider instance, permission mode, and (by default) project, directory and
 * model — read from the parent's shell row, never from arguments, so a spawn
 * can never escalate or aim outside its own thread's scope. The project is the
 * one derived point: a directory that is exactly a known project's workspace
 * root files the child there. That is labeling, not escalation — the mode
 * still inherits from the parent, and the directory itself was already the
 * agent's to choose. The interaction mode is always "default": a delegation
 * is given work to do, not a plan to propose, even when the parent itself is
 * in plan mode.
 *
 * Bootstrap goes through `ThreadBootstrapRunner`, the same service the
 * client's own `dispatchCommand` uses, so a spawned thread is created,
 * started, and cleaned up after a failure by exactly the code that runs when
 * the user opens a thread by hand — rather than by a second copy of it that
 * can drift.
 */
export const spawnThread = Effect.fn("SpawnToolkit.spawn_thread")(function* (params: {
  readonly prompt: string;
  readonly title: string;
  readonly directory?: string | undefined;
  readonly repositoryPath?: string | undefined;
  readonly baseBranch?: string | undefined;
  readonly model?: string | undefined;
  readonly delegateAs?: SpawnDelegateAs | undefined;
  readonly interactionMode?: ProviderInteractionMode | undefined;
}) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("spawn")) {
    return yield* new SpawnThreadError({
      reason: "capability-unavailable",
      message: "This session's T3 Code credential may not spawn threads.",
    });
  }

  const spent = spawnCountBySession.get(invocation.providerSessionId) ?? 0;
  if (spent >= SPAWN_LIMIT_PER_SESSION) {
    return yield* new SpawnThreadError({
      reason: "spawn-limit-reached",
      message: `This session has already spawned ${SPAWN_LIMIT_PER_SESSION} threads, which is the limit.`,
    });
  }

  const prompt = params.prompt.trim();
  if (prompt === "") {
    return yield* new SpawnThreadError({
      reason: "invalid-argument",
      message: "prompt must not be empty. Pass the new thread's first user message.",
    });
  }
  const title = params.title.trim();
  if (title === "") {
    return yield* new SpawnThreadError({
      reason: "invalid-argument",
      message: "title must not be empty. Pass a short sidebar title for the new thread.",
    });
  }
  const model = params.model?.trim();
  if (model === "") {
    return yield* new SpawnThreadError({
      reason: "invalid-argument",
      message: "model must not be blank. Omit it to use this thread's model.",
    });
  }
  // Both name where the thread works, so accepting both would mean silently
  // honoring one. The refusal says which to keep, since only the agent knows
  // whether the delegated work edits files.
  if (params.directory !== undefined && params.repositoryPath !== undefined) {
    return yield* new SpawnThreadError({
      reason: "invalid-argument",
      message:
        "Pass directory or repositoryPath, not both — they both say where the new thread works. Use repositoryPath to cut it a fresh worktree, which is what you want if it will change files; use directory to put it in a checkout as it stands.",
    });
  }

  // An agent that spawns without an opinion means a hand-off: work started for
  // the user, which the user alone follows. Only an explicit "teammate" opens a
  // reply channel and nests the thread, so the default is the weaker grant.
  const delegateAs = params.delegateAs ?? DEFAULT_SPAWN_DELEGATE_AS;
  const isTeammate = delegateAs === "teammate";

  // A delegation is given work to do, not a plan to propose, so the interaction
  // mode does NOT inherit — a parent in plan mode still spawns a thread that
  // works. The parent may override that explicitly when it wants the approach
  // before the action.
  const interactionMode: ProviderInteractionMode = params.interactionMode ?? "default";

  const projection = yield* ProjectionSnapshotQuery;
  const shell = yield* projection.getThreadShellById(invocation.threadId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("spawn_thread could not read the parent thread shell", {
        threadId: invocation.threadId,
        error,
      }).pipe(
        Effect.andThen(
          Effect.fail(
            new SpawnThreadError({
              reason: "rejected",
              message: "T3 Code could not resolve this thread to spawn from.",
            }),
          ),
        ),
      ),
    ),
  );
  if (Option.isNone(shell)) {
    return yield* new SpawnThreadError({
      reason: "rejected",
      message: "T3 Code could not resolve this thread to spawn from.",
    });
  }
  const parent = shell.value;

  // The directory is validated here, on the machine the new thread would run
  // on, exactly as `show_chris` validates its path.
  //
  // Which project the child files under is derived from the directory, never
  // chosen: a path that is exactly a known project's workspace root files the
  // child under that project (its root is then the natural cwd, so no worktree
  // override); any other path — a worktree, a subdirectory, an unrelated
  // place — rides as a worktree of the parent's project, exactly like a
  // user-created worktree thread. Path containment cannot do better, because
  // real worktrees deliberately live outside their project's workspace root.
  // No project is ever created for an unmatched directory.
  let projectId = parent.projectId;
  let worktreePath = parent.worktreePath;
  if (params.directory !== undefined) {
    const path = yield* Path.Path;
    const rawDirectory = params.directory.trim();
    if (rawDirectory === "" || !path.isAbsolute(rawDirectory)) {
      return yield* new SpawnThreadError({
        reason: "invalid-directory",
        message: `'${params.directory}' is not an absolute path. Pass the full path to a directory, or omit it.`,
      });
    }
    const requestedDirectory = path.resolve(rawDirectory);
    const fileSystem = yield* FileSystem.FileSystem;
    const info = yield* fileSystem.stat(requestedDirectory).pipe(
      Effect.mapError(
        () =>
          new SpawnThreadError({
            reason: "invalid-directory",
            message: `Nothing exists at '${requestedDirectory}'. Pass an existing directory.`,
          }),
      ),
    );
    if (info.type !== "Directory") {
      return yield* new SpawnThreadError({
        reason: "invalid-directory",
        message: `'${requestedDirectory}' is not a directory.`,
      });
    }
    const ownProject = yield* projection.getActiveProjectByWorkspaceRoot(requestedDirectory).pipe(
      Effect.catch((error) =>
        Effect.logWarning("spawn_thread could not look up a project for the directory", {
          threadId: invocation.threadId,
          directory: requestedDirectory,
          error,
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new SpawnThreadError({
                reason: "rejected",
                message: "T3 Code could not resolve the directory's project.",
              }),
            ),
          ),
        ),
      ),
    );
    if (Option.isSome(ownProject)) {
      projectId = ownProject.value.id;
      worktreePath = null;
    } else {
      worktreePath = requestedDirectory;
    }
  }

  // `repositoryPath` is the other shape of "where": rather than taking a
  // checkout as it stands, cut a fresh worktree from a repository so the new
  // thread can edit files without contending with whoever is in the source
  // checkout — including the caller. The thread stays in the caller's project,
  // like any user-created worktree thread, so delegated work remains part of
  // the same piece of work and the thread still has exactly one repository to
  // checkpoint against.
  let prepareWorktree:
    | { readonly projectCwd: string; readonly baseBranch: string; readonly branch: string }
    | undefined;
  if (params.repositoryPath !== undefined) {
    const path = yield* Path.Path;
    const rawPath = params.repositoryPath.trim();
    if (rawPath === "" || !path.isAbsolute(rawPath)) {
      return yield* new SpawnThreadError({
        reason: "invalid-path",
        message: `'${params.repositoryPath}' is not an absolute path. Pass the full path to the repository.`,
      });
    }
    // Normalize after the absolute check so `/a/b/../c` and `/a/c` name one
    // repository, matching how `show_chris` records the paths it is given.
    const repositoryPath = path.resolve(rawPath);
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    const status = yield* gitWorkflow.localStatus({ cwd: repositoryPath }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("spawn_thread could not read the requested repository", {
          threadId: invocation.threadId,
          repositoryPath,
          error,
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new SpawnThreadError({
                reason: "not-a-repository",
                message: `T3 Code could not read a git repository at '${repositoryPath}'.`,
              }),
            ),
          ),
        ),
      ),
    );
    if (!status.isRepo) {
      return yield* new SpawnThreadError({
        reason: "not-a-repository",
        message: `'${repositoryPath}' is not a git repository. A worktree can only be cut from one.`,
      });
    }
    // Without a base the worktree is cut from wherever the repository
    // currently stands, which is what a person picking "new thread" there
    // would get.
    const baseBranch = params.baseBranch?.trim() || status.refName;
    if (!baseBranch) {
      return yield* new SpawnThreadError({
        reason: "not-a-repository",
        message: `'${repositoryPath}' has no branch checked out, so there is nothing to base a worktree on. Pass baseBranch.`,
      });
    }
    // A temporary branch is not optional. Without one the bootstrap runs
    // `git worktree add <path> <baseBranch>`, which tries to CHECK OUT the
    // base branch — and git refuses, because the base is already checked out
    // in the repository we are cutting from. Naming a new branch makes it
    // `worktree add -b <new> <path> <base>`, which branches instead. Same
    // helper and same reason as the composer's own worktree path.
    const crypto = yield* Crypto.Crypto;
    const branchToken = yield* crypto.randomBytes(4).pipe(
      Effect.map((bytes) => Encoding.encodeHex(bytes)),
      Effect.orDie,
    );
    prepareWorktree = {
      projectCwd: repositoryPath,
      baseBranch,
      branch: buildTemporaryWorktreeBranchName(() => branchToken),
    };
    // The runner records the worktree it actually resolved, so the create
    // carries none.
    worktreePath = null;
  }

  // A different model drops the parent's per-model option selections rather
  // than carrying settings chosen for another model.
  const modelSelection: ModelSelection =
    model !== undefined
      ? { instanceId: parent.modelSelection.instanceId, model }
      : parent.modelSelection;

  const crypto = yield* Crypto.Crypto;
  const threadId = ThreadId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
  const messageId = MessageId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
  const millis = yield* Clock.currentTimeMillis;
  const createdAt = yield* nowIso;
  spawnCallOrdinal += 1;
  const commandId = (step: string) =>
    CommandId.make(`spawn-${step}:${invocation.providerSessionId}:${millis}:${spawnCallOrdinal}`);

  const runner = yield* ThreadBootstrapRunner;
  yield* runner
    .dispatchBootstrapTurnStart({
      type: "thread.turn.start",
      commandId: commandId("bootstrap"),
      threadId,
      message: {
        messageId,
        role: "user",
        // Only a teammate is told it was delegated to and how to reply. A
        // hand-off has no reply channel, so saying so would be false.
        text: isTeammate ? `${prompt}${DELEGATION_PREAMBLE}` : prompt,
        attachments: [],
      },
      modelSelection,
      runtimeMode: parent.runtimeMode,
      interactionMode,
      titleSeed: title,
      bootstrap: {
        createThread: {
          projectId,
          title,
          modelSelection,
          runtimeMode: parent.runtimeMode,
          interactionMode,
          branch: null,
          worktreePath,
          // Recorded only for a teammate. A hand-off is genuinely the user's
          // sibling thread, so it has no parent to nest under and no parent to
          // authorize messaging against — the mode and the authorization are
          // the same fact.
          ...(isTeammate ? { parentThreadId: invocation.threadId } : {}),
          createdAt,
        },
        ...(prepareWorktree ? { prepareWorktree, runSetupScript: true } : {}),
      },
      createdAt,
    })
    .pipe(
      // The runner owns the compensating delete, so a bootstrap that fails
      // after creating the thread never leaves an empty sidebar row behind.
      Effect.catch((error) =>
        Effect.logWarning("spawn_thread bootstrap rejected", {
          threadId: invocation.threadId,
          spawnedThreadId: threadId,
          error,
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new SpawnThreadError({
                reason: "rejected",
                message: `T3 Code refused to spawn the thread: ${error.message}`,
              }),
            ),
          ),
        ),
      ),
    );

  spawnCountBySession.set(invocation.providerSessionId, spent + 1);
  return {
    threadId,
    title,
    message: isTeammate ? TEAMMATE_CONFIRMATION : HAND_OFF_CONFIRMATION,
  };
});

/**
 * Reads a thread's shell row. A projection read failure and a missing row lead
 * to the same refusal here, and the tool's own error says more to an agent than
 * a SQL fault would; the cause is logged rather than dropped.
 */
const readThreadShell = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projection = yield* ProjectionSnapshotQuery;
    return yield* projection.getThreadShellById(threadId);
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("message_thread could not read a thread shell", { threadId, cause }).pipe(
        Effect.as(Option.none<OrchestrationThreadShell>()),
      ),
    ),
  );

/**
 * Delivers a message between a thread and its parent, in either direction.
 *
 * Parentage is the entire authorization model, and both ends of it are read
 * from projection rows rather than from arguments: the caller's thread comes
 * from the credential, and the recipient's parent pointer comes from its own
 * row. An agent therefore cannot forge a relationship it does not have.
 *
 * Sibling and child-to-child messaging is deliberately out of scope. This
 * checks a single parent pointer in each direction; a team would need a
 * persisted team entity, which is a separate decision.
 */
export const messageThread = Effect.fn("SpawnToolkit.message_thread")(function* (params: {
  readonly threadId?: string | undefined;
  readonly message: string;
}) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("spawn")) {
    return yield* new MessageThreadError({
      reason: "capability-unavailable",
      message: "This session's T3 Code credential may not message other threads.",
    });
  }

  const message = params.message.trim();
  if (message === "") {
    return yield* new MessageThreadError({
      reason: "invalid-argument",
      message: "message must not be empty. Pass what you want the other thread to read.",
    });
  }

  const caller = yield* readThreadShell(invocation.threadId);
  if (Option.isNone(caller)) {
    return yield* new MessageThreadError({
      reason: "rejected",
      message: "T3 Code could not read your own thread, so it cannot check who you may message.",
    });
  }

  // An omitted recipient means "whoever spawned me". The agent is never told
  // its parent's id — it has no way to learn one it did not create — so
  // requiring the id here would make replying upward impossible, and inviting a
  // guess would deliver a report to an unrelated thread. The server already
  // knows the answer, so it answers.
  const requestedThreadId = params.threadId?.trim();
  const targetThreadId = requestedThreadId
    ? ThreadId.make(requestedThreadId)
    : (caller.value.parentThreadId ?? null);
  if (targetThreadId === null) {
    return yield* new MessageThreadError({
      reason: "not-related",
      message:
        "No thread spawned this one as a teammate, so there is nobody to reply to. Pass the threadId of a teammate you spawned yourself if that is what you meant.",
    });
  }
  if (targetThreadId === invocation.threadId) {
    return yield* new MessageThreadError({
      reason: "not-related",
      message: "That is your own thread. Messaging yourself would only start another turn here.",
    });
  }

  const target = yield* readThreadShell(targetThreadId);
  if (Option.isNone(target)) {
    return yield* new MessageThreadError({
      reason: "not-found",
      message: `No active thread with id '${targetThreadId}' exists here.`,
    });
  }

  const targetIsChild = target.value.parentThreadId === invocation.threadId;
  const targetIsParent = caller.value.parentThreadId === targetThreadId;
  if (!targetIsChild && !targetIsParent) {
    return yield* new MessageThreadError({
      reason: "not-related",
      message:
        "You may only message the thread that spawned you as a teammate, or a teammate you spawned yourself.",
    });
  }

  const millis = yield* Clock.currentTimeMillis;
  spawnCallOrdinal += 1;
  const createdAt = yield* nowIso;
  const suffix = `${invocation.providerSessionId}:${millis}:${spawnCallOrdinal}`;

  const engine = yield* OrchestrationEngineService;
  yield* engine
    .dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`thread-message:${suffix}`),
      threadId: targetThreadId,
      message: {
        messageId: MessageId.make(`message-thread-${suffix}`),
        role: "user",
        text: message,
        attachments: [],
      },
      // The recipient keeps running as itself: its own model, runtime, and
      // interaction mode. A message is a turn in that thread, not a takeover
      // of it.
      modelSelection: target.value.modelSelection,
      runtimeMode: target.value.runtimeMode,
      interactionMode: target.value.interactionMode,
      createdAt,
    })
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning("message_thread delivery rejected", {
          threadId: invocation.threadId,
          targetThreadId,
          error,
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new MessageThreadError({
                reason: "rejected",
                message: `T3 Code could not deliver that message: ${error.message}`,
              }),
            ),
          ),
        ),
      ),
    );

  return {
    threadId: targetThreadId,
    message:
      "Delivered. It arrives as that thread's next turn, so if it is working now it will finish first. There is no reply to wait for here; if you asked for one it will reach you as a message of its own.",
  };
});

export const SpawnToolkitHandlersLive = SpawnToolkit.toLayer({
  spawn_thread: spawnThread,
  message_thread: messageThread,
});

/** Exposed for tests. */
export const __testing = {
  resetSpawnCounts: () => spawnCountBySession.clear(),
};
