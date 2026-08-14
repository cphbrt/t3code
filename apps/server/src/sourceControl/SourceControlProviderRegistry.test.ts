import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsRepositoryDetectionError } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import type * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "./GitHubCli.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const processOutput = (
  stdout: string,
  options?: {
    readonly stderr?: string;
    readonly exitCode?: ChildProcessSpawner.ExitCode;
  },
): VcsProcess.VcsProcessOutput => ({
  exitCode: options?.exitCode ?? ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: options?.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

function makeRegistry(input: {
  readonly remotes: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
  }>;
  readonly process?: Partial<VcsProcess.VcsProcess["Service"]>;
  readonly resolve?: VcsDriverRegistry.VcsDriverRegistry["Service"]["resolve"];
}) {
  const driver = {
    listRemotes: () =>
      Effect.succeed({
        remotes: input.remotes.map((remote) => ({
          ...remote,
          pushUrl: Option.none(),
          isPrimary: remote.name === "origin",
        })),
        freshness: {
          source: "live-local" as const,
          observedAt: TEST_EPOCH,
          expiresAt: Option.none(),
        },
      }),
  } satisfies Partial<VcsDriver.VcsDriver["Service"]>;

  const registryLayer = Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
    get: () => Effect.succeed(driver as unknown as VcsDriver.VcsDriver["Service"]),
    resolve:
      input.resolve ??
      (() =>
        Effect.succeed({
          kind: "git",
          repository: {
            kind: "git",
            rootPath: "/repo",
            metadataPath: null,
            freshness: {
              source: "live-local" as const,
              observedAt: TEST_EPOCH,
              expiresAt: Option.none(),
            },
          },
          driver: driver as unknown as VcsDriver.VcsDriver["Service"],
        })),
  });

  const processLayer = Layer.mock(VcsProcess.VcsProcess)({
    run: () => Effect.succeed(processOutput("")),
    ...input.process,
  });

  return SourceControlProviderRegistry.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        registryLayer,
        processLayer,
        Layer.mock(GitHubCli.GitHubCli)({}),
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-source-control-registry-test-",
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
}

it.effect("routes GitHub remotes to the GitHub provider", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@github.com:pingdotgg/t3code.git" }],
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "github");
  }),
);

it.effect("routes directly by provider kind for remote-first workflows", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [],
    });

    const provider = yield* registry.get("github");

    assert.strictEqual(provider.kind, "github");
  }),
);

it.effect("includes the request cwd when an unregistered provider is used", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ remotes: [] });
    const provider = yield* registry.get("unknown");

    const error = yield* provider
      .getChangeRequest({ cwd: "/repo", reference: "#42" })
      .pipe(Effect.flip);

    assert.strictEqual(error.provider, "unknown");
    assert.strictEqual(error.operation, "getChangeRequest");
    assert.strictEqual(error.cwd, "/repo");
    assert.strictEqual(error.reference, "#42");
  }),
);

it.effect("retains VCS detection failures with structured cwd context", () =>
  Effect.gen(function* () {
    const cause = new VcsRepositoryDetectionError({
      operation: "resolve",
      cwd: "/repo",
      detail: "raw VCS detection failure",
      cause: new Error("raw nested failure"),
    });
    const registry = yield* makeRegistry({
      remotes: [],
      resolve: () => Effect.fail(cause),
    });

    const error = yield* registry.resolve({ cwd: "/repo" }).pipe(Effect.flip);

    assert.strictEqual(error.provider, "unknown");
    assert.strictEqual(error.operation, "detectProvider");
    assert.strictEqual(error.cwd, "/repo");
    assert.strictEqual(error.detail, "Failed to detect source control provider.");
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message.includes(cause.message), false);
  }),
);

it.effect("keeps unsupported remote kinds recognizable without registering their providers", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@gitlab.com:group/project.git" }],
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });
    assert.strictEqual(provider.kind, "gitlab");

    const error = yield* provider
      .listChangeRequests({ cwd: "/repo", headSelector: "main", state: "open" })
      .pipe(Effect.flip);
    assert.match(error.detail, /No gitlab source control provider is registered/);
  }),
);
