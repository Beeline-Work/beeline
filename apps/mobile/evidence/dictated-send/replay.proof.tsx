import * as React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';

const rig = vi.hoisted(() => ({ activeNative: null as any, token: '', identity: '', fetchUpload: null as any, request: null as any }));


// Synchronous mock for react-native.
const platformSetter = vi.hoisted(() => {
  let _os = 'android';
  return {
    setOS: (v: string) => {
      _os = v;
    },
    getOS: () => _os,
  };
});
vi.mock('react-native', () => {
  function host(name: string) {
    return (props: any) => React.createElement(name, props, props.children);
  }
  return {
    Appearance: { getColorScheme: () => 'dark' },
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    View: host('View'),
    Linking: { openSettings: vi.fn() },
    Keyboard: { isVisible: () => true, addListener: () => ({ remove() {} }), dismiss() {} },
    Animated: {
      View: host('View'),
      Value: class {
        constructor(readonly value: number) {}
      },
      timing: () => ({ start() {}, stop() {} }),
    },
    Easing: { linear: (t: number) => t },
    Platform: {
      get OS() { return 'android'; },
      Version: 33,
      select: (choices: any) => choices.default,
    },
    StyleSheet: { create: (styles: any) => styles },
  } as any;
});

vi.mock('@/components/buzz/BeelineMarkSpinner', async () => {
  const ReactModule = await import('react');
  return {
    BeelineMarkSpinner: (props: any) => ReactModule.createElement('BeelineMarkSpinner', props),
  };
});

vi.mock('@/components/buzz/HullDialog', async () => {
  const ReactModule = await import('react');
  return {
    HullDialog: (props: any) => ReactModule.createElement('HullDialog', props),
  };
});
vi.mock('react-native-svg', () => {
  function host(name: string) {
    return (props: any) => React.createElement(name, props, props.children);
  }
  const Svg = host('RNSVG');
  return {
    default: Svg,
    Svg,
    Line: host('RNSVGLine'),
    Path: host('RNSVGPath'),
    Rect: host('RNSVGRect'),
  };
});

vi.mock('@/buzz/speech-recognition-adapter', () => ({ getRecognitionModule: () => rig.activeNative }));

vi.mock('@/buzz/groknight', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/buzz/groknight')>(),
  groknight: {
    type: { body: { lineHeight: 20 }, machine: {} },
    buzz: {
      dim: '#83838d',
      accent: '#b08a4a',
      dialogDanger: '#c4544d',
      ledgerQuiet: '#83838d',
      textSecondary: '#c9c9d1',
      textMuted: '#83838d',
      textPrimary: '#f0f0f3',
      bgRaised: '#190e21',
      border: '#291e33',
      radius: 3,
      bgBase: '#14091A',
      type: {
        body: {
          fontFamily: 'SpaceGrotesk-Regular',
          fontSize: 16,
          lineHeight: 23,
          letterSpacing: 0,
        },
        machine: {
          fontFamily: 'IBMPlexMono-Regular',
          fontSize: 13,
          lineHeight: 19,
          letterSpacing: 0,
        },
        meta: {
          fontFamily: 'SpaceGrotesk-Regular',
          fontSize: 13,
          lineHeight: 19,
          letterSpacing: 0,
        },
      },
      transcriptCard: { rowTitleSize: 15, rowKindSize: 12 },
    },
  },
}));

vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  ImpactFeedbackStyle: { Medium: 'medium' },
}));


