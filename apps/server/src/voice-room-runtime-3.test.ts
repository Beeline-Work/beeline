import { expect, it, vi, voiceTempo, markdownToSpeech, VoiceService, telemetry, VoiceRoomRuntime, spokenReport, voiceInterrupt, AuraSpeech, OpenRouterVoiceBrain, state, roster, conversationService, deferred, multiCall } from './test-support-voice-room-runtime.test-support.js';



it('uses two words or 400 ms of non-backchannel speech as the interrupt threshold', () => {
  const event = (transcript: string, seconds = 0.2) => ({ event: 'Update' as const, transcript, turn_index: 0, sequence_id: 0,
    words: transcript.split(' ').map((word, i, all) => ({ word, start: i * seconds / all.length, end: (i + 1) * seconds / all.length, confidence: 0.95 })) });
  expect(voiceInterrupt(event('hold on'))).toBe(true);
  expect(voiceInterrupt(event('stop', 0.45))).toBe(true);
  expect(voiceInterrupt(event('stop', 0.25))).toBe(false);
  for (const noise of ['uh', 'hmm', 'mm hmm', 'yeah okay', 'uh-huh', 'haha', 'oh wow', 'hmm', 'um', 'uh'])
    expect(voiceInterrupt(event(noise, 1))).toBe(false);
});


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


it('multi-human: an avatar pin persists for that person until explicitly cleared', async () => {
  const call = multiCall(2);
  const runtime = await VoiceRoomRuntime.connect(call.service as unknown as VoiceService, 'call', 'room');
  try {
    call.roomData('alex', { type: 'target', agentId: 'goose', tap: true });
    await vi.waitFor(() => expect(call.service.access).toHaveBeenCalled());
    await new Promise(resolve => setImmediate(resolve));
    await runtime.utterance('sam', 'What do you think?');
    await runtime.utterance('alex', 'What do you think?');
    await runtime.utterance('alex', 'And after that?');
    expect(call.answered()).toEqual(['goose', 'goose']);
    expect(call.service.recordHuman.mock.calls.map(c => [c[2], c[3].id])).toEqual([['alex', 'goose'], ['alex', 'goose']]);
    expect(call.signals('alex').filter(signal => signal.type === 'unaddressed')).toHaveLength(0);
    // A spoken name replaces the persistent tap for later requests.
    call.roomData('alex', { type: 'target', agentId: 'goose', tap: true });
    await new Promise(resolve => setTimeout(resolve, 10));
    await runtime.utterance('alex', 'Ruby, you answer');
    await runtime.utterance('alex', 'Anyone?');
    expect(call.answered()).toEqual(['goose', 'goose', 'goose', 'goose']);
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
      'tts_prefetch_request', 'brain_complete', 'tts_request', 'tts_first_byte', 'first_audio_published', 'first_voiced_audio_published',
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
    const service = { runtimeScope: vi.fn(async (roomId: string) => ({workspaceId:'human',authorityRoomId:roomId})), workspaceId: vi.fn(async () => 'human'), endWorkspaceCalls: vi.fn(async () => {}), callWorkState: vi.fn(async () => ({ pending: false, finishedAt: 0 })), endInactive: vi.fn(async () => false), budget: { fence: async (_call: string, _owner: string, enqueue: () => void) => { enqueue(); return true; }, read: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), record: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), limitMs: 3600000 }, owner: 'owner', config: { url: 'ws://local', apiKey: 'devkey', apiSecret: 'secret',
      brain: { answer: async (_agent: unknown, _history: unknown, delta: (text: string) => void) => {
        for (const character of answer) delta(character);
        return { text: answer };
      } } }, agents: vi.fn(async () => [agent]), humanCount: vi.fn(async () => 1),
      speech: async () => ({ async *synthesize(text: string) { spoken.push(text); yield new Uint8Array([200, 1]); } }),
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



it('gates microphone PCM on its durable checkpoint while reply playback remains independent', async () => {
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
    expect(input).not.toHaveBeenCalled();
    frames.enqueue({ data: new Int16Array(320) });
    await new Promise(resolve=>setImmediate(resolve));
    expect(input).not.toHaveBeenCalled();
    await runtime.utterance('human', 'Ruby, timing during blocked checkpoint');
    const after = timings().at(-1)!;
    expect(state.audio.captureFrame).toHaveBeenCalled();
    expect(after).toBeLessThan(100);
    console.log(`VOICE-BUDGET-LATENCY before=${before.toFixed(3)}ms after=${after.toFixed(3)}ms; checkpoint still unresolved at reply playback; microphone PCM remains staged; controlled providers and RTC.`);
  } finally { release?.(); await runtime.close(); }
});


it('broadcasts the shared countdown to every participant and ends the workspace at zero', async () => {
  const { service } = conversationService(2);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    const budget = { remainingMs: 120_000, resetAt: Date.now() + 86_400_000, timeZone: 'UTC' };
    await (runtime as any).meter.flush();
    expect(service.budget.record).not.toHaveBeenCalled();
    (runtime as any).meter.audio(20);
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
    (runtime as any).meter.audio(20, Date.now() + 20);
    service.budget.record.mockResolvedValueOnce({ ...budget, remainingMs: 0 });
    await (runtime as any).meter.flush();
    await vi.waitFor(() => expect(service.endWorkspaceCalls).toHaveBeenCalledWith('human'));
  } finally { await runtime.close(); }
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
  expect(spokenReport('短い文。' + '長い'.repeat(600))).toBe('短い文。 The rest is in the chat.');
  expect(spokenReport('Short sentence. ' + 'more '.repeat(400) + '.')).toBe('Short sentence. The rest is in the chat.');
});


