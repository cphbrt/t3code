import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { OrchestrationDispatchCommandError } from "@t3tools/contracts";

import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ThreadBootstrapRunner,
  type ThreadTurnStartCommand,
} from "../../../orchestration/Services/ThreadBootstrapRunner.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { spawnThread } from "./handlers.ts";
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
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ThreadBootstrapRunner, runner),
      Effect.provideService(ProjectionSnapshotQuery, makeProjection(shell, projectsByRoot)),
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
