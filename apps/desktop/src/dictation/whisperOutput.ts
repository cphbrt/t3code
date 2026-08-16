/**
 * Parsing for whisper.cpp's `-oj` JSON sidecar.
 *
 * whisper writes `<-of value>.json` containing a `transcription` array of
 * segments, each with its own `text`. The shape below was confirmed against
 * whisper-cli's own output; everything outside `transcription` (systeminfo,
 * model, params) is deliberately ignored so a future whisper release adding
 * fields does not break the parse.
 */

export type WhisperOutputParse =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Join the segment texts into one utterance.
 *
 * Each segment's text carries a leading space (whisper's own token spacing),
 * so segments concatenate directly and the result is trimmed once at the end.
 * Interior newlines are collapsed to spaces: the composer receives one spoken
 * utterance, and whisper's segment breaks are timing artifacts rather than
 * anything the speaker asked for.
 */
export function joinWhisperSegments(segments: readonly { readonly text: string }[]): string {
  return segments
    .map((segment) => segment.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse the raw contents of a whisper JSON sidecar.
 *
 * An empty transcription is a success with empty text, not an error: whisper
 * legitimately produces no segments for silence, and the caller decides
 * whether "nothing was said" is worth surfacing.
 */
export function parseWhisperJsonOutput(raw: string): WhisperOutputParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "whisper produced output that is not valid JSON." };
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: "whisper output was not a JSON object." };
  }

  const transcription = parsed["transcription"];
  if (!Array.isArray(transcription)) {
    return { ok: false, error: "whisper output did not contain a transcription array." };
  }

  const segments: { text: string }[] = [];
  for (const entry of transcription) {
    if (!isRecord(entry)) {
      return { ok: false, error: "whisper output contained a malformed transcription segment." };
    }
    const text = entry["text"];
    if (typeof text !== "string") {
      return { ok: false, error: "whisper output contained a segment with no text." };
    }
    segments.push({ text });
  }

  return { ok: true, text: joinWhisperSegments(segments) };
}

/** Longest stderr excerpt carried back to the renderer for a failed run. */
const STDERR_TAIL_CHARS = 400;

/**
 * Reduce whisper's stderr to the part worth showing a user.
 *
 * whisper logs its whole model and system configuration before doing any
 * work, so the interesting line (`error: failed to initialize whisper
 * context`) is always at the end.
 */
export function whisperStderrTail(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length <= STDERR_TAIL_CHARS) return trimmed;
  return `...${trimmed.slice(trimmed.length - STDERR_TAIL_CHARS)}`;
}
