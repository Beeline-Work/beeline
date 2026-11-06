import { VOICE_DATA_TOPIC, expect, it, vi, VoiceService, VoiceRoomRuntime, spokenReport, confirmedVoiceSpeech, voicePlaybackEcho, OpenRouterVoiceBrain, VoiceQuotaError, RealVoiceService, migrate, PgliteDatabase, LiveHub, claimAgentCommand, DaemonService, PhoneService, state, roster, conversationService, phantomHarness, deferred } from './test-support-voice-room-runtime.test-support.js';



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


it('Reproduction MD-TTS-1: conversational streamed replies and delayed reports send natural text to synthesis', async () => {
  const agent = { id: 'agent', name: 'Jellybean', handle: 'jellybean', voice: 'warm' };
  const spoken: string[] = [];
  const answer = '**Hello, friend.**\n\n[Visit](https://example.com/a_(b)/details).\n\n```ts\nignore me\n```\n\nHi @jellybean.';
  let reports: any[] = [];
  const service = { runtimeScope: vi.fn(async (roomId: string) => ({workspaceId:'human',authorityRoomId:roomId})), workspaceId: vi.fn(async () => 'human'), endWorkspaceCalls: vi.fn(async () => {}), callWorkState: vi.fn(async () => ({pending:false,finishedAt:0})), hasCallWork: vi.fn(async () => false), endInactive: vi.fn(async () => false), budget: { fence: async (_call: string, _owner: string, enqueue: () => void) => { enqueue(); return true; }, read: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), record: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), limitMs: 3600000 }, owner: 'owner', config: { url: 'ws://local', apiKey: 'devkey', apiSecret: 'secret',
    brain: { answer: async (_agent: unknown, _history: unknown, delta: (text: string) => void) => {
      for (const character of answer) delta(character);
      return { text: answer };
    } } }, agents: vi.fn(async () => [agent]), humanCount: vi.fn(async () => 1),
    speech: async () => ({ async *synthesize(text: string) { spoken.push(text); yield new Uint8Array([200, 1]); } }),
    recordHuman: vi.fn(async () => 'source'), recordAnswer: vi.fn(async () => {}),
    db: { query: vi.fn(async (sql: string) => ({ rowCount: 1, rows: sql.includes('SELECT DISTINCT') ? reports : [] })) },
    access: vi.fn(async () => {}), leave: vi.fn(async () => {}), runtimeClosed: vi.fn() } as unknown as VoiceService;
  const runtime = await VoiceRoomRuntime.connect(service, 'call', 'room');
  try {
    await runtime.utterance('human', 'Jellybean, hello');
    expect(spoken.join(' ')).toBe('Hello, friend. Visit. Hi Jellybean.');
    expect(service.recordAnswer).toHaveBeenCalledWith('room', 'agent', answer, expect.any(Object));
    reports = [{ source_message_id: 'source', id: 'report', text: '**Done**: [result](https://example.com/a_(b)/details)', agent_id: 'agent', human_id: 'human' }];
    await runtime.refresh();
    await vi.waitFor(() => expect(spoken.at(-1)).toBe('Done: result'));
    console.log('MD-TTS-1 synthesis:', spoken);
  } finally { await runtime.close(); }
});


it('cancels microphone input and sends a targeted quota signal when Flux rejects the handshake', async () => {
  const cancel = vi.fn();
  state.streams = [new ReadableStream({ cancel })];
  const service = { runtimeScope: vi.fn(async (roomId: string) => ({workspaceId:'human',authorityRoomId:roomId})), workspaceId: vi.fn(async () => 'human'), endWorkspaceCalls: vi.fn(async () => {}), callWorkState: vi.fn(async () => ({pending:false,finishedAt:0})), hasCallWork: vi.fn(async () => false), endInactive: vi.fn(async () => false), budget: { fence: async (_call: string, _owner: string, enqueue: () => void) => { enqueue(); return true; }, read: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), record: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), limitMs: 3600000 }, owner: 'owner', config: { url: 'ws://local', apiKey: 'devkey', apiSecret: 'secret',
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
    runtimeScope: vi.fn(async (roomId: string) => ({workspaceId:'human',authorityRoomId:roomId})), workspaceId: vi.fn(async () => 'human'), endWorkspaceCalls: vi.fn(async () => {}), callWorkState: vi.fn(async () => ({pending:false,finishedAt:0})), hasCallWork: vi.fn(async () => false), endInactive: vi.fn(async () => false), budget: { fence: async (_call: string, _owner: string, enqueue: () => void) => { enqueue(); return true; }, read: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), record: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), limitMs: 3600000 }, owner: 'owner', config: { url: 'ws://local', apiKey: 'devkey', apiSecret: 'secret',
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
    await vi.waitFor(() => expect(authorize).toBeTypeOf('function'));
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


it('checks expired voice authority on the next control event and does nothing while idle', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  let now = 1000;
  const monotonic = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const { service } = conversationService(1);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    service.db.query.mockClear();
    now += 16000;
    expect(runtime.isClosed).toBe(false);
    expect(service.db.query).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    state.room.emit('data', new TextEncoder().encode(JSON.stringify({ type: 'unpin' })),
      { identity: 'human' }, 0, VOICE_DATA_TOPIC);
    expect(runtime.isClosed).toBe(true);
    await runtime.close();
    expect(service.access).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally { monotonic.mockRestore(); await runtime.close(); }
});


