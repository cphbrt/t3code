import type { DesktopOpenPathOutcome } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";

/**
 * Opens a file this machine already holds, using the OS launcher, so an
 * artifact an agent wrote can be read in the user's own viewer.
 *
 * Deliberately NOT routed through ElectronShell.openExternal: that path is a
 * URL allowlist covering http/https and editor deep links, and it rejects
 * `file:` on purpose. Widening it to reach a local file would hand every
 * renderer caller an arbitrary-file opener. This service takes a path instead,
 * validates it here, and only ever spawns a fixed argv array.
 */

/**
 * How long a launcher gets to reject the file before it counts as launched.
 * `open` and `xdg-open` hand off and exit immediately, so a fast non-zero exit
 * is a real rejection. `google-chrome` with no browser already running keeps
 * running for as long as the browser does, so an elapsed window means it took
 * the file rather than refused it.
 */
const LAUNCH_SETTLE_WINDOW = Duration.seconds(2);

/**
 * Only macOS and Linux are supported; this fork is desktop-first on those.
 * The first candidate that accepts the file wins, so the preferred launcher
 * leads and the platform's generic handler backs it up.
 */
export function browserLaunchCandidates(
  platform: NodeJS.Platform,
  path: string,
): ReadonlyArray<{ readonly command: string; readonly args: ReadonlyArray<string> }> {
  switch (platform) {
    case "darwin":
      return [
        { command: "open", args: ["-a", "Google Chrome", path] },
        { command: "open", args: [path] },
      ];
    case "linux":
      return [
        { command: "google-chrome", args: [path] },
        { command: "xdg-open", args: [path] },
      ];
    default:
      return [];
  }
}

/**
 * A path this service is willing to hand to a launcher: a non-empty absolute
 * POSIX path with no NUL byte. Absolute is checked against a leading slash
 * rather than node:path, because the only supported platforms are macOS and
 * Linux and a drive-letter path would not be openable there anyway. Nothing
 * here is shell-interpreted — the path travels as one argv element — so this
 * guard is about refusing nonsense early, not about escaping.
 */
export function isOpenableArtifactPath(rawPath: unknown): rawPath is string {
  return (
    typeof rawPath === "string" &&
    rawPath.length > 0 &&
    rawPath.startsWith("/") &&
    !rawPath.includes("\0")
  );
}

export class DesktopPathOpener extends Context.Service<
  DesktopPathOpener,
  {
    readonly openInBrowser: (rawPath: unknown) => Effect.Effect<DesktopOpenPathOutcome>;
  }
>()("@t3tools/desktop/app/DesktopPathOpener") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  /**
   * Launches one candidate. `unref` runs before the wait so the browser
   * outlives this scope: the spawner only kills a still-running child on scope
   * close while it is still referenced.
   */
  const attempt = (candidate: { readonly command: string; readonly args: ReadonlyArray<string> }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          // argv array, never `shell: true` and never a joined string, so a
          // path with spaces or shell metacharacters cannot become syntax.
          ChildProcess.make(candidate.command, [...candidate.args], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }),
        );
        // Discards the re-reference effect on purpose: nothing here ever wants
        // the browser back under this scope's control.
        yield* Effect.asVoid(handle.unref);
        const exitCode = yield* Effect.timeout(handle.exitCode, LAUNCH_SETTLE_WINDOW).pipe(
          Effect.option,
        );
        // Still running past the window: it accepted the file.
        return exitCode._tag === "None" || Number(exitCode.value) === 0;
      }),
      // catchCause, not orElseSucceed: a missing binary arrives as a typed
      // spawn failure, but anything unexpected inside the spawn must also cost
      // only this candidate rather than the whole open.
    ).pipe(Effect.catchCause(() => Effect.succeed(false)));

  const openInBrowser = Effect.fn("desktop.pathOpener.openInBrowser")(function* (rawPath: unknown) {
    if (!isOpenableArtifactPath(rawPath)) {
      return "invalid-path" as const;
    }
    const candidates = browserLaunchCandidates(environment.platform, rawPath);
    if (candidates.length === 0) {
      return "unsupported-platform" as const;
    }
    // Checked before launching, so "the file is gone" is reported as itself
    // rather than as whatever a launcher happens to do with a missing path.
    const exists = yield* fileSystem.exists(rawPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return "missing" as const;
    }
    for (const candidate of candidates) {
      if (yield* attempt(candidate)) {
        return "opened" as const;
      }
    }
    return "launch-failed" as const;
  });

  return DesktopPathOpener.of({ openInBrowser });
});

export const layer = Layer.effect(DesktopPathOpener, make);
