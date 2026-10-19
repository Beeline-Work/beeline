import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { markdownToSpeech } from './markdown-to-speech.js';
import { VoiceService } from './voice-service.js';

const state = vi.hoisted(() => ({ room: undefined as any, streams: [] as ReadableStream<any>[], audio: undefined as any }));
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
import { VoiceRoomRuntime, spokenReport, confirmedVoiceSpeech, voiceInterrupt, voicePlaybackEcho } from './voice-room-runtime.js';
import { AuraSpeech, VoiceQuotaError } from './voice-providers.js';
import { VoiceService as RealVoiceService } from './voice-service.js';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { LiveHub } from './live.js';
import { routeHumanMessage, claimAgentCommand } from './agent-command.js';
import { DaemonService } from './daemon-service.js';
import { PhoneService } from './phone-service.js';
import { ConnectionPresence } from './connection-presence.js';

it.each([1,2].flatMap(humans => ['stop', 'End conversation.', 'leave conversation'].map(phrase => ({humans,phrase}))))('call-wide-end-3: %s interrupts without leaving or closing input', async ({humans,phrase}) => {
  let onSpeech!: (event: any) => void;
  state.streams = [new ReadableStream()];
  const { service } = conversationService(humans);
  const leave = vi.fn(async () => {}), close = vi.fn();
  service.config.stt.mockImplementation(async (callback: any) => {
    onSpeech = callback; return { send: vi.fn(), close };
  });
  const runtime = await VoiceRoomRuntime.connect({ ...service, leave } as unknown as VoiceService, 'call', 'room');
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(onSpeech).toBeDefined());
    const cleared = state.audio.clearQueue.mock.calls.length;
    onSpeech({ event: 'EndOfTurn', turn_index: 0, transcript: phrase,
      words: phrase.split(' ').map((word, index) => ({ word, confidence: 0.99, start: index * 0.3, end: index * 0.3 + 0.25 })) });
    await vi.waitFor(() => expect(state.audio.clearQueue.mock.calls.length).toBeGreaterThan(cleared));
    expect(leave).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    expect(state.room.localParticipant.publishData.mock.calls.some(([bytes]: any[]) => JSON.parse(new TextDecoder().decode(bytes)).type === 'stop')).toBe(false);
    expect(service.config.brain.answer).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});

it('multi-human-silence-1: resume without a report acknowledges idle playback to restore legacy microphones', async () => {
  const { service } = conversationService(2);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  state.room.remoteParticipants.set('human', { identity: 'human', trackPublications: new Map() });
  try {
    await runtime.resume('human');
    const [bytes, options] = state.room.localParticipant.publishData.mock.calls.at(-1)!;
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ type: 'speaker', agentId: null });
    expect(options.destination_identities).toEqual(['human']);
    expect(service.recordAnswer).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});

it('retains an absent RTC participant through a short radio handoff and resets the reconnect grace on return', async () => {
  let clock = 0;
  const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const { service } = conversationService(1);
  const leave = vi.fn(async () => {});
  service.db.query.mockImplementation(async (sql: string) => ({ rowCount: 1,
    rows: sql.includes('SELECT identity_id FROM voice_participants') && !state.room.remoteParticipants.has('human')
      ? [{ identity_id: 'human' }] : [] as any }));
  const runtime = await VoiceRoomRuntime.connect({ ...service, leave } as unknown as VoiceService, 'call', 'room');
  const tick = () => (runtime as any).heartbeat();
  try {
    const human = { identity: 'human' };
    state.room.remoteParticipants.delete('human'); state.room.emit('left', human);
    clock = 60_000; await tick(); expect(leave).not.toHaveBeenCalled();
    state.room.remoteParticipants.set('human', human);
    clock = 119_000; await tick();
    state.room.remoteParticipants.delete('human'); state.room.emit('left', human);
    clock = 180_000; await tick(); expect(leave).not.toHaveBeenCalled();
    clock = 240_000; await tick(); expect(leave).toHaveBeenCalledOnce();
    console.log('60-second RTC loss => participant retained; return resets grace; abandoned transport eventually removed');
  } finally { await runtime.close(); now.mockRestore(); }
});

it('Reproduction MD-TTS-1: conversational streamed replies and delayed reports send natural text to synthesis', async () => {
  const agent = { id: 'agent', name: 'Jellybean', handle: 'jellybean', voice: 'warm' };
  const spoken: string[] = [];
  const answer = '**Hello, friend.**\n\n[Visit](https://example.com/a_(b)/details).\n\n```ts\nignore me\n```\n\nHi @jellybean.';
  let reports: any[] = [];
  const service = { workspaceId: vi.fn(async () => 'human'), endWorkspaceCalls: vi.fn(async () => {}), callWorkState: vi.fn(async () => ({pending:false,finishedAt:0})), hasCallWork: vi.fn(async () => false), endInactive: vi.fn(async () => false), budget: { read: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), record: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), limitMs: 3600000 }, owner: 'owner', config: { url: 'ws://local', apiKey: 'devkey', apiSecret: 'secret',
    brain: { answer: async (_agent: unknown, _history: unknown, delta: (text: string) => void) => {
      for (const character of answer) delta(character);
      return { text: answer };
    } } }, agents: vi.fn(async () => [agent]), humanCount: vi.fn(async () => 1),
    speech: async () => ({ async *synthesize(text: string) { spoken.push(text); } }),
    recordHuman: vi.fn(async () => 'source'), recordAnswer: vi.fn(async () => {}),
    db: { query: vi.fn(async (sql: string) => ({ rowCount: 1, rows: sql.includes('SELECT DISTINCT') ? reports : [] })) },
    access: vi.fn(async () => {}), leave: vi.fn(async () => {}), runtimeClosed: vi.fn() } as unknown as VoiceService;
  const runtime = await VoiceRoomRuntime.connect(service, 'call', 'room');
  try {
    await runtime.utterance('human', 'Jellybean, hello');
    expect(spoken.join(' ')).toBe('Hello, friend. Visit. Hi Jellybean.');
    expect(service.recordAnswer).toHaveBeenCalledWith('room', 'agent', answer);
    reports = [{ source_message_id: 'source', id: 'report', text: '**Done**: [result](https://example.com/a_(b)/details)', agent_id: 'agent', human_id: 'human' }];
    await runtime.refresh();
    await vi.waitFor(() => expect(spoken.at(-1)).toBe('Done: result The rest is in the chat.'));
    console.log('MD-TTS-1 synthesis:', spoken);
  } finally { await runtime.close(); }
});

it('cancels microphone input and sends a targeted quota signal when Flux rejects the handshake', async () => {
  const cancel = vi.fn();
  state.streams = [new ReadableStream({ cancel })];
  const service = { workspaceId: vi.fn(async () => 'human'), endWorkspaceCalls: vi.fn(async () => {}), callWorkState: vi.fn(async () => ({pending:false,finishedAt:0})), hasCallWork: vi.fn(async () => false), endInactive: vi.fn(async () => false), budget: { read: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), record: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), limitMs: 3600000 }, owner: 'owner', config: { url: 'ws://local', apiKey: 'devkey', apiSecret: 'secret',
    stt: vi.fn(async () => { throw new VoiceQuotaError(); }) }, access: vi.fn(async () => {}),
    humanCount: vi.fn(async () => 1), agents: vi.fn(async () => []), db: { query: vi.fn(async () => ({ rowCount: 1, rows: [] })) },
    runtimeClosed: vi.fn() } as unknown as VoiceService;
  const runtime = await VoiceRoomRuntime.connect(service, 'call', 'room');
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    const quota = () => state.room.localParticipant.publishData.mock.calls.find(([bytes]: any[]) => JSON.parse(new TextDecoder().decode(bytes)).code === 'speech-quota-exhausted');
    await vi.waitFor(() => expect(quota()).toBeDefined());
    const [bytes, options] = quota()!;
    expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({ code: 'speech-quota-exhausted', message: expect.stringContaining('Daily voice limit') });
    expect(options.destination_identities).toEqual(['human']);
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
    workspaceId: vi.fn(async () => 'human'), endWorkspaceCalls: vi.fn(async () => {}), callWorkState: vi.fn(async () => ({pending:false,finishedAt:0})), hasCallWork: vi.fn(async () => false), endInactive: vi.fn(async () => false), budget: { read: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), record: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), limitMs: 3600000 }, owner: 'owner', config: { url: 'ws://local', apiKey: 'devkey', apiSecret: 'secret',
      stt: vi.fn(async (_event, failure) => {
        callbacks.push(failure); const input = { send: vi.fn(), close: vi.fn() }; inputs.push(input); return input;
      }) },
    access, humanCount: vi.fn(async () => 1), agents: vi.fn(async () => []),
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
    workspaceId: vi.fn(async () => 'human'), endWorkspaceCalls: vi.fn(async () => {}), callWorkState: vi.fn(async () => ({pending:false,finishedAt:0})), hasCallWork: vi.fn(async () => false), endInactive: vi.fn(async () => false), budget: { read: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), record: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), limitMs: 3600000 }, owner: 'owner', config: { url: 'ws://local', apiKey: 'devkey', apiSecret: 'secret', stt: vi.fn(),
      brain: { answer: vi.fn(async (_agent, _history, onText) => {
        onText('First sentence. Second sentence! Third sentence.');
        return { text: 'First sentence. Second sentence! Third sentence.', order: false };
      }) } },
    lastActiveAgent: vi.fn(async (): Promise<string | undefined> => undefined),
    humanCount: vi.fn(async () => humans), agents: vi.fn(async () => roster), speech: vi.fn(async () => speech),
    access: vi.fn(async () => {}), reviseHuman: vi.fn(async () => {}), recordHuman: vi.fn(async () => 'source'), recordAnswer: vi.fn(async () => {}),
    dispatch: vi.fn(async () => {}), db: { query: vi.fn(async (sql: string, parameters?: any[]) => ({ rowCount: 1,
      rows: sql.includes('identity_id=ANY') ? (parameters?.[1] ?? []).map((identity_id: string) => ({identity_id})) : [] })) }, runtimeClosed: vi.fn(),
  };
  return { service, speech };
}

it('routes unnamed solo speech to the last active agent despite the initial first-agent selection', async () => {
  const { service } = conversationService(1);
  service.lastActiveAgent.mockResolvedValue('goose');
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    state.room.emit('data', new TextEncoder().encode(JSON.stringify({ type: 'target', agentId: 'ruby' })),
      { identity: 'human' }, undefined, 'beeline.voice.v1');
    await vi.waitFor(() => expect(service.access).toHaveBeenCalled());
    await runtime.utterance('human', 'What do you think?');
    expect(service.recordHuman).toHaveBeenCalledWith('call', 'room', 'human', roster[1], 'What do you think?', 'owner', expect.any(String));
    expect(service.config.brain.answer.mock.calls.at(-1)?.[0].id).toBe('goose');
  } finally { await runtime.close(); }
});

it('keeps named addresses and deliberate avatar taps ahead of recent solo activity', async () => {
  const { service } = conversationService(1);
  service.lastActiveAgent.mockResolvedValue('goose');
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    await runtime.utterance('human', 'Ruby, help me');
    expect(service.config.brain.answer.mock.calls.at(-1)?.[0].id).toBe('ruby');
    state.room.emit('data', new TextEncoder().encode(JSON.stringify({ type: 'target', agentId: 'ruby', tap: true })),
      { identity: 'human' }, undefined, 'beeline.voice.v1');
    await vi.waitFor(() => expect(service.access).toHaveBeenCalled());
    await runtime.utterance('human', 'Continue please');
    expect(service.config.brain.answer.mock.calls.at(-1)?.[0].id).toBe('ruby');
    expect(service.lastActiveAgent).not.toHaveBeenCalled();
    await runtime.utterance('human', 'And what next?');
    expect(service.config.brain.answer.mock.calls.at(-1)?.[0].id).toBe('goose');
  } finally { await runtime.close(); }
});

it('preserves the first agent and selected target when no agent has been active', async () => {
  const { service } = conversationService(1);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    await runtime.utterance('human', 'Can you help?');
    expect(service.config.brain.answer.mock.calls.at(-1)?.[0].id).toBe('ruby');
    await runtime.utterance('human', 'Goosey help');
    await runtime.utterance('human', 'Continue please');
    expect(service.config.brain.answer.mock.calls.at(-1)?.[0].id).toBe('goose');
    expect(service.lastActiveAgent).toHaveBeenCalledTimes(2);
  } finally { await runtime.close(); }
});

it('refreshes recent solo activity each turn and does not use it for multi-human calls', async () => {
  const { service } = conversationService(1);
  service.lastActiveAgent.mockResolvedValueOnce('goose').mockResolvedValueOnce('ruby');
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    await runtime.utterance('human', 'Can you help?');
    await runtime.utterance('human', 'What next?');
    expect(service.config.brain.answer.mock.calls.map(call => call[0].id)).toEqual(['goose', 'ruby']);
    service.humanCount.mockResolvedValue(2);
    await runtime.utterance('human', 'Can you help?');
    expect(service.config.brain.answer).toHaveBeenCalledTimes(2);
    expect(service.lastActiveAgent).toHaveBeenCalledTimes(2);
  } finally { await runtime.close(); }
});

