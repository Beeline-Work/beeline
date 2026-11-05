import * as backgroundWork from './background-work.js';

import { EventEmitter } from 'node:events';

import { afterEach, expect, it, vi } from 'vitest';

import { voiceTempo } from './voice-tempo.js';

import { markdownToSpeech } from './markdown-to-speech.js';

import { VoiceService } from './voice-service.js';

import * as telemetry from './sentry.js';

import { VoiceRoomRuntime, spokenReport, confirmedVoiceSpeech, voiceInterrupt, voicePlaybackEcho } from './voice-room-runtime.js';

import { AuraSpeech, OpenRouterVoiceBrain, VoiceQuotaError } from './voice-providers.js';

import { VoiceService as RealVoiceService } from './voice-service.js';

import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

import { migrate } from './database.js';

import { PgliteDatabase } from './test-support.js';

import { LiveHub } from './live.js';

import { routeHumanMessage, claimAgentCommand } from './agent-command.js';

import { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';

import { PhoneService } from './phone-service.js';

import { ConnectionPresence } from './connection-presence.js';

import { groupBPostgresDatabase } from './test-fixtures/test-support-router-group-b-postgres.js';


afterEach(() => { vi.useRealTimers(); });

const state = vi.hoisted(() => ({ room: undefined as any, streams: [] as ReadableStream<any>[], audio: undefined as any }));
export { state };

vi.mock('@livekit/rtc-node', () => ({
  Room: class extends EventEmitter {
    remoteParticipants = new Map([['human', { identity: 'human' }]]);
    localParticipant = { publishTrack: vi.fn(), publishData: vi.fn() };
    constructor() { super(); state.room = this; }
    async connect() {} async disconnect() {}
  },
  RoomEvent: { TrackSubscribed: 'track', TrackUnsubscribed: 'untrack', ParticipantConnected: 'joined', ParticipantDisconnected: 'left',
    DataReceived: 'data', Disconnected: 'closed' },
  AudioStream: class { constructor() { return state.streams.shift()!; } },
  AudioSource: class {
    clearQueue = vi.fn(); captureFrame = vi.fn(async () => {}); waitForPlayout = vi.fn(async () => {});
    constructor() { state.audio = this; } async close() {}
  },
  LocalAudioTrack: { createAudioTrack: vi.fn() }, TrackPublishOptions: class {},
  TrackSource: { SOURCE_MICROPHONE: 1 }, TrackKind: { KIND_AUDIO: 1 }, AudioFrame: class { constructor(readonly data: Int16Array) {} },
}));

vi.mock('livekit-server-sdk', async original => {
  const actual = await original<typeof import('livekit-server-sdk')>();
  return { ...actual, RoomServiceClient: class { async removeParticipant() {} async deleteRoom() {} } };
});


export const roster = [
  { id: 'ruby', name: 'Ruby', handle: 'ruby', soul: '', voice: 'luna' },
  { id: 'goose', name: 'Goosey', handle: 'goose', soul: '', voice: 'apollo' },
];

export function conversationService(humans = 2) {
  const speech = { synthesize: vi.fn(async function* () { yield new Uint8Array([200, 1, 200, 1]); }) };
  const service = {
    runtimeScope: vi.fn(async (roomId: string) => ({workspaceId:'human',authorityRoomId:roomId})), workspaceId: vi.fn(async () => 'human'), endWorkspaceCalls: vi.fn(async () => {}), callWorkState: vi.fn(async () => ({pending:false,finishedAt:0})), hasCallWork: vi.fn(async () => false), endInactive: vi.fn(async () => false), budget: { fence: async (_call: string, _owner: string, enqueue: () => void) => { enqueue(); return true; }, read: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), record: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), limitMs: 3600000 }, owner: 'owner', config: { url: 'ws://local', apiKey: 'devkey', apiSecret: 'secret', stt: vi.fn(),
      brain: { answer: vi.fn(async (_agent, _history, onText) => {
        onText('First sentence. Second sentence! Third sentence.');
        return { text: 'First sentence. Second sentence! Third sentence.', order: false };
      }) } },
    lastActiveAgent: vi.fn(async (): Promise<string | undefined> => undefined),
    humanCount: vi.fn(async () => humans), agents: vi.fn(async () => roster), speech: vi.fn(async () => speech),
    access: vi.fn(async () => {}), leave: vi.fn(async () => {}), reviseHuman: vi.fn(async () => {}), recordHuman: vi.fn(async () => 'source'), recordAnswer: vi.fn(async () => {}),
    dispatch: vi.fn(async () => {}), db: { query: vi.fn(async (sql: string, parameters?: any[]) => ({ rowCount: 1,
      rows: sql.includes('identity_id=ANY') ? (parameters?.[1] ?? []).map((identity_id: string) => ({identity_id})) : [] })) }, runtimeClosed: vi.fn(),
  };
  return { service, speech };
}

