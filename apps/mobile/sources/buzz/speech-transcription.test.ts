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

function pcmWav(seconds: number): Uint8Array {
  const samples = Math.round(16000 * seconds);
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
  return wav;
}

/** Sample count in the IMA ADPCM upload's fact chunk. */
function uploadedSamples(call: number): number {
  const body = sessionFetch.mock.calls[call]![1].body as Uint8Array;
  return new DataView(body.buffer, body.byteOffset).getUint32(48, true);
}

function prompts(): string[] {
  return sessionFetch.mock.calls.map(([, init]) =>
    decodeURIComponent(init.headers['x-speech-prompt'] ?? ''),
  );
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('startDictationUpload', () => {
  it('uploads each piece when it closes, before stop, with the lexicon and language', async () => {
    sessionFetch.mockResolvedValueOnce(Response.json({ text: 'Ask Jellybean' }));
    const { startDictationUpload } = await load();

    const upload = startDictationUpload(['Jellybean', 'Ruby'], 'en-GB');
    upload.add('file:///a.wav');
    await settle();

    expect(sessionFetch).toHaveBeenCalledTimes(1);
    const [url, init, options] = sessionFetch.mock.calls[0]!;
    expect(url).toBe('https://server.test/v1/phone/transcriptions');
    expect(init.headers).toEqual({
      'content-type': 'audio/wav',
      'x-speech-language': 'en',
      'x-speech-prompt': encodeURIComponent('Jellybean, Ruby'),
    });
    expect(options).toEqual({ timeoutMs: 15_000 });
    expect(await upload.finish()).toBe('Ask Jellybean');
    expect(deleted).toEqual(['file:///a.wav']);
  });

  it('sends pieces one at a time, each prompted with the text before it, and joins the seams', async () => {
    let first!: (response: Response) => void;
    sessionFetch
      .mockReturnValueOnce(new Promise<Response>((resolve) => (first = resolve)))
      .mockResolvedValueOnce(Response.json({ text: 'To open a corner.' }));
    const { startDictationUpload } = await load();

    const upload = startDictationUpload(['Jellybean', 'Ruby'], 'en-GB');
    upload.add('file:///a.wav');
    upload.add('file:///b.wav');
    await settle();
    expect(sessionFetch).toHaveBeenCalledTimes(1);

    first(Response.json({ text: 'Ask Jellybean' }));
    expect(await upload.finish()).toBe('Ask Jellybean to open a corner.');
    expect(prompts()).toEqual(['Jellybean, Ruby', 'Jellybean, Ruby. Ask Jellybean']);
    expect(deleted).toEqual(['file:///a.wav', 'file:///b.wav']);
  });

  it('merges a piece under two seconds into the next one', async () => {
    recordings.set('file:///short.wav', pcmWav(1));
    recordings.set('file:///long.wav', pcmWav(3));
    sessionFetch.mockResolvedValueOnce(Response.json({ text: 'show me a mock' }));
    const { startDictationUpload } = await load();

    const upload = startDictationUpload([], 'en-US');
    upload.add('file:///short.wav');
    await settle();
    expect(sessionFetch).not.toHaveBeenCalled();
    upload.add('file:///long.wav');

    expect(await upload.finish()).toBe('show me a mock');
    expect(sessionFetch).toHaveBeenCalledTimes(1);
    expect(uploadedSamples(0)).toBe(16000 * 4);
  });

  it('uploads a short final piece alone on stop', async () => {
    recordings.set('file:///long.wav', pcmWav(3));
    recordings.set('file:///short.wav', pcmWav(1));
    sessionFetch
      .mockResolvedValueOnce(Response.json({ text: 'show me a' }))
      .mockResolvedValueOnce(Response.json({ text: 'Mock.' }));
    const { startDictationUpload } = await load();

    const upload = startDictationUpload([], 'en-US');
    upload.add('file:///long.wav');
    upload.add('file:///short.wav');

    expect(await upload.finish()).toBe('show me a Mock.');
    expect(uploadedSamples(0)).toBe(16000 * 3);
    expect(uploadedSamples(1)).toBe(16000);
  });

  it('answers null when any piece fails, and sends no later piece', async () => {
    sessionFetch.mockResolvedValueOnce(new Response('', { status: 502 }));
    const { startDictationUpload } = await load();

    const upload = startDictationUpload([], 'en-US');
    upload.add('file:///a.wav');
    upload.add('file:///b.wav');

    expect(await upload.finish()).toBeNull();
    expect(sessionFetch).toHaveBeenCalledTimes(1);
    expect(deleted).toEqual(['file:///a.wav', 'file:///b.wav']);
  });

  it('answers null when the last piece is still out at the stop deadline', async () => {
    sessionFetch.mockReturnValueOnce(new Promise<Response>(() => {}));
    const { startDictationUpload } = await load();

    const upload = startDictationUpload([], 'en-US');
    upload.add('file:///a.wav');

    expect(await upload.finish(20)).toBeNull();
    expect(deleted).toEqual(['file:///a.wav']);
  });

  it('stops offering transcription after the server reports no Groq key', async () => {
    sessionFetch.mockResolvedValueOnce(
      Response.json({ error: 'transcription_unavailable' }, { status: 503 }),
    );
    const { dictationTranscriptionAvailable, startDictationUpload } = await load();

    expect(dictationTranscriptionAvailable()).toBe(true);
    const upload = startDictationUpload([], 'en-US');
    upload.add('file:///a.wav');
    expect(await upload.finish()).toBeNull();
    expect(dictationTranscriptionAvailable()).toBe(false);
  });

  it('answers null when the request throws', async () => {
    sessionFetch.mockRejectedValueOnce(new Error('network'));
    const { startDictationUpload } = await load();
    const upload = startDictationUpload([], 'en-US');
    upload.add('file:///a.wav');
    expect(await upload.finish()).toBeNull();
    expect(deleted).toEqual(['file:///a.wav']);
  });

  it('deletes and never sends a piece after the take is discarded', async () => {
    const { startDictationUpload } = await load();
    const upload = startDictationUpload([], 'en-US');
    upload.discard();
    upload.add('file:///late.wav');
    await settle();
    expect(sessionFetch).not.toHaveBeenCalled();
    expect(deleted).toEqual(['file:///late.wav']);
  });

  it('sends a long note to Groq in chunks and waits for them past the base stop deadline', async () => {
    // Reproduction R1: one 90 s piece closes at stop on a 1 Mbit/s uplink.
    vi.useFakeTimers();
    try {
      recordings.set('file:///long.wav', pcmWav(90));
      // The phone's uplink is shared: requests send their bytes one after another.
      let linkFreeAt = 0;
      sessionFetch.mockImplementation((_url: string, init: { body: Uint8Array }) => {
        const start = Math.max(Date.now(), linkFreeAt);
        linkFreeAt = start + (init.body.length / 125_000) * 1000;
        const answer = linkFreeAt + 500 - Date.now();
        const call = sessionFetch.mock.calls.length;
        return new Promise<Response>((resolve) =>
          setTimeout(() => resolve(Response.json({ text: `part ${call}.` })), answer),
        );
      });
      const { startDictationUpload } = await load();

      const upload = startDictationUpload([], 'en-US');
      upload.add('file:///long.wav');
      const result = upload.finish();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(await result).toBe('part 1. part 2.');
      expect(sessionFetch).toHaveBeenCalledTimes(2);
      expect(uploadedSamples(0) + uploadedSamples(1)).toBeGreaterThanOrEqual(16000 * 90);
      expect(uploadedSamples(0)).toBeLessThanOrEqual(16000 * 60 + 505);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uploads a PCM recording as IMA ADPCM, a quarter of the bytes', async () => {
    const wav = pcmWav(3);
    recordings.set('file:///take.wav', wav);
    sessionFetch.mockResolvedValueOnce(Response.json({ text: 'Groq Whisper' }));
    const { startDictationUpload } = await load();

    const upload = startDictationUpload([], 'en-US');
    upload.add('file:///take.wav');
    expect(await upload.finish()).toBe('Groq Whisper');
    const body = sessionFetch.mock.calls[0]![1].body as Uint8Array;
    expect(new DataView(body.buffer, body.byteOffset).getUint16(20, true)).toBe(0x11);
    expect(body.length).toBeLessThan(wav.length / 3.8);
  });
});

describe('dictationPrompt', () => {
  it('keeps the end of the text so far within the server limit when the lexicon is long', async () => {
    const { dictationPrompt } = await load();
    const lexicon = Array.from({ length: 100 }, (_, i) => `Member${i}`);
    const previous = 'word '.repeat(80) + 'and then ask Jellybean';

    const prompt = dictationPrompt(lexicon, previous);

    expect(prompt.length).toBeLessThanOrEqual(600);
    expect(prompt.startsWith('Member0, Member1')).toBe(true);
    expect(prompt.endsWith('and then ask Jellybean')).toBe(true);
  });
});
