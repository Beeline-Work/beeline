import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { VoiceService } from './voice-service.js';

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
import { VoiceService as RealVoiceService } from './voice-service.js';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { LiveHub } from './live.js';
import { claimAgentCommand } from './agent-command.js';
import { DaemonService } from './daemon-service.js';
import { PhoneService } from './phone-service.js';

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
    access: vi.fn(async () => {}), reviseHuman: vi.fn(async () => {}), recordHuman: vi.fn(async () => 'source'), recordAnswer: vi.fn(async () => {}),
    dispatch: vi.fn(async () => {}), db: { query: vi.fn(async () => ({ rowCount: 1, rows: [] })) }, runtimeClosed: vi.fn(),
  };
  return { service, speech };
}

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
    expect(service.recordAnswer).not.toHaveBeenCalled();
    expect(speech.synthesize.mock.calls.map(call => call[0]).join(' ')).toBe('I’ll work on that and tell you when I’m done.');
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
    owner: 'owner', config: { url: 'ws://local', apiKey: 'devkey', apiSecret: 'secret',
      stt: vi.fn(async (onEvent: typeof receive) => { receive = onEvent; return { send() {}, close() {} }; }),
      brain: { answer: vi.fn(async (_agent: unknown, history: readonly { content: string }[], onText: (text: string) => void, _signal: AbortSignal) => {
        if (history.at(-1)?.content === 'stop') return { text: '', order: false };
        onText(answer); return { text: answer, order: false };
      }) } },
    access: vi.fn(async () => {}), agents: vi.fn(async () => [agent]),
    speech: vi.fn(async () => speech), humanCount: vi.fn(async () => 1),
    recordHuman: vi.fn(async (call: string, room: string, human: string, target: typeof agent, text: string, leaseOwner?: string): Promise<string> => {
      const writer = { access: service.access, db: {
        transaction: async (write: (db: { query(sql: string, args: unknown[]): Promise<unknown> }) => Promise<void>) => write({
          async query(sql, args) {
            if (sql.startsWith('INSERT INTO messages')) {
              const content = String(args[3]); messages.push(content); note(`message send: ${content}`);
            }
            return { rowCount: 1, rows: [] };
          },
        }),
      } } as unknown as VoiceService;
      return VoiceService.prototype.recordHuman.call(writer, call, room, human, target, text, leaseOwner);
    }), recordAnswer: vi.fn(async () => {}),
    db: { query: vi.fn(async (_sql: string, _args?: unknown[]) => ({ rowCount: 1, rows: [] as any[] })) },
    runtimeClosed: vi.fn(),
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
    await vi.waitFor(() => expect(harness.service.recordHuman).toHaveBeenCalledTimes(2));
    expect(harness.service.config.brain.answer.mock.calls[0]?.[3]?.aborted).toBe(true);
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
    await vi.waitFor(() => expect(harness.service.recordHuman).toHaveBeenCalledTimes(2));
    expect(harness.service.recordHuman.mock.calls[1]?.[4]).toBe(text);
    expect(harness.service.config.brain.answer.mock.calls[0]?.[3]?.aborted).toBe(true);
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
    offered = true; await runtime.refresh();
    await vi.waitFor(() => expect(harness.speech.synthesize).toHaveBeenCalledOnce());
    harness.emit('EndOfTurn', 'stop', 0);
    await vi.waitFor(() => expect(harness.service.recordHuman).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(harness.timeline.some(line => line.includes('TTS stop: Hey, here is the previous answer.'))).toBe(true));
    await runtime.refresh();
    await new Promise<void>(resolve => setImmediate(resolve));
    console.log('Reproduction phantom-2\n' + harness.timeline.join('\n'));
    expect(harness.speech.synthesize.mock.calls.filter(call => call[0] === report.text)).toHaveLength(1);
  } finally { await runtime.close(); }
});

