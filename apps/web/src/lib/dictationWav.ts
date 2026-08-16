/**
 * Minimal WAV encoding for dictation capture.
 *
 * whisper.cpp reads a file rather than a stream, and wants 16 kHz mono PCM.
 * The capture path already produces exactly that (an `AudioContext` opened at
 * 16 kHz hands us mono `Float32Array` blocks), so all that is missing is a
 * container. Writing the 44-byte canonical WAV header by hand keeps the
 * feature free of an encoder dependency and avoids shelling out to `afconvert`
 * or `ffmpeg`.
 */

/** Byte length of a canonical PCM WAV header: RIFF + fmt + data chunk headers. */
export const WAV_HEADER_BYTES = 44;

/** WAV format tag for uncompressed integer PCM. */
const WAVE_FORMAT_PCM = 1;

const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;

/**
 * Convert normalized float samples to signed 16-bit PCM.
 *
 * Samples outside [-1, 1] are clamped rather than allowed to wrap: a wrapped
 * sample flips to the opposite polarity and sounds like a loud click, which
 * whisper happily transcribes as a spurious word.
 */
export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
    // Asymmetric scaling: int16 holds -32768..32767, so -1 and +1 both map to
    // full scale without either end clipping.
    out[index] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
  }
  return out;
}

/**
 * Wrap mono float samples in a 16-bit PCM WAV file.
 *
 * Returns a standalone `Uint8Array` suitable for handing straight to the
 * desktop bridge, which writes it to a temp file for whisper.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`WAV sample rate must be a positive integer, got ${sampleRate}.`);
  }
  const pcm = floatToInt16(samples);
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  const byteRate = (sampleRate * CHANNELS * BITS_PER_SAMPLE) / 8;
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8;

  // RIFF chunk descriptor.
  writeAscii(0, "RIFF");
  // Size of everything after this field, i.e. the file minus "RIFF" + size.
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");

  // fmt subchunk.
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk body is 16 bytes.
  view.setUint16(20, WAVE_FORMAT_PCM, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);

  // data subchunk.
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < pcm.length; index += 1) {
    view.setInt16(WAV_HEADER_BYTES + index * 2, pcm[index] ?? 0, true);
  }

  return new Uint8Array(buffer);
}

/**
 * Flatten the block list an audio worklet accumulates into one contiguous
 * buffer. Kept separate from `encodeWav` so the recorder can report a live
 * duration without paying for a copy.
 */
export function concatFloat32(blocks: readonly Float32Array[]): Float32Array {
  let total = 0;
  for (const block of blocks) total += block.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}
