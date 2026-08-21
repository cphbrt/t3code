import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { OrchestrationDispatchCommandError } from "@t3tools/contracts";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import {
  ThreadBootstrapRunner,
  type ThreadTurnStartCommand,
} from "../../../orchestration/Services/ThreadBootstrapRunner.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { messageThread, spawnThread } from "./handlers.ts";
import { SPAWN_LIMIT_PER_SESSION } from "./tools.ts";

const PARENT_THREAD_ID = ThreadId.make("thread-parent");

const makeScope = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
  providerSessionId: string,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: PARENT_THREAD_ID,
  providerSessionId,
  providerInstanceId: ProviderInstanceId.make("claude"),
  capabilities: new Set(capabilities),
  issuedAt: 0,
});

const parentShell: OrchestrationThreadShell = {
  id: PARENT_THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Parent thread",
  modelSelection: {
    instanceId: ProviderInstanceId.make("claude"),
    model: "claude-haiku-4-5",
    options: [{ id: "effort", value: "high" }],
  },
  runtimeMode: "auto",
  interactionMode: "plan",
  branch: null,
  worktreePath: "/tmp/synthetic-parent-worktree",
  latestTurn: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  unreadArtifactCount: 0,
};

const makeProjection = (
  shell: Option.Option<OrchestrationThreadShell>,
  projectsByRoot: ReadonlyMap<string, ProjectId> = new Map(),
): ProjectionSnapshotQuery["Service"] =>
  ({
    getThreadShellById: () => Effect.succeed(shell),
    getActiveProjectByWorkspaceRoot: (workspaceRoot: string) => {
      const id = projectsByRoot.get(workspaceRoot);
      return Effect.succeed(id === undefined ? Option.none() : Option.some({ id, workspaceRoot }));
    },
  }) as unknown as ProjectionSnapshotQuery["Service"];

/**
 * The handler dispatches one bootstrap command rather than a create/turn pair:
 * `ThreadBootstrapRunner` owns thread creation, the turn start, and the
 * compensating delete, and `server.test.ts` proves that behavior against the
 * real service. These tests assert what the handler asks the runner for.
 */
const makeRunner = (
  dispatchBootstrapTurnStart: ThreadBootstrapRunner["Service"]["dispatchBootstrapTurnStart"],
): ThreadBootstrapRunner["Service"] => ({ dispatchBootstrapTurnStart });

/**
 * Only `localStatus` is reached: the handler asks whether a `repositoryPath`
 * is a repository and what it has checked out, then hands the worktree cut
 * itself to `ThreadBootstrapRunner`.
 */
const makeGit = (
  localStatus: (input: {
    readonly cwd: string;
  }) => Effect.Effect<{ readonly isRepo: boolean; readonly refName: string | null }, unknown>,
): GitWorkflowService.GitWorkflowService["Service"] =>
  ({ localStatus }) as unknown as GitWorkflowService.GitWorkflowService["Service"];

const repositoryGit = (refName: string | null = "main") =>
  makeGit(() => Effect.succeed({ isRepo: true, refName }));

const recordingRunner = (bootstrapped: ThreadTurnStartCommand[]) =>
  makeRunner((command) =>
    Effect.sync(() => {
      bootstrapped.push(command);
      return { sequence: 1 };
    }),
  );

const provideAll =
  (
    runner: ThreadBootstrapRunner["Service"],
    scope: McpInvocationContext.McpInvocationScope,
    shell: Option.Option<OrchestrationThreadShell> = Option.some(parentShell),
    projectsByRoot: ReadonlyMap<string, ProjectId> = new Map(),
    git: GitWorkflowService.GitWorkflowService["Service"] = repositoryGit(),
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ThreadBootstrapRunner, runner),
      Effect.provideService(ProjectionSnapshotQuery, makeProjection(shell, projectsByRoot)),
      Effect.provideService(GitWorkflowService.GitWorkflowService, git),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    );

/** The create half of the single bootstrap command, which every spawn carries. */
const createOf = (command: ThreadTurnStartCommand | undefined) => {
  const create = command?.bootstrap?.createThread;
  if (!create) throw new Error("expected a bootstrap createThread");
  return create;
};