it.each(['Ruby', 'Dr. Ruby', 'Ruby!', '🌻 Ruby'])('VOICE-LABEL-1: %s labels are removed before synthesis and transcript writes', async (name) => {
  const { service, speech } = conversationService(1);
  const outputs = [`${name} (@ruby) [#beeline/item/previous]: A small ceramic planter.`,
    '[#beeline/item/previous]: Choose one with drainage.'];
  const fetcher = vi.fn(async () => new Response(outputs.shift()!.match(/.{1,12}/gu)!.map(content =>
    'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n').join('') + 'data: [DONE]\n\n'));
  const brain = new OpenRouterVoiceBrain('test', fetcher as typeof fetch);
  service.config.brain.answer.mockImplementation((...args) => brain.answer(...args));
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    await runtime.utterance('human', 'Ruby, suggest a small gift.');
    await runtime.utterance('human', 'Ruby, what should I look for?');
    expect(speech.synthesize.mock.calls.map(call => call[0])).toEqual([
      'A small ceramic planter.', 'Choose one with drainage.',
    ]);
    expect(service.recordAnswer.mock.calls.map(call => call[2])).toEqual([
      'A small ceramic planter.', 'Choose one with drainage.',
    ]);
    expect(state.audio.captureFrame).toHaveBeenCalledTimes(2);
  } finally { await runtime.close(); }
});


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
    expect(service.config.brain.answer.mock.calls.at(-1)?.[0].id).toBe('ruby');
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
  let playbackStarted!: () => void;
  const firstPlayback = new Promise<void>(resolve => { playbackStarted = resolve; });
  let releaseClaim!: () => void;
  const report = { source_message_id: 'order', id: 'report', text: 'Completed work.', agent_id: 'ruby', human_id: 'human' };
  const query = service.db.query.getMockImplementation()!;
  service.db.query.mockImplementation(async (sql: string, parameters?: any[]) => {
    if (sql.startsWith('SELECT DISTINCT ON')) return { rowCount: offered ? 1 : 0, rows: offered ? [report] : [] };
    if (sql.startsWith('UPDATE voice_orders')) await new Promise<void>(resolve => { releaseClaim = resolve; });
    return query(sql, parameters);
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  let releasePlayback!: () => void;
  state.audio.waitForPlayout.mockImplementationOnce(() => new Promise<void>(resolve => { releasePlayback = resolve; playbackStarted(); }));
  try {
    (runtime as any).targets.set('human', report.agent_id);
    offered = true; await runtime.refresh();
    await vi.waitFor(() => expect(releaseClaim).toBeDefined());
    const utterance = runtime.utterance('human', 'Ruby hello');
    // Synchronize on the held playout itself, not a short polling window
    // that can expire under the full CI shard's event-loop load.
    await firstPlayback;
    // Membership refresh must keep the caller present while playback is held.
    await runtime.countHumans();
    expect(speech.synthesize).toHaveBeenCalledOnce();
    releaseClaim();
    await new Promise(resolve => setImmediate(resolve));
    expect(speech.synthesize).toHaveBeenCalledOnce();
    releasePlayback(); await utterance;
    await vi.waitFor(() => expect(speech.synthesize).toHaveBeenCalledTimes(4));
    expect(speech.synthesize.mock.calls.at(-1)?.[0]).toBe(spokenReport(report.text));
  } finally { await runtime.close(); }
});


