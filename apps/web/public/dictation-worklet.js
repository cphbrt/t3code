/**
 * Dictation capture worklet.
 *
 * Lives in `public/` rather than the module graph on purpose: the desktop
 * renderer's CSP allows scripts from `'self'` but not `blob:`, so registering
 * this processor from a Blob URL would work in dev and fail in the packaged
 * app. Served as a plain static asset it is same-origin in both.
 *
 * Runs on the audio thread, so it must stay allocation-light. It batches the
 * 128-sample render quanta into larger chunks before posting to the main
 * thread; at 16 kHz that turns ~125 messages per second into ~4.
 */

/** Samples per message. ~256 ms at 16 kHz: coarse enough to be cheap, fine
    enough that stopping mid-chunk loses nothing a listener would notice. */
const CHUNK_SAMPLES = 4096;

class DictationCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(CHUNK_SAMPLES);
    this._filled = 0;
    this._stopped = false;
    this.port.onmessage = (event) => {
      if (event.data === "flush") {
        this._flush();
        this._stopped = true;
        this.port.postMessage({ type: "done" });
      }
    };
  }

  _flush() {
    if (this._filled === 0) return;
    // `slice` copies, so the transfer neuters only the copy; the scratch
    // buffer stays owned by the audio thread and is refilled in place.
    const chunk = this._buffer.slice(0, this._filled);
    this.port.postMessage({ type: "audio", samples: chunk }, [chunk.buffer]);
    this._filled = 0;
  }

  process(inputs) {
    if (this._stopped) return false;
    const channel = inputs[0] && inputs[0][0];
    // No connected input yet (or a muted device): keep the node alive.
    if (!channel) return true;

    for (let index = 0; index < channel.length; index += 1) {
      this._buffer[this._filled] = channel[index];
      this._filled += 1;
      if (this._filled === CHUNK_SAMPLES) this._flush();
    }
    return true;
  }
}

registerProcessor("dictation-capture", DictationCaptureProcessor);