/** Real runtime and STT callback; only RTC, providers and persistence are fake. */
export function phantomHarness(answer = 'Hey there is the answer.') {
  const started = performance.now();
  const timeline: string[] = [];
  const messages: string[] = [];
  const note = (text: string) => timeline.push(`${(performance.now() - started).toFixed(1)}ms ${text}`);
  let receive!: (event: any) => void;
  const playing = new Set<() => void>();
  const agent = { id: 'ronnie', name: 'Ronnie', handle: 'ronnie', soul: '', voice: 'luna' };
  const speech = { synthesize: vi.fn(async function* (text: string, _voice: string, signal: AbortSignal) {
    note(`TTS start: ${text}`);
    yield Buffer.alloc(960, 1);
    let removeListener = () => {};
    try {
      await new Promise<void>((resolve, reject) => {
        const interrupted = () => { note('barge-in cancel'); reject(new DOMException('Interrupted', 'AbortError')); };
        playing.add(resolve);
        removeListener = () => { playing.delete(resolve); signal.removeEventListener('abort', interrupted); };
        if (signal.aborted) interrupted();
        else signal.addEventListener('abort', interrupted, { once: true });
      });
    } finally { removeListener(); note(`TTS stop: ${text}`); }
  }) };
  const service = {
    runtimeScope: vi.fn(async (roomId: string) => ({workspaceId:'human',authorityRoomId:roomId})), workspaceId: vi.fn(async () => 'human'), endWorkspaceCalls: vi.fn(async () => {}), callWorkState: vi.fn(async () => ({pending:false,finishedAt:0})), hasCallWork: vi.fn(async () => false), endInactive: vi.fn(async () => false), budget: { fence: async (_call: string, _owner: string, enqueue: () => void) => { enqueue(); return true; }, read: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), record: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), limitMs: 3600000 }, owner: 'owner', config: { url: 'ws://local', apiKey: 'devkey', apiSecret: 'secret',
      stt: vi.fn(async (onEvent: typeof receive) => { receive = onEvent; return { send() {}, close() {} }; }),
      brain: { answer: vi.fn(async (_agent: unknown, history: readonly { content: string }[], onText: (text: string) => void, _signal: AbortSignal) => {
        if (history.at(-1)?.content === 'stop') return { text: '', order: false };
        onText(answer); return { text: answer, order: false };
      }) } },
    access: vi.fn(async () => {}), agents: vi.fn(async () => [agent]),
    lastActiveAgent: vi.fn(async () => undefined),
    speech: vi.fn(async () => speech), humanCount: vi.fn(async () => 1),
    recordHuman: vi.fn(async (call: string, room: string, human: string, target: typeof agent, text: string, leaseOwner?: string): Promise<string> => {
      const writer = { access: service.access, live: new LiveHub(), db: {
        transaction: async (write: (db: { query(sql: string, args: unknown[]): Promise<unknown> }) => Promise<void>) => write({
          async query(sql, args) {
            if (sql.includes('INSERT INTO messages')) {
              const content = String(args[3]); messages.push(content); note(`message send: ${content}`);
            }
            return { rowCount: 1, rows: [] };
          },
        }),
      } } as unknown as VoiceService;
      return VoiceService.prototype.recordHuman.call(writer, call, room, human, target, text, leaseOwner);
    }), reviseHuman: vi.fn(async (_call: string, _room: string, _human: string, _target: unknown, _source: string, text: string) => {
      messages[0] = `@ronnie ${text}`;
    }), recordAnswer: vi.fn(async () => {}), dispatch: vi.fn(async () => {}),
    db: { query: vi.fn(async (sql: string, parameters?: any[]) => ({ rowCount: 1,
      rows: sql.includes('speaking_speed') ? [{speaking_speed: 1.5}] : sql.includes('identity_id=ANY') ? (parameters?.[1] ?? []).map((identity_id: string) => ({identity_id})) : [] as any[] })) },
    runtimeClosed: vi.fn(),
    leave: vi.fn(async () => {}),
  };
  let sequence = 0;
  return { service, speech, timeline, messages, note,
    finishPlayback() { for (const finish of playing) finish(); },
    emit(event: string, transcript: string, turn: number, words?: { confidence: number; start?: number; end?: number }[]) {
      note(`STT ${event} turn=${turn} text=${JSON.stringify(transcript)}`);
      receive({ event, transcript, turn_index: turn, sequence_id: sequence++, ...(words ? {
        words: words.map((word, i) => ({ word: transcript.split(' ')[i], start: i * 0.2, end: (i + 1) * 0.2, ...word })),
      } : {}) });
    } };
}


export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}


export function multiCall(humans = 2) {
  const { service, speech } = conversationService(humans);
  const roomData = (human: string, signal: object) => state.room.emit('data', new TextEncoder().encode(JSON.stringify(signal)),
    { identity: human }, undefined, 'beeline.voice.v1');
  const signals = (human?: string) => state.room.localParticipant.publishData.mock.calls
    .filter(([, options]: any[]) => !human || options.destination_identities?.includes(human))
    .map(([bytes]: any[]) => JSON.parse(new TextDecoder().decode(bytes)));
  const answered = () => service.config.brain.answer.mock.calls.map(call => call[0].id);
  return { service, speech, roomData, signals, answered };
}



export const inputOwnerPostgresUrl = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;

export { backgroundWork, telemetry };
export { EventEmitter } from 'node:events';
export { afterEach, expect, it, vi } from 'vitest';
export { voiceTempo } from './voice-tempo.js';
export { markdownToSpeech } from './markdown-to-speech.js';
export { VoiceService, VoiceService as RealVoiceService } from './voice-service.js';
export { VoiceRoomRuntime, spokenReport, confirmedVoiceSpeech, voiceInterrupt, voicePlaybackEcho } from './voice-room-runtime.js';
export { AuraSpeech, OpenRouterVoiceBrain, VoiceQuotaError } from './voice-providers.js';
export { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
export { migrate } from './database.js';
export { PgliteDatabase } from './test-support.js';
export { LiveHub } from './live.js';
export { routeHumanMessage, claimAgentCommand } from './agent-command.js';
export { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';
export { PhoneService } from './phone-service.js';
export { ConnectionPresence } from './connection-presence.js';
export { groupBPostgresDatabase } from './test-fixtures/test-support-router-group-b-postgres.js';