// Platform I/O only: actual composer, speech hook, uploader, transport, outbox,
// server command router and Groq remain real. Authentication stays in memory.
vi.mock('@/buzz/speech-locale', () => ({ getDeviceSpeechLocale: () => 'en-US' }));
vi.mock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: process.env.DICTATION_SERVER_URL ?? 'http://127.0.0.1:19347' }) }));
vi.mock('@/auth/monolith-session', () => ({
  MONOLITH_REQUEST_TIMEOUT_MS: 20_000,
  MonolithRequestTimeoutError: class extends Error {},
  MonolithSessionChangedError: class extends Error {},
  monolithSession: { fetch: (...args: any[]) => rig.fetchUpload(...args) },
}));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({ request: (...args: any[]) => rig.request(...args) }) }));
vi.mock('@/auth/signin-funnel', () => ({ funnelSuccessfulOperation: async () => {} }));
vi.mock('@/buzz/client-error-report', () => ({ reportClientError: async (_scope: string, error: unknown) => { throw error; } }));
vi.mock('@/utils/readFileBytes', () => ({ readFileBytes: async (uri: string) => new Uint8Array(readFileSync(uri)) }));
vi.mock('expo-file-system', () => ({ File: class { delete() {} } }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(randomBytes(n)) }));

import { ConversationComposer, COMPOSER_SINGLE_LINE_INPUT_HEIGHT } from '@/components/buzz/ConversationComposer';
import { MonolithRigTransport } from '@/sync/transport/monolith-rig-transport';
import { MessageOutbox } from '@/buzz/message-outbox';
import { joinSpeechPieces } from '@/buzz/speech-correction';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const base = process.env.DICTATION_SERVER_URL ?? 'http://127.0.0.1:19347';
if (!['127.0.0.1', 'localhost', '::1'].includes(new URL(base).hostname)) throw new Error('Replay requires an isolated loopback server');
if (!process.env.DICTATION_CLIP_DIR) throw new Error('DICTATION_CLIP_DIR is required');
const directory = resolve(process.env.DICTATION_CLIP_DIR);
const context = new AsyncLocalStorage<any>();
const samples: any[] = [];
function wordErrors(expected: string, actual: string): number {
  const words = (value: string) => value.toLowerCase().replace(/[^a-z ]/g, '').trim().split(/\s+/);
  const a = words(expected), b = words(actual);
  let row = Array.from({ length: b.length + 1 }, (_, n) => n);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j-1]!+1, row[j]!+1, row[j-1]!+(a[i-1] === b[j-1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}
const fixtures = readFileSync(resolve(directory, '6930-75918.trans.txt'), 'utf8').trim().split('\n');
const reference = (n: number) => fixtures.find(line => line.startsWith(`6930-75918-${String(n).padStart(4, '0')} `))!.split(' ').slice(1).join(' ').toLowerCase();
// Explicitly simulated native hypotheses; these are not phone recognition data.
const fallback = (text: string) => text.replace(/princess/g, 'prices').replace(/france/g, 'friends').replace(/congratulations/g, 'congratulation');
const clip = (n: number) => resolve(directory, `piece-${n}.wav`);
const manifest = JSON.parse(readFileSync(resolve(directory, 'clip-manifest.json'), 'utf8'));
const seconds: number[] = manifest.pieceSeconds;
let socket: WebSocket;
let nextRequest = 0;
const pending = new Map<string, { resolve(v: any): void; reject(e: any): void }>();
const transport = new MonolithRigTransport({ publicKey: '0'.repeat(64) } as any);
let room = '';

beforeAll(async () => {
  if (!process.env.DICTATION_CLIP_DIR) throw new Error('Run the documented opt-in replay command with real clips');
  const auth = await fetch(`${base}/v1/auth/review/exchange`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: process.env.DICTATION_REVIEW_SECRET ?? 'dictation-proof-local-only-fa2e557a' }),
  });
  if (!auth.ok) throw new Error(`Local replay sign-in failed: ${auth.status}`);
  const tokens = await auth.json() as any;
  rig.token = tokens.accessToken;
  rig.identity = tokens.identityId;
  socket = new WebSocket(`${base.replace(/^http/, 'ws')}/v1/phone/live`, [`bearer.${rig.token}`]);
  socket.on('message', data => {
    const frame = JSON.parse(String(data));
    const waiter = pending.get(frame.id);
    if (!waiter) return;
    pending.delete(frame.id);
    if (frame.ok === true) waiter.resolve(frame.result);
    else waiter.reject(new Error(JSON.stringify(frame.error)));
  });
  await new Promise<void>((done, fail) => { socket.once('open', done); socket.once('error', fail); });
  rig.request = (op: string, args: any) => new Promise((resolve, reject) => {
    const id = `replay-${++nextRequest}`;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ t: 'req', id, op, args }));
  });
  // The review fixture creates a private proof Room for this local identity.
  const roomResponse = await fetch(`${base}/v1/phone/rooms/bee11e00-0000-4000-8000-000000000103`, { headers: { authorization: `Bearer ${rig.token}` } });
  if (!roomResponse.ok) throw new Error(`Replay Room unavailable: ${roomResponse.status}`);
  room = 'bee11e00-0000-4000-8000-000000000103';
  (transport as any).identity = { publicKey: rig.identity };
  rig.fetchUpload = async (url: string, init: RequestInit, options: { timeoutMs?: number } = {}) => {
    const run = context.getStore();
    const started = performance.now();
    const work = (async () => {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(options.timeoutMs ?? 15_000), headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: `Bearer ${rig.token}` } });
      const value = await response.clone().json() as any;
      run?.groq.push({ started, roundTripMs: performance.now() - started, providerMs: Number(response.headers.get('x-dictation-groq-ms')) || undefined, status: response.status, text: value.text ?? '' });
      return response;
    })();
    run?.requests.push(work);
    return work;
  };
  const info = console.info;
  vi.spyOn(console, 'info').mockImplementation((...args) => { if (args[0] !== '[dictation-timing]') info(...args); });
});

