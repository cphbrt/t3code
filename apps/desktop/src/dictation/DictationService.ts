/**
 * Local speech-to-text for the composer's mic button.
 *
 * Runs a user-supplied whisper.cpp binary against a user-supplied model, in
 * the desktop main process. Audio is written to a scoped temp directory,
 * transcribed, and the directory is dropped; nothing is retained and nothing
 * reaches a T3 server.
 */
import type {
  DesktopDictationAvailability,
  DesktopDictationTranscribeResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import { parseWhisperJsonOutput, whisperStderrTail } from "./whisperOutput.ts";

/**
 * Ceiling on a single transcription. A small model handles a minute of speech
 * in a few seconds; anything approaching this bound means whisper is wedged
 * rather than working, and the user is left staring at a spinner.
 */
const TRANSCRIBE_TIMEOUT = Duration.seconds(60);

/** Grace period between SIGTERM and SIGKILL when a run is abandoned. */
const TERMINATE_GRACE = Duration.seconds(2);

export interface DictationPaths {
  readonly whisperCliPath: string;
  readonly modelPath: string;
}

export type DictationPathResolution =
  | { readonly paths: DictationPaths }
  | { readonly note: string };

/**
 * Decide which paths an availability check or a transcription should use.
 *
 * Caller-supplied paths win per field over the persisted ones. That matters
 * for the settings page: it asks about the values currently in its fields,
 * which it has only just handed to the (asynchronous, unawaited) settings
 * write. Reading persisted settings there would answer a question about the
 * previous configuration and report a stale verdict.
 */
export function resolveDictationPaths(input: {
  readonly override?: { readonly whisperCliPath?: string; readonly modelPath?: string } | undefined;
  readonly persisted?: { readonly whisperCliPath: string; readonly modelPath: string } | undefined;
}): DictationPathResolution {
  const whisperCliPath = (
    input.override?.whisperCliPath ??
    input.persisted?.whisperCliPath ??
    ""
  ).trim();
  const modelPath = (input.override?.modelPath ?? input.persisted?.modelPath ?? "").trim();

  if (whisperCliPath.length === 0) {
    return { note: "No whisper-cli binary configured." };
  }
  if (modelPath.length === 0) {
    return { note: "No whisper model configured." };
  }
  return { paths: { whisperCliPath, modelPath } };
}

export class Dictation extends Context.Service<
  Dictation,
  {
    readonly checkAvailability: (input: {
      readonly whisperCliPath?: string;
      readonly modelPath?: string;
    }) => Effect.Effect<DesktopDictationAvailability>;
    readonly transcribe: (input: {
      readonly wavData: Uint8Array;
      readonly language: string;
    }) => Effect.Effect<DesktopDictationTranscribeResult>;
  }
>()("@t3tools/desktop/dictation/DictationService/Dictation") {}

/**
 * Build the whisper argument list.
 *
 * `-mc 0` disables the max-context carryover between decode windows. Without
 * it whisper can lock into repeating the previous window's text forever,
 * turning a short utterance into paragraphs of the same phrase. `-oj` writes
 * the JSON sidecar we parse, `-np` drops the progress chrome, and `-bs 5` is
 * the beam width that trades a little latency for noticeably steadier output.
 */
export function buildWhisperArgs(input: {
  readonly modelPath: string;
  readonly audioPath: string;
  readonly outputBase: string;
  readonly language: string;
}): string[] {
  return [
    "-m",
    input.modelPath,
    "-f",
    input.audioPath,
    "-oj",
    "-np",
    "-l",
    input.language,
    "-bs",
    "5",
    "-mc",
    "0",
    "-of",
    input.outputBase,
  ];
}

const decodeUtf8 = (chunks: Iterable<Uint8Array>): string => {
  const list = Array.from(chunks);
  let total = 0;
  for (const chunk of list) total += chunk.length;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of list) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
};

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  // whisper is CPU-bound and saturates the machine; a second concurrent run
  // would only make both slower while racing for the same work directory.
  const busyRef = yield* Ref.make(false);

  /**
   * Resolve paths for one call, preferring any the caller supplied.
   *
   * Persisted settings are re-read every time rather than cached: the user
   * may be downloading a model while the settings page is open, and a cached
   * "missing" verdict would outlive the fix.
   */
  const resolveConfiguredPaths = (override?: {
    readonly whisperCliPath?: string;
    readonly modelPath?: string;
  }) =>
    Effect.gen(function* () {
      const settings = Option.getOrUndefined(yield* clientSettings.get);
      return resolveDictationPaths({
        override,
        ...(settings
          ? {
              persisted: {
                whisperCliPath: settings.dictationWhisperCliPath,
                modelPath: settings.dictationModelPath,
              },
            }
          : {}),
      });
    });

  /**
   * Confirm both configured paths point at usable files.
   *
   * The binary is checked for the execute bit as well as existence, because
   * an unexecutable file fails at spawn time with a far less obvious error.
   */
  const validatePaths = (paths: DictationPaths): Effect.Effect<DesktopDictationAvailability> =>
    Effect.gen(function* () {
      const binaryUsable = yield* fileSystem.access(paths.whisperCliPath, { ok: true }).pipe(
        Effect.as(true),
        Effect.catchTag("PlatformError", () => Effect.succeed(false)),
      );
      if (!binaryUsable) {
        return { available: false, note: `whisper-cli not found at ${paths.whisperCliPath}` };
      }

      const modelExists = yield* fileSystem
        .exists(paths.modelPath)
        .pipe(Effect.catchTag("PlatformError", () => Effect.succeed(false)));
      if (!modelExists) {
        return { available: false, note: `Model not found at ${paths.modelPath}` };
      }

      return { available: true };
    });

  const checkAvailability = Effect.fn("desktop.dictation.checkAvailability")(function* (input: {
    readonly whisperCliPath?: string;
    readonly modelPath?: string;
  }) {
    const resolved = yield* resolveConfiguredPaths(input);
    if ("note" in resolved) {
      return { available: false, note: resolved.note } satisfies DesktopDictationAvailability;
    }
    return yield* validatePaths(resolved.paths);
  });

  /**
   * One whisper run inside a scope that owns its work directory, so closing
   * the scope removes both the input wav and the JSON sidecar however the run
   * ended.
   */
  const runWhisper = (input: {
    readonly paths: DictationPaths;
    readonly wavData: Uint8Array;
    readonly language: string;
  }) =>
    Effect.gen(function* () {
      const workDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-dictation-" });
      const audioPath = path.join(workDir, "utterance.wav");
      const outputBase = path.join(workDir, "utterance");

      yield* fileSystem.writeFile(audioPath, input.wavData);

      const command = ChildProcess.make(
        input.paths.whisperCliPath,
        buildWhisperArgs({
          modelPath: input.paths.modelPath,
          audioPath,
          outputBase,
          language: input.language,
        }),
        {
          stdout: "pipe",
          stderr: "pipe",
          killSignal: "SIGTERM",
          forceKillAfter: TERMINATE_GRACE,
        },
      );

      const handle = yield* spawner.spawn(command);
      // Drain both pipes concurrently so neither buffer can fill and stall
      // whisper, which logs its whole configuration before doing any work.
      const [stderrChunks, exitCode] = yield* Effect.all(
        [
          Stream.runCollect(handle.stderr),
          // stdout is drained and discarded: whisper echoes the transcript
          // there for humans, but the JSON sidecar is the parseable copy.
          Stream.runDrain(handle.stdout).pipe(Effect.andThen(handle.exitCode)),
        ],
        { concurrency: "unbounded" },
      );

      if ((exitCode as unknown as number) !== 0) {
        const detail = whisperStderrTail(decodeUtf8(stderrChunks));
        return {
          ok: false,
          error:
            detail.length > 0
              ? `whisper exited with code ${exitCode}: ${detail}`
              : `whisper exited with code ${exitCode}.`,
        } satisfies DesktopDictationTranscribeResult;
      }

      const rawJson = yield* fileSystem.readFileString(`${outputBase}.json`);
      return parseWhisperJsonOutput(rawJson) satisfies DesktopDictationTranscribeResult;
    });

  const transcribe = Effect.fn("desktop.dictation.transcribe")(function* (input: {
    readonly wavData: Uint8Array;
    readonly language: string;
  }) {
    const claimed = yield* Ref.modify(busyRef, (busy) => [!busy, true] as const);
    if (!claimed) {
      return {
        ok: false,
        error: "A transcription is already running.",
      } satisfies DesktopDictationTranscribeResult;
    }

    return yield* Effect.gen(function* () {
      // Always the saved configuration: by the time anyone dictates, the
      // settings write has long since landed.
      const resolved = yield* resolveConfiguredPaths();
      if ("note" in resolved) {
        return { ok: false, error: resolved.note } satisfies DesktopDictationTranscribeResult;
      }
      const availability = yield* validatePaths(resolved.paths);
      if (!availability.available) {
        return {
          ok: false,
          error: availability.note ?? "Dictation is not available.",
        } satisfies DesktopDictationTranscribeResult;
      }

      return yield* Effect.scoped(
        runWhisper({
          paths: resolved.paths,
          wavData: input.wavData,
          language: input.language,
        }),
      ).pipe(
        Effect.timeoutOption(TRANSCRIBE_TIMEOUT),
        Effect.map(
          Option.getOrElse(
            (): DesktopDictationTranscribeResult => ({
              ok: false,
              error: `whisper did not finish within ${Duration.toSeconds(TRANSCRIBE_TIMEOUT)} seconds.`,
            }),
          ),
        ),
        // Any unexpected failure (temp-dir creation, spawn, unreadable
        // sidecar) becomes a displayable reason rather than a rejected IPC
        // call, so the renderer can always tell the user what went wrong.
        Effect.catchCause((cause) =>
          Effect.logWarning("Dictation transcription failed.", cause).pipe(
            Effect.as<DesktopDictationTranscribeResult>({
              ok: false,
              error: "whisper could not be run. Check the configured paths.",
            }),
          ),
        ),
      );
    }).pipe(Effect.ensuring(Ref.set(busyRef, false)));
  });

  return Dictation.of({ checkAvailability, transcribe });
});

export const layer = Layer.effect(Dictation, make);