it('prepares the playback provider and current voice concurrently without using a cached voice', async () => {
  const { service, speech } = conversationService(1);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  const prepared = deferred<typeof speech>();
  service.speech.mockReturnValue(prepared.promise);
  service.agents.mockResolvedValue([{ ...roster[0]!, voice: 'apollo' }]);
  try {
    const playing = (runtime as any).play('The answer.', roster[0], new AbortController().signal);
    await vi.waitFor(() => expect(service.agents).toHaveBeenCalled());
    expect(speech.synthesize).not.toHaveBeenCalled();
    prepared.resolve(speech); await playing;
    expect(speech.synthesize.mock.calls[0]?.[1]).toBe('apollo');
  } finally { prepared.resolve(speech); await runtime.close(); }
});


it('voice timing persistence never holds first audio behind a storage write', async () => {
  const { service } = conversationService(1);
  const timing = vi.fn(() => new Promise<void>(() => {}));
  const runtime = await VoiceRoomRuntime.connect({ ...service, recordTiming: timing } as unknown as VoiceService, 'call', 'room');
  try {
    await runtime.utterance('human', 'Ruby explain the answer');
    expect(state.audio.captureFrame).toHaveBeenCalled();
    expect(timing.mock.calls.map(([row]: any[]) => row.stage)).toContain('first_voiced_audio_published');
  } finally { await runtime.close(); }
});