afterAll(async () => {
  socket?.close();
  const output = process.env.DICTATION_RESULT_PATH;
  if (output) { mkdirSync(resolve(output, '..'), { recursive: true }); writeFileSync(output, JSON.stringify({ label: process.env.DICTATION_LABEL, timingKind: 'harness, not device', endMode: process.env.DICTATION_END_MODE, samples }, null, 2)); }
});

function composer(run: any) {
  const listeners = new Map<string, (value?: any) => void>();
  const emit = (event: string, value?: any) => context.run(run, () => listeners.get(event)?.(value));
  run.emit = emit;
  let last = '';
  const native = {
    getPermissionsAsync: async () => ({ status: 'granted', granted: true, canAskAgain: true }),
    requestPermissionsAsync: async () => ({ status: 'granted', granted: true, canAskAgain: true }),
    supportsRecording: () => true, getSpeechRecognitionServices: () => [],
    getSupportedLocales: async () => ({ installedLocales: [] }),
    start: () => emit('audiostart'), abort() {},
    stop: () => { emit('audioend', { uri: last }); if (process.env.DICTATION_END_MODE === 'immediate') emit('end'); },
    addListener: (event: string, handler: any) => { listeners.set(event, handler); return { remove: () => { listeners.delete(event); } }; },
  };
  const identity = { pubkey: rig.identity, kind: 'human', name: 'Replay' } as const;
  const outbox = new MessageOutbox({ load: async () => [], save: async () => {}, rejection: () => undefined,
    send: async event => {
      const result = await transport.publishPreparedMessage(event);
      run.acceptedAt = performance.now();
      run.messageId = event.id;
      return result;
    },
  });
  let draft = '';
  let settle!: () => void;
  run.done = new Promise<void>(resolve => { settle = resolve; });
  function Host() {
    const [value, setValue] = React.useState('');
    return <ConversationComposer value={value} height={COMPOSER_SINGLE_LINE_INPUT_HEIGHT} focused={false} disabled={false}
      onBlur={() => {}} onChangeText={text => { draft = text; setValue(text); }} onContentSizeChange={() => {}} onFocus={() => {}} onKeyPress={() => {}}
      onSend={async dictated => {
        try {
          run.sentText = draft;
          const event = await transport.composeMessage({ sessionId: room, text: draft });
          if (dictated) dictated.committed = true;
          await outbox.enqueue(event, { id: event.id, text: draft, createdAt: event.created_at, author: identity, presentation: 'message' });
          const result = await outbox.send(event.id);
          if (!result) throw new Error('Replay message was not accepted');
        } catch (error) { run.error = String(error); }
        finally { settle(); }
      }} />;
  }
  rig.activeNative = native;
  let renderer: any;
  act(() => { renderer = create(<Host />); });
  run.renderer = renderer;
  run.setLast = (uri: string) => { last = uri; };
  run.outbox = outbox;
  return run;
}

