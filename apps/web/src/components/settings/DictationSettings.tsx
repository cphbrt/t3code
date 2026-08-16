/**
 * Dictation configuration, rendered only in the macOS desktop app.
 *
 * Transcription runs against a whisper.cpp binary and model the user supplies,
 * so both are plain path fields with a live availability check rather than a
 * managed download.
 */
import { useEffect, useRef, useState } from "react";
import type { DesktopDictationAvailability } from "@t3tools/contracts";
import { DEFAULT_DICTATION_LANGUAGE } from "@t3tools/contracts/settings";

import { dictationBridge } from "~/hooks/useDictation";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * Languages offered in the picker. whisper accepts far more codes, but a
 * short list covers dictation in practice and keeps the control a picker
 * rather than another free-text field to typo.
 */
const DICTATION_LANGUAGES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "auto", label: "Detect automatically" },
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
  { value: "nl", label: "Dutch" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "zh", label: "Chinese" },
];

const languageLabel = (value: string) =>
  DICTATION_LANGUAGES.find((entry) => entry.value === value)?.label ?? value;

/**
 * A path field that commits on blur rather than on every keystroke.
 *
 * Persisting mid-word would fire an availability re-check against a
 * half-typed path and flash a misleading "not found".
 */
function PathSettingInput({
  label,
  placeholder,
  value,
  onCommit,
}: {
  label: string;
  placeholder: string;
  value: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [lastValue, setLastValue] = useState(value);
  if (lastValue !== value) {
    // Adopt an external change (hydration, edit from another window).
    setLastValue(value);
    setDraft(value);
  }

  return (
    <Input
      aria-label={label}
      autoCapitalize="off"
      autoComplete="off"
      autoCorrect="off"
      className="w-full sm:w-96"
      maxLength={1024}
      onBlur={() => onCommit(draft.trim())}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setDraft(value);
        }
      }}
      placeholder={placeholder}
      spellCheck={false}
      value={draft}
    />
  );
}

function AvailabilityStatus({
  availability,
}: {
  availability: DesktopDictationAvailability | null;
}) {
  if (availability === null) {
    return <span className="text-muted-foreground">Checking…</span>;
  }
  if (availability.available) {
    return <span className="text-success">Ready to dictate.</span>;
  }
  return <span className="text-destructive">{availability.note ?? "Not available."}</span>;
}

export function DictationSettings({
  whisperCliPath,
  modelPath,
  language,
  onUpdate,
}: {
  whisperCliPath: string;
  modelPath: string;
  language: string;
  onUpdate: (patch: {
    dictationWhisperCliPath?: string;
    dictationModelPath?: string;
    dictationLanguage?: string;
  }) => void;
}) {
  const [availability, setAvailability] = useState<DesktopDictationAvailability | null>(null);
  // Only the newest check may write the status line. Two edits in quick
  // succession race, and the older reply landing last would leave the row
  // describing a configuration the user has already moved past.
  const checkGenerationRef = useRef(0);

  // Re-check whenever either path changes, so fixing one is confirmed without
  // leaving the page. The paths are passed explicitly rather than left to the
  // main process to read back: `updateSettings` writes them to disk
  // asynchronously and without awaiting, so a check that consulted persisted
  // settings here would answer for the previous configuration and report a
  // stale verdict.
  useEffect(() => {
    const bridge = dictationBridge();
    if (!bridge) return;
    const generation = checkGenerationRef.current + 1;
    checkGenerationRef.current = generation;

    void (async () => {
      let next: DesktopDictationAvailability;
      try {
        next = await bridge.checkAvailability({ whisperCliPath, modelPath });
      } catch {
        next = { available: false, note: "Could not check dictation availability." };
      }
      if (checkGenerationRef.current === generation) setAvailability(next);
    })();
  }, [whisperCliPath, modelPath]);

  return (
    <SettingsSection id="dictation" title="Dictation">
      <SettingsRow
        {...searchableSetting("dictation-whisper-cli")}
        description="Absolute path to a whisper.cpp command-line binary. Dictation runs locally; audio never leaves this machine."
        status={<AvailabilityStatus availability={availability} />}
        control={
          <PathSettingInput
            label="Dictation binary path"
            placeholder="/path/to/whisper-cli"
            value={whisperCliPath}
            onCommit={(next) => onUpdate({ dictationWhisperCliPath: next })}
          />
        }
      />

      <SettingsRow
        {...searchableSetting("dictation-model")}
        description="Absolute path to a ggml model file. Smaller models transcribe faster; larger ones are more accurate."
        control={
          <PathSettingInput
            label="Dictation model path"
            placeholder="/path/to/ggml-small.en.bin"
            value={modelPath}
            onCommit={(next) => onUpdate({ dictationModelPath: next })}
          />
        }
      />

      <SettingsRow
        {...searchableSetting("dictation-language")}
        description="Spoken language passed to whisper. English-only models ignore this."
        control={
          <Select
            value={language}
            onValueChange={(next) => {
              if (typeof next !== "string") return;
              onUpdate({ dictationLanguage: next });
            }}
          >
            <SelectTrigger className="w-full sm:w-52" aria-label="Dictation language">
              <SelectValue>{languageLabel(language || DEFAULT_DICTATION_LANGUAGE)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {DICTATION_LANGUAGES.map((entry) => (
                <SelectItem hideIndicator key={entry.value} value={entry.value}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
