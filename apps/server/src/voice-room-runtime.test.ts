import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { VoiceService } from './voice-service.js';

const state = vi.hoisted(() => ({ room: undefined as any, streams: [] as ReadableStream<any>[], audio: undefined as any }));
vi.mock('@livekit/rtc-node', () => ({
  Room: class extends EventEmitter {
    remoteParticipants = new Map();
    localParticipant = { publishTrack: vi.fn(), publishData: vi.fn() };
    constructor() { super(); state.room = this; }
    async connect() {} async disconnect() {}
  },
  RoomEvent: { TrackSubscribed: 'track', TrackUnsubscribed: 'untrack', ParticipantDisconnected: 'left',
    DataReceived: 'data', Disconnected: 'closed' },
  AudioStream: class { constructor() { return state.streams.shift()!; } },
  AudioSource: class {
    clearQueue = vi.fn(); captureFrame = vi.fn(async () => {}); waitForPlayout = vi.fn(async () => {});
    constructor() { state.audio = this; } async close() {}
  },
  LocalAudioTrack: { createAudioTrack: vi.fn() }, TrackPublishOptions: class {},
  TrackSource: { SOURCE_MICROPHONE: 1 }, TrackKind: { KIND_AUDIO: 1 }, AudioFrame: class {},
}));
import { VoiceRoomRuntime, confirmedVoiceSpeech, voicePlaybackEcho } from './voice-room-runtime.js';
import { VoiceQuotaError } from './voice-providers.js';

it('Reproduction MD-TTS-1: conversational streamed replies and delayed reports send natural text to synthesis', async () => {
  const agent = { id: 'agent', name: 'Jellybean', handle: 'jellybean', voice: 'warm' };
  const spoken: string[] = [];
  const answer = '**Hello, friend.**\n\n[Visit](https://example.com/a_(b)/details).\n\n```ts\nignore me\n```\n\nHi @jellybean.';
  let reports: any[] = [];
  const service = { owner: 'owner', config: { url: 'ws://local', apiKey: 'devkey', apiSecret: 'secret',
    brain: { answer: async (_agent: unknown, _history: unknown, delta: (text: string) => void) => {
      for (const character of answer) delta(character);
      return { text: answer };
    } } }, agents: vi.fn(async () => [agent]), humanCount: vi.fn(async () => 1),
    speech: async () => ({ async *synthesize(text: string) { spoken.push(text); } }),
    recordHuman: vi.fn(async () => 'source'), recordAnswer: vi.fn(async () => {}),
    db: { query: vi.fn(async (sql: string) => ({ rowCount: 1, rows: sql.includes('SELECT DISTINCT') ? reports : [] })) },
    runtimeClosed: vi.fn() } as unknown as VoiceService;
  const runtime = await VoiceRoomRuntime.connect(service, 'call', 'room');
  try {
    await runtime.utterance('human', 'Hello');
    expect(spoken.join(' ')).toBe('Hello, friend. Visit. Hi jellybean.');
    expect(service.recordAnswer).toHaveBeenCalledWith('room', 'agent', answer);
    reports = [{ source_message_id: 'source', id: 'report', text: '**Done**: [result](https://example.com/a_(b)/details)', agent_id: 'agent', human_id: 'human' }];
    await runtime.refresh();
    await vi.waitFor(() => expect(spoken.at(-1)).toBe('Done: result'));
    console.log('MD-TTS-1 synthesis:', spoken);
  } finally { await runtime.close(); }
});