it.each(['stay', 'turn', 'leave'] as const)('reports wait for human quiet and recheck the caller: %s', async action => {
  const { service, speech } = conversationService(2);
  let claimed = false, available = false;
  const report = { source_message_id: 'order', id: 'report', text: 'Done.\n\n' + 'Details. '.repeat(100), agent_id: 'ruby', human_id: 'human' };
  service.db.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT DISTINCT ON')) return { rowCount: available && !claimed ? 1 : 0, rows: available && !claimed ? [report] : [] };
    if (sql.startsWith('UPDATE voice_orders')) claimed = true;
    return { rowCount: 1, rows: [] };
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    (runtime as any).targets.set('human', 'ruby');
    (runtime as any).humanSpeaking.add('human');
    // This committed report arrives after the caller/target are established.
    // Startup hydration must not race the test's actual quiet-wait scenario.
    available = true;
    await runtime.refresh();
    await new Promise(resolve => setImmediate(resolve));
    expect(speech.synthesize).not.toHaveBeenCalled();
    expect(claimed).toBe(false);
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


it('VOICE-CONTEXT-1: a capped abbreviation fragment never reaches synthesis', async () => {
  const { OpenRouterVoiceBrain } = await import('./voice-providers.js');
  const { service, speech } = conversationService(1);
  const content = 'The appointment is confirmed. Dr. Smith will explain the';
  const brain = new OpenRouterVoiceBrain('test', async () => new Response(
    'data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'length' }] }) + '\n\n'));
  const runtime = await VoiceRoomRuntime.connect({ ...service, config: { ...service.config, brain } } as unknown as VoiceService, 'call', 'room');
  try {
    await runtime.utterance('human', 'Ruby confirm the appointment');
    expect(speech.synthesize.mock.calls.map(call => call[0])).toEqual(['The appointment is confirmed.']);
  } finally { await runtime.close(); }
});


it.each(['fast', 'failed'] as const)('call search %s reaches audio or exactly one ordinary order', async mode => {
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
    expect(Buffer.concat(frames)).toEqual(Buffer.concat(await Array.fromAsync(voiceTempo((async function* () { yield expected; })()))));
    expect(frames.slice(0, -1).every((frame: Buffer) => frame.length === 960)).toBe(true);
    expect(state.audio.waitForPlayout).toHaveBeenCalledOnce();
    console.log('AURA-413-1:', text.length, 'characters,', requests.length, 'requests,', frames.length, 'ordered PCM frames');
  } finally { await runtime.close(); }
});


it('Reproduction CONVERSATION-2: a solo pin survives silence, completed turns and spoken names until unpinned', async () => {
  vi.useFakeTimers();
  const call = multiCall(1);
  call.service.lastActiveAgent.mockResolvedValue('goose');
  const runtime = await VoiceRoomRuntime.connect(call.service as unknown as VoiceService, 'call', 'room');
  try {
    call.roomData('human', { type: 'target', agentId: 'ruby', tap: true });
    await vi.advanceTimersByTimeAsync(4000);
    for (const text of ['Please help', 'And continue', 'Goosey your turn', 'More please']) {
      const turn = runtime.utterance('human', text);
      await vi.advanceTimersByTimeAsync(1500); await turn;
    }
    expect(call.answered()).toEqual(['ruby', 'ruby', 'ruby', 'ruby']);
  } finally { await runtime.close(); vi.useRealTimers(); }
});


it.each([false, true])('Reproduction CONVERSATION-1: joins 1200/1800ms fragments after brain completion before audio (order=%s)', async order => {
  vi.useFakeTimers();
  const { service, speech } = conversationService(1);
  service.config.brain.answer.mockResolvedValue({ order, text: 'Here is the reply.' });
  let attempts = 0;
  speech.synthesize.mockImplementation(async function* (_text: string, _voice: string, signal: AbortSignal) {
    if (++attempts < 3) await new Promise<void>((_resolve, reject) => signal.addEventListener('abort',
      () => reject(new DOMException('Interrupted', 'AbortError')), { once: true }));
    yield new Uint8Array([200, 1, 200, 1]);
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    const first = runtime.utterance('human', 'Ruby please build').catch(() => {});
    await vi.advanceTimersByTimeAsync(1200);
    expect(service.dispatch).not.toHaveBeenCalled();
    expect(state.audio.captureFrame).not.toHaveBeenCalled();
    const second = runtime.utterance('human', 'a small clock').catch(() => {});
    await vi.advanceTimersByTimeAsync(1800);
    expect(service.dispatch).not.toHaveBeenCalled();
    const third = runtime.utterance('human', 'with seconds');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([first, second, third]);
    expect(service.recordHuman).toHaveBeenCalledOnce();
    expect(service.reviseHuman.mock.calls.at(-1)?.[5]).toBe('Ruby please build a small clock with seconds');
    expect(service.dispatch).toHaveBeenCalledTimes(order ? 1 : 0);
    expect(service.config.brain.answer).toHaveBeenCalledTimes(3);
    expect(state.audio.captureFrame).toHaveBeenCalledOnce();
  } finally { await runtime.close(); vi.useRealTimers(); }
});


it('CONVERSATION-1: same-human partial speech pauses pre-audio playback without blocking another human', async () => {
  const { service, speech } = conversationService(2);
  let receive!: (event: any) => void;
  service.config.stt.mockImplementation(async callback => { receive = callback; return { send() {}, close() {} }; });
  service.config.brain.answer.mockResolvedValueOnce({ order: true, text: 'Checking.' })
    .mockResolvedValueOnce({ order: false, text: 'Hello.' })
    .mockResolvedValueOnce({ order: true, text: 'Checking.' });
  speech.synthesize.mockImplementationOnce(async function* (_text, _voice, signal) {
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort',
      () => reject(new DOMException('Interrupted', 'AbortError')), { once: true }));
    yield new Uint8Array([200, 1]);
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  state.streams = [new ReadableStream()];
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(receive).toBeDefined());
    const first = runtime.utterance('human', 'Ruby build a clock').catch(() => {});
    await vi.waitFor(() => expect(speech.synthesize).toHaveBeenCalledOnce());
    receive({ event: 'Update', turn_index: 1, transcript: 'with seconds', sequence_id: 1,
      words: [{word: 'with', confidence: .99, start: 0, end: .3}, {word: 'seconds', confidence: .99, start: .3, end: .6}] });
    await first;
    expect(state.audio.captureFrame).not.toHaveBeenCalled();
    await runtime.utterance('sam', 'Goosey hello');
    expect(service.recordAnswer).toHaveBeenCalledOnce();
    receive({ event: 'EndOfTurn', turn_index: 1, transcript: 'with seconds', sequence_id: 2 });
    await vi.waitFor(() => expect(service.reviseHuman).toHaveBeenCalledOnce());
    expect(service.reviseHuman.mock.calls[0]?.[5]).toBe('Ruby build a clock with seconds');
    await vi.waitFor(() => expect(service.dispatch).toHaveBeenCalledOnce());
    expect(service.config.brain.answer).toHaveBeenCalledTimes(3);
  } finally { await runtime.close(); }
});


it('DELIVERY-2: another human interrupting pre-audio synthesis cannot drop the order', async () => {
  const { service, speech } = conversationService(2);
  service.config.brain.answer.mockResolvedValueOnce({ order: true, text: 'Checking.' });
  speech.synthesize.mockImplementationOnce(async function* (_text, _voice, signal) {
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort',
      () => reject(new DOMException('Interrupted', 'AbortError')), { once: true }));
    yield new Uint8Array([200, 1]);
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    const first = runtime.utterance('human', 'Ruby build a clock').catch(error => {
      if (error.name !== 'AbortError') throw error;
    });
    await vi.waitFor(() => expect(speech.synthesize).toHaveBeenCalledOnce());
    await runtime.utterance('sam', 'Goosey hello');
    await first;
    expect(service.dispatch).toHaveBeenCalledOnce();
    expect(service.reviseHuman).not.toHaveBeenCalled();
    expect(service.recordHuman).toHaveBeenCalledTimes(2);
  } finally { await runtime.close(); }
});



it('VOICE-ROUTER-1: pending call work reaches the brain without an invented report', async () => {
  const { service } = conversationService(1);
  const original = service.db.query.getMockImplementation()!;
  service.db.query.mockImplementation(async (sql, params) => sql.includes('SELECT source.text')
    ? { rowCount: 1, rows: [{ source_message_id: 'work', agent_id: 'ruby', human_id: 'human', text: '@ruby check whether the release went out' }] as any }
    : original(sql, params));
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    service.db.query.mockImplementation(async (sql, params) => {
      if (sql.includes('SELECT source.text')) throw new Error('Pending lookup must stay off the turn path');
      return original(sql, params);
    });
    await runtime.utterance('human', 'Ruby, are you still working on it?');
    const history = service.config.brain.answer.mock.calls.at(-1)![1] as any;
    expect(history.find((row: any) => row.content.startsWith('Call work still pending')).content).toContain('Call work still pending; no report or progress is available');
    expect(history.find((row: any) => row.content.startsWith('Call work still pending')).content).toContain('check whether the release went out');
    expect(history.some((row: any) => row.role === 'user' && row.content.includes('are you still working on it?'))).toBe(true);
  } finally { await runtime.close(); }
});