it.layer(NodeServices.layer)("spawn_thread handler", (it) => {
  it.effect("creates a sibling thread and starts its first turn with inherited scope", () =>
    Effect.gen(function* () {
      const bootstrapped: ThreadTurnStartCommand[] = [];
      const result = yield* spawnThread({
        prompt: "Review the flaky test in apps/server.",
        title: "Flaky test review",
      }).pipe(provideAll(recordingRunner(bootstrapped), makeScope(["spawn"], "session-inherit")));

      expect(bootstrapped).toHaveLength(1);
      const turn = bootstrapped[0];
      if (!turn) throw new Error("expected a bootstrap turn start");
      const create = createOf(turn);
      // Everything not an argument is inherited from the parent shell — except
      // the interaction mode, which is always "default": a delegation is given
      // work to do even when the parent is in plan mode.
      expect(create.projectId).toBe(parentShell.projectId);
      expect(create.modelSelection).toEqual(parentShell.modelSelection);
      expect(create.runtimeMode).toBe("auto");
      expect(create.interactionMode).toBe("default");
      expect(create.worktreePath).toBe(parentShell.worktreePath);
      expect(turn.threadId).not.toBe(PARENT_THREAD_ID);
      expect(turn.runtimeMode).toBe("auto");
      expect(turn.interactionMode).toBe("default");
      expect(turn.message.text).toBe("Review the flaky test in apps/server.");
      expect(result.threadId).toBe(turn.threadId);
    }),
  );

  it.effect("treats an unmatched directory as a worktree of the parent's project", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const bootstrapped: ThreadTurnStartCommand[] = [];
      yield* spawnThread({
        prompt: "Work over there.",
        title: "Elsewhere",
        directory,
      }).pipe(provideAll(recordingRunner(bootstrapped), makeScope(["spawn"], "session-directory")));

      const create = createOf(bootstrapped[0]);
      expect(create.projectId).toBe(parentShell.projectId);
      expect(create.worktreePath).toBe(directory);
    }).pipe(Effect.scoped),
  );

  it.effect("files the thread under the project whose root the directory names", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const otherProjectId = ProjectId.make("project-other");
      const bootstrapped: ThreadTurnStartCommand[] = [];
      yield* spawnThread({
        prompt: "Work in the other repo.",
        title: "Other repo",
        directory,
      }).pipe(
        provideAll(
          recordingRunner(bootstrapped),
          makeScope(["spawn"], "session-other-project"),
          Option.some(parentShell),
          new Map([[directory, otherProjectId]]),
        ),
      );

      const create = createOf(bootstrapped[0]);
      // The project root is the thread's natural cwd, so no worktree override.
      expect(create.projectId).toBe(otherProjectId);
      expect(create.worktreePath).toBeNull();
      // Mode still inherits from the parent thread, not the target project.
      expect(create.runtimeMode).toBe(parentShell.runtimeMode);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a relative directory without dispatching", () =>
    Effect.gen(function* () {
      const bootstrapped: ThreadTurnStartCommand[] = [];
      const error = yield* spawnThread({
        prompt: "Work over there.",
        title: "Elsewhere",
        directory: "some/relative/place",
      }).pipe(
        provideAll(recordingRunner(bootstrapped), makeScope(["spawn"], "session-relative")),
        Effect.flip,
      );

      expect(error.reason).toBe("invalid-directory");
      expect(bootstrapped).toHaveLength(0);
    }),
  );

  it.effect("refuses a directory with nothing at it", () =>
    Effect.gen(function* () {
      const bootstrapped: ThreadTurnStartCommand[] = [];
      const error = yield* spawnThread({
        prompt: "Work over there.",
        title: "Elsewhere",
        directory: "/tmp/t3-spawn-does-not-exist/nowhere",
      }).pipe(
        provideAll(recordingRunner(bootstrapped), makeScope(["spawn"], "session-missing-dir")),
        Effect.flip,
      );

      expect(error.reason).toBe("invalid-directory");
      expect(bootstrapped).toHaveLength(0);
    }),
  );

  it.effect("keeps the provider instance and drops options when the model is overridden", () =>
    Effect.gen(function* () {
      const bootstrapped: ThreadTurnStartCommand[] = [];
      yield* spawnThread({
        prompt: "Cheap sweep.",
        title: "Sweep",
        model: "claude-sonnet-5",
      }).pipe(provideAll(recordingRunner(bootstrapped), makeScope(["spawn"], "session-model")));

      const create = createOf(bootstrapped[0]);
      expect(create.modelSelection).toEqual({
        instanceId: parentShell.modelSelection.instanceId,
        model: "claude-sonnet-5",
      });
    }),
  );

  it.effect("cuts a fresh worktree on a new branch when a repository is named", () =>
    Effect.gen(function* () {
      const bootstrapped: ThreadTurnStartCommand[] = [];
      yield* spawnThread({
        prompt: "Fix the flaky test over there.",
        title: "Other repo",
        repositoryPath: "/synthetic/repo",
      }).pipe(provideAll(recordingRunner(bootstrapped), makeScope(["spawn"], "session-worktree")));

      const turn = bootstrapped[0];
      if (!turn) throw new Error("expected a bootstrap turn start");
      const prepare = turn.bootstrap?.prepareWorktree;
      if (!prepare) throw new Error("expected a bootstrap prepareWorktree");
      expect(prepare.projectCwd).toBe("/synthetic/repo");
      // Defaults to whatever the repository has checked out.
      expect(prepare.baseBranch).toBe("main");
      // A NEW branch, not the base: `worktree add <path> <base>` would try to
      // check out a branch the source repository already has checked out, and
      // git refuses. Naming a branch makes it `worktree add -b`.
      expect(prepare.branch).not.toBe("main");
      expect(prepare.branch).toBeTruthy();
      // The runner records the worktree it resolves, so the create carries none.
      expect(createOf(turn).worktreePath).toBeNull();
      // Delegated work stays part of the caller's project even in another
      // repository, so the thread keeps exactly one repository to checkpoint.
      expect(createOf(turn).projectId).toBe(parentShell.projectId);
      expect(turn.bootstrap?.runSetupScript).toBe(true);
    }),
  );

  it.effect("normalizes the repository path and honours an explicit base branch", () =>
    Effect.gen(function* () {
      const bootstrapped: ThreadTurnStartCommand[] = [];
      yield* spawnThread({
        prompt: "Work from the release branch.",
        title: "Release fix",
        repositoryPath: "/synthetic/repo/nested/../",
        baseBranch: "release",
      }).pipe(provideAll(recordingRunner(bootstrapped), makeScope(["spawn"], "session-base")));

      const prepare = bootstrapped[0]?.bootstrap?.prepareWorktree;
      if (!prepare) throw new Error("expected a bootstrap prepareWorktree");
      expect(prepare.projectCwd).toBe("/synthetic/repo");
      expect(prepare.baseBranch).toBe("release");
    }),
  );

  it.effect("refuses a relative repository path", () =>
    Effect.gen(function* () {
      const bootstrapped: ThreadTurnStartCommand[] = [];
      const error = yield* spawnThread({
        prompt: "Hi.",
        title: "Hi",
        repositoryPath: "relative/repo",
      }).pipe(
        provideAll(recordingRunner(bootstrapped), makeScope(["spawn"], "session-rel-repo")),
        Effect.flip,
      );

      expect(error.reason).toBe("invalid-path");
      expect(bootstrapped).toHaveLength(0);
    }),
  );

  it.effect("refuses a path that is not a git repository", () =>
    Effect.gen(function* () {
      const bootstrapped: ThreadTurnStartCommand[] = [];
      const error = yield* spawnThread({
        prompt: "Hi.",
        title: "Hi",
        repositoryPath: "/synthetic/not-a-repo",
      }).pipe(
        provideAll(
          recordingRunner(bootstrapped),
          makeScope(["spawn"], "session-not-repo"),
          Option.some(parentShell),
          new Map(),
          makeGit(() => Effect.succeed({ isRepo: false, refName: null })),
        ),
        Effect.flip,
      );

      expect(error.reason).toBe("not-a-repository");
      expect(bootstrapped).toHaveLength(0);
    }),
  );

  it.effect("refuses a repository with nothing checked out and no base branch", () =>
    Effect.gen(function* () {
      const bootstrapped: ThreadTurnStartCommand[] = [];
      const error = yield* spawnThread({
        prompt: "Hi.",
        title: "Hi",
        repositoryPath: "/synthetic/detached",
      }).pipe(
        provideAll(
          recordingRunner(bootstrapped),
          makeScope(["spawn"], "session-detached"),
          Option.some(parentShell),
          new Map(),
          repositoryGit(null),
        ),
        Effect.flip,
      );

      expect(error.reason).toBe("not-a-repository");
      expect(error.message).toContain("baseBranch");
      expect(bootstrapped).toHaveLength(0);
    }),
  );

  it.effect("refuses directory and repositoryPath together rather than picking one", () =>
    Effect.gen(function* () {
      const bootstrapped: ThreadTurnStartCommand[] = [];
      const error = yield* spawnThread({
        prompt: "Hi.",
        title: "Hi",
        directory: "/synthetic/dir",
        repositoryPath: "/synthetic/repo",
      }).pipe(
        provideAll(recordingRunner(bootstrapped), makeScope(["spawn"], "session-both")),
        Effect.flip,
      );

      expect(error.reason).toBe("invalid-argument");
      expect(bootstrapped).toHaveLength(0);
    }),
  );

  // Chris's original behavior: no repositoryPath means no worktree is cut, and
  // the thread takes the parent's directory as it stands.
  it.effect("cuts no worktree when no repository is named", () =>
    Effect.gen(function* () {
      const bootstrapped: ThreadTurnStartCommand[] = [];
      yield* spawnThread({ prompt: "In place.", title: "In place" }).pipe(
        provideAll(recordingRunner(bootstrapped), makeScope(["spawn"], "session-no-worktree")),
      );

      const turn = bootstrapped[0];
      expect(turn?.bootstrap?.prepareWorktree).toBeUndefined();
      expect(createOf(turn).worktreePath).toBe(parentShell.worktreePath);
    }),
  );

  it.effect("refuses a credential without the spawn capability", () =>
    Effect.gen(function* () {
      const bootstrapped: ThreadTurnStartCommand[] = [];
      const error = yield* spawnThread({ prompt: "Hi.", title: "Hi" }).pipe(
        provideAll(
          recordingRunner(bootstrapped),
          makeScope(["preview", "settle", "usage", "artifact"], "session-no-cap"),
        ),
        Effect.flip,
      );

      expect(error._tag).toBe("SpawnThreadError");
      expect(error.reason).toBe("capability-unavailable");
      expect(bootstrapped).toHaveLength(0);
    }),
  );

  it.effect("stops at the per-session spawn limit, counting only successful spawns", () =>
    Effect.gen(function* () {
      const bootstrapped: ThreadTurnStartCommand[] = [];
      const scope = makeScope(["spawn"], "session-cap");
      const provide = provideAll(recordingRunner(bootstrapped), scope);

      // A refused attempt must not consume the allowance.
      yield* spawnThread({ prompt: "", title: "Empty" }).pipe(provide, Effect.flip);

      for (let index = 0; index < SPAWN_LIMIT_PER_SESSION; index += 1) {
        yield* spawnThread({ prompt: `Task ${index}.`, title: `Task ${index}` }).pipe(provide);
      }
      const error = yield* spawnThread({ prompt: "One more.", title: "Overflow" }).pipe(
        provide,
        Effect.flip,
      );

      expect(error.reason).toBe("spawn-limit-reached");
      // One bootstrap per successful spawn, nothing for the refusals.
      expect(bootstrapped).toHaveLength(SPAWN_LIMIT_PER_SESSION);
    }),
  );

  // The runner performs the compensating delete itself, proven against the
  // real service in `server.test.ts`. What the handler owes the agent is the
  // reason the bootstrap failed, in words it can act on.
  it.effect("reports the bootstrap failure's own reason and spends no allowance", () =>
    Effect.gen(function* () {
      const scope = makeScope(["spawn"], "session-bootstrap-failed");
      const runner = makeRunner(() =>
        Effect.fail(new OrchestrationDispatchCommandError({ message: "no provider available" })),
      );
      const error = yield* spawnThread({ prompt: "Doomed.", title: "Doomed" }).pipe(
        provideAll(runner, scope),
        Effect.flip,
      );

      expect(error.reason).toBe("rejected");
      expect(error.message).toContain("no provider available");

      // A failed spawn must not consume the session's allowance.
      const bootstrapped: ThreadTurnStartCommand[] = [];
      yield* spawnThread({ prompt: "Retry.", title: "Retry" }).pipe(
        provideAll(recordingRunner(bootstrapped), scope),
      );
      expect(bootstrapped).toHaveLength(1);
    }),
  );

  // Decision: the two delegations are different grants, so the default is the
  // weaker one. An agent spawning without an opinion means a hand-off.
  it.effect("defaults to a hand-off with no parent recorded and no preamble", () =>
    Effect.gen(function* () {
      const bootstrapped: ThreadTurnStartCommand[] = [];
      const result = yield* spawnThread({
        prompt: "Look into the build.",
        title: "Build",
      }).pipe(provideAll(recordingRunner(bootstrapped), makeScope(["spawn"], "session-handoff")));

      const turn = bootstrapped[0];
      if (!turn) throw new Error("expected a bootstrap turn start");
      // No parent: a hand-off is genuinely the user's sibling thread, so it
      // neither nests nor gains a reply channel.
      expect(createOf(turn).parentThreadId).toBeUndefined();
      // And it is not told about a channel it does not have.
      expect(turn.message.text).toBe("Look into the build.");
      expect(turn.message.text).not.toContain("message_thread");
      expect(result.message).toContain("will not report back");
    }),
  );

  it.effect("records the parent and teaches the reply route for a teammate", () =>
    Effect.gen(function* () {
      const bootstrapped: ThreadTurnStartCommand[] = [];
      const result = yield* spawnThread({
        prompt: "Find out which migration broke it.",
        title: "Migration hunt",
        delegateAs: "teammate",
      }).pipe(provideAll(recordingRunner(bootstrapped), makeScope(["spawn"], "session-teammate")));

      const turn = bootstrapped[0];
      if (!turn) throw new Error("expected a bootstrap turn start");
      // Parentage is both the nesting signal and the authorization model.
      expect(createOf(turn).parentThreadId).toBe(PARENT_THREAD_ID);
      expect(turn.message.text).toContain("Find out which migration broke it.");
      // Told how to reply, and told NOT to guess an id — the id it would guess
      // is the one thing it can get wrong.
      expect(turn.message.text).toContain("message_thread");
      expect(turn.message.text).toContain("**no** `threadId`");
      expect(result.message).toContain("teammate");
    }),
  );

  it.effect("forces the delegation to work rather than plan, and lets the parent say plan", () =>
    Effect.gen(function* () {
      const scope = makeScope(["spawn"], "session-interaction");
      // The parent shell is in plan mode; the delegation still gets work.
      expect(parentShell.interactionMode).toBe("plan");

      const forced: ThreadTurnStartCommand[] = [];
      yield* spawnThread({ prompt: "Do it.", title: "Do it" }).pipe(
        provideAll(recordingRunner(forced), scope),
      );
      expect(forced[0]?.interactionMode).toBe("default");
      expect(createOf(forced[0]).interactionMode).toBe("default");

      const overridden: ThreadTurnStartCommand[] = [];
      yield* spawnThread({
        prompt: "Propose an approach first.",
        title: "Approach",
        interactionMode: "plan",
      }).pipe(provideAll(recordingRunner(overridden), scope));
      expect(overridden[0]?.interactionMode).toBe("plan");
      expect(createOf(overridden[0]).interactionMode).toBe("plan");
    }),
  );

  it.effect("rejects when the parent thread shell cannot be resolved", () =>
    Effect.gen(function* () {
      const bootstrapped: ThreadTurnStartCommand[] = [];
      const error = yield* spawnThread({ prompt: "Hi.", title: "Hi" }).pipe(
        provideAll(
          recordingRunner(bootstrapped),
          makeScope(["spawn"], "session-gone"),
          Option.none(),
        ),
        Effect.flip,
      );

      expect(error.reason).toBe("rejected");
      expect(bootstrapped).toHaveLength(0);
    }),
  );
});

