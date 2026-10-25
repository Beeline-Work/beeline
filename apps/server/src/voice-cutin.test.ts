import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import type { VoiceService } from './voice-service.js';
import type { FluxEvent } from './voice-providers.js';

const native = vi.hoisted(() => ({ room: undefined as any, frames: [] as number[], clears: [] as number[] }));
vi.mock('@livekit/rtc-node', () => ({
  Room: class extends EventEmitter {
    remoteParticipants = new Map([['human', { identity: 'human' }]]);
    localParticipant = { publishTrack: vi.fn(), publishData: vi.fn() };
    constructor() { super(); native.room = this; }
    async connect() {} async disconnect() {}
  },
  RoomEvent: { TrackSubscribed: 'track', TrackUnsubscribed: 'untrack', ParticipantConnected: 'joined',
    ParticipantDisconnected: 'left', DataReceived: 'data', Disconnected: 'closed' },
  AudioStream: class { constructor() { return new ReadableStream(); } },
  AudioSource: class {
    clearQueue() { native.clears.push(performance.now()); }
    async captureFrame() { native.frames.push(performance.now()); }
    async waitForPlayout() {} async close() {}
  },
  LocalAudioTrack: { createAudioTrack: vi.fn() }, TrackPublishOptions: class {},
  TrackSource: { SOURCE_MICROPHONE: 1 }, TrackKind: { KIND_AUDIO: 1 },
  AudioFrame: class { constructor(readonly data: Int16Array) {} },
}));

// A disposable exact historical module may be selected for comparison; CI uses the runtime under test.
const runtimePath = process.env.VOICE_CUTIN_RUNTIME ?? './voice-room-runtime.js';
const { VoiceRoomRuntime } = await import(runtimePath);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const first = "Ruby, I don't know how to explain this, but you have a way of sending";
const continuation = 'a message to Croc Bot';
let sequence = 0;
function event(kind: FluxEvent['event'], turn: number, transcript: string): FluxEvent {
  return { event: kind, turn_index: turn, sequence_id: sequence++, transcript,
    words: transcript.split(' ').filter(Boolean).map((word, index) => ({ word, confidence: 0.99,
      start: index * 0.2, end: index * 0.2 + 0.18 })) };
}

it.each([200, 400, 600, 800, 1200].flatMap(resumeMs =>
  [{kind: 'StartOfTurn', cumulative: false}, {kind: 'TurnResumed', cumulative: false}, {kind: 'TurnResumed', cumulative: true}]
    .map(value => ({ resumeMs, ...value, kind: value.kind as FluxEvent['event'] }))))(
  'VOICE-CUTIN-1: split request resumes at $resumeMs ms with $kind (cumulative=$cumulative)', async ({ resumeMs, kind, cumulative }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    native.frames = []; native.clears = [];
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    let onSpeech!: (value: FluxEvent) => void;
    const agent = { id: 'ruby', name: 'Ruby', handle: 'ruby', soul: '', voice: 'luna' };
    const writes: string[] = [], revisions: string[] = [];
    const service = {
      owner: 'owner', workspaceId: async () => 'workspace', endWorkspaceCalls: async () => {},
      callWorkState: async () => ({ pending: false, finishedAt: 0 }), hasCallWork: async () => false,
      endInactive: async () => false,
      budget: { read: async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' }),
        record: async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' }), limitMs: 3600000 },
      config: { url: 'ws://local', apiKey: 'devkey', apiSecret: 'secret',
        stt: async (callback: typeof onSpeech) => { onSpeech = callback; return { send() {}, close() {} }; },
        brain: { answer: async (_agent: unknown, _history: unknown, delta: (text: string) => void) => {
          await delay(700); delta('I can help with that.'); return { text: 'I can help with that.', order: false };
        } } },
      agents: async () => [agent], humanCount: async () => 1, lastActiveAgent: async () => 'ruby',
      speech: async () => ({ async *synthesize() {
        await delay(50);
        for (let frame = 0; frame < 150; frame++) {
          const pcm = new Int16Array(480).fill(2000);
          yield new Uint8Array(pcm.buffer); await delay(20);
        }
      } }),
      recordHuman: async (_call: string, _room: string, _human: string, _agent: unknown, text: string) => {
        writes.push(text); return 'source-' + writes.length;
      },
      reviseHuman: async (_call: string, _room: string, _human: string, _agent: unknown, _source: string, text: string) => { revisions.push(text); },
      recordAnswer: async () => {}, recordTiming: async () => {}, dispatch: async () => {},
      db: { query: async () => ({ rowCount: 1, rows: [] }) }, access: async () => {}, leave: async () => {}, runtimeClosed() {},
    };
    const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
    try {
      native.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
      await vi.advanceTimersByTimeAsync(0);
      expect(onSpeech).toBeDefined();
      onSpeech(event('EagerEndOfTurn', 0, first));
      await vi.advanceTimersByTimeAsync(600);
      const finalAt = performance.now();
      onSpeech(event('EndOfTurn', 0, first));
      await vi.advanceTimersByTimeAsync(resumeMs);
      const resumeAt = performance.now();
      onSpeech(event(kind, kind === 'TurnResumed' ? 0 : 1, continuation));
      await vi.advanceTimersByTimeAsync(4500);
      const priorFrames = native.frames.filter(at => at < resumeAt);
      const afterFrames = native.frames.filter(at => at >= resumeAt);
      const row = { reproduction: 'VOICE-CUTIN-1', runtime: process.env.VOICE_CUTIN_LABEL ?? 'current', kind, resumeMs,
        voicedBeforeResume: priorFrames.length > 0, firstVoicedMs: native.frames.length ? native.frames[0]! - finalAt : null,
        publicationAfterResumeMs: afterFrames.length ? afterFrames.at(-1)! - resumeAt : 0,
        queueClearedMs: native.clears.find(at => at >= resumeAt) === undefined ? null : native.clears.find(at => at >= resumeAt)! - resumeAt };
      onSpeech(event('EndOfTurn', cumulative ? 0 : 1, cumulative ? first + ' ' + continuation : continuation));
      await vi.advanceTimersByTimeAsync(4000);
      const joined = [...writes, ...revisions].some(text => text.includes('way of sending') && text.includes(continuation));
      const result = { ...row, cumulative, joined, writes: writes.length, revisions: revisions.length };
      if (process.env.VOICE_CUTIN_RESULTS) appendFileSync(process.env.VOICE_CUTIN_RESULTS, JSON.stringify(result) + '\n');
      console.log('VOICE-CUTIN-1', JSON.stringify(result));
      if (!process.env.VOICE_CUTIN_MEASURE_ONLY) {
        expect(row.publicationAfterResumeMs).toBeLessThanOrEqual(20);
        expect(row.queueClearedMs).toBeLessThanOrEqual(20);
        expect(joined).toBe(true);
        expect(revisions.at(-1)).toBe(first + ' ' + continuation);
        expect(row.firstVoicedMs).toBe(150);
        const resumed = log.mock.calls.find(([tag]) => tag === '[voice-playback-resume]');
        const stopped = log.mock.calls.find(([tag]) => tag === '[voice-playback-stopped]');
        expect(JSON.parse(String(resumed?.[1]))).toMatchObject({ callerId: 'human', replyKind: 'turn', sinceFirstVoicedMs: resumeMs - 150 });
        expect(JSON.parse(String(stopped?.[1]))).toMatchObject({ callerId: 'human', publicationTailMs: 0, queueClearMs: 0 });
      }
    } finally { await runtime.close(); log.mockRestore(); vi.useRealTimers(); }
  });
