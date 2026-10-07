import { describe, expect, it } from 'vitest';
import { compressDictationWav } from './wav-adpcm';

const STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73,
  80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494,
  544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499,
  2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
  12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const INDEX_STEPS = [-1, -1, -1, -1, 2, 4, 6, 8];

function pcmWav(samples: Int16Array, rate = 16000, channels = 1, dataSize?: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(out.buffer);
  const text = (offset: number, value: string) =>
    [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, out.length - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2 * channels, true);
  view.setUint16(32, 2 * channels, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, dataSize ?? samples.length * 2, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, s, true));
  return out;
}

/** Reference IMA ADPCM WAV decoder (Microsoft block layout). */
function decode(wav: Uint8Array): { format: number; rate: number; samples: number[] } {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const format = view.getUint16(20, true);
  const rate = view.getUint32(24, true);
  const blockBytes = view.getUint16(32, true);
  const total = view.getUint32(48, true);
  const dataSize = view.getUint32(56, true);
  const samples: number[] = [];
  for (let base = 60; base < 60 + dataSize; base += blockBytes) {
    let predicted = view.getInt16(base, true);
    let index = view.getUint8(base + 2);
    samples.push(predicted);
    for (let i = 0; i < (blockBytes - 4) * 2; i++) {
      const byte = view.getUint8(base + 4 + (i >> 1));
      const nibble = i & 1 ? byte >> 4 : byte & 15;
      const step = STEPS[index]!;
      let delta = step >> 3;
      if (nibble & 4) delta += step;
      if (nibble & 2) delta += step >> 1;
      if (nibble & 1) delta += step >> 2;
      predicted = Math.max(-32768, Math.min(32767, predicted + (nibble & 8 ? -delta : delta)));
      index = Math.max(0, Math.min(88, index + INDEX_STEPS[nibble & 7]!));
      samples.push(predicted);
    }
  }
  return { format, rate, samples: samples.slice(0, total) };
}

function speechLike(count: number): Int16Array {
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    const t = i / 16000;
    samples[i] = Math.round(
      6000 * Math.sin(2 * Math.PI * 220 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t)) +
        2500 * Math.sin(2 * Math.PI * 1300 * t),
    );
  }
  return samples;
}

describe('compressDictationWav', () => {
  it('turns a 16-bit mono PCM WAV into IMA ADPCM WAV a quarter of the size', () => {
    const samples = speechLike(16000 * 5);
    const pcm = pcmWav(samples);

    const compressed = compressDictationWav(pcm);

    expect(compressed.length).toBeLessThan(pcm.length / 3.9);
    const decoded = decode(compressed);
    expect(decoded.format).toBe(0x11);
    expect(decoded.rate).toBe(16000);
    expect(decoded.samples).toHaveLength(samples.length);
    let signal = 0;
    let noise = 0;
    samples.forEach((s, i) => {
      signal += s * s;
      noise += (s - decoded.samples[i]!) ** 2;
    });
    // Speech-grade fidelity: the signal stays well over 20 dB above the coding error.
    expect(10 * Math.log10(signal / noise)).toBeGreaterThan(20);
  });

  it('reads to the end of the file when the recorder left the data size unset', () => {
    const samples = speechLike(4000);

    const decoded = decode(compressDictationWav(pcmWav(samples, 16000, 1, 0)));

    expect(decoded.samples).toHaveLength(samples.length);
  });

  it('returns anything other than 16-bit mono PCM WAV unchanged', () => {
    const stereo = pcmWav(speechLike(1000), 16000, 2);
    const text = new TextEncoder().encode('not audio');

    expect(compressDictationWav(stereo)).toBe(stereo);
    expect(compressDictationWav(text)).toBe(text);
  });
});