it.each([false, true])('Reproduction SPOKEN-1: records search speech before a final reply or failure (fails=%s)', async fails => {
  const { service } = conversationService(1);
  service.config.brain.answer.mockImplementation(async (_agent, _history, onText, _signal, context) => {
    await context.announce('Let me look.');
    if (fails) throw new Error('Voice reply unavailable');
    onText('Here is the answer.'); return { text: 'Here is the answer.', order: false };
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    const reply = runtime.utterance('human', 'Ruby find the answer');
    if (fails) await expect(reply).rejects.toThrow('Voice reply unavailable'); else await reply;
    expect(service.recordAnswer.mock.calls.map(call => call[2])).toEqual(fails
      ? ['Let me look.'] : ['Let me look.', 'Here is the answer.']);
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
    expect(service.recordAnswer).toHaveBeenCalledWith('room', 'ruby', 'Checking. I’ll tell you when I have it.', expect.any(Object));
    expect(speech.synthesize.mock.calls.map(call => call[0]).join(' ')).toBe('Checking. I’ll tell you when I have it.');
  } finally { await runtime.close(); }
});


it('records the audible acknowledgement before external work completes', async () => {
  const { service } = conversationService(1);
  service.config.brain.answer.mockImplementation(async (_agent, _history, onText) => {
    onText('You’re right to question it.');
    return { text: 'You’re right to question it.', order: true };
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    await runtime.utterance('human', 'Ruby reproduce the bug');
    expect(service.dispatch).toHaveBeenCalledOnce();
    expect(service.recordAnswer).toHaveBeenCalledWith('room', 'ruby', 'You’re right to question it.', expect.any(Object));
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


it('Reproduction voice-lost-1 stand-in: mixed request dispatch and failure follow-up reach the phone once', async () => {
  const db = new PgliteDatabase();
  const live = new LiveHub();
  const human = 'a'.repeat(64), agent = 'b'.repeat(64);
  const workspace = '11111111-1111-4111-8111-111111111111';
  const room = '22222222-2222-4222-8222-222222222222';
  const config = conversationService(1).service.config;
  const request = 'Introduce yourself. Connect my Shopify';
  const failure = 'Shopify could not connect because Trusty Squire is unavailable.';
  const brain = new OpenRouterVoiceBrain('test', async (_url, options) => {
    const body = JSON.parse(options!.body as string);
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: request });
    expect(body.messages[0].content).toContain('For a request that mixes conversation with work, call order for the whole request');
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: {
      tool_calls: [{ index: 0, function: { name: 'order', arguments: '{}' } }],
    } }] }) + '\n\ndata: [DONE]\n\n');
  });
  config.brain.answer.mockImplementation((...args) => brain.answer(...args));
  const synthesized: string[] = [];
  const voice = new RealVoiceService(db, live, { ...config,
    speech: { synthesize: async function* (text) { synthesized.push(text); yield new Uint8Array([200, 1]); } } });
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
    state.room.remoteParticipants.set(human, { identity: human });
    await runtime!.utterance(human, request);
    const command = (await db.query<{ id: string; source_message_id: string }>(`SELECT id,source_message_id FROM agent_commands WHERE room_id=$1`, [room])).rows;
    expect(command).toHaveLength(1);
    expect((await db.query<{text:string}>(`SELECT text FROM messages WHERE id=$1`, [command[0]!.source_message_id])).rows[0]!.text).toBe('@ruby ' + request);
    await claimAgentCommand(db, room, agent, command[0]!.id, 'proof-generation');
    await new DaemonService(db, live).execute('postRoomMessage', {
      roomId: room, requestId: command[0]!.source_message_id, generationId: 'proof-generation', text: failure,
    }, agent);
    const phone = new PhoneService(db, 'http://proof');
    const replies = (await phone.readRoom(room, human))!.messages.filter(message => message.author.pubkey === agent && message.presentation === 'message');
    expect(replies.map(reply => reply.text)).toEqual(['Checking. I’ll tell you when I have it.', failure]);
    await runtime!.refresh(); await (runtime as any).reportQueue;
    await runtime!.refresh(); await (runtime as any).reportQueue;
    expect(synthesized.filter(text => text === failure)).toHaveLength(1);
    expect((await db.query(`SELECT id FROM agent_commands WHERE room_id=$1`, [room])).rowCount).toBe(1);
    // A conversation-only answer remains owned by the voice path.
    config.brain.answer.mockImplementation(async (_agent, _history, onText) => {
      const answer = '**I’m listening.**\nWhat were you going to say?\n\nI’m listening. What were you going to say?';
      onText(answer); return { text: answer, order: false };
    });
    await runtime!.utterance(human, 'Ruby I’m');
    const view = (await phone.readRoom(room, human))!;
    expect(view.messages.filter(message => message.text.includes('I’m listening.')).map(message => message.text))
      .toEqual(['**I’m listening.**\nWhat were you going to say?']);
    config.brain.answer.mockImplementation(async (_agent, _history, onText, _signal, context) => {
      await context.announce('Let me look.');
      onText('The answer is here.'); return { text: 'The answer is here.', order: false };
    });
    await runtime!.utterance(human, 'Ruby find the answer');
    const spoken = (await phone.readRoom(room, human))!.messages.filter(message => message.author.pubkey === agent);
    expect(spoken.slice(-2).map(message => message.text)).toEqual(['Let me look.', 'The answer is here.']);
    await vi.waitFor(async () => expect((await db.query(`SELECT 1 FROM voice_turn_timings
      WHERE call_id=$1 AND stage='first_voiced_audio_published'`, [joined.call.id])).rowCount).toBe(3));
    console.log('SPOKEN-1: spoken acknowledgement → normal completion and search announcement → answer; persisted phone reads preserve every utterance once, in order.');
  } finally { await voice.close(); await db.close(); }
}, 30_000);


it.each(['I', 'um', 'so', 'and'])('Reproduction stray-word-1: drops confident %s without interrupting or prefixing the next request', async text => {
  const harness = phantomHarness();
  const runtime = await VoiceRoomRuntime.connect(harness.service as unknown as VoiceService, 'call', 'room');
  state.streams = [new ReadableStream()];
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(harness.service.config.stt).toHaveBeenCalledOnce());
    harness.emit('EndOfTurn', 'Explain the answer', 0);
    await vi.waitFor(() => expect(harness.speech.synthesize).toHaveBeenCalledOnce());
    const signal = harness.speech.synthesize.mock.calls[0]![2];
    harness.emit('Update', text, 1, [{ confidence: 0.99, start: 0, end: 0.6 }]);
    harness.emit('EndOfTurn', text, 1, [{ confidence: 0.99, start: 0, end: 0.6 }]);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(signal.aborted).toBe(false);
    expect(harness.messages).toEqual(['@ronnie Explain the answer']);
    expect(harness.service.config.brain.answer).toHaveBeenCalledOnce();
    harness.finishPlayback();
    await vi.waitFor(() => expect(harness.service.recordAnswer).toHaveBeenCalledOnce());
    harness.emit('EndOfTurn', 'I think so', 2);
    await vi.waitFor(() => expect(harness.messages).toEqual(['@ronnie Explain the answer', '@ronnie I think so']));
  } finally { harness.finishPlayback(); await runtime.close(); }
});


