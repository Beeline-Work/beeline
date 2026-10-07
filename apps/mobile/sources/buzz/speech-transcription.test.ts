import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionFetch = vi.hoisted(() => vi.fn());
const deleted = vi.hoisted(() => [] as string[]);

vi.mock('@/auth/monolith-session', () => ({ monolithSession: { fetch: sessionFetch } }));
vi.mock('@/utils/readFileBytes', () => ({
  readFileBytes: vi.fn(async (uri: string) => new TextEncoder().encode(uri)),
}));
vi.mock('./runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.test' }),
}));
vi.mock('expo-file-system', () => ({
  File: class {
    constructor(private readonly uri: string) {}
    delete() {
      deleted.push(this.uri);
    }
  },
}));

async function load() {
  vi.resetModules();
  return import('./speech-transcription');
}

beforeEach(() => {
  sessionFetch.mockReset();
  deleted.length = 0;
});

describe('transcribeDictation', () => {
  it('posts each segment with the lexicon and language, joins the text, and deletes the audio', async () => {
    sessionFetch
      .mockResolvedValueOnce(Response.json({ text: 'Ask Jellybean' }))
      .mockResolvedValueOnce(Response.json({ text: 'to open a corner.' }));
    const { transcribeDictation } = await load();

    const text = await transcribeDictation(
      ['file:///a.wav', 'file:///b.wav'],
      ['Jellybean', 'Ruby'],
      'en-GB',
    );

    expect(text).toBe('Ask Jellybean to open a corner.');
    const [url, init, options] = sessionFetch.mock.calls[0]!;
    expect(url).toBe('https://server.test/v1/phone/transcriptions');
    expect(init.headers).toEqual({
      'content-type': 'audio/wav',
      'x-speech-language': 'en',
      'x-speech-prompt': encodeURIComponent('Jellybean, Ruby'),
    });
    expect(options).toEqual({ timeoutMs: 5000 });
    expect(deleted).toEqual(['file:///a.wav', 'file:///b.wav']);
  });

  it('answers null when any segment fails, so the on-device text stays', async () => {
    sessionFetch
      .mockResolvedValueOnce(Response.json({ text: 'one' }))
      .mockResolvedValueOnce(new Response('', { status: 502 }));
    const { transcribeDictation } = await load();

    expect(await transcribeDictation(['file:///a.wav', 'file:///b.wav'], [], 'en-US')).toBeNull();
    expect(deleted).toEqual(['file:///a.wav', 'file:///b.wav']);
  });

  it('stops offering transcription after the server reports no Groq key', async () => {
    sessionFetch.mockResolvedValueOnce(
      Response.json({ error: 'transcription_unavailable' }, { status: 503 }),
    );
    const { dictationTranscriptionAvailable, transcribeDictation } = await load();

    expect(dictationTranscriptionAvailable()).toBe(true);
    expect(await transcribeDictation(['file:///a.wav'], [], 'en-US')).toBeNull();
    expect(dictationTranscriptionAvailable()).toBe(false);
  });

  it('answers null when the request throws or times out', async () => {
    sessionFetch.mockRejectedValueOnce(new Error('timeout'));
    const { transcribeDictation } = await load();
    expect(await transcribeDictation(['file:///a.wav'], [], 'en-US')).toBeNull();
    expect(deleted).toEqual(['file:///a.wav']);
  });
});