it('switches on an opening name and ignores unnamed speech from either human, including after an avatar tap', async () => {
  const { service } = conversationService();
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    await runtime.utterance('human', 'Hello Ruby');
    await runtime.utterance('human', 'Please help me, GOOSEY');
    expect(service.config.brain.answer).toHaveBeenCalledOnce();
    await runtime.utterance('human', 'Hey GOOSEY, please help me');
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
    await vi.waitFor(() => expect(state.audio.clearQueue).toHaveBeenCalledTimes(cleared + 1));
    expect((runtime as any).speaking?.signal.aborted ?? true).toBe(true);
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
    (runtime as any).targets.set('human', report.agent_id);
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
    (runtime as any).targets.set('human', report.agent_id);
    offered = true; await runtime.refresh();
    await vi.waitFor(() => expect(releaseClaim).toBeDefined());
    const utterance = runtime.utterance('human', 'Ruby hello');
    await vi.waitFor(() => expect(speech.synthesize).toHaveBeenCalledOnce());
    releaseClaim();
    await new Promise(resolve => setImmediate(resolve));
    expect(speech.synthesize).toHaveBeenCalledOnce();
    releasePlayback(); await utterance;
    await vi.waitFor(() => expect(speech.synthesize).toHaveBeenCalledTimes(4));
    expect(speech.synthesize.mock.calls.at(-1)?.[0]).toBe(spokenReport(report.text));
  } finally { await runtime.close(); }
});

it('lookup goes to order: speaks a short checking line at once when the brain streams only whitespace', async () => {
  const { service, speech } = conversationService(1);
  service.config.brain.answer.mockImplementation(async (_agent, _history, onText) => {
    onText(' '); return { text: '', order: true };
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    await runtime.utterance('human', 'Ruby build a widget');
    expect(service.dispatch).toHaveBeenCalledOnce();
    expect(service.recordAnswer).not.toHaveBeenCalled();
    expect(speech.synthesize.mock.calls.map(call => call[0]).join(' ')).toBe('Checking. I’ll tell you when I have it.');
  } finally { await runtime.close(); }
});

it('hands external work to the normal turn without posting a second visible reply', async () => {
  const { service } = conversationService(1);
  service.config.brain.answer.mockImplementation(async (_agent, _history, onText) => {
    onText('You’re right to question it.');
    return { text: 'You’re right to question it.', order: true };
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    await runtime.utterance('human', 'Ruby reproduce the bug');
    expect(service.dispatch).toHaveBeenCalledOnce();
    expect(service.recordAnswer).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});

it('does not fall back to a second visible reply when a handoff fails', async () => {
  const { service } = conversationService(1);
  service.config.brain.answer.mockImplementation(async (_agent, _history, onText) => {
    onText('I’ll check.'); return { text: 'I’ll check.', order: true };
  });
  service.dispatch.mockRejectedValueOnce(new Error('dispatch failed'));
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    await expect(runtime.utterance('human', 'Ruby check the code')).rejects.toThrow('dispatch failed');
    expect(service.recordAnswer).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});

it('demonstrates one visible reply through voice handoff, normal completion and the phone read', async () => {
  const db = new PgliteDatabase();
  const live = new LiveHub();
  const human = 'a'.repeat(64), agent = 'b'.repeat(64);
  const workspace = '11111111-1111-4111-8111-111111111111';
  const room = '22222222-2222-4222-8222-222222222222';
  const config = conversationService(1).service.config;
  config.brain.answer.mockImplementation(async (_agent, _history, onText) => {
    onText('You’re right to question it.');
    return { text: 'You’re right to question it.', order: true };
  });
  const voice = new RealVoiceService(db, live, { ...config,
    speech: { synthesize: async function* () { yield new Uint8Array([200, 1]); } } });
  try {
    await migrate(db);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Human','human'),($2,'agent','Ruby','ruby')`, [human, agent]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, human]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Duplicate reply proof')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants) VALUES($1,$2,'DM',$3)`, [room, workspace, [human, agent]]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`, [workspace, human, agent, room]);
    const joined = await voice.join(room, human);
    const call = (await db.query<any>(`SELECT * FROM voice_calls WHERE id=$1`, [joined.call.id])).rows[0];
    const runtime = await voice.ensureRuntime(call);
    await runtime!.utterance(human, 'Ruby reproduce the bug');
    const command = (await db.query<{ id: string; source_message_id: string }>(`SELECT id,source_message_id FROM agent_commands WHERE room_id=$1`, [room])).rows;
    expect(command).toHaveLength(1);
    await claimAgentCommand(db, room, agent, command[0]!.id, 'proof-generation');
    await new DaemonService(db, live).execute('postRoomMessage', {
      roomId: room, requestId: command[0]!.source_message_id, generationId: 'proof-generation', text: 'The cause is confirmed.',
    }, agent);
    const phone = new PhoneService(db, 'http://proof');
    const replies = (await phone.readRoom(room, human))!.messages.filter(message => message.author.pubkey === agent && message.presentation === 'message');
    expect(replies.map(reply => reply.text)).toEqual(['The cause is confirmed.']);
    // A conversation-only answer remains owned by the voice path.
    config.brain.answer.mockImplementation(async (_agent, _history, onText) => {
      const answer = '**I’m listening.**\nWhat were you going to say?\n\nI’m listening. What were you going to say?';
      onText(answer); return { text: answer, order: false };
    });
    await runtime!.utterance(human, 'Ruby I’m');
    const view = (await phone.readRoom(room, human))!;
    expect(view.messages.filter(message => message.text.includes('I’m listening.')).map(message => message.text))
      .toEqual(['**I’m listening.**\nWhat were you going to say?']);
    console.log('Reproduction voice-double-reply: voice handoff → ordinary agent completion → phone shows exactly one reply; repeated Luna rendition → phone shows one rendition.');
  } finally { await voice.close(); await db.close(); }
}, 30_000);
/** Real runtime and STT callback; only RTC, providers and persistence are fake. */
function phantomHarness(answer = 'Hey there is the answer.') {
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
    workspaceId: vi.fn(async () => 'human'), endWorkspaceCalls: vi.fn(async () => {}), callWorkState: vi.fn(async () => ({pending:false,finishedAt:0})), hasCallWork: vi.fn(async () => false), endInactive: vi.fn(async () => false), budget: { read: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), record: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), limitMs: 3600000 }, owner: 'owner', config: { url: 'ws://local', apiKey: 'devkey', apiSecret: 'secret',
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
    }), recordAnswer: vi.fn(async () => {}),
    db: { query: vi.fn(async (sql: string, parameters?: any[]) => ({ rowCount: 1,
      rows: sql.includes('identity_id=ANY') ? (parameters?.[1] ?? []).map((identity_id: string) => ({identity_id})) : [] as any[] })) },
    runtimeClosed: vi.fn(),
    leave: vi.fn(async () => {}),
  };
  let sequence = 0;
  return { service, speech, timeline, messages, note,
    finishPlayback() { for (const finish of playing) finish(); },
    emit(event: string, transcript: string, turn: number, words?: { confidence: number }[]) {
      note(`STT ${event} turn=${turn} text=${JSON.stringify(transcript)}`);
      receive({ event, transcript, turn_index: turn, sequence_id: sequence++, ...(words ? {
        words: words.map((word, i) => ({ word: transcript.split(' ')[i], start: i * 0.2, end: (i + 1) * 0.2, ...word })),
      } : {}) });
    } };
}

it('Reproduction phantom-1: never sends Hey or Yeah from a noisy turn during TTS; stop still interrupts', async () => {
  const harness = phantomHarness();
  const runtime = await VoiceRoomRuntime.connect(harness.service as unknown as VoiceService, 'call', 'room');
  state.streams = [new ReadableStream()];
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(harness.service.config.stt).toHaveBeenCalledOnce());
    harness.emit('EndOfTurn', 'Explain the answer', 0);
    await vi.waitFor(() => expect(harness.speech.synthesize).toHaveBeenCalledOnce());
    harness.emit('StartOfTurn', '', 1);
    harness.emit('Update', 'Hey', 1);
    harness.emit('EndOfTurn', 'Hey', 1);
    harness.emit('StartOfTurn', '', 2);
    harness.emit('Update', 'Yeah', 2);
    harness.emit('EndOfTurn', 'Yeah', 2);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(harness.service.recordHuman.mock.calls.map(call => call[4])).toEqual(['Explain the answer']);
    expect(harness.messages).toEqual(['@ronnie Explain the answer']);
    expect(harness.timeline.filter(line => line.endsWith('barge-in cancel'))).toHaveLength(0);
    harness.emit('StartOfTurn', '', 3);
    harness.emit('EndOfTurn', 'stop', 3);
    await vi.waitFor(() => expect(harness.speech.synthesize.mock.calls[0]?.[2]?.aborted).toBe(true));
    expect(harness.service.leave).not.toHaveBeenCalled();
    expect(harness.service.recordHuman).toHaveBeenCalledOnce();
    expect(harness.speech.synthesize.mock.calls[0]?.[2]?.aborted).toBe(true);
  } finally {
    console.log('Reproduction phantom-1\n' + harness.timeline.join('\n'));
    await runtime.close();
  }
});

it.each(['stop', 'wait', 'no', 'Yeah', 'Please explain something else'])('preserves a real barge-in: %s', async text => {
  const harness = phantomHarness('Hey stop wait no there is the answer.');
  const runtime = await VoiceRoomRuntime.connect(harness.service as unknown as VoiceService, 'call', 'room');
  state.streams = [new ReadableStream()];
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(harness.service.config.stt).toHaveBeenCalledOnce());
    harness.emit('EndOfTurn', 'Explain the answer', 0);
    await vi.waitFor(() => expect(harness.speech.synthesize).toHaveBeenCalledOnce());
    harness.emit('Update', text, 1, [{ confidence: 0.95 }]);
    harness.emit('EndOfTurn', text, 1, [{ confidence: 0.95 }]);
    harness.emit('EndOfTurn', text, 1, [{ confidence: 0.95 }]);
    if (text === 'stop') {
      await vi.waitFor(() => expect(harness.speech.synthesize.mock.calls[0]?.[2]?.aborted).toBe(true));
    expect(harness.service.leave).not.toHaveBeenCalled();
      expect(harness.service.recordHuman).toHaveBeenCalledOnce();
    } else {
      await vi.waitFor(() => expect(harness.service.recordHuman).toHaveBeenCalledTimes(2));
      expect(harness.service.recordHuman.mock.calls[1]?.[4]).toBe(text);
    }
    expect(harness.speech.synthesize.mock.calls[0]?.[2]?.aborted).toBe(true);
  } finally { await runtime.close(); }
});

it('keeps echo context until a delayed final and ignores duplicate finals before they cancel audio', async () => {
  const harness = phantomHarness();
  const runtime = await VoiceRoomRuntime.connect(harness.service as unknown as VoiceService, 'call', 'room');
  state.streams = [new ReadableStream()];
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(harness.service.config.stt).toHaveBeenCalledOnce());
    harness.emit('EndOfTurn', 'Explain the answer', 0);
    await vi.waitFor(() => expect(harness.speech.synthesize).toHaveBeenCalledOnce());
    harness.emit('StartOfTurn', '', 0);
    harness.emit('EndOfTurn', 'Explain the answer', 0);
    expect(harness.timeline.some(line => line.endsWith('barge-in cancel'))).toBe(false);
    harness.emit('StartOfTurn', '', 1);
    harness.emit('Update', 'Hey', 1);
    harness.finishPlayback();
    await vi.waitFor(() => expect(harness.timeline.some(line => line.includes('TTS stop:'))).toBe(true));
    const later = performance.now() + 2000;
    clock = vi.spyOn(performance, 'now').mockReturnValue(later);
    harness.emit('EndOfTurn', 'Hey', 1);
    harness.emit('EndOfTurn', 'Hey', 1);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(harness.service.recordHuman).toHaveBeenCalledOnce();
    expect(harness.service.config.brain.answer).toHaveBeenCalledOnce();
    // A new deliberate short utterance after playback is still a valid turn.
    harness.emit('EndOfTurn', 'Hey', 2);
    await vi.waitFor(() => expect(harness.service.recordHuman).toHaveBeenCalledTimes(2));
  } finally { clock?.mockRestore(); await runtime.close(); }
});

it('rejects a later clause echoed by a recognizer turn that began during the first clause', async () => {
  const harness = phantomHarness('First sentence. Second sentence.');
  const runtime = await VoiceRoomRuntime.connect(harness.service as unknown as VoiceService, 'call', 'room');
  state.streams = [new ReadableStream()];
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(harness.service.config.stt).toHaveBeenCalledOnce());
    harness.emit('EndOfTurn', 'Explain the answer', 0);
    await vi.waitFor(() => expect(harness.speech.synthesize).toHaveBeenCalledOnce());
    harness.emit('StartOfTurn', '', 1);
    harness.finishPlayback();
    await vi.waitFor(() => expect(harness.speech.synthesize).toHaveBeenCalledTimes(2));
    harness.emit('Update', 'Second sentence', 1, [{ confidence: 0.95 }, { confidence: 0.95 }]);
    harness.emit('EndOfTurn', 'Second sentence', 1);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(harness.timeline.some(line => line.endsWith('barge-in cancel'))).toBe(false);
    expect(harness.messages).toEqual(['@ronnie Explain the answer']);
  } finally { await runtime.close(); }
});

it('Reproduction phantom-2: an interrupted delegated answer does not replay its opening on refresh', async () => {
  const harness = phantomHarness();
  let offered = false, claimed = false;
  const report = { source_message_id: 'order', id: 'report', text: 'Hey, here is the previous answer.', agent_id: 'ronnie', human_id: 'human' };
  harness.service.db.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT DISTINCT ON')) return { rowCount: offered && !claimed ? 1 : 0, rows: offered && !claimed ? [report] : [] };
    if (sql.startsWith('UPDATE voice_orders')) { claimed = true; harness.note('report marked spoken'); }
    return { rowCount: 1, rows: [] };
  });
  const runtime = await VoiceRoomRuntime.connect(harness.service as unknown as VoiceService, 'call', 'room');
  state.streams = [new ReadableStream()];
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(harness.service.config.stt).toHaveBeenCalledOnce());
    (runtime as any).targets.set('human', report.agent_id);
    offered = true; await runtime.refresh();
    await vi.waitFor(() => expect(harness.speech.synthesize).toHaveBeenCalledOnce());
    harness.emit('EndOfTurn', 'wait', 0);
    await vi.waitFor(() => expect(harness.service.recordHuman).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(harness.timeline.some(line => line.includes('TTS stop: Hey, here is the previous answer.'))).toBe(true));
    await runtime.refresh();
    await new Promise<void>(resolve => setImmediate(resolve));
    console.log('Reproduction phantom-2\n' + harness.timeline.join('\n'));
    expect(harness.speech.synthesize.mock.calls.filter(call => call[0] === spokenReport(report.text))).toHaveLength(1);
  } finally { await runtime.close(); }
});

