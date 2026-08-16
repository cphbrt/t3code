# Dictation

Speak your prompt instead of typing it. CPH Code records from your microphone, transcribes the audio on your own machine, and appends the text to whatever is already in the composer.

Dictation is available in the macOS desktop app only, and it needs a local [whisper.cpp](https://github.com/ggml-org/whisper.cpp) build. Nothing is sent to a provider or to any server: the recording is transcribed locally and the audio is discarded as soon as the text comes back.

## Set it up

You supply the transcriber, so CPH Code never downloads a model behind your back.

1. Build or install whisper.cpp and note the full path to its command-line binary.
2. Download a ggml model file and note its full path. Smaller models transcribe faster; larger ones are more accurate.
3. Open **Settings → General → Dictation** and paste both paths in.
4. Pick the language you speak. Choose **Detect automatically** if you switch languages; English-only models ignore this setting.

The section shows a live status line under the binary field. It stays red and names the exact problem — a binary it cannot find, a model that is not there yet — until both paths check out, then reports that dictation is ready.

## Dictate

The microphone button sits next to the send button.

- Click it to start recording. It turns red and counts up while it listens.
- Click it again to stop. The button shows a spinner while whisper works, then the text lands at the end of the composer.
- Press **Escape** while recording to throw the recording away without transcribing it.

The first recording asks for microphone permission. If you refuse and change your mind, grant it in **System Settings → Privacy & Security → Microphone**.

The button is disabled with an explanation when dictation is not configured, and hidden entirely outside the macOS desktop app. Very short recordings are ignored, so a mis-click costs nothing.

If the composer cannot accept the text — because it is busy, or waiting on an approval — the transcript is offered in a notification with a button to copy it, rather than being thrown away.

One recording is transcribed at a time. Transcription is CPU-bound, so a long recording on a large model takes a while; anything that runs past a minute is abandoned and reported.
