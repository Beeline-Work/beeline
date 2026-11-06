import { expect, it, vi } from 'vitest';
const request = vi.hoisted(() => vi.fn());
vi.mock('@/auth/monolith-session', () => ({ monolithSession: { fetch: request } }));
vi.mock('@/utils/readFileBytes', () => ({ readFileBytes: async () => new Uint8Array([1, 2]) }));
vi.mock('./runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'http://fixture.invalid' }) }));
vi.mock('./wav-adpcm', () => ({
  compressDictationWav: (bytes: Uint8Array) => bytes,
  concatDictationWavs: () => null, dictationWavSeconds: () => 3,
  splitDictationWav: (bytes: Uint8Array) => [bytes],
}));
import { startDictationUpload } from './speech-transcription';

it('settles a failed piece without resending its audio when capture stops', async () => {
  request.mockRejectedValue(new Error('Upload disconnected'));
  const take = startDictationUpload([], 'en-US');
  take.add('blob:fixture');
  expect(await take.finish()).toBeNull();
  expect(request).toHaveBeenCalledOnce();
});