it('Reproduction voice-name-1: switches transcript, reply and voice together and retains the target', async () => {
  const agents = [
    { id: 'ruby', name: 'Ruby', handle: 'ruby', soul: '', voice: 'ruby-voice' },
    { id: 'candy', name: 'Candy', handle: 'candy', soul: '', voice: 'candy-voice' },
  ];
  const recordHuman = vi.fn(async () => 'source');
  const answer = vi.fn(async () => ({ text: '' }));
  const service = { workspaceId: vi.fn(async () => 'human'), endWorkspaceCalls: vi.fn(async () => {}), callWorkState: vi.fn(async () => ({pending:false,finishedAt:0})), hasCallWork: vi.fn(async () => false), endInactive: vi.fn(async () => false), budget: { read: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), record: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), limitMs: 3600000 }, owner: 'owner', config: { url: 'ws://local', apiKey: 'devkey', apiSecret: 'secret', brain: { answer } },
    access: vi.fn(async () => {}),
    lastActiveAgent: vi.fn(async () => undefined),
    humanCount: vi.fn(async () => 1), agents: vi.fn(async () => agents), recordHuman, recordAnswer: vi.fn(async () => {}),
    db: { query: vi.fn(async () => ({ rowCount: 1, rows: [] })) }, runtimeClosed: vi.fn() } as unknown as VoiceService;
  const runtime = await VoiceRoomRuntime.connect(service, 'call', 'room');
  // Exercise the turn boundary with transport/provider doubles, including actual playback selection.
  const play = vi.spyOn(runtime as any, 'play').mockResolvedValue(undefined);
  answer.mockImplementation(async (_agent?: any, _history?: any, delta?: any) => {
    delta?.('Here is my answer.'); return { text: 'Here is my answer.' };
  });
  try {
    for (const [text, expected] of [
      ['Ruby, hello', 'ruby'], ['hey Candie what do you think?', 'candy'],
      ['What does Ruby think?', 'candy'], ['Unknown, help', 'candy'], ['Ruby, come back', 'ruby'],
    ]) {
      await runtime.utterance('human', text!);
      expect(recordHuman.mock.lastCall?.[3]).toMatchObject({ id: expected, handle: expected });
      expect(answer.mock.lastCall?.[0]).toMatchObject({ id: expected });
      expect(play.mock.lastCall?.[1]).toMatchObject({ id: expected, voice: `${expected}-voice` });
      const signals = state.room.localParticipant.publishData.mock.calls.map(([bytes]: any[]) => JSON.parse(new TextDecoder().decode(bytes)));
      expect(signals.filter((s: any) => s.type === 'target').at(-1)).toEqual({ type: 'target', agentId: expected });
      console.log(`${text} => transcript/reply/voice/UI target ${expected}`);
    }
  } finally { await runtime.close(); }
});


it('ignores legacy park and routes resume to the RTC owner only for the current session', async () => {
  const { service } = conversationService();
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  const resume = vi.spyOn(runtime, 'resume').mockResolvedValue(undefined);
  let parked = true;
  service.db.query.mockImplementation(async (_sql: string, args?: unknown[]) => ({
    rowCount: args?.length === 4 ? Number(args[2] === 'current' && args[3] === parked) : 1, rows: [],
  }));
  const signal = (type: string, sessionId: string) => state.room.emit('data',
    new TextEncoder().encode(JSON.stringify({ type, sessionId })), { identity: 'human' }, undefined, 'beeline.voice.v1');
  try {
    signal('park', 'old');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(state.audio.clearQueue).not.toHaveBeenCalled();
    signal('park', 'current');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(state.audio.clearQueue).not.toHaveBeenCalled();
    signal('resume', 'current');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(resume).not.toHaveBeenCalled();
    parked = false;
    signal('resume', 'current');
    await vi.waitFor(() => expect(resume).toHaveBeenCalledWith('human'));
  } finally { await runtime.close(); }
});

it('finished-sentence timing adds no wait before commit or first audio', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const { service, speech } = conversationService(1);
  let committed = 0, audible = 0;
  service.agents.mockImplementation(async () => { await delay(3); return roster; });
  service.recordHuman.mockImplementation(async () => { await delay(5); committed = performance.now(); return 'source'; });
  service.config.brain.answer.mockImplementation(async () => { await delay(20); return { text: 'A finished reply.', order: false }; });
  speech.synthesize.mockImplementation(async function* () { await delay(40); yield new Uint8Array([200, 1]); });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  service.humanCount.mockImplementation(async () => { await delay(2); return 1; });
  state.room.localParticipant.publishData.mockImplementation(async () => { await delay(1); });
  state.audio.captureFrame.mockImplementation(async () => { await delay(1); audible = performance.now(); });
  try {
    const finished = (async () => { await delay(1000); await runtime.utterance('human', 'Ruby this sentence is finished.'); })();
    await vi.advanceTimersByTimeAsync(1200); await finished;
    expect({ committed, audible }).toEqual({ committed: 1011, audible: 1076 });
    console.log('FINISHED-SENTENCE timing fixture:', JSON.stringify({ speechEndToCommitMs: committed, speechEndToFirstAudioMs: audible, eotThreshold: 0.7, eotTimeoutMs: 1000, providerAndTransport: 'controlled doubles' }));
  } finally { await runtime.close(); vi.useRealTimers(); }
});

it('Reproduction CONTINUATION-1: resumes during thinking without creating another message', async () => {
  const { service } = conversationService(1);
  const releases: Array<() => void> = [];
  service.config.brain.answer.mockImplementation(async (_agent, _history, _onText, signal) => {
    await new Promise<void>((resolve, reject) => {
      releases.push(resolve);
      signal.addEventListener('abort', () => reject(new DOMException('Interrupted', 'AbortError')), { once: true });
    });
    return { text: 'One complete reply.', order: false };
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    const first = runtime.utterance('human', 'Ruby I can talk for hours.').catch(() => {});
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const second = runtime.utterance('human', 'That does not exist today.');
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[0]!(); releases[1]!(); await second; await first;
    expect(service.recordHuman).toHaveBeenCalledOnce();
    expect(service.config.brain.answer.mock.calls[1]?.[1].filter(message => message.role === 'user').at(-1)?.content).toBe('Ruby I can talk for hours. That does not exist today.');
    expect(service.recordAnswer).toHaveBeenCalledOnce();
    console.log('CONTINUATION-1: one message, combined request, one reply');
  } finally { await runtime.close(); }
});

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it('a failed authorization after confirmed partial speech does not poison the next final', async () => {
  const { service } = conversationService(1);
  let receive!: (event: any) => void;
  service.config.stt.mockImplementation(async callback => { receive = callback; return { send() {}, close() {} }; });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  state.streams = [new ReadableStream()];
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(receive).toBeDefined());
    const authorization = deferred<typeof roster>();
    service.agents.mockImplementationOnce(() => authorization.promise);
    const reads = service.agents.mock.calls.length;
    receive({ event: 'EndOfTurn', transcript: 'Ruby failed', turn_index: 0, sequence_id: 0 });
    await vi.waitFor(() => expect(service.agents.mock.calls.length).toBe(reads + 1));
    receive({ event: 'Update', transcript: 'continued speech', turn_index: 1, sequence_id: 1,
      words: [{ word: 'continued', start: 0, end: .2, confidence: .95 }, { word: 'speech', start: .2, end: .4, confidence: .95 }] });
    authorization.reject(new Error('access denied'));
    await vi.waitFor(() => expect(state.room.localParticipant.publishData.mock.calls.map(([bytes]: any[]) => JSON.parse(new TextDecoder().decode(bytes))).some(signal => signal.type === 'error')).toBe(true));
    receive({ event: 'EndOfTurn', transcript: 'Ruby continue', turn_index: 1, sequence_id: 2 });
    await vi.waitFor(() => expect(service.recordAnswer).toHaveBeenCalledOnce());
    expect(service.recordHuman).toHaveBeenCalledOnce();
    expect(service.recordHuman.mock.calls[0]?.[4]).toBe('Ruby continue');
  } finally { await runtime.close(); }
});

it.each(['agents', 'humanCount'])('settles a shared source when %s fails and allows the next turn', async stage => {
  const { service } = conversationService(1);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  const setup = deferred<any>();
  const failing = stage === 'agents' ? service.agents : stage === 'humanCount' ? service.humanCount : state.room.localParticipant.publishData;
  failing.mockClear();
  failing.mockImplementationOnce(() => setup.promise);
  try {
    const first = runtime.utterance('human', 'Ruby first').catch(error => error.message);
    await vi.waitFor(() => expect(failing).toHaveBeenCalledOnce());
    const second = runtime.utterance('human', 'continued').catch(error => error.message);
    setup.reject(new Error('setup failed'));
    expect(await Promise.all([first, second])).toEqual(['setup failed', 'setup failed']);
    expect(service.recordHuman).not.toHaveBeenCalled();
    await runtime.utterance('human', 'Ruby fresh');
    expect(service.recordHuman).toHaveBeenCalledOnce();
  } finally { await runtime.close(); }
});

it('shares an insert in flight and serializes later edits before restarting the newest text', async () => {
  const { service } = conversationService(1);
  const insert = deferred<string>(), edit = deferred<void>();
  service.recordHuman.mockImplementationOnce(() => insert.promise);
  service.reviseHuman.mockImplementationOnce(() => edit.promise);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    const first = runtime.utterance('human', 'Ruby first');
    await vi.waitFor(() => expect(service.recordHuman).toHaveBeenCalledOnce());
    const second = runtime.utterance('human', 'second');
    insert.resolve('source');
    await vi.waitFor(() => expect(service.reviseHuman).toHaveBeenCalledOnce());
    const third = runtime.utterance('human', 'third');
    await new Promise(resolve => setImmediate(resolve));
    expect(service.reviseHuman).toHaveBeenCalledOnce();
    edit.resolve();
    await Promise.all([first, second, third]);
    expect(service.reviseHuman.mock.calls.map(call => call[5])).toEqual(['Ruby first second', 'Ruby first second third']);
    expect(service.recordHuman).toHaveBeenCalledOnce();
    expect(service.config.brain.answer).toHaveBeenCalledOnce();
    expect(service.config.brain.answer.mock.calls[0]?.[1].filter(message => message.role === 'user').at(-1)?.content).toBe('Ruby first second third');
  } finally { await runtime.close(); }
});