const CHILD_THREAD_ID = ThreadId.make("thread-child");

const childShell: OrchestrationThreadShell = {
  ...parentShell,
  id: CHILD_THREAD_ID,
  title: "Child thread",
  parentThreadId: PARENT_THREAD_ID,
  interactionMode: "default",
};

const unrelatedShell: OrchestrationThreadShell = {
  ...parentShell,
  id: ThreadId.make("thread-unrelated"),
  title: "Unrelated thread",
};

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

/**
 * `message_thread` reads two shells: the caller's, keyed by the credential, and
 * the recipient's, keyed by the id under test. Both come from projection rows,
 * never from arguments, which is what makes parentage unforgeable.
 */
const provideMessaging =
  (
    engine: OrchestrationEngineService["Service"],
    scope: McpInvocationContext.McpInvocationScope,
    shellsById: ReadonlyMap<string, OrchestrationThreadShell>,
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(OrchestrationEngineService, engine),
      Effect.provideService(ProjectionSnapshotQuery, {
        getThreadShellById: (threadId: string) => {
          const shell = shellsById.get(threadId);
          return Effect.succeed(shell === undefined ? Option.none() : Option.some(shell));
        },
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
      } as unknown as ProjectionSnapshotQuery["Service"]),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    );

const parentAndChild = new Map([
  [PARENT_THREAD_ID, parentShell],
  [CHILD_THREAD_ID, childShell],
]);

