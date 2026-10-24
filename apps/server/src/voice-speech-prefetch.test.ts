import { expect, it } from 'vitest';
import { VoiceSpeechPrefetch } from './voice-speech-prefetch.js';

it('cancels an awaiting reader even if the provider ignores abort', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const parent = new AbortController();
  const opening = new VoiceSpeechPrefetch('Hello.',parent.signal,async function*(){ await gate; yield new Uint8Array([1,2]); });
  const reader = opening.read(); const first = reader.next();
  parent.abort();
  await expect(first).rejects.toMatchObject({name:'AbortError'});
  release();
});

it('bounds a private opening rather than accumulating an unbounded provider response', async () => {
  const opening = new VoiceSpeechPrefetch('Hello.',new AbortController().signal,async function*(){yield new Uint8Array(1_048_577);});
  await expect(Array.fromAsync(opening.read())).rejects.toThrow('prefetch budget');
});
