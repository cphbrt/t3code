import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopPathOpener from "./DesktopPathOpener.ts";

const ARTIFACT_PATH = "/srv/work/review notes.md";

interface RecordedLaunch {
  readonly commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>;
  readonly unreffed: string[];
}

const mockProcess = (command: string, exitCode: number, recorded: RecordedLaunch) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.sync(() => {
      recorded.unreffed.push(command);
      return Effect.void;
    }),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

/** A launcher that stays up, the way `google-chrome` does with no browser running. */
const stillRunningProcess = (command: string, recorded: RecordedLaunch) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(2),
    exitCode: Effect.never,
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.sync(() => {
      recorded.unreffed.push(command);
      return Effect.void;
    }),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const makeOpenerLayer = (
  recorded: RecordedLaunch,
  input: {
    readonly platform?: NodeJS.Platform;
    readonly exists?: boolean;
    /** Exit code per command name; anything absent exits 0. */
    readonly exitCodes?: Record<string, number>;
    /** Command names whose spawn fails outright, as a missing binary would. */
    readonly missingBinaries?: ReadonlyArray<string>;
    /** Command names that never exit, as a browser holding the terminal does. */
    readonly neverExit?: ReadonlyArray<string>;
  } = {},
) =>
  DesktopPathOpener.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          platform: input.platform ?? "darwin",
        } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
        FileSystem.layerNoop({
          exists: () => Effect.succeed(input.exists ?? true),
        }),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as {
              readonly command: string;
              readonly args: ReadonlyArray<string>;
            };
            recorded.commands.push({
              command: childProcess.command,
              args: childProcess.args,
            });
            if (input.missingBinaries?.includes(childProcess.command)) {
              return Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "ChildProcess",
                  method: "spawn",
                  description: `spawn ${childProcess.command} ENOENT`,
                  pathOrDescriptor: childProcess.command,
                }),
              );
            }
            if (input.neverExit?.includes(childProcess.command)) {
              return Effect.succeed(stillRunningProcess(childProcess.command, recorded));
            }
            return Effect.succeed(
              mockProcess(
                childProcess.command,
                input.exitCodes?.[childProcess.command] ?? 0,
                recorded,
              ),
            );
          }),
        ),
      ),
    ),
  );

const runOpen = (
  recorded: RecordedLaunch,
  path: unknown,
  input: Parameters<typeof makeOpenerLayer>[1] = {},
) =>
  Effect.gen(function* () {
    const opener = yield* DesktopPathOpener.DesktopPathOpener;
    return yield* opener.openInBrowser(path);
  }).pipe(Effect.provide(makeOpenerLayer(recorded, input)));

const recorder = (): RecordedLaunch => ({ commands: [], unreffed: [] });

describe("browserLaunchCandidates", () => {
  it("passes the path as its own argv element on every supported platform", () => {
    const darwin = DesktopPathOpener.browserLaunchCandidates("darwin", ARTIFACT_PATH);
    assert.deepEqual(darwin, [
      { command: "open", args: ["-a", "Google Chrome", ARTIFACT_PATH] },
      { command: "open", args: [ARTIFACT_PATH] },
    ]);

    const linux = DesktopPathOpener.browserLaunchCandidates("linux", ARTIFACT_PATH);
    assert.deepEqual(linux, [
      { command: "google-chrome", args: [ARTIFACT_PATH] },
      { command: "xdg-open", args: [ARTIFACT_PATH] },
    ]);
  });

  it("offers nothing on Windows", () => {
    assert.deepEqual(DesktopPathOpener.browserLaunchCandidates("win32", ARTIFACT_PATH), []);
  });
});

describe("isOpenableArtifactPath", () => {
  it("accepts an absolute path and refuses everything else", () => {
    assert.equal(DesktopPathOpener.isOpenableArtifactPath("/srv/work/review.md"), true);
    assert.equal(DesktopPathOpener.isOpenableArtifactPath("review.md"), false);
    assert.equal(DesktopPathOpener.isOpenableArtifactPath("../../etc/passwd"), false);
    assert.equal(DesktopPathOpener.isOpenableArtifactPath(""), false);
    assert.equal(DesktopPathOpener.isOpenableArtifactPath("/srv/work/re\0view.md"), false);
    assert.equal(DesktopPathOpener.isOpenableArtifactPath(42), false);
    assert.equal(DesktopPathOpener.isOpenableArtifactPath(null), false);
  });
});