const childScope = (providerSessionId: string) => ({
  ...makeScope(["spawn"], providerSessionId),
  threadId: CHILD_THREAD_ID,
});

it.effect("delivers a child's reply upward with no threadId given", () =>
  Effect.gen(function* () {
    const dispatched: OrchestrationCommand[] = [];
    const result = yield* messageThread({ message: "Migration 041 broke it." }).pipe(
      provideMessaging(recordingEngine(dispatched), childScope("session-up"), parentAndChild),
    );

    expect(result.threadId).toBe(PARENT_THREAD_ID);
    expect(dispatched).toHaveLength(1);
    const turn = dispatched[0];
    if (turn?.type !== "thread.turn.start") throw new Error("expected thread.turn.start");
    expect(turn.threadId).toBe(PARENT_THREAD_ID);
    expect(turn.message.text).toBe("Migration 041 broke it.");
    // The recipient keeps running as itself: a message is a turn in that
    // thread, not a takeover of it.
    expect(turn.interactionMode).toBe(parentShell.interactionMode);
    expect(turn.modelSelection).toEqual(parentShell.modelSelection);
  }),
);

it.effect("delivers a parent's instruction down to a thread it spawned", () =>
  Effect.gen(function* () {
    const dispatched: OrchestrationCommand[] = [];
    const result = yield* messageThread({
      threadId: CHILD_THREAD_ID,
      message: "Skip the flaky one for now.",
    }).pipe(
      provideMessaging(
        recordingEngine(dispatched),
        makeScope(["spawn"], "session-down"),
        parentAndChild,
      ),
    );

    expect(result.threadId).toBe(CHILD_THREAD_ID);
    const turn = dispatched[0];
    if (turn?.type !== "thread.turn.start") throw new Error("expected thread.turn.start");
    expect(turn.threadId).toBe(CHILD_THREAD_ID);
    expect(turn.interactionMode).toBe(childShell.interactionMode);
  }),
);