it('cancels microphone input and sends a targeted quota signal when Flux rejects the handshake', async () => {
  const cancel = vi.fn();
  state.streams = [new ReadableStream({ cancel })];
  const service = { owner: 'owner', config: { url: 'ws://local', apiKey: 'devkey', apiSecret: 'secret',
    stt: vi.fn(async () => { throw new VoiceQuotaError(); }) }, access: vi.fn(async () => {}),
    agents: vi.fn(async () => []), db: { query: vi.fn(async () => ({ rowCount: 1, rows: [] })) },
    runtimeClosed: vi.fn() } as unknown as VoiceService;
  const runtime = await VoiceRoomRuntime.connect(service, 'call', 'room');
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(state.room.localParticipant.publishData).toHaveBeenCalled());
    const [bytes, options] = state.room.localParticipant.publishData.mock.calls[0];
    expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({ code: 'speech-quota-exhausted', message: expect.stringContaining('Daily voice limit') });
    expect(options.destinationIdentities).toEqual(['human']);
    expect(cancel).toHaveBeenCalledOnce();
  } finally { await runtime.close(); }
});

it('buffers first microphone frames during authorization and ignores stale STT failures after a track replacement', async () => {
  let authorize!: () => void;
  const access = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { authorize = resolve; }))
    .mockResolvedValue(undefined);
  const callbacks: Array<() => void> = [];
  const inputs: Array<{ send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
  const service = {
    owner: 'owner', config: { url: 'ws://local', apiKey: 'devkey', apiSecret: 'secret',
      stt: vi.fn(async (_event, failure) => {
        callbacks.push(failure); const input = { send: vi.fn(), close: vi.fn() }; inputs.push(input); return input;
      }) },
    access, agents: vi.fn(async () => []),
    db: { query: vi.fn(async () => ({ rowCount: 1, rows: [] })) }, runtimeClosed: vi.fn(),
  } as unknown as VoiceService;
  let first!: ReadableStreamDefaultController<any>, second!: ReadableStreamDefaultController<any>;
  state.streams = [new ReadableStream({ start(c) { first = c; } }), new ReadableStream({ start(c) { second = c; } })];
  const runtime = await VoiceRoomRuntime.connect(service, 'call', 'room');
  try {
    const human = { identity: 'human' };
    state.room.emit('track', { kind: 1 }, {}, human);
    first.enqueue({ data: new Int16Array([123, 456]) });
    expect(inputs).toHaveLength(0);
    authorize();
    await vi.waitFor(() => expect(inputs[0]?.send).toHaveBeenCalledWith(new Int16Array([123, 456])));
    state.room.emit('track', { kind: 1 }, {}, human);
    await vi.waitFor(() => expect(inputs).toHaveLength(2));
    callbacks[0]!();
    second.enqueue({ data: new Int16Array([789]) });
    await vi.waitFor(() => expect(inputs[1]?.send).toHaveBeenCalledWith(new Int16Array([789])));
    expect(inputs[1]?.close).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});

const roster = [
  { id: 'ruby', name: 'Ruby', handle: 'ruby', soul: '', voice: 'luna' },
  { id: 'goose', name: 'Goosey', handle: 'goose', soul: '', voice: 'apollo' },
];
function conversationService(humans = 2) {
  const speech = { synthesize: vi.fn(async function* () { yield new Uint8Array([200, 1, 200, 1]); }) };
  const service = {
    owner: 'owner', config: { url: 'ws://local', apiKey: 'devkey', apiSecret: 'secret', stt: vi.fn(),
      brain: { answer: vi.fn(async (_agent, _history, onText) => {
        onText('First sentence. Second sentence! Third sentence.');
        return { text: 'First sentence. Second sentence! Third sentence.', order: false };
      }) } },
    humanCount: vi.fn(async () => humans), agents: vi.fn(async () => roster), speech: vi.fn(async () => speech),
    access: vi.fn(async () => {}), recordHuman: vi.fn(async () => 'source'), recordAnswer: vi.fn(async () => {}),
    dispatch: vi.fn(async () => {}), db: { query: vi.fn(async () => ({ rowCount: 1, rows: [] })) }, runtimeClosed: vi.fn(),
  };
  return { service, speech };
}