describe("DesktopPathOpener.openInBrowser", () => {
  it.effect("launches the preferred browser and reports it opened", () =>
    Effect.gen(function* () {
      const recorded = recorder();
      const outcome = yield* runOpen(recorded, ARTIFACT_PATH);

      assert.equal(outcome, "opened");
      assert.deepEqual(recorded.commands, [
        { command: "open", args: ["-a", "Google Chrome", ARTIFACT_PATH] },
      ]);
      // Unreffed before the wait, so closing the scope cannot take the
      // browser down with it.
      assert.deepEqual(recorded.unreffed, ["open"]);
    }),
  );

  it.effect("falls back to the platform handler when the preferred one refuses", () =>
    Effect.gen(function* () {
      const recorded = recorder();
      const outcome = yield* runOpen(recorded, ARTIFACT_PATH, {
        platform: "linux",
        exitCodes: { "google-chrome": 1 },
      });

      assert.equal(outcome, "opened");
      assert.deepEqual(
        recorded.commands.map((entry) => entry.command),
        ["google-chrome", "xdg-open"],
      );
    }),
  );

  it.effect("falls back when the preferred launcher is not installed at all", () =>
    Effect.gen(function* () {
      const recorded = recorder();
      const outcome = yield* runOpen(recorded, ARTIFACT_PATH, {
        platform: "linux",
        missingBinaries: ["google-chrome"],
      });

      assert.equal(outcome, "opened");
      assert.deepEqual(
        recorded.commands.map((entry) => entry.command),
        ["google-chrome", "xdg-open"],
      );
    }),
  );

  it.effect("reports a launch failure once every candidate refuses", () =>
    Effect.gen(function* () {
      const recorded = recorder();
      const outcome = yield* runOpen(recorded, ARTIFACT_PATH, {
        exitCodes: { open: 1 },
      });

      assert.equal(outcome, "launch-failed");
      assert.equal(recorded.commands.length, 2);
    }),
  );

  it.effect("reports a missing file without launching anything", () =>
    Effect.gen(function* () {
      const recorded = recorder();
      const outcome = yield* runOpen(recorded, ARTIFACT_PATH, { exists: false });

      assert.equal(outcome, "missing");
      assert.deepEqual(recorded.commands, []);
    }),
  );

  it.effect("refuses a path that is not absolute without touching the filesystem", () =>
    Effect.gen(function* () {
      const recorded = recorder();
      assert.equal(yield* runOpen(recorded, "review.md"), "invalid-path");
      assert.equal(yield* runOpen(recorded, "/srv/work/re\0view.md"), "invalid-path");
      assert.deepEqual(recorded.commands, []);
    }),
  );

  it.effect("counts a launcher that keeps running as having taken the file", () => {
    const recorded = recorder();
    return Effect.gen(function* () {
      const fiber = yield* runOpen(recorded, ARTIFACT_PATH, {
        platform: "linux",
        neverExit: ["google-chrome"],
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(3));
      const outcome = yield* Fiber.join(fiber);

      assert.equal(outcome, "opened");
      // It never fell through to xdg-open, and it was unreffed so closing the
      // scope leaves the browser alone.
      assert.deepEqual(
        recorded.commands.map((entry) => entry.command),
        ["google-chrome"],
      );
      assert.deepEqual(recorded.unreffed, ["google-chrome"]);
    }).pipe(Effect.provide(TestClock.layer()));
  });

  it.effect("reports an unsupported platform rather than guessing a launcher", () =>
    Effect.gen(function* () {
      const recorded = recorder();
      const outcome = yield* runOpen(recorded, ARTIFACT_PATH, { platform: "win32" });

      assert.equal(outcome, "unsupported-platform");
      assert.deepEqual(recorded.commands, []);
    }),
  );
});