it('multi-human-silence-1: unnamed speech cannot inherit a pending pre-audio target', async () => {
  const { service, speech } = conversationService(2);
  speech.synthesize.mockImplementationOnce(async function* (_text, _voice, signal) {
    yield Buffer.alloc(960);
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(new DOMException('Interrupted', 'AbortError'));
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    const first = runtime.utterance('human', 'Ruby, help').catch(error => { if (error.name !== 'AbortError') throw error; });
    await vi.waitFor(() => expect(state.audio.captureFrame).toHaveBeenCalledOnce());
    await runtime.utterance('human', 'So so I think... yeah. No. You go.'); await first;
    expect(service.reviseHuman).not.toHaveBeenCalled();
    expect(service.config.brain.answer).toHaveBeenCalledOnce();
    expect(state.room.localParticipant.publishData.mock.calls.some(([bytes]: any[]) => JSON.parse(new TextDecoder().decode(bytes)).type === 'unaddressed')).toBe(true);
  } finally { await runtime.close(); }
});

it('a final conversational answer closes assembly even when its audio is quiet', async () => {
  const { service, speech } = conversationService(1);
  speech.synthesize.mockImplementationOnce(async function* (_text, _voice, signal) {
    yield Buffer.alloc(960);
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(new DOMException('Interrupted', 'AbortError'));
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
    yield Buffer.alloc(960, 1);
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    const first = runtime.utterance('human', 'Ruby first').catch(error => { if (error.name !== 'AbortError') throw error; });
    await vi.waitFor(() => expect(state.audio.captureFrame).toHaveBeenCalledOnce());
    await runtime.utterance('human', 'continued'); await first;
    expect(service.recordHuman).toHaveBeenCalledTimes(2);
    expect(service.reviseHuman).not.toHaveBeenCalled();
    expect(service.recordAnswer).toHaveBeenCalledTimes(2);
  } finally { await runtime.close(); }
});

it('does not call playback after cancellation during an awaited speaker signal', async () => {
  const { service } = conversationService(1);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  const speaker = deferred<void>();
  let waiting = false;
  state.room.localParticipant.publishData.mockImplementationOnce(async () => {});
  state.room.localParticipant.publishData.mockImplementation(async (bytes: Uint8Array) => {
    const signal = JSON.parse(new TextDecoder().decode(bytes));
    if (!waiting && signal.type === 'speaker' && signal.agentId === 'ruby') { waiting = true; await speaker.promise; }
  });
  const play = vi.spyOn(runtime as any, 'play');
  try {
    const first = runtime.utterance('human', 'Ruby first').catch(error => { if (error.name !== 'AbortError') throw error; });
    await vi.waitFor(() => expect(waiting).toBe(true));
    await runtime.utterance('human', 'continued');
    speaker.resolve(); await first;
    expect(play).toHaveBeenCalledTimes(3);
    expect(service.recordHuman).toHaveBeenCalledTimes(2);
    expect(service.recordAnswer).toHaveBeenCalledTimes(2);
  } finally { speaker.resolve(); await runtime.close(); }
});

it('Reproduction DELIVERY-2: another human cannot cancel classification before acknowledgement', async () => {
  const { service, speech } = conversationService(2);
  const decision = deferred<any>();
  let signal!: AbortSignal;
  service.config.brain.answer.mockImplementationOnce(async (_agent, _history, delta, cancellation) => {
    signal = cancellation; delta('Checking. '); return decision.promise;
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    const first = runtime.utterance('human', 'Ruby check my latest report');
    await vi.waitFor(() => expect(service.config.brain.answer).toHaveBeenCalledOnce());
    expect(speech.synthesize).not.toHaveBeenCalled();
    await runtime.utterance('second', 'Goosey another question');
    expect(signal.aborted).toBe(false);
    decision.resolve({ text: 'Checking.', order: true }); await first;
    expect(service.dispatch).toHaveBeenCalledOnce();
    expect(service.reviseHuman).not.toHaveBeenCalled();
  } finally { decision.resolve({text: '', order: false}); await runtime.close(); }
});

it('superseded pending setup cannot restore an older target', async () => {
  const { service } = conversationService(1);
  const authorization = deferred<typeof roster>();
  service.agents.mockImplementationOnce(() => authorization.promise);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    const first = runtime.utterance('human', 'Goosey first');
    const second = runtime.utterance('human', 'Ruby continued');
    authorization.resolve(roster); await Promise.all([first, second]);
    expect(service.recordHuman).toHaveBeenCalledOnce();
    expect(service.config.brain.answer).toHaveBeenCalledOnce();
    expect(service.config.brain.answer.mock.calls[0]?.[0].id).toBe('ruby');
    const targets = state.room.localParticipant.publishData.mock.calls.map(([bytes]: any[]) => JSON.parse(new TextDecoder().decode(bytes))).filter(signal => signal.type === 'target');
    expect(targets.map(signal => signal.agentId)).toEqual(['ruby']);
  } finally { await runtime.close(); }
});

it('a continuation can change the authorized target without creating another source', async () => {
  const { service } = conversationService(1);
  service.config.brain.answer.mockImplementationOnce(async (_agent, _history, _delta, signal) => {
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Interrupted', 'AbortError')), { once: true }));
    return { text: '', order: false };
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    const first = runtime.utterance('human', 'Ruby first').catch(() => {});
    await vi.waitFor(() => expect(service.config.brain.answer).toHaveBeenCalledOnce());
    await runtime.utterance('human', 'Goosey continue'); await first;
    expect(service.recordHuman).toHaveBeenCalledOnce();
    expect(service.reviseHuman.mock.calls[0]?.[3].id).toBe('goose');
    expect(service.config.brain.answer.mock.calls[1]?.[0].id).toBe('goose');
    expect(service.recordAnswer).toHaveBeenCalledOnce();
  } finally { await runtime.close(); }
});

it.each([2, 960])('commits before first capture (%d bytes), with independent later requests', async size => {
  const { service } = conversationService(1);
  service.speech.mockResolvedValue({ synthesize: async function* () { yield Buffer.alloc(size, 1); } } as any);
  service.config.brain.answer.mockImplementation(async () => ({ text: 'I will do it.', order: true }));
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  const capture = deferred<void>();
  state.audio.captureFrame.mockImplementationOnce(() => capture.promise);
  try {
    const first = runtime.utterance('human', 'Ruby first').catch(() => {});
    await vi.waitFor(() => expect(state.audio.captureFrame).toHaveBeenCalledOnce());
    expect(service.dispatch).toHaveBeenCalledOnce();
    expect(state.room.localParticipant.publishData.mock.calls.map(([bytes]: any[]) => JSON.parse(new TextDecoder().decode(bytes))).some(signal => signal.type === 'latency')).toBe(false);
    const second = runtime.utterance('human', 'continued');
    await second; capture.resolve(); await first;
    expect(service.recordHuman).toHaveBeenCalledTimes(2);
    expect(service.reviseHuman).not.toHaveBeenCalled();
    expect(service.dispatch).toHaveBeenCalledTimes(2);
    expect(service.recordAnswer).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});

it('inherits an opening target while authorization is still pending', async () => {
  const { service } = conversationService(1);
  const agents = deferred<typeof roster>();
  service.agents.mockImplementationOnce(() => agents.promise);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    const first = runtime.utterance('human', 'Goosey first');
    const second = runtime.utterance('human', 'continued');
    agents.resolve(roster); await Promise.all([first, second]);
    expect(service.recordHuman).toHaveBeenCalledOnce();
    expect(service.config.brain.answer).toHaveBeenCalledOnce();
    expect(service.config.brain.answer.mock.calls[0]?.[0].id).toBe('goose');
    expect(service.reviseHuman).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});

it('respects an avatar target change during a pre-audio continuation', async () => {
  const { service } = conversationService(1);
  service.config.brain.answer.mockImplementationOnce(async (_agent, _history, _delta, signal) => {
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Interrupted', 'AbortError')), { once: true }));
    return { text: '', order: false };
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    const first = runtime.utterance('human', 'Ruby first').catch(() => {});
    await vi.waitFor(() => expect(service.config.brain.answer).toHaveBeenCalledOnce());
    state.room.emit('data', new TextEncoder().encode(JSON.stringify({ type: 'target', agentId: 'goose' })), { identity: 'human' }, undefined, 'beeline.voice.v1');
    await new Promise(resolve => setImmediate(resolve));
    await runtime.utterance('human', 'continued'); await first;
    expect(service.config.brain.answer.mock.calls[1]?.[0].id).toBe('goose');
  } finally { await runtime.close(); }
});

it('dispatches an audible order before playback ends and keeps it across barge-in', async () => {
  const { service } = conversationService(1);
  service.config.brain.answer.mockImplementationOnce(async () => ({ text: 'I will do it.', order: true }));
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  const playback = deferred<void>(), dispatch = deferred<void>();
  service.dispatch.mockImplementationOnce(() => dispatch.promise);
  try {
    const first = runtime.utterance('human', 'Ruby build it').catch(() => {});
    await vi.waitFor(() => expect(service.dispatch).toHaveBeenCalledOnce());
    const second = runtime.utterance('human', 'Ruby another question');
    await second;
    expect(service.recordHuman).toHaveBeenCalledTimes(2);
    expect(service.reviseHuman).not.toHaveBeenCalled();
    dispatch.resolve(); await first;
    expect(service.dispatch).toHaveBeenCalledOnce();
    expect(service.recordAnswer).toHaveBeenCalledOnce();
  } finally { await runtime.close(); }
});

it('does not duplicate an audible answer when barge-in races its persistence', async () => {
  const { service } = conversationService(1);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  const persistence = deferred<void>();
  service.recordAnswer.mockImplementationOnce(() => persistence.promise);
  try {
    const first = runtime.utterance('human', 'Ruby first').catch(() => {});
    await vi.waitFor(() => expect(service.recordAnswer).toHaveBeenCalledOnce());
    const second = runtime.utterance('human', 'Ruby another');
    await second; persistence.resolve(); await first;
    expect(service.recordHuman).toHaveBeenCalledTimes(2);
    expect(service.recordAnswer).toHaveBeenCalledTimes(2);
  } finally { await runtime.close(); }
});

it('delivers external work even when acknowledgement produces no audio', async () => {
  const { service, speech } = conversationService(1);
  service.config.brain.answer.mockImplementation(async () => ({ text: 'I will do it.', order: true }));
  speech.synthesize.mockImplementation(async function* () {});
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    await runtime.utterance('human', 'Ruby build it');
    expect(service.dispatch).toHaveBeenCalledOnce();
    expect(service.recordAnswer).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});

it('Reproduction DELIVERY-2: dispatch retry reuses the accepted source without reclassifying or revising', async () => {
  const { service, speech } = conversationService(2);
  service.config.brain.answer.mockImplementationOnce(async () => ({ text: 'Checking.', order: true }));
  service.dispatch.mockRejectedValueOnce(new Error('commit acknowledgement lost'));
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    await expect(runtime.utterance('human', 'Ruby build it')).rejects.toThrow('commit acknowledgement lost');
    expect(speech.synthesize).not.toHaveBeenCalled();
    await runtime.utterance('human', 'try again');
    expect(service.dispatch.mock.calls).toEqual([['call', 'source', 'ruby'], ['call', 'source', 'ruby']]);
    expect(service.config.brain.answer).toHaveBeenCalledOnce();
    expect(service.recordHuman).toHaveBeenCalledOnce();
    expect(service.reviseHuman).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});

it.each([1200, 1500])('CONTINUATION-1: real service and phone read retain one source after a %dms pause', async pause => {
  const db = new PgliteDatabase(), live = new LiveHub();
  const human = 'a'.repeat(64), agent = 'b'.repeat(64);
  const workspace = '11111111-1111-4111-8111-111111111111', room = '22222222-2222-4222-8222-222222222222';
  const { service: fixture, speech } = conversationService(1);
  let receive!: (event: any) => void;
  fixture.config.stt.mockImplementation(async callback => { receive = callback; return { send() {}, close() {} }; });
  const release = deferred<void>();
  fixture.config.brain.answer.mockImplementationOnce(async (_agent, _history, onText, signal) => {
    onText('An unheard partial answer. ');
    await new Promise<void>((resolve, reject) => {
      release.promise.then(resolve, reject);
      signal.addEventListener('abort', () => reject(new DOMException('Interrupted', 'AbortError')), { once: true });
    });
    return { text: 'An unheard partial answer.', order: true };
  });
  fixture.config.brain.answer.mockImplementation(async () => ({ text: 'One complete reply.', order: false }));
  const voice = new RealVoiceService(db, live, { ...fixture.config, speech });
  try {
    await migrate(db);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Human','human'),($2,'agent','Ruby','ruby')`, [human, agent]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, human]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Continuation proof')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [room, workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`, [workspace, human, agent, room]);
    const joined = await voice.join(room, human);
    const runtime = await voice.ensureRuntime((await db.query<any>(`SELECT * FROM voice_calls WHERE id=$1`, [joined.call.id])).rows[0]);
    state.streams = [new ReadableStream()];
    state.room.emit('track', { kind: 1 }, {}, { identity: human });
    await vi.waitFor(() => expect(receive).toBeDefined());
    const event = (type: string, transcript: string, turn: number) => receive({ event: type, transcript, turn_index: turn, sequence_id: turn,
      words: transcript.split(' ').map((word, i) => ({ word, start: i * .2, end: (i + 1) * .2, confidence: .95 })) });
    event('EndOfTurn', 'Ruby I can talk for hours.', 0);
    await vi.waitFor(() => expect(fixture.config.brain.answer).toHaveBeenCalledOnce());
    expect(speech.synthesize).not.toHaveBeenCalled();
    await new Promise(resolve => setTimeout(resolve, pause));
    event('Update', 'That does not exist today.', 1);
    await vi.waitFor(() => expect(fixture.config.brain.answer.mock.calls[0]?.[3].aborted).toBe(true));
    await new Promise(resolve => setImmediate(resolve));
    expect((await db.query(`SELECT * FROM agent_commands WHERE room_id=$1`, [room])).rowCount).toBe(0);
    expect((await db.query(`SELECT * FROM messages WHERE room_id=$1 AND author_id=$2`, [room, agent])).rowCount).toBe(0);
    event('EndOfTurn', 'That does not exist today.', 1);
    event('EndOfTurn', 'That does not exist today.', 1);
    await vi.waitFor(() => expect(fixture.config.brain.answer).toHaveBeenCalledTimes(2));
    const phone = new PhoneService(db, 'http://proof');
    await vi.waitFor(async () => expect((await phone.readRoom(room, human))!.messages.filter(m => m.author.pubkey === agent)).toHaveLength(1));
    const view = (await phone.readRoom(room, human))!;
    expect(view.messages.filter(m => m.author.pubkey === human).map(m => m.text)).toEqual(['@ruby Ruby I can talk for hours. That does not exist today.']);
    expect(view.messages.filter(m => m.author.pubkey === agent).map(m => m.text)).toEqual(['One complete reply.']);
    expect(fixture.config.brain.answer).toHaveBeenCalledTimes(2);
    expect(speech.synthesize.mock.calls.map(call => call[0])).toEqual(['One complete reply.']);
    expect((await db.query(`SELECT * FROM agent_commands WHERE room_id=$1`, [room])).rowCount).toBe(0);
    const selected = (await voice.agents(room, human))[0]!;
    const call = (await db.query<any>(`SELECT runtime_owner FROM voice_calls WHERE id=$1`, [joined.call.id])).rows[0]!;
    const source = view.messages.find(m => m.author.pubkey === human)!.id;
    await expect(voice.reviseHuman(joined.call.id, room, human, selected, source, 'stale', 'old-lease')).rejects.toThrow('access denied');
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [room, human]);
    await expect(voice.reviseHuman(joined.call.id, room, human, selected, source, 'removed', call.runtime_owner)).rejects.toThrow('access denied');
    console.log(`CONTINUATION-1 pause=${pause}ms: phone read one source, one complete reply, two brain runs, no ordinary command; membership and lease refusals verified. Injected STT and provider/RTC doubles.`);
    release.resolve();
    expect(runtime).toBeDefined();
  } finally { await voice.close(); await db.close(); }
}, 30_000);
it('Reproduction MULTI-1: another human\'s laughter does not cancel the reply to the human who tagged an agent', async () => {
  const { service } = conversationService(2);
  const opened: ((event: any) => void)[] = [];
  service.config.stt.mockImplementation(async (onEvent: (event: any) => void) => {
    opened.push(onEvent);
    return { send: vi.fn(), close: vi.fn() };
  });
  const receivers = new Map<string, (event: any) => void>();
  let firstToken!: () => void;
  service.config.brain.answer.mockImplementation(async (_agent, _history, onText, signal: AbortSignal) => {
    // The model is still producing its first token when the other human talks.
    await new Promise<void>((resolve, reject) => {
      firstToken = resolve;
      signal.addEventListener('abort', () => reject(new DOMException('Interrupted', 'AbortError')), { once: true });
    });
    onText('I’m here. What do you need?');
    return { text: 'I’m here. What do you need?', order: false };
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  state.streams = [new ReadableStream(), new ReadableStream()];
  const words = (text: string) => text.split(' ').map((word, i) => ({ word, start: i * 0.2, end: (i + 1) * 0.2, confidence: 0.95 }));
  const say = (human: string, event: string, transcript: string, turn: number) =>
    receivers.get(human)!({ event, transcript, turn_index: turn, sequence_id: turn, words: words(transcript) });
  try {
    for (const human of ['starter', 'second']) {
      state.room.emit('track', { kind: 1 }, {}, { identity: human });
      await vi.waitFor(() => expect(opened).toHaveLength(receivers.size + 1));
      receivers.set(human, opened.at(-1)!);
    }
    say('second', 'EndOfTurn', 'Ruby are you there', 0);
    await vi.waitFor(() => expect(service.config.brain.answer).toHaveBeenCalledOnce());
    say('starter', 'Update', 'haha', 0);
    say('starter', 'EndOfTurn', 'haha', 0);
    firstToken();
    await vi.waitFor(() => expect(service.recordAnswer).toHaveBeenCalledWith('room', 'ruby', 'I’m here. What do you need?'));
    expect(service.config.brain.answer.mock.calls[0]?.[3].aborted).toBe(false);
    expect(service.recordHuman.mock.calls.map(call => [call[2], call[4]])).toEqual([['second', 'Ruby are you there']]);
  } finally { await runtime.close(); }
});

it('Demonstration MULTI-1: two humans in one call both get the agent reply, with no false offline notice', async () => {
  const db = new PgliteDatabase();
  const live = new LiveHub();
  const starter = 'a'.repeat(64), second = 'd'.repeat(64), agent = 'b'.repeat(64);
  const workspace = '11111111-1111-4111-8111-111111111111';
  const room = '22222222-2222-4222-8222-222222222222';
  const started = performance.now();
  const timeline: string[] = [];
  const note = (text: string) => timeline.push(`${(performance.now() - started).toFixed(1).padStart(7)}ms ${text}`);
  const config = conversationService(2).service.config;
  const opened: ((event: any) => void)[] = [];
  config.stt.mockImplementation(async (onEvent: (event: any) => void) => { opened.push(onEvent); return { send: vi.fn(), close: vi.fn() }; });
  const latency: { commit: number; brain: number }[] = [];
  let endOfTurn = 0;
  config.brain.answer.mockImplementation(async (_agent, history, onText, signal: AbortSignal) => {
    latency.push({ commit: 0, brain: performance.now() - endOfTurn });
    const text = history.at(-1)!.content.includes('Candy') ? 'I’m here, senpai!' : 'I’m here. What do you need?';
    note(`brain start for "${history.at(-1)!.content}"`);
    // Luna's first token takes about half a second; the other human talks meanwhile.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 300);
      signal.addEventListener('abort', () => { clearTimeout(timer); note('reply CANCELLED before its first token'); reject(new DOMException('Interrupted', 'AbortError')); }, { once: true });
    });
    onText(text); return { text, order: false };
  });
  const voice = new RealVoiceService(db, live, { ...config, speech: { synthesize: async function* () { yield new Uint8Array([200, 1]); } } });
  const presence = new ConnectionPresence(db, live, 500);
  const words = (text: string) => text.split(' ').map((word, i) => ({ word, start: i * 0.2, end: (i + 1) * 0.2, confidence: 0.95 }));
  try {
    await migrate(db);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Starter','starter'),($2,'human','Second','second'),($3,'agent','Candy','candy')`, [starter, second, agent]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, starter]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Multiparty proof')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'experiments')`, [room, workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member'),($1,$5,$2,'owner'),($1,$5,$3,'member'),($1,$5,$4,'member')`,
      [workspace, starter, second, agent, room]);
    await presence.announce(room, agent, { lifecycleId: 'helper-boot' });
    const joined = await voice.join(room, starter);
    await voice.join(room, second);
    const call = (await db.query<any>(`SELECT * FROM voice_calls WHERE id=$1`, [joined.call.id])).rows[0];
    const runtime = (await voice.ensureRuntime(call))!;
    state.streams = [new ReadableStream(), new ReadableStream()];
    const receivers = new Map<string, (event: any) => void>();
    for (const human of [starter, second]) {
      state.room.emit('track', { kind: 1 }, {}, { identity: human });
      await vi.waitFor(() => expect(opened).toHaveLength(receivers.size + 1));
      receivers.set(human, opened.at(-1)!);
    }
    const say = (human: string, event: string, transcript: string, turn: number) => {
      note(`${human === starter ? 'starter' : 'second '} STT ${event}: "${transcript}"`);
      if (event === 'EndOfTurn') endOfTurn = performance.now();
      receivers.get(human)!({ event, transcript, turn_index: turn, sequence_id: turn, words: words(transcript) });
    };
    const replies = async () => (await new PhoneService(db, 'http://proof').readRoom(room, starter))!.messages
      .filter(message => message.author.pubkey === agent && message.presentation === 'message').map(message => message.text);
    // The call starter tags the agent; the second human is mid-sentence.
    say(starter, 'EndOfTurn', 'Candy are you there', 0);
    await vi.waitFor(() => expect(config.brain.answer).toHaveBeenCalledTimes(1));
    say(second, 'Update', 'haha', 0);
    await vi.waitFor(async () => expect(await replies()).toEqual(['I’m here, senpai!']), { timeout: 3000 });
    note('reply visible to starter');
    // The second human tags the agent; the starter laughs over the first token.
    say(second, 'EndOfTurn', 'Candy can you hear me too', 1);
    await vi.waitFor(() => expect(config.brain.answer).toHaveBeenCalledTimes(2));
    say(starter, 'Update', 'mm hmm', 1);
    await vi.waitFor(async () => expect(await replies()).toHaveLength(2), { timeout: 3000 });
    note('reply visible to second human');
    await presence.observe(room);
    await new Promise(resolve => setTimeout(resolve, 900));
    const failed = (await db.query(`SELECT text FROM messages WHERE card_type='turn-failed'`)).rows;
    const status = (await db.query<{ body: { status: string } }>(`SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence'`, [agent])).rows[0]!.body.status;
    note(`after the pickup window: presence=${status}, offline notices=${failed.length}`);
    expect(failed).toEqual([]);
    expect(status).toBe('online');
    await runtime.close();
  } finally {
    console.log('Demonstration MULTI-1\n' + timeline.join('\n'));
    for (const [i, sample] of latency.entries()) console.log(`latency turn ${i}: end of speech -> brain start ${sample.brain.toFixed(1)} ms`);
    await presence.stop(); await voice.close(); await db.close();
  }
}, 30_000);

it('uses two words or 400 ms of non-backchannel speech as the interrupt threshold', () => {
  const event = (transcript: string, seconds = 0.2) => ({ event: 'Update' as const, transcript, turn_index: 0, sequence_id: 0,
    words: transcript.split(' ').map((word, i, all) => ({ word, start: i * seconds / all.length, end: (i + 1) * seconds / all.length, confidence: 0.95 })) });
  expect(voiceInterrupt(event('hold on'))).toBe(true);
  expect(voiceInterrupt(event('stop', 0.45))).toBe(true);
  expect(voiceInterrupt(event('stop', 0.25))).toBe(false);
  for (const noise of ['uh', 'hmm', 'mm hmm', 'yeah okay', 'uh-huh', 'haha', 'oh wow', 'hmm', 'um', 'uh'])
    expect(voiceInterrupt(event(noise, 1))).toBe(false);
});

function multiCall(humans = 2) {
  const { service, speech } = conversationService(humans);
  const roomData = (human: string, signal: object) => state.room.emit('data', new TextEncoder().encode(JSON.stringify(signal)),
    { identity: human }, undefined, 'beeline.voice.v1');
  const signals = (human?: string) => state.room.localParticipant.publishData.mock.calls
    .filter(([, options]: any[]) => !human || options.destination_identities?.includes(human))
    .map(([bytes]: any[]) => JSON.parse(new TextDecoder().decode(bytes)));
  const answered = () => service.config.brain.answer.mock.calls.map(call => call[0].id);
  return { service, speech, roomData, signals, answered };
}

it('1-human lock: the locked agent answers every unnamed turn until a spoken name or avatar tap switches it', async () => {
  const call = multiCall(1);
  const runtime = await VoiceRoomRuntime.connect(call.service as unknown as VoiceService, 'call', 'room');
  try {
    await runtime.utterance('human', 'What do you think?');
    await runtime.utterance('human', 'Gussie, your turn');
    await runtime.utterance('human', 'And then what?');
    call.roomData('human', { type: 'target', agentId: 'ruby', tap: true });
    await vi.waitFor(() => expect(call.service.access).toHaveBeenCalled());
    for (const text of ['Keep going', 'More please', 'One more']) await runtime.utterance('human', text);
    expect(call.answered()).toEqual(['ruby', 'goose', 'goose', 'ruby', 'ruby', 'ruby']);
    expect(call.signals('human').filter(signal => signal.type === 'unaddressed')).toEqual([]);
  } finally { await runtime.close(); }
});

it('multi-human: only named speech is answered; unnamed speech is dropped and the speaker\'s tip flashes', async () => {
  const call = multiCall(2);
  const runtime = await VoiceRoomRuntime.connect(call.service as unknown as VoiceService, 'call', 'room');
  try {
    expect(call.signals()).toContainEqual({ type: 'humans', count: 2 });
    await runtime.utterance('alex', 'Ruby, what is next?');
    await runtime.utterance('alex', 'And after that?');
    await runtime.utterance('sam', 'I think so too');
    await runtime.utterance('sam', 'hey Goosey, what about you?');
    expect(call.answered()).toEqual(['ruby', 'goose']);
    expect(call.service.recordHuman.mock.calls.map(c => [c[2], c[4]])).toEqual([['alex', 'Ruby, what is next?'], ['sam', 'hey Goosey, what about you?']]);
    expect(call.signals('alex').filter(signal => signal.type === 'unaddressed')).toHaveLength(1);
    expect(call.signals('sam').filter(signal => signal.type === 'unaddressed')).toHaveLength(1);
  } finally { await runtime.close(); }
});

it('multi-human: an avatar tap sends one unnamed turn from that person only, then clears', async () => {
  const call = multiCall(2);
  const runtime = await VoiceRoomRuntime.connect(call.service as unknown as VoiceService, 'call', 'room');
  try {
    call.roomData('alex', { type: 'target', agentId: 'goose', tap: true });
    await vi.waitFor(() => expect(call.service.access).toHaveBeenCalled());
    await new Promise(resolve => setImmediate(resolve));
    await runtime.utterance('sam', 'What do you think?');
    await runtime.utterance('alex', 'What do you think?');
    await runtime.utterance('alex', 'And after that?');
    expect(call.answered()).toEqual(['goose']);
    expect(call.service.recordHuman.mock.calls.map(c => [c[2], c[3].id])).toEqual([['alex', 'goose']]);
    expect(call.signals('alex').filter(signal => signal.type === 'unaddressed')).toHaveLength(1);
    // A spoken name beats a pending tap and still uses it up.
    call.roomData('alex', { type: 'target', agentId: 'goose', tap: true });
    await new Promise(resolve => setTimeout(resolve, 10));
    await runtime.utterance('alex', 'Ruby, you answer');
    await runtime.utterance('alex', 'Anyone?');
    expect(call.answered()).toEqual(['goose', 'ruby']);
  } finally { await runtime.close(); }
});

it('multi-human: any human interrupts a speaking agent with real speech, never with noise or backchannel', async () => {
  const call = multiCall(2);
  const receivers = new Map<string, (event: any) => void>();
  const opened: ((event: any) => void)[] = [];
  call.service.config.stt.mockImplementation(async (onEvent: (event: any) => void) => { opened.push(onEvent); return { send: vi.fn(), close: vi.fn() }; });
  const runtime = await VoiceRoomRuntime.connect(call.service as unknown as VoiceService, 'call', 'room');
  let release!: () => void;
  state.audio.waitForPlayout.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  state.streams = [new ReadableStream(), new ReadableStream()];
  const say = (human: string, transcript: string, turn: number, seconds = 0.2 * transcript.split(' ').length) =>
    receivers.get(human)!({ event: 'Update', transcript, turn_index: turn, sequence_id: turn,
      words: transcript.split(' ').map((word, i, all) => ({ word, start: i * seconds / all.length, end: (i + 1) * seconds / all.length, confidence: 0.95 })) });
  try {
    for (const human of ['alex', 'sam']) {
      state.room.emit('track', { kind: 1 }, {}, { identity: human });
      await vi.waitFor(() => expect(opened).toHaveLength(receivers.size + 1));
      receivers.set(human, opened.at(-1)!);
    }
    const reply = runtime.utterance('alex', 'Ruby, explain the plan');
    await vi.waitFor(() => expect(state.audio.waitForPlayout).toHaveBeenCalled());
    const cleared = state.audio.clearQueue.mock.calls.length;
    say('sam', 'uh', 0); say('sam', 'mm hmm', 1, 1); say('sam', 'yeah okay', 2); say('alex', 'hmm', 0, 0.6); say('sam', 'wait', 3, 0.25);
    expect(state.audio.clearQueue).toHaveBeenCalledTimes(cleared);
    expect(call.speech.synthesize.mock.calls[0]?.[2].aborted).toBe(false);
    // Sam did not ask the question; two real words still stop the agent.
    say('sam', 'hold on', 4);
    await vi.waitFor(() => expect(state.audio.clearQueue).toHaveBeenCalledTimes(cleared + 1));
    expect(call.speech.synthesize.mock.calls[0]?.[2].aborted).toBe(true);
    release(); await reply.catch(() => {});
  } finally { await runtime.close(); }
});

it.each([1,2])('multi-human-mode-2: interruption uses live membership despite the last announcement being %s', async announced => {
  const { service } = conversationService(announced);
  let receive!: (event: any) => void;
  service.config.stt.mockImplementation(async callback => { receive=callback; return { send() {}, close() {} }; });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService,'call','room');
  let release!: () => void;
  state.audio.waitForPlayout.mockImplementationOnce(() => new Promise<void>(resolve => { release=resolve; }));
  state.streams=[new ReadableStream()];
  try {
    state.room.emit('track',{kind:1},{},{identity:'human'});
    await vi.waitFor(() => expect(receive).toBeDefined());
    const reply=runtime.utterance('human','Ruby, explain the plan');
    await vi.waitFor(() => expect(state.audio.waitForPlayout).toHaveBeenCalled());
    const actual=announced===1?2:1;
    service.humanCount.mockResolvedValue(actual);
    const reads=service.humanCount.mock.calls.length;
    receive({event:'Update',transcript:'wait',turn_index:0,sequence_id:0,
      words:[{word:'wait',start:0,end:.25,confidence:.99}]});
    await vi.waitFor(() => expect(service.humanCount.mock.calls.length).toBeGreaterThan(reads));
    await new Promise(resolve => setImmediate(resolve));
    expect((runtime as any).speaking?.signal.aborted ?? true).toBe(actual===1);
    release(); await reply.catch(() => {});
  } finally { await runtime.close(); }
});

it('multi-human-mode-2: a join while agent access resolves applies group routing to that final', async () => {
  const { service }=conversationService(1);
  const runtime=await VoiceRoomRuntime.connect(service as unknown as VoiceService,'call','room');
  const agents=deferred<typeof roster>();
  service.agents.mockImplementationOnce(() => agents.promise);
  try {
    const final=runtime.utterance('human','What do you think?',performance.now(),true);
    service.humanCount.mockResolvedValue(2);
    agents.resolve(roster); await final;
    expect(service.recordHuman).not.toHaveBeenCalled();
    expect(service.config.brain.answer).not.toHaveBeenCalled();
    expect(state.room.localParticipant.publishData.mock.calls.some(([bytes]: any[]) =>
      JSON.parse(new TextDecoder().decode(bytes)).type==='unaddressed')).toBe(true);
  } finally { await runtime.close(); }
});

it('broadcasts the human count when people join or leave, so every panel switches between label and tips', async () => {
  const call = multiCall(1);
  const runtime = await VoiceRoomRuntime.connect(call.service as unknown as VoiceService, 'call', 'room');
  try {
    expect(call.signals().filter(signal => signal.type === 'humans')).toEqual([{ type: 'humans', count: 1 }]);
    call.service.humanCount.mockResolvedValue(2);
    state.room.emit('joined', { identity: 'sam' });
    await vi.waitFor(() => expect(call.signals().filter(signal => signal.type === 'humans').at(-1)).toEqual({ type: 'humans', count: 2 }));
  } finally { await runtime.close(); }
});

it('multi-human: a completed backchannel turn after an avatar tap neither interrupts nor uses up the tap', async () => {
  const call = multiCall(2);
  const opened: ((event: any) => void)[] = [];
  call.service.config.stt.mockImplementation(async (onEvent: (event: any) => void) => { opened.push(onEvent); return { send: vi.fn(), close: vi.fn() }; });
  const runtime = await VoiceRoomRuntime.connect(call.service as unknown as VoiceService, 'call', 'room');
  let release!: () => void;
  state.audio.waitForPlayout.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  state.streams = [new ReadableStream(), new ReadableStream()];
  const receivers = new Map<string, (event: any) => void>();
  const say = (human: string, event: string, transcript: string, turn: number, seconds: number) =>
    receivers.get(human)!({ event, transcript, turn_index: turn, sequence_id: turn,
      words: transcript.split(' ').map((word, i, all) => ({ word, start: i * seconds / all.length, end: (i + 1) * seconds / all.length, confidence: 0.95 })) });
  try {
    for (const human of ['alex', 'sam']) {
      state.room.emit('track', { kind: 1 }, {}, { identity: human });
      await vi.waitFor(() => expect(opened).toHaveLength(receivers.size + 1));
      receivers.set(human, opened.at(-1)!);
    }
    await vi.waitFor(() => expect(call.signals()).toContainEqual({ type: 'humans', count: 2 }));
    say('alex', 'EndOfTurn', 'Ruby, explain the plan', 0, 0.8);
    await vi.waitFor(() => expect(state.audio.waitForPlayout).toHaveBeenCalled());
    call.roomData('sam', { type: 'target', agentId: 'ruby', tap: true });
    await vi.waitFor(() => expect(call.service.access).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 10));
    say('sam', 'EndOfTurn', 'uh', 0, 0.2);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(call.speech.synthesize.mock.calls[0]?.[2].aborted).toBe(false);
    expect(call.service.config.brain.answer).toHaveBeenCalledOnce();
    expect(call.service.recordHuman).toHaveBeenCalledOnce();
    // Real speech from Sam still interrupts and uses the pending tap.
    say('sam', 'EndOfTurn', 'what about the budget', 1, 0.8);
    await vi.waitFor(() => expect(call.service.config.brain.answer).toHaveBeenCalledTimes(2));
    expect(call.speech.synthesize.mock.calls[0]?.[2].aborted).toBe(true);
    expect(call.service.recordHuman.mock.calls.map(c => [c[2], c[3].id])).toEqual([['alex', 'ruby'], ['sam', 'ruby']]);
    release();
  } finally { await runtime.close(); }
});

it('multi-human: a short name-only completed turn does not interrupt a speaking agent', async () => {
  const call = multiCall(2);
  const opened: ((event: any) => void)[] = [];
  call.service.config.stt.mockImplementation(async (onEvent: (event: any) => void) => { opened.push(onEvent); return { send: vi.fn(), close: vi.fn() }; });
  const runtime = await VoiceRoomRuntime.connect(call.service as unknown as VoiceService, 'call', 'room');
  let release!: () => void;
  state.audio.waitForPlayout.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  state.streams = [new ReadableStream(), new ReadableStream()];
  const receivers = new Map<string, (event: any) => void>();
  const say = (human: string, transcript: string, turn: number, seconds: number) =>
    receivers.get(human)!({ event: 'EndOfTurn', transcript, turn_index: turn, sequence_id: turn,
      words: transcript.split(' ').map((word, i, all) => ({ word, start: i * seconds / all.length, end: (i + 1) * seconds / all.length, confidence: 0.95 })) });
  try {
    for (const human of ['alex', 'sam']) {
      state.room.emit('track', { kind: 1 }, {}, { identity: human });
      await vi.waitFor(() => expect(opened).toHaveLength(receivers.size + 1));
      receivers.set(human, opened.at(-1)!);
    }
    await vi.waitFor(() => expect(call.signals()).toContainEqual({ type: 'humans', count: 2 }));
    say('alex', 'Ruby, explain the plan', 0, 0.8);
    await vi.waitFor(() => expect(state.audio.waitForPlayout).toHaveBeenCalled());
    say('sam', 'Ruby', 0, 0.2);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(call.speech.synthesize.mock.calls[0]?.[2].aborted).toBe(false);
    expect(call.service.config.brain.answer).toHaveBeenCalledOnce();
    // A named turn that meets the threshold still interrupts.
    say('sam', 'Goosey, your turn', 1, 0.6);
    await vi.waitFor(() => expect(call.service.config.brain.answer).toHaveBeenCalledTimes(2));
    expect(call.speech.synthesize.mock.calls[0]?.[2].aborted).toBe(true);
    expect(call.answered()).toEqual(['ruby', 'goose']);
    release();
  } finally { await runtime.close(); }
});


it('times one finished turn through streamed brain text, TTS bytes and accepted audio without logging speech', async () => {
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
  const { service } = conversationService(1);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    await runtime.utterance('human', 'Ruby this sentence is finished.');
    const timings = logs.mock.calls.filter(([label]) => label === '[voice-turn-timing]')
      .map(([, value]) => JSON.parse(value as string));
    expect(timings.map(row => row.stage)).toEqual([
      'flux_final', 'human_committed', 'brain_request', 'brain_first_token',
      'brain_complete', 'tts_request', 'tts_first_byte', 'first_audio_published', 'first_voiced_audio_published',
    ]);
    expect(new Set(timings.map(row => row.traceId)).size).toBe(1);
    expect(timings.every(row => row.callId === 'call' && row.elapsedMs >= 0)).toBe(true);
    expect(JSON.stringify(timings)).not.toContain('this sentence');
    expect(service.config.brain.answer).toHaveBeenCalledOnce();
    expect(service.recordHuman).toHaveBeenCalledOnce();
    expect(service.recordAnswer).toHaveBeenCalledOnce();
    console.log('LATENCY-AUDIT-1: one finished turn -> stage timings, one brain call, one source and one reply; no provider run.');
  } finally { await runtime.close(); logs.mockRestore(); }
});


