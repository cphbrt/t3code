import { describe, expect, it } from "vite-plus/test";

import { WAV_HEADER_BYTES, concatFloat32, encodeWav, floatToInt16 } from "./dictationWav";

const ascii = (bytes: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...bytes.slice(offset, offset + length));

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

describe("floatToInt16", () => {
  it("maps the full-scale endpoints without wrapping", () => {
    const pcm = floatToInt16(new Float32Array([1, -1, 0]));
    expect(Array.from(pcm)).toEqual([32767, -32768, 0]);
  });

  it("clamps out-of-range samples instead of letting them wrap polarity", () => {
    const pcm = floatToInt16(new Float32Array([1.5, -1.5]));
    expect(Array.from(pcm)).toEqual([32767, -32768]);
  });

  it("scales interior samples proportionally", () => {
    const pcm = floatToInt16(new Float32Array([0.5, -0.5]));
    expect(Array.from(pcm)).toEqual([16384, -16384]);
  });
});

describe("encodeWav", () => {
  it("writes a canonical 44-byte PCM header", () => {
    const bytes = encodeWav(new Float32Array([0, 0, 0, 0]), 16_000);
    const data = view(bytes);

    expect(ascii(bytes, 0, 4)).toBe("RIFF");
    expect(ascii(bytes, 8, 4)).toBe("WAVE");
    expect(ascii(bytes, 12, 4)).toBe("fmt ");
    expect(ascii(bytes, 36, 4)).toBe("data");

    // Everything after the RIFF size field: 36 header bytes + 8 sample bytes.
    expect(data.getUint32(4, true)).toBe(36 + 8);
    expect(data.getUint32(16, true)).toBe(16); // fmt chunk body size
    expect(data.getUint16(20, true)).toBe(1); // WAVE_FORMAT_PCM
    expect(data.getUint16(22, true)).toBe(1); // mono
    expect(data.getUint32(24, true)).toBe(16_000); // sample rate
    expect(data.getUint32(28, true)).toBe(32_000); // byte rate
    expect(data.getUint16(32, true)).toBe(2); // block align
    expect(data.getUint16(34, true)).toBe(16); // bits per sample
    expect(data.getUint32(40, true)).toBe(8); // data chunk size
  });

  it("sizes the file as header plus two bytes per sample", () => {
    const bytes = encodeWav(new Float32Array(1_000), 16_000);
    expect(bytes.byteLength).toBe(WAV_HEADER_BYTES + 2_000);
  });

  it("writes samples little-endian after the header", () => {
    const bytes = encodeWav(new Float32Array([1, -1]), 16_000);
    const data = view(bytes);
    expect(data.getInt16(WAV_HEADER_BYTES, true)).toBe(32767);
    expect(data.getInt16(WAV_HEADER_BYTES + 2, true)).toBe(-32768);
  });

  it("encodes an empty recording as a header-only file", () => {
    const bytes = encodeWav(new Float32Array(0), 16_000);
    expect(bytes.byteLength).toBe(WAV_HEADER_BYTES);
    expect(view(bytes).getUint32(40, true)).toBe(0);
  });

  it("rejects a nonsensical sample rate rather than writing a corrupt header", () => {
    expect(() => encodeWav(new Float32Array([0]), 0)).toThrow(RangeError);
  });
});

describe("concatFloat32", () => {
  it("joins blocks in order", () => {
    const joined = concatFloat32([new Float32Array([1, 2]), new Float32Array([3])]);
    expect(Array.from(joined)).toEqual([1, 2, 3]);
  });

  it("returns an empty buffer for no blocks", () => {
    expect(concatFloat32([]).length).toBe(0);
  });
});