it('Reproduction R1 / SPOKEN-150: cleans the heavy report and measures refresh to first audio with controlled synthesis and RTC', async () => {
  const elapsed: number[] = [];
  for (let sample = 0; sample < 7; sample++) {
    const { service, speech } = conversationService(1);
    let offered = false, claimed = false;
    const text = 'History helps us understand how people lived and why their choices still matter so much. '.repeat(8).trim();
    const report = { source_message_id: 'order', id: 'report', text: 'Ruby: ' + text, agent_id: 'ruby', human_id: 'human' };
    service.db.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT DISTINCT ON')) return { rowCount: offered && !claimed ? 1 : 0, rows: offered && !claimed ? [report] : [] };
      if (sql.startsWith('UPDATE voice_orders')) claimed = true;
      return { rowCount: 1, rows: [] };
    });
    const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
    try {
      (runtime as any).targets.set('human', 'ruby');
      let first = 0;
      state.audio.captureFrame.mockImplementation(async () => { first ||= performance.now(); });
      offered = true;
      const started = performance.now();
      await runtime.refresh();
      await (runtime as any).reportQueue;
      expect(first).toBeGreaterThan(started);
      expect(speech.synthesize.mock.calls.map(call => call[0]).join('')).toBe(text);
      elapsed.push(first - started);
      if (sample === 0) console.log('SPOKEN-150 synthesized:', speech.synthesize.mock.calls.map(call => call[0]).join(''));
    } finally { await runtime.close(); }
  }
  elapsed.sort((a, b) => a - b);
  console.log(`SPOKEN-150 refresh-to-first-audio p50=${elapsed[3]!.toFixed(3)}ms samples=${elapsed.map(n => n.toFixed(3)).join(',')}; controlled provider and RTC, no live network or phone speaker measurement.`);
});