it.effect("refuses a thread with no parent to reply to, and says what to do instead", () =>
  Effect.gen(function* () {
    const dispatched: OrchestrationCommand[] = [];
    const error = yield* messageThread({ message: "Anyone there?" }).pipe(
      provideMessaging(
        recordingEngine(dispatched),
        makeScope(["spawn"], "session-orphan"),
        parentAndChild,
      ),
      Effect.flip,
    );

    expect(error.reason).toBe("not-related");
    // This is the refusal an agent must be able to act on, so it must name the
    // alternative rather than only stating the failure.
    expect(error.message).toContain("threadId");
    expect(dispatched).toHaveLength(0);
  }),
);

it.effect("refuses an unrelated thread even when it exists", () =>
  Effect.gen(function* () {
    const dispatched: OrchestrationCommand[] = [];
    const error = yield* messageThread({
      threadId: unrelatedShell.id,
      message: "Do my bidding.",
    }).pipe(
      provideMessaging(
        recordingEngine(dispatched),
        childScope("session-unrelated"),
        new Map([...parentAndChild, [unrelatedShell.id, unrelatedShell]]),
      ),
      Effect.flip,
    );

    // Parentage is the entire authorization model: without it any agent could
    // drive any thread on this machine.
    expect(error.reason).toBe("not-related");
    expect(dispatched).toHaveLength(0);
  }),
);

