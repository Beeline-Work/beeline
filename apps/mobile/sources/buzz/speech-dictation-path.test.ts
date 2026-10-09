/**
 * The whole dictation path in one process: the composer's speech hook with a
 * recording recognizer, the phone's piece uploader, the Beeline server's
 * transcription route, and a stand-in for Groq behind the real transcriber.
 */
import type { AddressInfo } from 'node:net';
import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBeelineServer } from '../../../server/src/server';
import { SpeechTranscriber } from '../../../server/src/speech-transcription';
import { useSpeechInput } from './speech-input';

const PHONE_TOKEN = 'phone-key-for-dictation-path';
const server = vi.hoisted(() => ({ url: '' }));
const recordings = vi.hoisted(() => new Map<string, Uint8Array>());

vi.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 33, select: (c: any) => c.default },
}));
vi.mock('./speech-locale', () => ({ getDeviceSpeechLocale: () => 'en-US' }));
vi.mock('./speech-recognition-adapter', () => ({ getRecognitionModule: () => recognizer }));
vi.mock('./runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: server.url }) }));
vi.mock('@/utils/readFileBytes', () => ({
  readFileBytes: async (uri: string) => recordings.get(uri) ?? new Uint8Array(),
}));
vi.mock('@/auth/monolith-session', () => ({
  monolithSession: {
    fetch: (url: string, init: RequestInit & { headers: Record<string, string> }) =>
      fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${PHONE_TOKEN}` } }),
  },
}));
// The mobile suite does not build the auth or push-gateway packages; the
// transcription route uses neither.
vi.mock('@beeline/auth/environment', () => ({}));
vi.mock('@beeline/auth/github', () => ({}));
vi.mock('@beeline/auth/phone-github-ticket', () => ({}));
vi.mock('@beeline/auth/server', () => ({}));
vi.mock('@beeline/auth/store', () => ({}));
vi.mock('@beeline/push-gateway/projection', () => ({}));
vi.mock('expo-file-system', () => ({
  File: class {
    delete() {}
  },
}));

const handlers = new Map<string, (event?: any) => void>();
const recognizer = {
  start: vi.fn(),
  stop: vi.fn(),
  abort: vi.fn(),
  getPermissionsAsync: async () => ({ status: 'granted', granted: true, canAskAgain: true }),
  requestPermissionsAsync: async () => ({ status: 'granted', granted: true, canAskAgain: true }),
  supportsOnDeviceRecognition: () => true,
  supportsRecording: () => true,
  getSupportedLocales: async () => ({ locales: [], installedLocales: [] }),
  getSpeechRecognitionServices: () => [],
  addListener: (event: string, handler: (event?: any) => void) => {
    handlers.set(event, handler);
    return { remove: () => handlers.delete(event) };
  },
};
const emit = (event: string, payload?: unknown) => handlers.get(event)?.(payload);

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

/** Groq: answers each upload with its length in seconds, from the ADPCM fact chunk. */
type GroqCall = { seconds: number; status: number };
function fakeGroq(calls: GroqCall[], failFirst: number) {
  return async (_url: string | URL | Request, init?: RequestInit) => {
    const file = (init!.body as FormData).get('file') as File;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const seconds = Math.round(new DataView(bytes.buffer).getUint32(48, true) / 1600) / 10;
    const status = calls.length < failFirst ? 502 : 200;
    calls.push({ seconds, status });
    if (status !== 200) return new Response('upstream', { status });
    return Response.json({ text: `Part ${seconds}.` });
  };
}

let listening: ReturnType<typeof createBeelineServer> | undefined;
async function startServer(groq: typeof fetch) {
  listening = createBeelineServer({
    database: { query: vi.fn(), transaction: vi.fn() } as any,
    auth: {
      authenticatePhone: async (value: string) => (value === PHONE_TOKEN ? 'viewer' : null),
    } as any,
    phone: {} as any,
    daemon: {} as any,
    live: {} as any,
    mediaMaximumBytes: 1,
    speechTranscriber: new SpeechTranscriber('groq-test-key', groq),
  });
  await new Promise<void>((resolve) => listening!.listen(0, '127.0.0.1', resolve));
  server.url = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
}

function Harness({ onResult }: { onResult: (text: string) => void }) {
  const speech = useSpeechInput(onResult);
  return React.createElement('div', { speechRef: speech } as any);
}

beforeEach(() => {
  handlers.clear();
  recordings.clear();
});

afterEach(async () => {
  await new Promise<void>((resolve) => (listening ? listening.close(() => resolve()) : resolve()));
  listening = undefined;
});

describe('long dictation from the composer hook through the server to Groq', () => {
  it('sends every piece to Groq, retries the one Groq refused, and commits Groq text', async () => {
    const calls: GroqCall[] = [];
    // Groq refuses the first upload, as a timeout, 429 or 502 would.
    await startServer(fakeGroq(calls, 1) as typeof fetch);
    recordings.set('file:///cache/a.wav', pcmWav(20));
    recordings.set('file:///cache/b.wav', pcmWav(75));
    const onResult = vi.fn();
    let renderer: any;
    act(() => {
      renderer = create(React.createElement(Harness, { onResult }));
    });
    const speech = () => renderer.root.findByType('div').props.speechRef;

    await act(async () => {
      await speech().start();
    });
    expect(recognizer.start.mock.lastCall?.[0]).toHaveProperty('recordingOptions');
    // The first 20 s piece closes while the member keeps talking; Groq refuses it.
    await act(async () => {
      emit('result', { results: [{ transcript: 'first on device words' }], isFinal: true });
      emit('audioend', { uri: 'file:///cache/a.wav' });
      emit('end');
    });
    await vi.waitFor(() => expect(calls).toEqual([{ seconds: 20, status: 502 }]));

    // A 75 s piece closes at stop.
    let captured: boolean | null = null;
    await act(async () => {
      emit('result', { results: [{ transcript: 'second on device words' }], isFinal: true });
      const stopped = speech().stop();
      emit('audioend', { uri: 'file:///cache/b.wav' });
      emit('end');
      captured = await stopped;
    });

    console.log('Groq uploads:', JSON.stringify(calls));
    console.log('Committed text:', JSON.stringify(onResult.mock.calls));
    expect(captured).toBe(true);
    // The 75 s piece went as two chunks; the refused 20 s piece was retried.
    expect(calls.slice(1).map((call) => call.status)).toEqual([200, 200, 200]);
    // Chunks upload together, so they may arrive in either order; the first is the longer.
    const chunks = calls
      .slice(1, 3)
      .map((call) => call.seconds)
      .sort((a, b) => b - a);
    expect(chunks[0]).toBeLessThanOrEqual(60);
    expect(chunks[0]! + chunks[1]!).toBeCloseTo(75, 0);
    expect(calls[3]).toEqual({ seconds: 20, status: 200 });
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(`Part 20. Part ${chunks[0]}. Part ${chunks[1]}.`);
  }, 30_000);
});
