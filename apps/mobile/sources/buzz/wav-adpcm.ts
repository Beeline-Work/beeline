/**
 * Shrinks a 16-bit mono PCM WAV to IMA ADPCM WAV (4 bits per sample), a
 * quarter of the bytes. Dictation uploads raw PCM at 32 KB per second of
 * speech, which a weak phone uplink cannot send before the 5 s deadline;
 * Groq's Whisper decodes IMA ADPCM WAV with the same transcript.
 */

const STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73,
  80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494,
  544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499,
  2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
  12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const INDEX_STEPS = [-1, -1, -1, -1, 2, 4, 6, 8];
const BLOCK_BYTES = 256;
// One header sample plus two 4-bit samples per byte after the 4-byte block header.
const SAMPLES_PER_BLOCK = 1 + (BLOCK_BYTES - 4) * 2;
const HEADER_BYTES = 60;

function ascii(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/** Returns the PCM samples of a 16-bit mono WAV, or null for any other file. */
function pcmSamples(wav: Uint8Array): { rate: number; samples: Int16Array } | null {
  if (wav.length < 12) return null;
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  if (ascii(view, 0) !== 'RIFF' || ascii(view, 8) !== 'WAVE') return null;
  let rate = 0;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = ascii(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (body + 16 > wav.length) return null;
      const format = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const bits = view.getUint16(body + 14, true);
      if (format !== 1 || channels !== 1 || bits !== 16) return null;
      rate = view.getUint32(body + 4, true);
    } else if (id === 'data') {
      if (!rate) return null;
      // A recorder that never patched the size leaves 0; read to the end.
      const end = size && body + size <= wav.length ? body + size : wav.length;
      const count = Math.floor((end - body) / 2);
      const samples = new Int16Array(count);
      for (let i = 0; i < count; i++) samples[i] = view.getInt16(body + i * 2, true);
      return { rate, samples };
    }
    offset = body + size + (size & 1);
  }
  return null;
}

/** Answers the IMA ADPCM WAV for a 16-bit mono PCM WAV; any other input is returned unchanged. */
export function compressDictationWav(wav: Uint8Array): Uint8Array {
  const pcm = pcmSamples(wav);
  if (!pcm || !pcm.samples.length) return wav;
  const { rate, samples } = pcm;
  const blocks = Math.ceil(samples.length / SAMPLES_PER_BLOCK);
  const out = new Uint8Array(HEADER_BYTES + blocks * BLOCK_BYTES);
  const view = new DataView(out.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < 4; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, out.length - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 20, true);
  view.setUint16(20, 0x11, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, Math.floor((rate * BLOCK_BYTES) / SAMPLES_PER_BLOCK), true);
  view.setUint16(32, BLOCK_BYTES, true);
  view.setUint16(34, 4, true);
  view.setUint16(36, 2, true);
  view.setUint16(38, SAMPLES_PER_BLOCK, true);
  text(40, 'fact');
  view.setUint32(44, 4, true);
  view.setUint32(48, samples.length, true);
  text(52, 'data');
  view.setUint32(56, blocks * BLOCK_BYTES, true);

  let index = 0;
  for (let block = 0; block < blocks; block++) {
    const start = block * SAMPLES_PER_BLOCK;
    const base = HEADER_BYTES + block * BLOCK_BYTES;
    let predicted = samples[start]!;
    view.setInt16(base, predicted, true);
    out[base + 2] = index;
    for (let i = 0; i < SAMPLES_PER_BLOCK - 1; i++) {
      const position = start + 1 + i;
      // The last block repeats its prediction as padding.
      const sample = position < samples.length ? samples[position]! : predicted;
      let step = STEPS[index]!;
      let difference = sample - predicted;
      let nibble = 0;
      if (difference < 0) {
        nibble = 8;
        difference = -difference;
      }
      let quantized = step >> 3;
      if (difference >= step) {
        nibble |= 4;
        difference -= step;
        quantized += step;
      }
      step >>= 1;
      if (difference >= step) {
        nibble |= 2;
        difference -= step;
        quantized += step;
      }
      step >>= 1;
      if (difference >= step) {
        nibble |= 1;
        quantized += step;
      }
      predicted += nibble & 8 ? -quantized : quantized;
      predicted = Math.max(-32768, Math.min(32767, predicted));
      index = Math.max(0, Math.min(88, index + INDEX_STEPS[nibble & 7]!));
      const byte = base + 4 + (i >> 1);
      out[byte] = i & 1 ? out[byte]! | (nibble << 4) : nibble;
    }
  }
  return out;
}

/** Seconds of audio in a 16-bit mono PCM WAV, or null for any other file. */
export function dictationWavSeconds(wav: Uint8Array): number | null {
  const pcm = pcmSamples(wav);
  return pcm ? pcm.samples.length / pcm.rate : null;
}

/**
 * Joins 16-bit mono PCM WAVs of one rate into one PCM WAV, in order. Answers
 * null when any input is another format or the rates differ.
 */
export function concatDictationWavs(wavs: readonly Uint8Array[]): Uint8Array | null {
  const parts = wavs.map(pcmSamples);
  const rate = parts[0]?.rate;
  if (!rate || parts.some((part) => !part || part.rate !== rate)) return null;
  const count = parts.reduce((total, part) => total + part!.samples.length, 0);
  const out = new Uint8Array(44 + count * 2);
  const view = new DataView(out.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < 4; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, out.length - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, count * 2, true);
  let offset = 44;
  for (const part of parts) {
    for (const sample of part!.samples) {
      view.setInt16(offset, sample, true);
      offset += 2;
    }
  }
  return out;
}