it.effect("refuses a sibling, which is out of scope rather than merely unbuilt", () =>
  Effect.gen(function* () {
    const siblingId = ThreadId.make("thread-sibling");
    const siblingShell: OrchestrationThreadShell = {
      ...childShell,
      id: siblingId,
      title: "Sibling thread",
    };
    const dispatched: OrchestrationCommand[] = [];
    const error = yield* messageThread({ threadId: siblingId, message: "Hey sibling." }).pipe(
      provideMessaging(
        recordingEngine(dispatched),
        childScope("session-sibling"),
        new Map([...parentAndChild, [siblingId, siblingShell]]),
      ),
      Effect.flip,
    );

    // Both threads share a parent, which is deliberately not a relationship
    // this tool honours; a team would need a persisted team entity.
    expect(error.reason).toBe("not-related");
    expect(dispatched).toHaveLength(0);
  }),
);

it.effect("refuses a thread that does not exist", () =>
  Effect.gen(function* () {
    const dispatched: OrchestrationCommand[] = [];
    const error = yield* messageThread({
      threadId: "thread-imaginary",
      message: "Hello?",
    }).pipe(
      provideMessaging(
        recordingEngine(dispatched),
        makeScope(["spawn"], "session-ghost"),
        parentAndChild,
      ),
      Effect.flip,
    );

    expect(error.reason).toBe("not-found");
    expect(dispatched).toHaveLength(0);
  }),
);

