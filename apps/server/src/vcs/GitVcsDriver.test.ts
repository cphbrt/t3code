import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import { assert, it } from "@effect/vitest";

import { CheckpointRef, GitCommandError } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-contract-",
});
const GitContractLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({
      operation: "GitVcsDriver.contract.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

type GitContractError = GitCommandError | PlatformError.PlatformError;

/**
 * Reproduce what `git bisect run`, hooks, and `rebase --exec` do to the
 * processes they spawn: export repository-location variables that override
 * working directory based discovery. Restored when the test scope closes.
 */
const leakEnvIntoProcessEnv = (
  entries: Readonly<Record<string, string>>,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(
        Object.keys(entries).map((key) => [key, process.env[key]] as const),
      );
      Object.assign(process.env, entries);
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }),
  ).pipe(Effect.asVoid);

runVcsDriverContractSuite<GitVcsDriver.GitVcsDriver, GitContractError>({
  name: "Git",
  kind: "git",
  layer: GitContractLayer,
  fixture: {
    createRepo: (cwd) =>
      Effect.gen(function* () {
        yield* runGit(cwd, ["init"]);
        yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
        yield* runGit(cwd, ["config", "user.name", "Test"]);
      }),
    writeFile: (cwd, relativePath, contents) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const absolutePath = path.join(cwd, relativePath);
        yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
        yield* fileSystem.writeFileString(absolutePath, contents);
      }),
    trackFile: (cwd, relativePath) => runGit(cwd, ["add", relativePath]),
    commit: (cwd, message) => runGit(cwd, ["commit", "-m", message]),
    ignorePath: (cwd, pattern) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), `${pattern}\n`);
      }),
  },
});

it.effect("GitVcsDriver forwards execute env to the VCS process", () => {
  let observedEnv: NodeJS.ProcessEnv | undefined;
  let observedExtendEnv: boolean | undefined;
  let observedAppendTruncationMarker: boolean | undefined;

  return Effect.gen(function* () {
    const driver = yield* GitVcsDriver.makeVcsDriverShape();

    // What `git bisect run` and hooks export into the processes they spawn.
    yield* leakEnvIntoProcessEnv({
      GIT_DIR: "/decoy/.git",
      GIT_WORK_TREE: "/decoy",
    });

    yield* driver.execute({
      operation: "GitVcsDriver.test.env",
      cwd: "/repo",
      args: ["status"],
      env: {
        GIT_INDEX_FILE: "/tmp/t3-index",
      },
      appendTruncationMarker: true,
    });

    // A complete environment, not an overlay, so `extendEnv` cannot merge the
    // stripped repository-location variables back in from the parent process.
    assert.strictEqual(observedExtendEnv, false);
    assert.strictEqual(observedEnv?.PATH, process.env.PATH);
    assert.strictEqual(observedEnv?.GIT_DIR, undefined);
    assert.strictEqual(observedEnv?.GIT_WORK_TREE, undefined);
    // The caller's deliberate value still wins over the stripped inheritance.
    assert.strictEqual(observedEnv?.GIT_INDEX_FILE, "/tmp/t3-index");
    assert.strictEqual(observedAppendTruncationMarker, true);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              observedEnv = input.env;
              observedExtendEnv = input.extendEnv;
              observedAppendTruncationMarker = input.appendTruncationMarker;
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
      ),
    ),
  );
});

it.effect("GitVcsDriver captures checkpoints in the requested repository under GIT_DIR", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "git-vcs-checkpoint-cwd-" });
    const decoy = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "git-vcs-checkpoint-decoy-",
    });

    yield* driver.initRepository({ cwd });
    yield* driver.initRepository({ cwd: decoy });
    const decoyGitDir = yield* driver
      .execute({
        operation: "GitVcsDriver.test.decoyGitDir",
        cwd: decoy,
        args: ["rev-parse", "--absolute-git-dir"],
      })
      .pipe(Effect.map((result) => result.stdout.trim()));

    yield* leakEnvIntoProcessEnv({ GIT_DIR: decoyGitDir });

    yield* fileSystem.writeFileString(pathService.join(cwd, "README.md"), "# test\n");
    const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/env-shield/turn/1");
    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

    assert.isTrue(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }));
    assert.isFalse(yield* driver.checkpoints.hasCheckpointRef({ cwd: decoy, checkpointRef }));
  }).pipe(Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);
