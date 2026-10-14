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