it.effect("refuses messaging itself", () =>
  Effect.gen(function* () {
    const dispatched: OrchestrationCommand[] = [];
    const error = yield* messageThread({
      threadId: PARENT_THREAD_ID,
      message: "Note to self.",
    }).pipe(
      provideMessaging(
        recordingEngine(dispatched),
        makeScope(["spawn"], "session-self"),
        parentAndChild,
      ),
      Effect.flip,
    );

    expect(error.reason).toBe("not-related");
    expect(dispatched).toHaveLength(0);
  }),
);

it.effect("refuses an empty message and a credential without the capability", () =>
  Effect.gen(function* () {
    const dispatched: OrchestrationCommand[] = [];
    const empty = yield* messageThread({ message: "   " }).pipe(
      provideMessaging(recordingEngine(dispatched), childScope("session-empty"), parentAndChild),
      Effect.flip,
    );
    expect(empty.reason).toBe("invalid-argument");

    const uncapable = yield* messageThread({ message: "Hi." }).pipe(
      provideMessaging(
        recordingEngine(dispatched),
        { ...childScope("session-msg-no-cap"), capabilities: new Set(["usage" as const]) },
        parentAndChild,
      ),
      Effect.flip,
    );
    expect(uncapable.reason).toBe("capability-unavailable");
    expect(dispatched).toHaveLength(0);
  }),
);