it.each(['Okay.', 'Yeah.', 'Mm hmm', 'Uh', 'Yes'])('Reproduction VOICE-ACK-1: %s only answers a question', async word => {
  for (const question of [false, true]) {
    const harness = phantomHarness(question ? 'Is that okay?' : 'The task is finished.');
    const runtime = await VoiceRoomRuntime.connect(harness.service as unknown as VoiceService, 'call', 'room');
    state.streams = [new ReadableStream()];
    try {
      state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
      await vi.waitFor(() => expect(harness.service.config.stt).toHaveBeenCalledOnce());
      harness.emit('EndOfTurn', 'Explain the answer', 0);
      await vi.waitFor(() => expect(harness.service.recordAnswer).toHaveBeenCalledOnce());
      harness.finishPlayback();
      await vi.waitFor(() => expect((runtime as any).speaking).toBeUndefined());
      harness.service.config.brain.answer.mockImplementationOnce(async () => ({ text: 'Proceeding.', order: true }));
      harness.emit('EndOfTurn', word, 1);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(harness.messages).toEqual(question
        ? ['@ronnie Explain the answer', '@ronnie ' + word] : ['@ronnie Explain the answer']);
      expect(harness.service.config.brain.answer).toHaveBeenCalledTimes(question ? 2 : 1);
      expect(harness.service.dispatch).toHaveBeenCalledTimes(question ? 1 : 0);
      if (question) {
        harness.finishPlayback();
        await vi.waitFor(() => expect((runtime as any).speaking).toBeUndefined());
        harness.emit('EndOfTurn', word, 2);
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(harness.service.config.brain.answer).toHaveBeenCalledTimes(2);
        expect(harness.service.dispatch).toHaveBeenCalledOnce();
      }
    } finally { harness.finishPlayback(); await runtime.close(); }
  }
});


it.each(['Ronnie', '@ronnie'])('keeps a lone call agent name or handle: %s', async text => {
  const harness = phantomHarness();
  const runtime = await VoiceRoomRuntime.connect(harness.service as unknown as VoiceService, 'call', 'room');
  const utterance = vi.spyOn(runtime, 'utterance');
  state.streams = [new ReadableStream()];
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(harness.service.config.stt).toHaveBeenCalledOnce());
    harness.emit('EndOfTurn', text, 0, [{ confidence: 0.99, start: 0, end: 0.2 }]);
    await vi.waitFor(() => expect(utterance).toHaveBeenCalledWith('human', text, expect.any(Number), false, true));
    expect(harness.service.config.brain.answer).not.toHaveBeenCalled();
    harness.emit('EndOfTurn', 'I think so', 1);
    await vi.waitFor(() => expect(harness.service.recordHuman).toHaveBeenCalledOnce());
    expect(harness.service.recordHuman.mock.calls[0]![3].id).toBe('ronnie');
  } finally { harness.finishPlayback(); await runtime.close(); }
});


it.each([
  ['Hey,', 0.3, 0.2, false],
  ['Hey', 0.95, 0.08, false],
  ['Hey', 0.95, 0.2, false],
  ...['uh', 'um', 'huh', 'hmm', 'mm'].map(text => [text, 0.3, 0.2, false]),
  ...['yes', 'yeah', 'yep', 'yup', 'sure', 'okay', 'ok'].map(text => [text, 0.3, 0.2, false]),
  ...['no', 'nope', 'wait', 'pause', 'continue', 'thanks', 'Definitely', 'Goosy', 'okay so what about tomorrow', 'I think so'].map(text => [text, 0.3, 0.2, true]),
] as [string, number, number, boolean][])('Reproduction filler-final-1: %s confidence=%s duration=%s delivered=%s', async (text, confidence, end, delivered) => {
  const harness = phantomHarness();
  const runtime = await VoiceRoomRuntime.connect(harness.service as unknown as VoiceService, 'call', 'room');
  state.streams = [new ReadableStream()];
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(harness.service.config.stt).toHaveBeenCalledOnce());
    const utterance = vi.spyOn(runtime as any, 'utterance');
    harness.emit('EndOfTurn', text, 0, [{ confidence, start: 0, end }]);
    if (delivered) {
      await vi.waitFor(() => expect(harness.service.recordHuman).toHaveBeenCalledOnce());
      expect(harness.messages).toEqual(['@ronnie ' + text]);
    } else {
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(utterance).not.toHaveBeenCalled();
      expect(harness.messages).toEqual([]);
    }
  } finally { harness.finishPlayback(); await runtime.close(); }
});