it('switches on a name mid-utterance and ignores unnamed speech from either human, including after an avatar tap', async () => {
  const { service } = conversationService();
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    await runtime.utterance('human', 'Hello Ruby');
    await runtime.utterance('human', 'Please help me, GOOSEY');
    expect(service.config.brain.answer.mock.calls.map(call => call[0].id)).toEqual(['ruby', 'goose']);
    state.room.emit('data', new TextEncoder().encode(JSON.stringify({ type: 'target', agentId: 'ruby' })), { identity: 'human' }, undefined, 'beeline.voice.v1');
    await vi.waitFor(() => expect(service.access).toHaveBeenCalled());
    await runtime.utterance('human', 'What do you think?');
    await runtime.utterance('second', 'I agree with you.');
    expect(service.config.brain.answer).toHaveBeenCalledTimes(2);
    expect(service.recordHuman).toHaveBeenCalledTimes(2);
    service.humanCount.mockResolvedValue(1);
    await runtime.utterance('human', 'Continue please');
    expect(service.config.brain.answer.mock.calls.at(-1)?.[0].id).toBe('ruby');
  } finally { await runtime.close(); }
});

it.each([true, false])('plays the complete reply when streamed=%s, including every sentence', async streamed => {
  const { service, speech } = conversationService(1);
  if (!streamed) service.config.brain.answer.mockImplementation(async () => ({ text: 'First sentence. Second sentence! Third sentence.', order: false }));
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    await runtime.utterance('human', 'Ruby please explain');
    expect(speech.synthesize.mock.calls.map(call => call[0]).join(' ')).toBe('First sentence. Second sentence! Third sentence.');
    expect(service.recordAnswer).toHaveBeenCalledOnce();
    expect(state.audio.captureFrame).toHaveBeenCalledTimes(streamed ? 3 : 1);
  } finally { await runtime.close(); }
});

it('uses confident recognized speech for barge-in and rejects noise and echo fragments', () => {
  const event = { event: 'Update' as const, transcript: 'Stop please', turn_index: 0, sequence_id: 1,
    words: [{ word: 'Stop', start: 0, end: 0.2, confidence: 0.95 }, { word: 'please', start: 0.2, end: 0.4, confidence: 0.95 }] };
  expect(confirmedVoiceSpeech({ ...event, event: 'StartOfTurn', transcript: '', words: [] })).toBe(false);
  expect(confirmedVoiceSpeech({ ...event, words: event.words.map(word => ({ ...word, confidence: 0.2 })) })).toBe(false);
  expect(confirmedVoiceSpeech(event)).toBe(true);
  expect(voicePlaybackEcho('SECOND sentence', 'First sentence. Second sentence!')).toBe(true);
  expect(voicePlaybackEcho('Stop please', 'First sentence. Second sentence!')).toBe(false);
});

it('opens one STT stream for duplicate track events, dispatches one final turn, and ignores noise or echo while speaking', async () => {
  const { service } = conversationService(1);
  service.config.brain.answer.mockImplementation(async (_agent, _history, onText) => {
    onText('Sure. Here is the full explanation.');
    return { text: 'Sure. Here is the full explanation.', order: false };
  });
  let emit!: (event: any) => void;
  service.config.stt.mockImplementation(async onEvent => { emit = onEvent; return { send: vi.fn(), close: vi.fn() }; });
  let release!: () => void;
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  state.audio.waitForPlayout.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  state.streams = [new ReadableStream()];
  const track = { kind: 1 }, human = { identity: 'human' };
  try {
    state.room.emit('track', track, {}, human);
    state.room.emit('track', track, {}, human);
    await vi.waitFor(() => expect(service.config.stt).toHaveBeenCalledOnce());
    const end = { event: 'EndOfTurn', transcript: 'Ruby hello', turn_index: 0, sequence_id: 1 };
    emit(end); emit(end);
    await vi.waitFor(() => expect(state.audio.waitForPlayout).toHaveBeenCalledOnce());
    const cleared = state.audio.clearQueue.mock.calls.length;
    emit(end); // A late duplicate must not interrupt the reply it already started.
    emit({ ...end, event: 'StartOfTurn', transcript: '', turn_index: 1 });
    emit({ ...end, event: 'Update', transcript: 'noise words', turn_index: 1,
      words: [{ word: 'noise', confidence: 0.1, start: 0, end: 0.4 }] });
    emit({ ...end, transcript: 'Sure', turn_index: 1 });
    expect(state.audio.clearQueue).toHaveBeenCalledTimes(cleared);
    expect(service.config.brain.answer).toHaveBeenCalledOnce();
    emit({ ...end, event: 'Update', transcript: 'Stop please', turn_index: 2,
      words: [{ word: 'Stop', confidence: 0.95, start: 0, end: 0.4 }] });
    expect(state.audio.clearQueue).toHaveBeenCalledTimes(cleared + 1);
    expect(service.config.brain.answer.mock.calls[0]?.[3].aborted).toBe(true);
    release();
  } finally { await runtime.close(); }
});

