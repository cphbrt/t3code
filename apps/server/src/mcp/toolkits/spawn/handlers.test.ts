import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionSelection,
  type ServerProvider,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { OrchestrationDispatchCommandError } from "@t3tools/contracts";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
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

const PARENT_MODEL_SLUG = parentShell.modelSelection.model;
const PARENT_INSTANCE_ID = parentShell.modelSelection.instanceId;

/**
 * A snapshot carrying the model the parent thread runs on. `agentDescriptor`
 * decides whether that model advertises the probe-injected `agent` select — the
 * one fact the gate consults, so it is expressed as the descriptor the real
 * probe emits rather than a boolean the fake could answer on its own.
 */
const makeProviderSnapshot = (input: {
  readonly slug?: string;
  readonly agentDescriptor: boolean;
}): ServerProvider =>
  ({
    instanceId: PARENT_INSTANCE_ID,
    driver: ProviderDriverKind.make("claudeAgent"),
    status: "ready",
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      {
        slug: input.slug ?? PARENT_MODEL_SLUG,
        name: "Haiku",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              options: [{ id: "medium", label: "Medium", isDefault: true }],
            },
            ...(input.agentDescriptor
              ? [
                  {
                    id: "agent",
                    label: "Agent Profile",
                    type: "select" as const,
                    options: [
                      { id: "none", label: "None", isDefault: true },
                      { id: "my-manager", label: "my-manager" },
                    ],
                  },
                ]
              : []),
          ],
        },
      },
    ],
    slashCommands: [],
    skills: [],
  }) as unknown as ServerProvider;

/**
 * Only `getProviders` is supplied. `Layer.mock` typechecks the member against
 * the real service and leaves every other one raising `UnimplementedError`,
 * which pins the second half of the claim these tests make: the gate reads the
 * cached snapshot and nothing else — no refresh, no stream, no probe.
 */
const makeProviderRegistry = (providers: ReadonlyArray<ServerProvider>) =>
  Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed(providers) });

/**
 * The gate only reads `ProviderRegistry`, so every spawn test can carry a
 * supporting snapshot without caring: they never pass `agentProfile`, and an
 * absent parameter never reaches the gate.
 */
const supportingRegistry = makeProviderRegistry([makeProviderSnapshot({ agentDescriptor: true })]);

const agentOptionOf = (command: ThreadTurnStartCommand) =>
  command.modelSelection?.options?.find((option) => option.id === "agent");

/**
 * The agent entry on the selection PERSISTED with the new thread, read off the
 * create payload rather than the turn command.
 *
 * The handler happens to pass one object to both today, so asserting through
 * the turn command would make this a restatement that cannot fail on its own.
 * The persisted copy is what the provider command reactor falls back to, and so
 * what actually delivers `--agent`; a refactor that built the two selections
 * separately must not be able to quietly break it.
 */
const persistedAgentOptionOf = (command: ThreadTurnStartCommand) =>
  command.bootstrap?.createThread?.modelSelection?.options?.find((option) => option.id === "agent");