it.each(['Hey,', 'I', 'um', 'so', 'and'])('Reproduction stray-word-1/filler-final-2: does not append %s to a pending request', async text => {
  const harness = phantomHarness();
  let finish!: () => void;
  harness.service.config.brain.answer.mockImplementationOnce(async (_agent, _history, onText) => {
    await new Promise<void>(resolve => { finish = resolve; });
    onText('The reply.'); return { text: 'The reply.', order: false };
  });
  const runtime = await VoiceRoomRuntime.connect(harness.service as unknown as VoiceService, 'call', 'room');
  state.streams = [new ReadableStream()];
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(harness.service.config.stt).toHaveBeenCalledOnce());
    harness.emit('EndOfTurn', 'Your reply seems slower than the previous version.', 0);
    await vi.waitFor(() => expect(finish).toBeDefined());
    harness.emit('Update', text, 1, [{ confidence: 0.99, start: 0, end: 0.6 }]);
    harness.emit('EndOfTurn', text, 1, [{ confidence: 0.99, start: 0, end: 0.6 }]);
    await new Promise(resolve => setImmediate(resolve));
    expect((runtime as any).assembler.current('human').text).toBe('Your reply seems slower than the previous version.');
    finish();
    await vi.waitFor(() => expect(harness.speech.synthesize).toHaveBeenCalledOnce());
    expect(harness.service.config.brain.answer).toHaveBeenCalledOnce();
    expect(harness.messages).toEqual(['@ronnie Your reply seems slower than the previous version.']);
  } finally { finish?.(); harness.finishPlayback(); await runtime.close(); }
});


it('Demonstration VOICE-ACK-1, stray-word-1 and filler-final-1/2: recognizer finals reach the persisted phone transcript without phantom fillers', async () => {
  const db = new PgliteDatabase(), live = new LiveHub();
  const human = 'a'.repeat(64), agent = 'b'.repeat(64);
  const workspace = '11111111-1111-4111-8111-111111111111', room = '22222222-2222-4222-8222-222222222222';
  const fixture = conversationService(1);
  let receive!: (event: any) => void, finish!: () => void;
  fixture.service.config.stt.mockImplementation(async callback => {
    receive = callback; return { send: vi.fn(), close: vi.fn() };
  });
  fixture.service.config.brain.answer.mockImplementationOnce(async (_agent, _history, onText) => {
    await new Promise<void>(resolve => { finish = resolve; });
    onText('The reply.'); return { text: 'The reply.', order: false };
  });
  const voice = new RealVoiceService(db, live, { ...fixture.service.config, speech: fixture.speech });
  try {
    await migrate(db);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Human','human'),($2,'agent','Ruby','ruby')`, [human, agent]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, human]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Filler proof')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants) VALUES($1,$2,'DM',$3)`, [room, workspace, [human, agent]]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`, [workspace, human, agent, room]);
    const joined = await voice.join(room, human);
    const call = (await db.query<any>(`SELECT * FROM voice_calls WHERE id=$1`, [joined.call.id])).rows[0];
    await voice.ensureRuntime(call);
    state.room.remoteParticipants.set(human, { identity: human });
    state.streams = [new ReadableStream()];
    state.room.emit('track', { kind: 1 }, {}, { identity: human });
    await vi.waitFor(() => expect(receive).toBeDefined());
    const phone = new PhoneService(db, 'http://proof');
    const transcript = async () => (await phone.readRoom(room, human))!.messages
      .filter(message => message.author.pubkey === human && message.presentation === 'message').map(message => message.text);
    const say = (text: string, turn: number, confidence: number, end = 0.2) => receive({
      event: 'EndOfTurn', transcript: text, turn_index: turn, sequence_id: turn,
      words: text.split(' ').map(word => ({ word, confidence, start: 0, end })),
    });
    say('Hey,', 0, 0.3);
    await new Promise(resolve => setImmediate(resolve));
    expect(await transcript()).toEqual([]);
    say('Ruby slower than the previous version.', 1, 0.3);
    await vi.waitFor(() => expect(finish).toBeDefined());
    say('Hey,', 2, 0.3);
    await new Promise(resolve => setImmediate(resolve));
    expect(await transcript()).toEqual(['@ruby Ruby slower than the previous version.']);
    finish();
    await vi.waitFor(() => expect(fixture.speech.synthesize).toHaveBeenCalled());
    for (const [index, word] of ['I', 'um', 'so', 'and'].entries()) say(word, 3 + index, 0.99);
    await new Promise(resolve => setImmediate(resolve));
    expect(await transcript()).toEqual(['@ruby Ruby slower than the previous version.']);
    say('Okay.', 7, 0.95);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(await transcript()).toEqual(['@ruby Ruby slower than the previous version.']);
    fixture.service.config.brain.answer.mockImplementationOnce(async (_agent, _history, onText) => {
      onText('Should I continue?'); return { text: 'Should I continue?', order: false };
    });
    say('Ask me a question', 8, 0.95);
    await vi.waitFor(async () => expect((await phone.readRoom(room, human))!.messages.some(message => message.text === 'Should I continue?')).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 30));
    say('yes', 9, 0.95);
    await vi.waitFor(async () => expect(await transcript()).toEqual(['@ruby Ruby slower than the previous version.', '@ruby Ask me a question', '@ruby yes']));
    console.log('filler-final-1/2: STT final → real VoiceService/database → PhoneService transcript: noise absent, prior request unchanged, confident stray words absent, yes delivered.');
  } finally { finish?.(); await voice.close(); await db.close(); }
}, 30_000);


