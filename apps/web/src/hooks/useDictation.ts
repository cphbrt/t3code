/**
 * Microphone capture and local transcription for the composer.
 *
 * Desktop-only by construction: every entry point checks the optional
 * `dictation` bridge, which only the Electron preload defines. Capture runs at
 * 16 kHz mono because that is what whisper.cpp wants; Chromium resamples the
 * device stream to the `AudioContext` rate for us, so no resampling code is
 * needed here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopDictationAvailability } from "@t3tools/contracts";

import { concatFloat32, encodeWav } from "~/lib/dictationWav";
import { isElectron } from "~/env";
import { isMacPlatform } from "~/lib/utils";

/** whisper.cpp's native rate. Feeding it anything else forces a resample. */
const DICTATION_SAMPLE_RATE = 16_000;

/** Path of the capture worklet, served as a static asset from the app origin. */
const DICTATION_WORKLET_URL = "/dictation-worklet.js";

/** Utterances shorter than this are treated as a mis-click, not speech. */
const MIN_UTTERANCE_SAMPLES = DICTATION_SAMPLE_RATE / 4;

export type DictationStatus = "idle" | "recording" | "transcribing";

export interface DictationState {
  readonly status: DictationStatus;
  /** Whole seconds recorded so far; drives the button's timer. */
  readonly elapsedSeconds: number;
  readonly availability: DesktopDictationAvailability | null;
}

interface ActiveCapture {
  readonly stream: MediaStream;
  readonly context: AudioContext;
  readonly node: AudioWorkletNode;
  readonly source: MediaStreamAudioSourceNode;
  readonly blocks: Float32Array[];
}

/**
 * True when this build can offer dictation at all: the macOS desktop shell,
 * running a desktop build new enough to expose the bridge.
 */
export function dictationBridge() {
  if (typeof window === "undefined") return null;
  if (!isElectron || !isMacPlatform(navigator.platform)) return null;
  return window.desktopBridge?.dictation ?? null;
}

/** Release the microphone and audio graph. Safe to call more than once. */
function teardownCapture(capture: ActiveCapture) {
  try {
    capture.source.disconnect();
    capture.node.disconnect();
  } catch {
    // The graph may already be torn down; releasing the device still matters.
  }
  for (const track of capture.stream.getTracks()) track.stop();
  void capture.context.close().catch(() => undefined);
}

