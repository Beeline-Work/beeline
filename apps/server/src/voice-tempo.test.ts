import { expect, it, vi } from 'vitest';
import { voiceTempo } from './voice-tempo.js';

it.each([1.15, 1.3, 1.5])('keeps pitch and duration at %sx across irregular and odd byte boundaries', async speed => {
  const pcm = Buffer.alloc(24000 * 3 * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * 220 * i / 24000)), i * 2);
  async function* input() { for (let i = 0; i < pcm.length; i += 1337) yield pcm.subarray(i, i + 1337); }
  const result = Buffer.concat(await Array.fromAsync(voiceTempo(input(), speed)));
  expect(result.length / 2).toBe(Math.round(72000 / speed));
  let crossings = 0;
  for (let i = 1001; i < result.length / 2 - 1000; i++)
    if (result.readInt16LE((i - 1) * 2) < 0 && result.readInt16LE(i * 2) >= 0) crossings++;
  const frequency = crossings * 24000 / (result.length / 2 - 2001);
  expect(frequency).toBeGreaterThan(218); expect(frequency).toBeLessThan(222);
});

it.each([1.15, 1.3, 1.5])('publishes the first PCM frame at %sx without reading ahead or awaiting a timer', async speed => {
  let reads = 0;
  async function* input() {
    reads++; yield Buffer.alloc(960, 1);
    reads++; throw new Error('No second provider chunk yet');
  }
  const output = voiceTempo(input(), speed);
  const first = await output.next();
  expect(reads).toBe(1); expect(first.value).toEqual(Buffer.alloc(960, 1));
  await output.return(undefined);
});

it.each([1.15, 1.3, 1.5].flatMap(speed => [0, 1, -1, 150, -150].map(padding => ({speed, padding}))))('preserves quiet padding (%s) across odd byte boundaries and speeds only the voiced suffix', async ({speed, padding}) => {
  const silence = Buffer.alloc(960 * 5);
  for (let i = 0; i < silence.length / 2; i++) silence.writeInt16LE(padding, i * 2);
  const tone = Buffer.alloc(24000 * 2);
  for (let i = 0; i < 24000; i++) tone.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * 220 * i / 24000)), i * 2);
  async function* chunks(pcm: Buffer) {
    for (let i = 0; i < pcm.length; i += 137) yield pcm.subarray(i, i + 137);
  }
  const voiced = Buffer.concat(await Array.fromAsync(voiceTempo(chunks(tone), speed)));
  const padded = Buffer.concat(await Array.fromAsync(voiceTempo(chunks(Buffer.concat([silence, tone])), speed)));
  expect(padded.subarray(0, silence.length)).toEqual(silence);
  expect(padded.length).toBe(silence.length + Math.round(24000 / speed) * 2);
  expect(padded.subarray(silence.length)).toEqual(voiced);
});

it('adds zero first-frame delay with timed, fragmented provider delivery', async () => {
  vi.useFakeTimers();
  try {
    const run = async (tempo: boolean) => {
      const start = Date.now();
      async function* input() {
        await new Promise(resolve => setTimeout(resolve, 100));
        yield Buffer.alloc(479, 1);
        await new Promise(resolve => setTimeout(resolve, 10));
        yield Buffer.alloc(481, 1);
      }
      let first = -1, bytes = 0;
      const work = (async () => {
        for await (const chunk of tempo ? voiceTempo(input()) : input()) {
          bytes += chunk.length;
          if (bytes >= 960 && first < 0) first = Date.now() - start;
        }
      })();
      await vi.advanceTimersByTimeAsync(120);
      await work;
      return first;
    };
    expect(await run(false)).toBe(110);
    expect(await run(true)).toBe(110);
  } finally { vi.useRealTimers(); }
});


it.each([undefined, null, 1, 2, '1.5', NaN])('falls back to Normal for unsupported speed %s', async speed => {
  async function* input() { yield Buffer.alloc(4800, 1); }
  const actual = Buffer.concat(await Array.fromAsync(voiceTempo(input(), speed)));
  const normal = Buffer.concat(await Array.fromAsync(voiceTempo(input(), 1.15)));
  expect(actual).toEqual(normal);
});