async function replay(name: string) {
  const count = Number(process.env.DICTATION_RUNS ?? 5);
  const runs = Array.from({ length: count }, (_, index) => composer({ name, index, groq: [], requests: [], startedAt: performance.now() }));
  await Promise.all(runs.map(run => run.outbox.connectionChanged(true)));
  await act(async () => { for (const run of runs) context.run(run, () => run.renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress()); });
  const interval = setInterval(() => { act(() => { for (const run of runs) run.emit('volumechange', { value: 5 }); }); }, 250);
  const close = (index: number) => act(() => { for (const run of runs) {
    run.emit('result', { results: [{ transcript: fallback(reference(index)) }], isFinal: true });
    run.emit('audioend', { uri: clip(index) }); run.emit('end');
  } });
  try {
    if (name === 'paused') {
      for (let index = 0; index < 3; index++) { await new Promise(r => setTimeout(r, seconds[index]! * 1000)); close(index); }
      await new Promise(r => setTimeout(r, seconds[3]! * 1000));
      for (const run of runs) run.setLast(clip(3));
      act(() => { for (const run of runs) run.emit('result', { results: [{ transcript: fallback(reference(3)) }], isFinal: false }); });
    } else {
      const duration = name === 'short' ? 5.025 : 46.07;
      await new Promise(r => setTimeout(r, duration * 1000));
      for (const run of runs) run.setLast(resolve(directory, `${name === 'short' ? 'short' : 'continuous'}.wav`));
      act(() => { for (const run of runs) run.emit('result', { results: [{ transcript: fallback(name === 'short' ? reference(2) : [0,1,2,3].map(reference).join(' ')) }], isFinal: false }); });
    }
    act(() => { for (const run of runs) context.run(run, () => {
      run.sendAt = performance.now();
      run.renderer.root.findByProps({ testID: 'chat-send' }).props.onPress();
    }); });
    let watchdog: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([Promise.all(runs.map(run => run.done)), new Promise((_, fail) => { watchdog = setTimeout(() => fail(new Error('Replay send exceeded 40 seconds')), 40_000); })]);
    } finally { clearTimeout(watchdog!); }
    await Promise.all(runs.flatMap(run => run.requests).map(work => work.catch(() => {})));
    for (const run of runs) {
      expect(run.error).toBeUndefined();
      expect(run.acceptedAt).toBeGreaterThan(run.sendAt);
      const whisper = joinSpeechPieces(run.groq.filter((r: any) => r.status === 200).sort((a: any,b: any) => a.started-b.started).map((r: any) => r.text), [], 'en-US');
      const normalized = (v: string) => v.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g,' ').trim();
      samples.push({ take: name, repetition: run.index, sendToRoomMs: Math.round(run.acceptedAt-run.sendAt), groq: run.groq.map((r: any) => ({ roundTripMs: Math.round(r.roundTripMs), providerMs: r.providerMs, status: r.status })), fallback: normalized(run.sentText) !== normalized(whisper), sentText: run.sentText, nativeFallbackText: fallback(name === 'short' ? reference(2) : [0,1,2,3].map(reference).join(' ')), whisperText: whisper, sentVsWhisperWordErrors: wordErrors(whisper, run.sentText), nativeVsWhisperWordErrors: wordErrors(whisper, fallback(name === 'short' ? reference(2) : [0,1,2,3].map(reference).join(' '))), messageId: run.messageId });
    }
  } finally {
    clearInterval(interval);
    act(() => { for (const run of runs) run.renderer.unmount(); });
    runs.forEach(run => run.outbox.dispose());
  }
}

it('DS1 replays a short human take through Send to the real Room', async () => { await replay('short'); });
it('DS1 replays natural-pause human pieces through Send to the real Room', async () => { await replay('paused'); });
it('DS1 replays continuous human speech through Send to the real Room', async () => { await replay('continuous'); });