it('claims a report once before playback and never replays an interrupted opening on refresh', async () => {
  const { service, speech } = conversationService();
  let offered = false, claimed = false;
  const report = { source_message_id: 'order', id: 'report', text: 'The full report. More detail.', agent_id: 'ruby', human_id: 'human' };
  service.db.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT DISTINCT ON')) return { rowCount: offered && !claimed ? 1 : 0, rows: offered && !claimed ? [report] : [] };
    if (sql.startsWith('UPDATE voice_orders')) { if (claimed) return { rowCount: 0, rows: [] }; claimed = true; }
    return { rowCount: 1, rows: [] };
  });
  speech.synthesize.mockImplementation(async function* () { throw new DOMException('Interrupted', 'AbortError'); });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    offered = true;
    await runtime.refresh();
    await vi.waitFor(() => expect(speech.synthesize).toHaveBeenCalledOnce());
    await runtime.refresh(); await runtime.refresh();
    expect(speech.synthesize).toHaveBeenCalledOnce();
    expect(claimed).toBe(true);
  } finally { await runtime.close(); }
});

it('waits for an utterance that starts while a report claim is in flight', async () => {
  const { service, speech } = conversationService(1);
  let offered = false;
  let releaseClaim!: () => void;
  const report = { source_message_id: 'order', id: 'report', text: 'Completed work.', agent_id: 'ruby', human_id: 'human' };
  service.db.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT DISTINCT ON')) return { rowCount: offered ? 1 : 0, rows: offered ? [report] : [] };
    if (sql.startsWith('UPDATE voice_orders')) await new Promise<void>(resolve => { releaseClaim = resolve; });
    return { rowCount: 1, rows: [] };
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  let releasePlayback!: () => void;
  state.audio.waitForPlayout.mockImplementationOnce(() => new Promise<void>(resolve => { releasePlayback = resolve; }));
  try {
    offered = true; await runtime.refresh();
    await vi.waitFor(() => expect(releaseClaim).toBeDefined());
    const utterance = runtime.utterance('human', 'Ruby hello');
    await vi.waitFor(() => expect(speech.synthesize).toHaveBeenCalledOnce());
    releaseClaim();
    await new Promise(resolve => setImmediate(resolve));
    expect(speech.synthesize).toHaveBeenCalledOnce();
    releasePlayback(); await utterance;
    await vi.waitFor(() => expect(speech.synthesize).toHaveBeenCalledTimes(4));
    expect(speech.synthesize.mock.calls.at(-1)?.[0]).toBe(report.text);
  } finally { await runtime.close(); }
});

it('speaks the order acknowledgement when the brain streams only whitespace', async () => {
  const { service, speech } = conversationService(1);
  service.config.brain.answer.mockImplementation(async (_agent, _history, onText) => {
    onText(' '); return { text: '', order: true };
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    await runtime.utterance('human', 'Ruby build a widget');
    expect(service.dispatch).toHaveBeenCalledOnce();
    expect(speech.synthesize.mock.calls.map(call => call[0]).join(' ')).toBe('I’ll work on that and tell you when I’m done.');
  } finally { await runtime.close(); }
});
