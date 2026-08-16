import { describe, expect, it } from "vite-plus/test";

import { buildWhisperArgs, resolveDictationPaths } from "./DictationService.ts";
import { joinWhisperSegments, parseWhisperJsonOutput, whisperStderrTail } from "./whisperOutput.ts";

/**
 * Trimmed from real `whisper-cli -oj` output. The surrounding systeminfo,
 * model, and params keys are dropped on purpose: the parser must not depend
 * on them.
 */
const REAL_OUTPUT = JSON.stringify({
  systeminfo: "WHISPER : COREML = 0 | OPENVINO = 0",
  model: { type: "small", multilingual: false },
  params: { model: "/models/ggml-small.en.bin", language: "en", translate: false },
  result: { language: "en" },
  transcription: [
    {
      timestamps: { from: "00:00:00,000", to: "00:00:02,000" },
      offsets: { from: 0, to: 2000 },
      text: " Hello there.",
    },
    {
      timestamps: { from: "00:00:02,000", to: "00:00:04,000" },
      offsets: { from: 2000, to: 4000 },
      text: " This is a test.",
    },
  ],
});

describe("parseWhisperJsonOutput", () => {
  it("concatenates segment text from real whisper output", () => {
    expect(parseWhisperJsonOutput(REAL_OUTPUT)).toEqual({
      ok: true,
      text: "Hello there. This is a test.",
    });
  });

  it("treats an empty transcription as an empty success, not a failure", () => {
    expect(parseWhisperJsonOutput(JSON.stringify({ transcription: [] }))).toEqual({
      ok: true,
      text: "",
    });
  });

  it("ignores unknown top-level keys so a whisper upgrade does not break parsing", () => {
    const withExtras = JSON.stringify({
      somethingNew: { nested: true },
      transcription: [{ text: " ok" }],
    });
    expect(parseWhisperJsonOutput(withExtras)).toEqual({ ok: true, text: "ok" });
  });

  it("reports invalid JSON", () => {
    const result = parseWhisperJsonOutput("not json at all");
    expect(result.ok).toBe(false);
  });

  it("reports a missing transcription array", () => {
    const result = parseWhisperJsonOutput(JSON.stringify({ result: { language: "en" } }));
    expect(result).toEqual({
      ok: false,
      error: "whisper output did not contain a transcription array.",
    });
  });

  it("reports a segment whose text is not a string", () => {
    const result = parseWhisperJsonOutput(JSON.stringify({ transcription: [{ text: 42 }] }));
    expect(result).toEqual({
      ok: false,
      error: "whisper output contained a segment with no text.",
    });
  });

  it("reports a non-object segment", () => {
    const result = parseWhisperJsonOutput(JSON.stringify({ transcription: ["nope"] }));
    expect(result).toEqual({
      ok: false,
      error: "whisper output contained a malformed transcription segment.",
    });
  });

  it("rejects a JSON array at the root", () => {
    expect(parseWhisperJsonOutput("[]")).toEqual({
      ok: false,
      error: "whisper output was not a JSON object.",
    });
  });
});

describe("joinWhisperSegments", () => {
  it("collapses whisper's newlines and padding into single spaces", () => {
    expect(joinWhisperSegments([{ text: " one\n" }, { text: "  two  " }])).toBe("one two");
  });

  it("returns an empty string for no segments", () => {
    expect(joinWhisperSegments([])).toBe("");
  });
});

describe("resolveDictationPaths", () => {
  const persisted = { whisperCliPath: "/saved/whisper-cli", modelPath: "/saved/model.bin" };

  it("uses persisted paths when the caller supplies none", () => {
    expect(resolveDictationPaths({ persisted })).toEqual({
      paths: { whisperCliPath: "/saved/whisper-cli", modelPath: "/saved/model.bin" },
    });
  });

  it("prefers caller-supplied paths over persisted ones", () => {
    // The settings page's case: it asks about what is in its fields, which it
    // has only just handed to an unawaited settings write. Consulting
    // persisted settings here would describe the previous configuration.
    expect(
      resolveDictationPaths({
        override: { whisperCliPath: "/typed/whisper-cli", modelPath: "/typed/model.bin" },
        persisted,
      }),
    ).toEqual({
      paths: { whisperCliPath: "/typed/whisper-cli", modelPath: "/typed/model.bin" },
    });
  });

  it("overrides per field, falling back to persisted for the rest", () => {
    expect(
      resolveDictationPaths({ override: { modelPath: "/typed/model.bin" }, persisted }),
    ).toEqual({
      paths: { whisperCliPath: "/saved/whisper-cli", modelPath: "/typed/model.bin" },
    });
  });

  it("treats an explicitly cleared field as unconfigured rather than falling back", () => {
    expect(resolveDictationPaths({ override: { whisperCliPath: "" }, persisted })).toEqual({
      note: "No whisper-cli binary configured.",
    });
  });

  it("trims surrounding whitespace, which pasted paths commonly carry", () => {
    expect(
      resolveDictationPaths({
        override: { whisperCliPath: "  /typed/whisper-cli \n", modelPath: " /typed/model.bin " },
      }),
    ).toEqual({
      paths: { whisperCliPath: "/typed/whisper-cli", modelPath: "/typed/model.bin" },
    });
  });

  it("names the missing binary before the missing model", () => {
    expect(resolveDictationPaths({})).toEqual({ note: "No whisper-cli binary configured." });
    expect(resolveDictationPaths({ override: { whisperCliPath: "/w" } })).toEqual({
      note: "No whisper model configured.",
    });
  });
});

describe("buildWhisperArgs", () => {
  const args = buildWhisperArgs({
    modelPath: "/models/ggml-small.en.bin",
    audioPath: "/tmp/work/utterance.wav",
    outputBase: "/tmp/work/utterance",
    language: "en",
  });

  it("passes -mc 0 to disable context carryover", () => {
    // Load-bearing: without it whisper can lock into repeating the previous
    // decode window forever, turning one sentence into paragraphs.
    expect(args[args.indexOf("-mc") + 1]).toBe("0");
  });

  it("requests JSON output alongside the output base whisper appends .json to", () => {
    expect(args).toContain("-oj");
    expect(args[args.indexOf("-of") + 1]).toBe("/tmp/work/utterance");
  });

  it("passes the model, audio file, and language through", () => {
    expect(args[args.indexOf("-m") + 1]).toBe("/models/ggml-small.en.bin");
    expect(args[args.indexOf("-f") + 1]).toBe("/tmp/work/utterance.wav");
    expect(args[args.indexOf("-l") + 1]).toBe("en");
  });

  it("never interpolates paths into a shell string", () => {
    const spaced = buildWhisperArgs({
      modelPath: "/models/my models/ggml.bin",
      audioPath: "/tmp/a b/utterance.wav",
      outputBase: "/tmp/a b/utterance",
      language: "auto",
    });
    // Each path is its own argv entry, so spaces need no quoting.
    expect(spaced).toContain("/models/my models/ggml.bin");
    expect(spaced).toContain("/tmp/a b/utterance.wav");
  });
});

describe("whisperStderrTail", () => {
  it("keeps a short stderr verbatim", () => {
    expect(whisperStderrTail("error: failed to initialize whisper context\n")).toBe(
      "error: failed to initialize whisper context",
    );
  });

  it("keeps the end of a long stderr, where whisper reports the failure", () => {
    const noise = "x".repeat(1_000);
    const tail = whisperStderrTail(`${noise}error: boom`);
    expect(tail.startsWith("...")).toBe(true);
    expect(tail.endsWith("error: boom")).toBe(true);
    expect(tail.length).toBeLessThan(noise.length);
  });
});