const provideAll =
  (
    runner: ThreadBootstrapRunner["Service"],
    scope: McpInvocationContext.McpInvocationScope,
    shell: Option.Option<OrchestrationThreadShell> = Option.some(parentShell),
    projectsByRoot: ReadonlyMap<string, ProjectId> = new Map(),
    git: GitWorkflowService.GitWorkflowService["Service"] = repositoryGit(),
    registry: Layer.Layer<ProviderRegistry> = supportingRegistry,
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ThreadBootstrapRunner, runner),
      Effect.provideService(ProjectionSnapshotQuery, makeProjection(shell, projectsByRoot)),
      Effect.provideService(GitWorkflowService.GitWorkflowService, git),
      Effect.provide(registry),
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

  /**
   * The agent-profile tests vary only in the parent's selection, the parameter,
   * and the snapshot. Every other spawn dependency is the ordinary happy path,
   * so a failure here is about the profile and nothing else.
   */
  const spawnWithProfile = (input: {
    readonly agentProfile?: string | undefined;
    readonly parentOptions?: ReadonlyArray<ProviderOptionSelection>;
    readonly registry?: Layer.Layer<ProviderRegistry>;
    readonly dispatched: ThreadTurnStartCommand[];
    readonly session: string;
  }) =>
    spawnThread({
      repositoryPath: "/repos/other-repo",
      title: "Look at X",
      prompt: "p",
      ...(input.agentProfile === undefined ? {} : { agentProfile: input.agentProfile }),
    }).pipe(
      provideAll(
        recordingRunner(input.dispatched),
        makeScope(["spawn"], input.session),
        Option.some(
          input.parentOptions === undefined
            ? parentShell
            : {
                ...parentShell,
                modelSelection: { ...parentShell.modelSelection, options: input.parentOptions },
              },
        ),
        new Map(),
        repositoryGit(),
        input.registry ?? supportingRegistry,
      ),
    );

  it.effect("sets the child's agent profile when the model supports one", () =>
    Effect.gen(function* () {
      const dispatched: ThreadTurnStartCommand[] = [];
      yield* spawnWithProfile({
        agentProfile: "my-manager",
        // A parent option that is not the profile, to prove assembly edits one
        // entry rather than replacing the selection.
        parentOptions: [{ id: "effort", value: "high" }],
        dispatched,
        session: "session-profile-set",
      });

      const command = dispatched[0]!;
      expect(agentOptionOf(command)).toEqual({ id: "agent", value: "my-manager" });
      // The rest of the parent's selection rides along untouched.
      expect(command.modelSelection?.options).toContainEqual({ id: "effort", value: "high" });
      expect(command.modelSelection?.model).toBe(PARENT_MODEL_SLUG);
      expect(command.modelSelection?.instanceId).toBe(PARENT_INSTANCE_ID);
      // The persisted selection on the new thread is what the adapter later
      // reads, so the create payload must carry it too — not just the turn.
      expect(persistedAgentOptionOf(command)).toEqual({ id: "agent", value: "my-manager" });
    }),
  );

  it.effect("strips the parent's own agent profile when none is asked for", () =>
    Effect.gen(function* () {
      // The child inherits the parent's model selection wholesale, which would
      // otherwise propagate the parent's profile as an accident: a manager
      // profile spawning workers must not mint more managers. Omitting the
      // parameter means no profile, never "the same as mine".
      const dispatched: ThreadTurnStartCommand[] = [];
      yield* spawnWithProfile({
        parentOptions: [
          { id: "agent", value: "my-manager" },
          { id: "effort", value: "high" },
        ],
        dispatched,
        session: "session-profile-strip",
      });

      const command = dispatched[0]!;
      expect(agentOptionOf(command)).toBeUndefined();
      expect(persistedAgentOptionOf(command)).toBeUndefined();
      // Stripping is surgical: the parent's other selections survive.
      expect(command.modelSelection?.options).toContainEqual({ id: "effort", value: "high" });
    }),
  );

  it.effect('treats the literal "none" exactly as an omitted profile', () =>
    Effect.gen(function* () {
      // The descriptor's explicit None choice spells its value "none", so an
      // agent reading the option list will pass it. It must mean the same thing
      // end to end as leaving the parameter out, including the strip.
      const dispatched: ThreadTurnStartCommand[] = [];
      yield* spawnWithProfile({
        agentProfile: "none",
        parentOptions: [{ id: "agent", value: "my-manager" }],
        dispatched,
        session: "session-profile-none",
      });

      expect(agentOptionOf(dispatched[0]!)).toBeUndefined();
      expect(persistedAgentOptionOf(dispatched[0]!)).toBeUndefined();
    }),
  );

  it.effect("refuses a profile when the child's model advertises no agent select", () =>
    Effect.gen(function* () {
      // A Codex parent lands here for free: no descriptor is ever emitted for
      // Codex models. Spawning a plain child instead would be the failure the
      // calling agent is least able to see, so this refuses rather than drops.
      const dispatched: ThreadTurnStartCommand[] = [];
      const error = yield* spawnWithProfile({
        agentProfile: "my-manager",
        registry: makeProviderRegistry([makeProviderSnapshot({ agentDescriptor: false })]),
        dispatched,
        session: "session-profile-unsupported",
      }).pipe(Effect.flip);

      expect(error.reason).toBe("invalid-agent-profile");
      expect(dispatched).toHaveLength(0);
      // The message has to name the parameter and the retry, since the agent is
      // the only party that can act on it.
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("agentProfile");
      expect(error.message).toContain("my-manager");
    }),
  );

  it.effect("refuses a profile when the provider snapshot cannot be found", () =>
    Effect.gen(function* () {
      // Reject-when-unknown: an empty or lagging registry is not evidence of
      // support, and spawning ungated would produce a silently profile-less
      // child. The same refusal covers both unknowns.
      const dispatched: ThreadTurnStartCommand[] = [];
      const error = yield* spawnWithProfile({
        agentProfile: "my-manager",
        registry: makeProviderRegistry([]),
        dispatched,
        session: "session-profile-no-instance",
      }).pipe(Effect.flip);

      expect(error.reason).toBe("invalid-agent-profile");
      expect(dispatched).toHaveLength(0);
    }),
  );

  it.effect("refuses a profile when the snapshot has no entry for the child's model", () =>
    Effect.gen(function* () {
      const dispatched: ThreadTurnStartCommand[] = [];
      const error = yield* spawnWithProfile({
        agentProfile: "my-manager",
        // The instance is present and supports profiles on a DIFFERENT model, so
        // this pins that the gate matches on the child's own slug.
        registry: makeProviderRegistry([
          makeProviderSnapshot({ slug: "some-other-model", agentDescriptor: true }),
        ]),
        dispatched,
        session: "session-profile-no-model",
      }).pipe(Effect.flip);

      expect(error.reason).toBe("invalid-agent-profile");
      expect(dispatched).toHaveLength(0);
    }),
  );

  it.effect("gates the profile against an overridden model, not the parent's", () =>
    Effect.gen(function* () {
      // Their `model` parameter moves the child off the parent's model, so the
      // gate has to follow it: a parent on a profile-capable model must not be
      // able to smuggle a profile onto a child model that advertises none.
      const dispatched: ThreadTurnStartCommand[] = [];
      const error = yield* spawnThread({
        repositoryPath: "/repos/other-repo",
        title: "Look at X",
        prompt: "p",
        model: "some-other-model",
        agentProfile: "my-manager",
      }).pipe(
        provideAll(
          recordingRunner(dispatched),
          makeScope(["spawn"], "session-profile-model-override"),
          Option.some(parentShell),
          new Map(),
          repositoryGit(),
          // Profiles are supported on the PARENT's model only.
          supportingRegistry,
        ),
        Effect.flip,
      );

      expect(error.reason).toBe("invalid-agent-profile");
      expect(dispatched).toHaveLength(0);
    }),
  );

  it.effect("does not consult the provider registry when no profile is asked for", () =>
    Effect.gen(function* () {
      // Stripping needs no capability, so an absent parameter must not be able
      // to fail on a provider snapshot the spawn does not depend on.
      const dispatched: ThreadTurnStartCommand[] = [];
      yield* spawnWithProfile({
        registry: makeProviderRegistry([]),
        dispatched,
        session: "session-profile-absent",
      });

      expect(dispatched).toHaveLength(1);
      expect(agentOptionOf(dispatched[0]!)).toBeUndefined();
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
