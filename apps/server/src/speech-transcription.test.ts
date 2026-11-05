import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqlDatabase } from './database.js';
import type { TokenAuth } from './auth.js';
import type { PhoneService } from './phone-service.js';
import type { DaemonService } from './daemon-service.js';
import type { LiveHub } from './live.js';
import { createBeelineServer } from './server.js';
import {
  GROQ_TRANSCRIPTION_MODEL,
  GROQ_TRANSCRIPTION_URL,
  SpeechTranscriber,
  TRANSCRIPTION_MAXIMUM_BYTES,
  speechTranscriberFromEnv,
} from './speech-transcription.js';

const WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);

describe('SpeechTranscriber', () => {
  it('sends the audio, lexicon prompt and language to Groq Whisper', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ text: ' Ask @jellybean to open a corner. ' }),
    );
    const transcriber = new SpeechTranscriber('groq-test-key', fetchImpl as typeof fetch);

    const text = await transcriber.transcribe({
      audio: WAV,
      mimeType: 'audio/wav',
      prompt: 'jellybean, corner, Beeline',
      language: 'en',
    });

    expect(text).toBe('Ask @jellybean to open a corner.');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(GROQ_TRANSCRIPTION_URL);
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer groq-test-key');
    const form = init!.body as FormData;
    expect(form.get('model')).toBe(GROQ_TRANSCRIPTION_MODEL);
    expect(form.get('prompt')).toBe('jellybean, corner, Beeline');
    expect(form.get('language')).toBe('en');
    const file = form.get('file') as File;
    expect(file.name).toBe('dictation.wav');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(WAV);
  });

  it('throws when Groq refuses, so the phone keeps its on-device text', async () => {
    const transcriber = new SpeechTranscriber(
      'groq-test-key',
      (async () => new Response('rate limited', { status: 429 })) as typeof fetch,
    );
    await expect(transcriber.transcribe({ audio: WAV, mimeType: 'audio/wav' })).rejects.toThrow(
      '429',
    );
  });

  it('exists only when GROQ_API_KEY is set', () => {
    expect(speechTranscriberFromEnv({})).toBeUndefined();
    expect(speechTranscriberFromEnv({ GROQ_API_KEY: '  ' })).toBeUndefined();
    expect(speechTranscriberFromEnv({ GROQ_API_KEY: 'gsk_test' })).toBeInstanceOf(SpeechTranscriber);
  });
});

describe('POST /v1/phone/transcriptions', () => {
  const servers: ReturnType<typeof createBeelineServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function post(
    transcriber: Pick<SpeechTranscriber, 'transcribe'> | undefined,
    body: Uint8Array,
    headers: Record<string, string> = {},
    token = 'phone-key-for-transcription-test',
  ): Promise<Response> {
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() } as unknown as SqlDatabase,
      auth: {
        authenticatePhone: async (value: string) => (value === 'phone-key-for-transcription-test' ? 'viewer' : null),
      } as TokenAuth,
      phone: {} as PhoneService,
      daemon: {} as DaemonService,
      live: {} as LiveHub,
      mediaMaximumBytes: 1,
      ...(transcriber ? { speechTranscriber: transcriber as SpeechTranscriber } : {}),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return fetch(`http://127.0.0.1:${port}/v1/phone/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/wav', ...headers },
      body: body as unknown as BodyInit,
    });
  }

  it('returns Groq text with the decoded lexicon prompt and language', async () => {
    const transcribe = vi.fn(async () => 'Ask @jellybean');
    const response = await post({ transcribe }, WAV, {
      'x-speech-prompt': encodeURIComponent('jellybean, Ruby'),
      'x-speech-language': 'en',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'Ask @jellybean' });
    expect(transcribe).toHaveBeenCalledWith({
      audio: Buffer.from(WAV),
      mimeType: 'audio/wav',
      prompt: 'jellybean, Ruby',
      language: 'en',
    });
  });

  it('answers 503 without a Groq key', async () => {
    const response = await post(undefined, WAV);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'transcription_unavailable' });
  });

  it('requires a phone token', async () => {
    const transcribe = vi.fn();
    const response = await post({ transcribe }, WAV, {}, 'wrong');
    expect(response.status).toBe(401);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("sends audio up to Groq's 25 MB upload limit to Groq", async () => {
    const transcribe = vi.fn(async () => 'long note');
    const response = await post({ transcribe }, new Uint8Array(12 * 1024 * 1024));
    expect(TRANSCRIPTION_MAXIMUM_BYTES).toBe(25 * 1024 * 1024);
    expect(response.status).toBe(200);
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it('refuses audio over the size limit before calling Groq', async () => {
    const transcribe = vi.fn();
    const response = await post({ transcribe }, new Uint8Array(TRANSCRIPTION_MAXIMUM_BYTES + 1));
    expect(response.status).toBe(413);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('answers 502 when Groq fails', async () => {
    const response = await post(
      { transcribe: vi.fn(async () => Promise.reject(new Error('groq transcription failed (500)'))) },
      WAV,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'transcription_failed' });
  });
});