it('speaks a 120-word answer whole without a chat suffix', () => {
  const text = 'History helps us understand how people lived and why their choices still matter so much. '.repeat(8).trim();
  expect(text.split(/\s+/)).toHaveLength(120);
  expect(spokenReport(text)).toBe(text);
  expect(spokenReport('All done.')).toBe('All done.');
  expect(spokenReport('')).toBe('');
});


it('cuts a 400-word paragraph after the last sentence within 150 words', () => {
  const sentence = 'People shaped history through choices that changed their daily lives.';
  const text = Array(40).fill(sentence).join(' ');
  expect(text.split(/\s+/)).toHaveLength(400);
  expect(spokenReport(text)).toBe(Array(15).fill(sentence).join(' ') + ' The rest is in the chat.');
});


it('scales the character and CJK limits by six', () => {
  expect(spokenReport('短い文。'.repeat(80))).toBe('短い文。'.repeat(80));
  expect(spokenReport('短い文。'.repeat(81))).toBe('短い文。'.repeat(80) + ' The rest is in the chat.');
  expect(spokenReport('x'.repeat(1079) + '.')).toBe('x'.repeat(1079) + '.');
  expect(spokenReport('x'.repeat(1080) + '.')).toBe('The rest is in the chat.');
});


it('VOICE-ROUTER-1: remembers a new dispatch immediately and clears it on committed completion', async () => {
  const { service } = conversationService(1);
  service.config.brain.answer.mockResolvedValueOnce({ text: 'Checking.', order: true });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    await runtime.utterance('human', 'Ruby check whether the release went out');
    await runtime.utterance('human', 'Ruby are you still working?');
    const pending = service.config.brain.answer.mock.calls.at(-1)![1] as any[];
    expect(pending.some(row => row.content.startsWith('Call work still pending'))).toBe(true);
    await runtime.refresh();
    await runtime.utterance('human', 'Ruby hello');
    const finished = service.config.brain.answer.mock.calls.at(-1)![1] as any[];
    expect(finished.some(row => row.content.startsWith('Call work still pending'))).toBe(false);
  } finally { await runtime.close(); }
});



