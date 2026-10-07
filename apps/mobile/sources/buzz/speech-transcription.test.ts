import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionFetch = vi.hoisted(() => vi.fn());
const deleted = vi.hoisted(() => [] as string[]);
const recordings = vi.hoisted(() => new Map<string, Uint8Array>());

vi.mock('@/auth/monolith-session', () => ({ monolithSession: { fetch: sessionFetch } }));
vi.mock('@/utils/readFileBytes', () => ({
  readFileBytes: vi.fn(async (uri: string) => recordings.get(uri) ?? new TextEncoder().encode(uri)),
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
  recordings.clear();
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

  it('uploads a PCM recording as IMA ADPCM, a quarter of the bytes', async () => {
    const samples = 16000 * 3;
    const wav = new Uint8Array(44 + samples * 2);
    const view = new DataView(wav.buffer);
    [...'RIFF'].forEach((c, i) => view.setUint8(i, c.charCodeAt(0)));
    view.setUint32(4, wav.length - 8, true);
    [...'WAVEfmt '].forEach((c, i) => view.setUint8(8 + i, c.charCodeAt(0)));
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    [...'data'].forEach((c, i) => view.setUint8(36 + i, c.charCodeAt(0)));
    view.setUint32(40, samples * 2, true);
    for (let i = 0; i < samples; i++)
      view.setInt16(44 + i * 2, Math.round(4000 * Math.sin(i / 7)), true);
    recordings.set('file:///take.wav', wav);
    sessionFetch.mockResolvedValueOnce(Response.json({ text: 'Groq Whisper' }));
    const { transcribeDictation } = await load();

    expect(await transcribeDictation(['file:///take.wav'], [], 'en-US')).toBe('Groq Whisper');
    const body = sessionFetch.mock.calls[0]![1].body as Uint8Array;
    expect(new DataView(body.buffer, body.byteOffset).getUint16(20, true)).toBe(0x11);
    expect(body.length).toBeLessThan(wav.length / 3.8);
  });
});