it.each([0.6, 0.3, 0.95])('Reproduction keep-turn-1: records and replies to a final at confidence %s', async confidence => {
  const harness = phantomHarness();
  const logs = vi.spyOn(console, 'info');
  const runtime = await VoiceRoomRuntime.connect(harness.service as unknown as VoiceService, 'call', 'room');
  state.streams = [new ReadableStream()];
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(harness.service.config.stt).toHaveBeenCalledOnce());
    const text = 'can you check the build';
    harness.emit('EndOfTurn', text, 0, text.split(' ').map((_, i) => ({ confidence, start: confidence === 0.6 ? i * 0.2 : 0, end: confidence === 0.6 ? (i + 1) * 0.2 : 0.08 })));
    await vi.waitFor(() => expect(harness.service.recordHuman).toHaveBeenCalledOnce());
    expect(harness.messages).toEqual(['@ronnie ' + text]);
    await vi.waitFor(() => expect(harness.speech.synthesize).toHaveBeenCalledOnce());
    harness.finishPlayback();
    await vi.waitFor(() => expect(harness.service.recordAnswer).toHaveBeenCalledOnce());
    expect(harness.service.config.brain.answer).toHaveBeenCalledOnce();
    expect(logs).toHaveBeenCalledWith('[voice-speech-shadow]', expect.stringContaining(text));
    expect(logs).toHaveBeenCalledWith('[voice-router-decision]', expect.stringContaining('answer'));
  } finally { await runtime.close(); logs.mockRestore(); }
});


it('dispatches a low-confidence final without interrupting playback when voiceInterrupt is false', async () => {
  const harness = phantomHarness();
  const runtime = await VoiceRoomRuntime.connect(harness.service as unknown as VoiceService, 'call', 'room');
  const utterance = vi.spyOn(runtime, 'utterance');
  state.streams = [new ReadableStream()];
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(harness.service.config.stt).toHaveBeenCalledOnce());
    harness.emit('EndOfTurn', 'Explain the answer', 0);
    await vi.waitFor(() => expect(harness.speech.synthesize).toHaveBeenCalledOnce());
    const signal = harness.speech.synthesize.mock.calls[0]![2];
    const words = [{ confidence: 0.3, start: 0, end: 0.08 }];
    harness.emit('Update', 'thanks', 1, words);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(signal.aborted).toBe(false);
    harness.emit('EndOfTurn', 'thanks', 1, words);
    await vi.waitFor(() => expect(utterance).toHaveBeenCalledWith('human', 'thanks', expect.any(Number), false, false));
    await vi.waitFor(() => expect(harness.service.recordHuman).toHaveBeenCalledTimes(2));
    expect(signal.aborted).toBe(false);
    expect(harness.timeline.filter(line => line.endsWith('barge-in cancel'))).toHaveLength(0);
  } finally { await runtime.close(); }
});