it('VOICE-ROUTER-1: empty call work is hydrated once across transcript invalidations', async () => {
  const { service } = conversationService(1);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    await runtime.refresh();
    await runtime.refresh();
    expect(service.db.query.mock.calls.filter(([sql]) => sql.includes('SELECT source.text'))).toHaveLength(1);
  } finally { await runtime.close(); }
});



it('VOICE-BARGE-1: assembler pause aborts a provider without publishing or capturing an error', async () => {
  const capture = vi.spyOn(telemetry, 'captureServerError').mockImplementation(() => {});
  const { service } = conversationService(1);
  let active!: AbortSignal;
  service.config.brain.answer.mockImplementation(async (_agent: unknown, _history: unknown, _text: unknown, signal: AbortSignal) => {
    active = signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    const work = (runtime as any).task(() => runtime.utterance('human', 'Ruby explain this'), 'human');
    await vi.waitFor(() => expect(active).toBeDefined());
    (runtime as any).assembler.pause('human');
    await work;
    expect(active.aborted).toBe(true);
    expect(capture).not.toHaveBeenCalled();
    const signals = state.room.localParticipant.publishData.mock.calls.map(([bytes]: any[]) => JSON.parse(new TextDecoder().decode(bytes)));
    expect(signals.some((signal: any) => signal.type === 'error')).toBe(false);
  } finally { await runtime.close(); capture.mockRestore(); }
});



it('VOICE-TIMEOUT-1: the call plays remaining Aura audio after RTC backpressure exceeds 30 seconds', async () => {
  const { service } = conversationService(1);
  service.agents.mockResolvedValue(roster.map(agent => ({ ...agent, voice: 'luna' })));
  service.config.brain.answer.mockImplementation(async () => ({ text: 'A spoken answer. '.repeat(50), order: false }));
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { body = controller; controller.enqueue(Buffer.alloc(960, 1)); },
  })));
  service.speech.mockResolvedValue(new AuraSpeech('test', 'account', fetcher) as any);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  const playback = deferred<void>();
  state.audio.captureFrame.mockImplementationOnce(() => playback.promise);
  vi.useFakeTimers();
  try {
    const work = runtime.utterance('human', 'Ruby explain this');
    await vi.waitFor(() => expect(state.audio.captureFrame).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(31000);
    body.enqueue(Buffer.alloc(960, 1)); body.close(); playback.resolve();
    await work;
    expect(state.audio.captureFrame).toHaveBeenCalledTimes(2);
    expect(service.recordAnswer).toHaveBeenCalledOnce();
    expect(state.room.localParticipant.publishData.mock.calls.map(([bytes]: any[]) => JSON.parse(new TextDecoder().decode(bytes)))
      .some((signal: any) => signal.type === 'error')).toBe(false);
  } finally { playback.resolve(); vi.useRealTimers(); await runtime.close(); }
});