it('Reproduction voice-name-1: switches transcript, reply and voice together and retains the target', async () => {
  const agents = [
    { id: 'ruby', name: 'Ruby', handle: 'ruby', soul: '', voice: 'ruby-voice' },
    { id: 'candy', name: 'Candy', handle: 'candy', soul: '', voice: 'candy-voice' },
  ];
  const recordHuman = vi.fn(async () => 'source');
  const answer = vi.fn(async () => ({ text: '' }));
  const service = { owner: 'owner', config: { url: 'ws://local', apiKey: 'devkey', apiSecret: 'secret', brain: { answer } },
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

it('finished-sentence timing adds no wait before commit or first audio', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const { service, speech } = conversationService(1);
  let committed = 0, audible = 0;
  service.agents.mockImplementation(async () => { await delay(3); return roster; });
  service.humanCount.mockImplementation(async () => { await delay(2); return 1; });
  service.recordHuman.mockImplementation(async () => { await delay(5); committed = performance.now(); return 'source'; });
  service.config.brain.answer.mockImplementation(async () => { await delay(20); return { text: 'A finished reply.', order: false }; });
  speech.synthesize.mockImplementation(async function* () { await delay(40); yield new Uint8Array([200, 1]); });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
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
    receive({ event: 'EndOfTurn', transcript: 'Ruby failed', turn_index: 0, sequence_id: 0 });
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

it.each(['agents', 'humanCount', 'target signal'])('settles a shared source when %s fails and allows the next turn', async stage => {
  const { service } = conversationService(1);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  const setup = deferred<any>();
  const failing = stage === 'agents' ? service.agents : stage === 'humanCount' ? service.humanCount : state.room.localParticipant.publishData;
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

it('quiet captured frames keep the same-message continuation window open', async () => {
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
    expect(service.recordHuman).toHaveBeenCalledOnce();
    expect(service.reviseHuman).toHaveBeenCalledOnce();
    expect(service.recordAnswer).toHaveBeenCalledOnce();
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
    expect(service.recordHuman).toHaveBeenCalledOnce();
    expect(service.recordAnswer).toHaveBeenCalledOnce();
  } finally { speaker.resolve(); await runtime.close(); }
});

it('ignores late brain deltas after barge-in while preserving only the heard prefix', async () => {
  const { service } = conversationService(1);
  const generation = deferred<any>();
  let delta!: (text: string) => void;
  service.config.brain.answer.mockImplementationOnce(async (_agent, _history, onText) => {
    delta = onText; onText('Heard clause. '); return generation.promise;
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    const first = runtime.utterance('human', 'Ruby first').catch(error => error.message);
    await vi.waitFor(() => expect(state.room.localParticipant.publishData.mock.calls.map(([bytes]: any[]) => JSON.parse(new TextDecoder().decode(bytes))).some(signal => signal.type === 'latency')).toBe(true));
    await runtime.utterance('human', 'Ruby another question');
    delta('Unheard stale delta. '); generation.reject(new Error('provider interrupted'));
    expect(await first).toBe('provider interrupted');
    expect(service.recordAnswer.mock.calls.map(call => call[2])).toContain('Heard clause.');
    expect(service.recordAnswer.mock.calls.some(call => call[2].includes('Unheard'))).toBe(false);
  } finally { await runtime.close(); }
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

it.each([2, 960])('closes the merge window before the first voiced capture (%d bytes) and dispatches only captured audio', async size => {
  const { service } = conversationService(1);
  service.speech.mockResolvedValue({ synthesize: async function* () { yield Buffer.alloc(size, 1); } } as any);
  service.config.brain.answer.mockImplementation(async () => ({ text: 'I will do it.', order: true }));
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  const capture = deferred<void>();
  state.audio.captureFrame.mockImplementationOnce(() => capture.promise);
  try {
    const first = runtime.utterance('human', 'Ruby first').catch(() => {});
    await vi.waitFor(() => expect(state.audio.captureFrame).toHaveBeenCalledOnce());
    expect(service.dispatch).not.toHaveBeenCalled();
    expect(state.room.localParticipant.publishData.mock.calls.map(([bytes]: any[]) => JSON.parse(new TextDecoder().decode(bytes))).some(signal => signal.type === 'latency')).toBe(false);
    const second = runtime.utterance('human', 'continued');
    await second; capture.resolve(); await first;
    expect(service.recordHuman).toHaveBeenCalledTimes(2);
    expect(service.reviseHuman).not.toHaveBeenCalled();
    expect(service.dispatch).toHaveBeenCalledOnce();
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
    expect(service.reviseHuman.mock.calls[0]?.[3].id).toBe('goose');
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
  state.audio.waitForPlayout.mockImplementationOnce(() => playback.promise);
  service.dispatch.mockImplementationOnce(() => dispatch.promise);
  try {
    const first = runtime.utterance('human', 'Ruby build it').catch(() => {});
    await vi.waitFor(() => expect(service.dispatch).toHaveBeenCalledOnce());
    const second = runtime.utterance('human', 'Ruby another question');
    await second;
    expect(service.recordHuman).toHaveBeenCalledTimes(2);
    expect(service.reviseHuman).not.toHaveBeenCalled();
    playback.reject(new DOMException('Interrupted', 'AbortError'));
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

it('surfaces an inaudible order acknowledgement without starting an ordinary command', async () => {
  const { service, speech } = conversationService(1);
  service.config.brain.answer.mockImplementation(async () => ({ text: 'I will do it.', order: true }));
  speech.synthesize.mockImplementation(async function* () {});
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    await expect(runtime.utterance('human', 'Ruby build it')).rejects.toThrow('acknowledgement produced no audio');
    expect(service.dispatch).not.toHaveBeenCalled();
    expect(service.recordAnswer).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});

it('keeps an audible acknowledgement decision alive when barge-in precedes the final order classification', async () => {
  const { service } = conversationService(1);
  const decision = deferred<void>();
  service.config.brain.answer.mockImplementationOnce(async (_agent, _history, onText, signal) => {
    onText('I will do it. ');
    await decision.promise;
    expect(signal.aborted).toBe(false);
    return { text: 'I will do it.', order: true };
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    const first = runtime.utterance('human', 'Ruby build it').catch(error => { if (error.name !== 'AbortError') throw error; });
    await vi.waitFor(() => expect(state.audio.captureFrame).toHaveBeenCalledOnce());
    await runtime.utterance('human', 'Ruby another question');
    expect(service.recordHuman).toHaveBeenCalledTimes(2);
    expect(service.dispatch).not.toHaveBeenCalled();
    decision.resolve(); await first;
    expect(service.dispatch).toHaveBeenCalledOnce();
    expect(service.recordAnswer).toHaveBeenCalledOnce();
  } finally { decision.resolve(); await runtime.close(); }
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
  // Keep the cancelled draft before its first audio. The restart uses the same
  // real service and message row; only STT, generation and RTC are controlled.
  speech.synthesize.mockImplementationOnce(async function* (_text, _voice, signal) {
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Interrupted', 'AbortError')), { once: true }));
    yield new Uint8Array([200, 1]);
  });
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
    await vi.waitFor(() => expect(speech.synthesize).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, pause));
    event('Update', 'That does not exist today.', 1);
    expect(fixture.config.brain.answer.mock.calls[0]?.[3].aborted).toBe(true);
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
    expect(speech.synthesize.mock.calls.map(call => call[0])).toEqual(['An unheard partial answer.', 'One complete reply.']);
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