export function useDictation(input: {
  readonly language: string;
  /** Receives the transcript. Return false when it could not be inserted. */
  readonly onTranscript: (text: string) => boolean;
  readonly onError: (message: string, transcript?: string) => void;
}) {
  const { language, onTranscript, onError } = input;
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [availability, setAvailability] = useState<DesktopDictationAvailability | null>(null);
  const captureRef = useRef<ActiveCapture | null>(null);
  // Callbacks are read through a ref so starting a recording does not
  // resubscribe every time the composer re-renders with new handlers.
  const handlersRef = useRef({ onTranscript, onError });
  handlersRef.current = { onTranscript, onError };

  const refreshAvailability = useCallback(async () => {
    const bridge = dictationBridge();
    if (!bridge) {
      setAvailability(null);
      return;
    }
    try {
      setAvailability(await bridge.checkAvailability());
    } catch {
      setAvailability({ available: false, note: "Could not check dictation availability." });
    }
  }, []);

  useEffect(() => {
    void refreshAvailability();
  }, [refreshAvailability]);

  // A plain one-second interval, live only while recording. Deliberately not
  // a CSS or rAF animation: the composer is on screen all day and a
  // continuously repainting timer costs frames for no added information.
  useEffect(() => {
    if (status !== "recording") return;
    const id = window.setInterval(() => {
      setElapsedSeconds((previous) => previous + 1);
    }, 1_000);
    return () => window.clearInterval(id);
  }, [status]);

  useEffect(
    () => () => {
      const capture = captureRef.current;
      captureRef.current = null;
      if (capture) teardownCapture(capture);
    },
    [],
  );

  const start = useCallback(async () => {
    const bridge = dictationBridge();
    if (!bridge || captureRef.current) return;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Denial and "no input device" are indistinguishable here, and both are
      // fixed in the same place.
      handlersRef.current.onError(
        "Microphone access was denied. Grant it in System Settings › Privacy & Security › Microphone.",
      );
      return;
    }

    try {
      const context = new AudioContext({ sampleRate: DICTATION_SAMPLE_RATE });
      await context.audioWorklet.addModule(DICTATION_WORKLET_URL);
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, "dictation-capture");
      const blocks: Float32Array[] = [];
      // Assigning `onmessage` (rather than addEventListener) implicitly starts
      // the port; with addEventListener the worklet's messages would queue
      // undelivered until an explicit `port.start()`.
      // oxlint-disable-next-line unicorn/prefer-add-event-listener
      node.port.onmessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; samples?: Float32Array };
        if (data.type === "audio" && data.samples) blocks.push(data.samples);
      };
      source.connect(node);
      // Terminates the graph without routing the microphone to the speakers.
      node.connect(context.destination);

      captureRef.current = { stream, context, node, source, blocks };
      setElapsedSeconds(0);
      setStatus("recording");
    } catch {
      for (const track of stream.getTracks()) track.stop();
      handlersRef.current.onError("Could not start audio capture.");
    }
  }, []);

  /** Stop capture and hand the audio to whisper. */
  const stopAndTranscribe = useCallback(async () => {
    const capture = captureRef.current;
    const bridge = dictationBridge();
    if (!capture || !bridge) return;
    captureRef.current = null;

    // Ask the worklet to emit its partial chunk before the graph goes away,
    // so the last fraction of a second is not clipped off the utterance.
    await new Promise<void>((resolve) => {
      const timeout = window.setTimeout(resolve, 250);
      // Deliberately replaces the capture handler installed in `start`: from
      // here on the same port also has to resolve this promise.
      // oxlint-disable-next-line unicorn/prefer-add-event-listener
      capture.node.port.onmessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; samples?: Float32Array };
        if (data.type === "audio" && data.samples) capture.blocks.push(data.samples);
        if (data.type === "done") {
          window.clearTimeout(timeout);
          resolve();
        }
      };
      // This is a MessagePort, not a Window: its second argument is a transfer
      // list, so adding a target origin here would throw rather than secure
      // anything.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      capture.node.port.postMessage("flush");
    });

    const samples = concatFloat32(capture.blocks);
    teardownCapture(capture);

    if (samples.length < MIN_UTTERANCE_SAMPLES) {
      setStatus("idle");
      setElapsedSeconds(0);
      return;
    }

    setStatus("transcribing");
    try {
      const result = await bridge.transcribe({
        wavData: encodeWav(samples, DICTATION_SAMPLE_RATE),
        language,
      });
      if (!result.ok) {
        handlersRef.current.onError(result.error);
      } else if (result.text.length === 0) {
        handlersRef.current.onError("Nothing was transcribed.");
      } else if (!handlersRef.current.onTranscript(result.text)) {
        // The composer refused the text (busy, approval state). Hand it back
        // rather than dropping words the user already spoke.
        handlersRef.current.onError("The composer could not accept the text.", result.text);
      }
    } catch {
      handlersRef.current.onError("Transcription failed.");
    } finally {
      setStatus("idle");
      setElapsedSeconds(0);
    }
  }, [language]);

  /** Abandon the recording without transcribing. */
  const cancel = useCallback(() => {
    const capture = captureRef.current;
    if (!capture) return;
    captureRef.current = null;
    teardownCapture(capture);
    setStatus("idle");
    setElapsedSeconds(0);
  }, []);

  // Stable while nothing observable changed, so the memoized mic button does
  // not re-render alongside the composer on every keystroke.
  const state = useMemo<DictationState>(
    () => ({ status, elapsedSeconds, availability }),
    [status, elapsedSeconds, availability],
  );

  return { state, start, stopAndTranscribe, cancel, refreshAvailability };
}