it('Reproduction PARK-LEASE-1: a nonowner resume after 25 seconds keeps the parked RTC owner', async () => {
  const db = new PgliteDatabase(), live = new LiveHub();
  const human = 'a'.repeat(64), agent = 'b'.repeat(64);
  const workspace = '11111111-1111-4111-8111-111111111111', room = '22222222-2222-4222-8222-222222222222';
  const fixture = conversationService(1);
  const config = { ...fixture.service.config, speech: fixture.speech };
  const owner = new RealVoiceService(db, live, config), other = new RealVoiceService(db, live, config);
  const connect = vi.spyOn(VoiceRoomRuntime, 'connect');
  try {
    await migrate(db);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Human','human'),($2,'agent','Ruby','ruby')`, [human, agent]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, human]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Park lease proof')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [room, workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`, [workspace, human, agent, room]);
    const joined = await owner.join(room, human);
    const call = (await db.query<any>(`SELECT * FROM voice_calls WHERE id=$1`, [joined.call.id])).rows[0];
    const runtime = (await owner.ensureRuntime(call))!;
    state.room.remoteParticipants.clear();
    state.room.remoteParticipants.set(human, { identity: human, trackPublications: new Map() });
    const retainedRoom = state.room;
    const resumed = vi.spyOn(runtime, 'resume');
    const source = await owner.recordHuman(joined.call.id, room, human, (await owner.agents(room, human))[0]!, 'Work until the report is ready');
    await owner.dispatch(joined.call.id, source, agent);
    expect(await owner.idle(joined.call.id, human, joined.sessionId)).toEqual({ state: 'ready' });
    // Real PostgreSQL time advances beyond the original runtime lease, with no audio or reads.
    await new Promise(resolve => setTimeout(resolve, 25_000));
    await other.resume(joined.call.id, human, joined.sessionId);
    expect((await db.query(`SELECT runtime_owner FROM voice_calls WHERE id=$1`, [joined.call.id])).rows[0]?.runtime_owner).toBe(call.runtime_owner);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(runtime.isClosed).toBe(false);
    retainedRoom.emit('data', new TextEncoder().encode(JSON.stringify({ type: 'resume', sessionId: joined.sessionId })),
      { identity: human }, undefined, 'beeline.voice.v1');
    await vi.waitFor(() => expect(resumed).toHaveBeenCalledWith(human));
    await resumed.mock.results[0]!.value;
    expect(state.room).toBe(retainedRoom);
    await owner.leave(joined.call.id, human);
    console.log('PARK-LEASE-1: 25-second park, nonowner HTTP resume, unchanged runtime_owner, one RTC connect; RTC/provider doubles, real Pglite service path.');
  } finally {
    connect.mockRestore(); await other.close(); await owner.close(); await db.close();
  }
}, 40_000);

it.each(['quiet','pending','outside'])('call-wide-end-3: %s work uses one 60-second end for every human', async scenario => {
  const db = new PgliteDatabase(), live = new LiveHub();
  const human = 'a'.repeat(64), agent = 'b'.repeat(64);
  const workspace = '11111111-1111-4111-8111-111111111111', room = '22222222-2222-4222-8222-222222222222';
  const fixture = conversationService(1);
  const config = { ...fixture.service.config, speech: fixture.speech };
  const owner = new RealVoiceService(db, live, config);

  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  try {
    await migrate(db);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Human','human'),($2,'agent','Ruby','ruby')`, [human, agent]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, human]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Call end proof')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [room, workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`, [workspace, human, agent, room]);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const timer = vi.spyOn(globalThis, 'setInterval');
    const joined = await owner.join(room, human);
    const call = (await db.query<any>(`SELECT * FROM voice_calls WHERE id=$1`, [joined.call.id])).rows[0];
    const runtime = (await owner.ensureRuntime(call))!;
    state.room.remoteParticipants.clear();
    state.room.remoteParticipants.set(human, { identity: human, trackPublications: new Map() });
    const retainedRoom = state.room;
    const phone = new PhoneService(db, 'http://proof');
    const tick = timer.mock.calls.find(([callback, delay]) => delay === 1000 && String(callback).includes('checkInactivity'))![0] as () => Promise<void>;
    timer.mockRestore();
    let source: string | undefined;
    if (scenario !== 'quiet') {
      source = await owner.recordHuman(joined.call.id,room,human,(await owner.agents(room,human))[0]!, 'Work');
      if (scenario === 'outside') await db.transaction(tx => routeHumanMessage(tx,source!));
      else await owner.dispatch(joined.call.id,source,agent);
    }
    retainedRoom.localParticipant.publishData.mockClear();
    for (clock = 5000; clock < 60_000; clock += 5000) await tick();
    expect((await db.query(`SELECT ended_at FROM voice_calls WHERE id=$1`, [call.id])).rows[0]?.ended_at).toBeNull();
    expect(retainedRoom.localParticipant.publishData.mock.calls.map(([bytes]: any) => JSON.parse(new TextDecoder().decode(bytes))).some((event: any) => event.type === 'ending' && event.deadline !== null)).toBe(scenario !== 'pending');
    await tick();
    if (scenario === 'pending') {
      for (clock=65_000;clock<=120_000;clock+=5000) await tick();
      expect(await owner.current(room,human)).not.toBeNull();
      await db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE source_message_id=$1`,[source]);
      clock=125_000; await tick();
      for (clock=130_000;clock<185_000;clock+=5000) await tick();
      expect(await owner.current(room,human)).not.toBeNull();
      await tick();
    }
    expect((await db.query(`SELECT ended_at FROM voice_calls WHERE id=$1`, [call.id])).rows[0]?.ended_at).not.toBeNull();
    expect(await owner.current(room, human)).toBeNull();
    const card = (await phone.readRoom(room, human))?.messages.find(m => m.voiceCall);
    expect(card?.text).toMatch(/^Voice call ended ·/);
    expect(card?.presentation).toBe('system');
    expect(runtime.isClosed).toBe(true);
    console.log('call-wide-end-3:',scenario,'-> ended once after a full quiet window; phone card ended');
  } finally {
    vi.restoreAllMocks(); await owner.close(); vi.useRealTimers(); await db.close();
  }
}, 30_000);

it('call-wide-end-3: completion between quiet checks restarts the full window', async () => {
  let clock=0;
  const now=vi.spyOn(performance,'now').mockImplementation(()=>clock);
  const intervals=vi.spyOn(globalThis,'setInterval');
  const {service}=conversationService(1);
  const runtime=await VoiceRoomRuntime.connect(service as unknown as VoiceService,'call','room');
  const tick=intervals.mock.calls.find(([callback,delay])=>delay===1000 && String(callback).includes('checkInactivity'))![0] as ()=>Promise<void>;
  intervals.mockRestore();
  try {
    clock=60_000;
    service.callWorkState.mockResolvedValue({pending:false,finishedAt:Date.now()-1000});
    await tick(); expect(service.endInactive).not.toHaveBeenCalled();
    clock=118_000; await tick(); expect(service.endInactive).not.toHaveBeenCalled();
    clock=120_000; await tick(); expect(service.endInactive).toHaveBeenCalledOnce();
  } finally { await runtime.close();now.mockRestore(); }
});

it('call-wide-end-3: stalled TTS without new playback cannot hold the call open', async () => {
  let clock=0, release!:()=>void;
  const now=vi.spyOn(performance,'now').mockImplementation(()=>clock);
  const intervals=vi.spyOn(globalThis,'setInterval');
  const {service,speech}=conversationService(1);
  const held=new Promise<void>(resolve=>{release=resolve;});
  speech.synthesize.mockImplementation(async function*(){yield new Uint8Array(960).fill(5);await held;});
  const runtime=await VoiceRoomRuntime.connect(service as unknown as VoiceService,'call','room');
  const tick=intervals.mock.calls.find(([callback,delay])=>delay===1000 && String(callback).includes('checkInactivity'))![0] as ()=>Promise<void>;
  intervals.mockRestore();
  const reply=runtime.utterance('human','Ruby, explain this');
  try {
    await vi.waitFor(()=>expect(state.audio.captureFrame).toHaveBeenCalled());
    clock=60_001;await tick();expect(service.endInactive).toHaveBeenCalledOnce();
  } finally {release();await reply;await runtime.close();now.mockRestore();}
});

it('warns after 45 seconds and cancels the deadline on human speech or call work', async () => {
  let clock=0;
  const now=vi.spyOn(performance,'now').mockImplementation(()=>clock);
  const intervals=vi.spyOn(globalThis,'setInterval');
  const {service}=conversationService(2);
  const runtime=await VoiceRoomRuntime.connect(service as unknown as VoiceService,'call','room');
  const tick=intervals.mock.calls.find(([callback,delay])=>delay===1000 && String(callback).includes('checkInactivity'))![0] as ()=>Promise<void>;
  intervals.mockRestore();
  const events=()=>state.room.localParticipant.publishData.mock.calls.map(([bytes]: any)=>JSON.parse(new TextDecoder().decode(bytes))).filter((event: any)=>event.type==='ending');
  state.room.localParticipant.publishData.mockClear();
  try {
    clock=44_000;await tick();expect(events()).toHaveLength(0);
    clock=45_000;await tick();expect(events().at(-1).deadline-events().at(-1).serverNow).toBeCloseTo(15_000,-1);
    await runtime.utterance('human','Sam, how did it go?');expect(events().at(-1).deadline).toBeNull();
    clock=90_000;await tick();expect(events().at(-1).deadline).not.toBeNull();
    service.callWorkState.mockResolvedValue({pending:true,finishedAt:0});
    await tick();expect(events().at(-1).deadline).toBeNull();
    clock=160_000;await tick();expect(service.endInactive).not.toHaveBeenCalled();
  } finally {await runtime.close();now.mockRestore();}
});

it('plays one short warning tone at ten seconds left without postponing the end', async () => {
  let clock = 0;
  const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const { service } = conversationService(2);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  const tick = () => (runtime as any).checkInactivity();
  try {
    clock = 49_000; await tick(); expect(state.audio.captureFrame).not.toHaveBeenCalled();
    clock = 50_000; await tick(); expect(state.audio.captureFrame).toHaveBeenCalledOnce();
    clock = 51_000; await tick(); expect(state.audio.captureFrame).toHaveBeenCalledOnce();
    clock = 60_000; await tick(); expect(service.endInactive).toHaveBeenCalledOnce();
    service.callWorkState.mockResolvedValue({pending:false,finishedAt:Date.now()});
    clock = 61_000; await tick();
    clock = 112_000; await tick(); expect(state.audio.captureFrame).toHaveBeenCalledTimes(2);
  } finally { await runtime.close(); now.mockRestore(); }
});



it('Reproduction VOICE-IDS-7: the synthesis path never receives a leaked ID when the cap flushes mid-clause', async () => {
  const longWord = 'w'.repeat(250);
  const cases = [
    { answer: 'Note (' + 'word '.repeat(36) + 'a' + '1'.repeat(39) + ').', leak: '111' },
    // An ID longer than the cap with no whitespace inside it.
    { answer: 'Bug (' + 'a' + '1'.repeat(250) + ').', leak: '111' },
    // A plain word longer than the cap must stay whole, not be sliced.
    { answer: 'Note (' + longWord + ').', keep: longWord },
  ];
  for (const { answer, leak, keep } of cases) {
    const agent = { id: 'agent', name: 'Jellybean', handle: 'jellybean', voice: 'warm' };
    const spoken: string[] = [];
    const service = { workspaceId: vi.fn(async () => 'human'), endWorkspaceCalls: vi.fn(async () => {}), callWorkState: vi.fn(async () => ({ pending: false, finishedAt: 0 })), endInactive: vi.fn(async () => false), budget: { read: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), record: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), limitMs: 3600000 }, owner: 'owner', config: { url: 'ws://local', apiKey: 'devkey', apiSecret: 'secret',
      brain: { answer: async (_agent: unknown, _history: unknown, delta: (text: string) => void) => {
        for (const character of answer) delta(character);
        return { text: answer };
      } } }, agents: vi.fn(async () => [agent]), humanCount: vi.fn(async () => 1),
      speech: async () => ({ async *synthesize(text: string) { spoken.push(text); } }),
      recordHuman: vi.fn(async () => 'source'), recordAnswer: vi.fn(async () => {}),
      db: { query: vi.fn(async () => ({ rowCount: 1, rows: [] })) },
      access: vi.fn(async () => {}), leave: vi.fn(async () => {}), runtimeClosed: vi.fn() } as unknown as VoiceService;
    const runtime = await VoiceRoomRuntime.connect(service, 'call', 'room');
    try {
      await runtime.utterance('human', 'Jellybean, hello');
      if (keep) {
        // The long token reaches synthesis whole inside a single phrase.
        expect(spoken.some((text) => text.includes(keep))).toBe(true);
      } else {
        // The cap splits the parenthetical, but the ID token stays whole and is dropped.
        expect(spoken.join('')).toBe(markdownToSpeech(answer));
        expect(spoken.join('')).not.toContain(leak!);
      }
      console.log('VOICE-IDS-7 synthesis:', spoken);
    } finally { await runtime.close(); }
  }
});


it('keeps first-audio delivery independent of an in-flight accounting checkpoint', async () => {
  const { service } = conversationService(2);
  let release!: () => void;
  service.budget.record.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({
    remainingMs: 3599000, resetAt: Date.now() + 86400000, timeZone: 'UTC',
  }); }));
  const input = vi.fn();
  service.config.stt.mockResolvedValue({ send: input, close: vi.fn() });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  let frames!: ReadableStreamDefaultController<any>;
  state.streams = [new ReadableStream({ start(controller) { frames = controller; } })];
  const timings = () => state.room.localParticipant.publishData.mock.calls
    .map(([bytes]: any[]) => JSON.parse(new TextDecoder().decode(bytes)))
    .filter((data: any) => data.type === 'latency').map((data: any) => data.firstAudioMs as number);
  try {
    await runtime.utterance('human', 'Ruby, baseline timing');
    const before = timings().at(-1)!;
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(service.config.stt).toHaveBeenCalled());
    frames.enqueue({ data: new Int16Array(320) });
    await vi.waitFor(() => expect(release).toBeDefined());
    const sent = input.mock.calls.length;
    frames.enqueue({ data: new Int16Array(320) });
    await vi.waitFor(() => expect(input.mock.calls.length).toBeGreaterThan(sent));
    await runtime.utterance('human', 'Ruby, timing during blocked checkpoint');
    const after = timings().at(-1)!;
    expect(state.audio.captureFrame).toHaveBeenCalled();
    expect(after).toBeLessThan(100);
    console.log(`VOICE-BUDGET-LATENCY before=${before.toFixed(3)}ms after=${after.toFixed(3)}ms; checkpoint still unresolved at first audio; controlled providers and RTC.`);
  } finally { release?.(); await runtime.close(); }
});

it('broadcasts the shared countdown to every participant and ends the workspace at zero', async () => {
  const { service } = conversationService(2);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    const budget = { remainingMs: 120_000, resetAt: Date.now() + 86_400_000, timeZone: 'UTC' };
    service.budget.record.mockResolvedValueOnce(budget);
    await (runtime as any).meter.flush();
    await vi.waitFor(() => {
      const warning = state.room.localParticipant.publishData.mock.calls.find(([bytes]: any[]) =>
        JSON.parse(new TextDecoder().decode(bytes)).type === 'budget');
      expect(warning).toBeDefined();
      expect(warning![1].destination_identities).toBeUndefined();
      expect(JSON.parse(new TextDecoder().decode(warning![0]))).toEqual({ type: 'budget', budget });
    });
    service.budget.read.mockResolvedValue({ ...budget, remainingMs: 0 });
    service.budget.record.mockResolvedValueOnce({ ...budget, remainingMs: 0 });
    await (runtime as any).meter.flush();
    await vi.waitFor(() => expect(service.endWorkspaceCalls).toHaveBeenCalledWith('human'));
  } finally { await runtime.close(); }
});

it('Reproduction VOICE-BOUND-2: two call audio pumps retain independent one-second bounds and one daily budget', async () => {
  const db = new PgliteDatabase();
  const { VoiceBudgetStore } = await import('./voice-budget.js');
  await db.query(`CREATE TABLE voice_calls(id text PRIMARY KEY,runtime_owner text,runtime_until timestamptz, room_id text);
    CREATE TABLE rooms(id text,workspace_id text);
    INSERT INTO rooms VALUES('room','human');
    CREATE TABLE voice_participants(call_id text,identity_id text);
    CREATE TABLE voice_workspace_usage(workspace_id text,call_id text,day_start bigint,audio int8multirange DEFAULT '{}',PRIMARY KEY(workspace_id,call_id,day_start));
    INSERT INTO voice_calls VALUES('a','owner','2099-01-01','room'),('b','owner','2099-01-01','room');
    INSERT INTO voice_participants VALUES('a','human'),('b','human');`);
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const stores = [new VoiceBudgetStore(db), new VoiceBudgetStore(db)];
  const runtimes: VoiceRoomRuntime[] = [];
  const frames: ReadableStreamDefaultController<any>[] = [];
  const sends = [vi.fn(), vi.fn()];
  const failures: ReturnType<typeof vi.spyOn>[] = [];
  // Keep intervals frozen while exercising actual SDK-reader -> STT.send pumps.
  const until = async (condition: () => boolean) => {
    for (let i = 0; !condition(); i++) {
      if (i === 2000) throw new Error('Audio pump did not become ready');
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  };
  try {
    for (let i = 0; i < 2; i++) {
      const { service } = conversationService(2);
      service.config.stt.mockResolvedValue({ send: sends[i]!, close() {} });
      const runtime = await VoiceRoomRuntime.connect({ ...service, budget: stores[i] } as unknown as VoiceService, i ? 'b' : 'a', 'room');
      runtimes.push(runtime);
      state.streams = [new ReadableStream({ start(controller) { frames.push(controller); } })];
      state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
      await until(() => !!(runtime as any).inputs.get('human')?.stt);
      failures.push(vi.spyOn(stores[i]!, 'record').mockRejectedValue(new Error('database outage')));
    }
    for (let i = 0; i < 2; i++) {
      now += 500; frames[i]!.enqueue({ data: new Int16Array(8000) });
      await until(() => sends[i]!.mock.calls.length === 1);
      await expect((runtimes[i] as any).meter.flush()).rejects.toThrow('outage');
    }
    for (let i = 0; i < 2; i++) {
      now += 1000; frames[i]!.enqueue({ data: new Int16Array(16000) });
      await until(() => sends[i]!.mock.calls.length === 2);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    const forwardedMs = sends.flatMap(send => send.mock.calls).reduce((sum, [pcm]) => sum + pcm.length / 16, 0);
    expect(forwardedMs).toBe(2000);
    expect(sends.map(send => send.mock.calls.reduce((sum, [pcm]) => sum + pcm.length / 16, 0))).toEqual([1000, 1000]);
    // A process death restores only committed state: this deliberately accepts
    // one second per stream, as specified in brief revision 5.
    const snapshot = PgliteDatabase.fromSnapshot(await db.snapshot());
    try {
      expect((await new VoiceBudgetStore(snapshot).read('human')).remainingMs).toBe(3600000);
    } finally { await snapshot.close(); }
    now += 1000;
    for (const stream of frames) stream.enqueue({ data: new Int16Array(16000) });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(sends.map(send => send.mock.calls.length)).toEqual([2, 2]);
    failures[0]!.mockRestore();
    await (runtimes[0] as any).meter.flush();
    now += 20;
    for (const stream of frames) stream.enqueue({ data: new Int16Array(320) });
    await until(() => sends[0]!.mock.calls.length === 3);
    expect(sends[1]!.mock.calls.length).toBe(2);
    // Only the recovered stream resumes; the other keeps its own failed batch.
    failures[1]!.mockRestore();
    await (runtimes[1] as any).meter.flush();
    expect((await stores[0]!.read('human')).remainingMs).toBe(3598000);
    expect((await stores[1]!.read('human')).remainingMs).toBe(3598000);

    console.log(`VOICE-BOUND-2 service path: two RTC readers -> two independent runtimes/stores -> STT.send=${forwardedMs}ms total, 1000ms per stream; snapshot loss=2000ms; both stop, one recovers independently, and both stores observe the same 2000ms durable daily usage.`);
  } finally {
    failures.forEach(spy => spy.mockRestore());
    for (const runtime of runtimes) await runtime.close();
    vi.useRealTimers(); clock.mockRestore(); await db.close();
  }
});

it('CALL-ERROR-1: a database access outage retains the caller; confirmed denial removes them', async () => {
  const { service } = conversationService(1);
  const leave = vi.fn(async () => {});
  const runtime = await VoiceRoomRuntime.connect({ ...service, leave } as unknown as VoiceService, 'call', 'room');
  try {
    await vi.waitFor(() => expect((runtime as any).touching).toBe(false));
    service.access.mockClear();
    service.access.mockRejectedValueOnce(Object.assign(new Error('network interrupted'), { code: 'ECONNRESET' }));
    await (runtime as any).heartbeat();
    expect(leave).not.toHaveBeenCalled(); expect(runtime.isClosed).toBe(false);
    expect(service.access).toHaveBeenCalledTimes(2);
    await runtime.utterance('human', 'Ruby hello');
    expect(service.recordAnswer).toHaveBeenCalledOnce();
    service.access.mockRejectedValueOnce(new Error('voice call access denied'));
    await (runtime as any).heartbeat(); expect(leave).toHaveBeenCalledOnce();
  } finally { await runtime.close(); }
});

it('CALL-ERROR-1: failed error publication cannot escape the supervisor; the next turn speaks', async () => {
  const { service, speech } = conversationService(1);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    state.room.localParticipant.publishData.mockRejectedValueOnce(new Error('signal outage'));
    (runtime as any).task(async () => { throw new Error('provider failure'); });
    await new Promise(resolve => setImmediate(resolve));
    await runtime.utterance('human', 'Ruby hello');
    expect(runtime.isClosed).toBe(false); expect(speech.synthesize).toHaveBeenCalled();
    expect((runtime as any).speaking).toBeUndefined();
  } finally { await runtime.close(); }
});

it('CALL-ERROR-1: cleanup continues after a failing meter and disconnect', async () => {
  const { service } = conversationService(1);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  const audioClose = vi.spyOn(state.audio, 'close');
  vi.spyOn((runtime as any).meter, 'close').mockRejectedValue(new Error('database unavailable'));
  vi.spyOn(state.room, 'disconnect').mockRejectedValue(new Error('transport unavailable'));
  await runtime.close();
  expect(audioClose).toHaveBeenCalledOnce(); expect(service.runtimeClosed).toHaveBeenCalledOnce();
});

it('CALL-ERROR-1: exhausted lease retries retain valid ownership, then expiry closes only the worker', async () => {
  const { service } = conversationService(1);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  await vi.waitFor(() => expect((runtime as any).touching).toBe(false));
  vi.useFakeTimers();
  try {
    service.db.query.mockRejectedValue(Object.assign(new Error('database outage'), { code: '08006' }));
    const failed = expect((runtime as any).renewLease()).rejects.toThrow('database outage');
    await vi.advanceTimersByTimeAsync(2000); await failed;
    expect(runtime.isClosed).toBe(false);
    (runtime as any).leaseValidUntil = performance.now();
    (runtime as any).armLeaseExpiry();
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.isClosed).toBe(true);
    expect(service.runtimeClosed).toHaveBeenCalledOnce();
    expect(service.endInactive).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); await runtime.close(); }
});

it('Reproduction DELIVERY-2: commits external work even when acknowledgement synthesis fails', async () => {
  const { service, speech } = conversationService(2);
  service.config.brain.answer.mockImplementation(async () => ({ text: 'Checking.', order: true }));
  speech.synthesize.mockImplementation(async function* () { throw new Error('TTS unavailable'); });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    await expect(runtime.utterance('human', 'Ruby check my latest report')).rejects.toThrow('Request delivered; voice reply unavailable');
    expect(service.dispatch).toHaveBeenCalledOnce();
  } finally { await runtime.close(); }
});

it('Reproduction DELIVERY-2: name pause, expiry, other-human isolation and retargeting', async () => {
  let clock = performance.now();
  const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const { service } = conversationService(2);
  service.config.brain.answer.mockImplementation(async () => ({ text: 'Checking.', order: true }));
  service.db.query.mockImplementation(async (sql: string, parameters?: any[]) => ({ rowCount: 1,
    rows: sql.includes('identity_id=ANY') ? (parameters?.[1] ?? []).map((identity_id: string) => ({identity_id})) : [] }));
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    await runtime.utterance('human', 'Ruby');
    expect(service.recordHuman).not.toHaveBeenCalled();
    expect(service.config.brain.answer).not.toHaveBeenCalled();
    clock += 2000;
    await runtime.utterance('second', 'check my latest report');
    expect(service.dispatch).not.toHaveBeenCalled();
    await runtime.utterance('human', 'check my latest report');
    expect(service.dispatch.mock.calls.map(call => call[2])).toEqual(['ruby']);
    await runtime.utterance('human', 'build another');
    expect(service.dispatch).toHaveBeenCalledOnce();
    await runtime.utterance('human', 'Ruby');
    clock += 3001;
    await runtime.utterance('human', 'check my latest report');
    expect(service.dispatch).toHaveBeenCalledOnce();
    await runtime.utterance('human', 'Ruby');
    await runtime.utterance('human', 'Goosey check my latest report');
    expect(service.dispatch.mock.calls.map(call => call[2])).toEqual(['ruby', 'goose']);
    await runtime.utterance('human', 'Ruby');
    runtime.participantLeft('human');
    await runtime.utterance('human', 'check my latest report');
    expect(service.dispatch).toHaveBeenCalledTimes(2);
  } finally { await runtime.close(); now.mockRestore(); }
});

it('shortens only spoken reports, preserving sentence boundaries and the source text', () => {
  const text = 'The build is ready.\n\n' + 'Full details remain here. '.repeat(30);
  expect(spokenReport(text)).toBe('The build is ready. The rest is in the chat.');
  expect(text).toContain('Full details remain here.');
  expect(spokenReport('x'.repeat(2000))).toBe('The rest is in the chat.');
  expect(spokenReport('短い文。' + '長い'.repeat(100))).toBe('短い文。 The rest is in the chat.');
  expect(spokenReport('Short sentence. ' + 'more '.repeat(80) + '.')).toBe('Short sentence. The rest is in the chat.');
});

it.each(['stay', 'turn', 'leave'] as const)('reports wait for human quiet and recheck the caller: %s', async action => {
  const { service, speech } = conversationService(2);
  let claimed = false;
  const report = { source_message_id: 'order', id: 'report', text: 'Done.\n\n' + 'Details. '.repeat(100), agent_id: 'ruby', human_id: 'human' };
  service.db.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT DISTINCT ON')) return { rowCount: claimed ? 0 : 1, rows: claimed ? [] : [report] };
    if (sql.startsWith('UPDATE voice_orders')) claimed = true;
    return { rowCount: 1, rows: [] };
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    (runtime as any).targets.set('human', 'ruby');
    (runtime as any).humanSpeaking.add('human');
    await runtime.refresh();
    await new Promise(resolve => setImmediate(resolve));
    expect(speech.synthesize).not.toHaveBeenCalled();
    if (action === 'turn') (runtime as any).targets.set('human', 'goose');
    if (action === 'leave') { state.room.remoteParticipants.delete('human'); runtime.participantLeft('human'); }
    (runtime as any).humanQuiet('human');
    await (runtime as any).reportQueue;
    expect(claimed).toBe(true);
    expect(speech.synthesize).toHaveBeenCalledTimes(action === 'stay' ? 1 : 0);
    if (action === 'stay') expect(speech.synthesize.mock.calls[0]![0]).toBe('Done. The rest is in the chat.');
    await runtime.refresh(); await (runtime as any).reportQueue;
    expect(speech.synthesize).toHaveBeenCalledTimes(action === 'stay' ? 1 : 0);
  } finally { await runtime.close(); }
});

it.each(['fast', 'failed', 'slow'] as const)('call search %s reaches audio or exactly one ordinary order', async mode => {
  const { OpenRouterVoiceBrain } = await import('./voice-providers.js');
  const { service, speech } = conversationService(1);
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{
      function: { name: 'search_web', arguments: JSON.stringify({ query: 'Japan', spoken_line: 'Let me look.' }) },
    }] } }] }) + '\n\n'))
    .mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"Tokyo."}}]}\n\n'));
  const search = vi.fn(async () => {
    if (mode === 'failed') throw new Error('Search unavailable');
    if (mode === 'slow') return new Promise<string>(() => {});
    return 'Tokyo, Japan.';
  });
  const configured = { ...service, search, config: { ...service.config, brain: new OpenRouterVoiceBrain('test', fetcher) } };
  const runtime = await VoiceRoomRuntime.connect(configured as unknown as VoiceService, 'call', 'room');
  try {
    await runtime.utterance('human', 'Ruby search Japan');
    const spoken = speech.synthesize.mock.calls.map(call => call[0]).join(' ');
    expect(spoken).toContain('Let me look.');
    expect(service.dispatch).toHaveBeenCalledTimes(mode === 'fast' ? 0 : 1);
    expect(fetcher).toHaveBeenCalledTimes(mode === 'fast' ? 2 : 1);
    if (mode === 'fast') expect(spoken).toContain('Tokyo.');
    else expect(spoken).not.toMatch(/error|unavailable|timed out/i);
  } finally { await runtime.close(); }
});

it('Reproduction AURA-413-1: a long report plays completely through provider requests and RTC frames', async () => {
  const text = 'The report is complete and every detail should be heard. '.repeat(100).trim();
  const requests: string[] = [];
  const wire: Buffer[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const { text: part } = JSON.parse(init!.body as string);
    requests.push(part);
    if (part.length > 2000) return new Response(null, { status: 413 });
    // Odd provider boundaries must survive both response reads and request boundaries.
    const pcm = Buffer.alloc(part.length * 2 + 1, requests.length);
    wire.push(pcm);
    return new Response(new ReadableStream({ start(c) {
      c.enqueue(pcm.subarray(0, 3)); c.enqueue(pcm.subarray(3)); c.close();
    } }));
  });
  const { service } = conversationService(1);
  const speech = new AuraSpeech('test', 'account', fetcher);
  const runtime = await VoiceRoomRuntime.connect({ ...service, agents: async () => [{ ...roster[0], voice: 'luna' }], speech: async () => speech } as unknown as VoiceService, 'call', 'room');
  try {
    await (runtime as any).play(text, { ...roster[0], voice: 'luna' }, new AbortController().signal);
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every(part => part.length <= 1800)).toBe(true);
    expect(requests.join('')).toBe(text);
    const frames = state.audio.captureFrame.mock.calls.map(([frame]: any[]) => Buffer.from(frame.data.buffer));
    const expected = Buffer.concat(wire);
    expect(Buffer.concat(frames)).toEqual(expected.subarray(0, expected.length - expected.length % 2));
    expect(frames.slice(0, -1).every((frame: Buffer) => frame.length === 960)).toBe(true);
    expect(state.audio.waitForPlayout).toHaveBeenCalledOnce();
    console.log('AURA-413-1:', text.length, 'characters,', requests.length, 'requests,', frames.length, 'ordered PCM frames');
  } finally { await runtime.close(); }
});
