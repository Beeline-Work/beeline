import { expect, it, vi, VoiceService, VoiceRoomRuntime, spokenReport, RealVoiceService, migrate, PgliteDatabase, LiveHub, PhoneService, ConnectionPresence, state, roster, conversationService, phantomHarness, deferred } from './test-support-voice-room-runtime.test-support.js';



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


it.each(['stop', 'cancel', 'wait', 'no', 'Yeah', 'Please explain something else'])('preserves a real barge-in: %s', async text => {
  const harness = phantomHarness('Hey stop wait no there is the answer.');
  const runtime = await VoiceRoomRuntime.connect(harness.service as unknown as VoiceService, 'call', 'room');
  state.streams = [new ReadableStream()];
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(harness.service.config.stt).toHaveBeenCalledOnce());
    harness.emit('EndOfTurn', 'Explain the answer', 0);
    await vi.waitFor(() => expect(harness.speech.synthesize).toHaveBeenCalledOnce());
    harness.emit('Update', text, 1, [{ confidence: 0.95 }]);
    await vi.waitFor(() => expect(harness.speech.synthesize.mock.calls[0]?.[2]?.aborted).toBe(true));
    harness.emit('EndOfTurn', text, 1, [{ confidence: 0.95 }]);
    harness.emit('EndOfTurn', text, 1, [{ confidence: 0.95 }]);
    if (text === 'stop' || text === 'cancel') {
      await vi.waitFor(() => expect(harness.speech.synthesize.mock.calls[0]?.[2]?.aborted).toBe(true));
    expect(harness.service.leave).not.toHaveBeenCalled();
      expect(harness.service.recordHuman).toHaveBeenCalledOnce();
    } else {
      await vi.waitFor(() => expect(harness.service.reviseHuman).toHaveBeenCalledOnce());
      expect(harness.service.reviseHuman.mock.calls[0]?.[5]).toBe(`Explain the answer ${text}`);
      expect(harness.service.recordHuman).toHaveBeenCalledOnce();
    }
    expect(harness.speech.synthesize.mock.calls[0]?.[2]?.aborted).toBe(true);
  } finally { await runtime.close(); }
});


it('VOICE-CUTIN-1: a delayed membership read cannot cancel a newer finalized request', async () => {
  const harness = phantomHarness('Here is the answer.');
  const runtime = await VoiceRoomRuntime.connect(harness.service as unknown as VoiceService, 'call', 'room');
  state.streams = [new ReadableStream()];
  let release!: (value: number) => void;
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(harness.service.config.stt).toHaveBeenCalledOnce());
    harness.emit('EndOfTurn', 'Explain the answer', 0);
    await vi.waitFor(() => expect(harness.service.recordAnswer).toHaveBeenCalledOnce());
    harness.service.humanCount.mockImplementationOnce(() => new Promise<number>(resolve => { release = resolve; }));
    harness.emit('Update', 'wait', 1, [{ confidence: 0.95 }]);
    harness.emit('EndOfTurn', 'Please explain something else', 1);
    await vi.waitFor(() => expect(harness.speech.synthesize).toHaveBeenCalledTimes(2));
    release(1);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(harness.service.recordHuman).toHaveBeenCalledTimes(2);
    expect(harness.speech.synthesize.mock.calls.at(-1)?.[2].aborted).toBe(false);
  } finally { harness.finishPlayback(); await runtime.close(); }
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
    // A meaningful short utterance after playback is still a valid turn.
    harness.emit('EndOfTurn', 'continue', 2);
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
  const service = { runtimeScope: vi.fn(async (roomId: string) => ({workspaceId:'human',authorityRoomId:roomId})), workspaceId: vi.fn(async () => 'human'), endWorkspaceCalls: vi.fn(async () => {}), callWorkState: vi.fn(async () => ({pending:false,finishedAt:0})), hasCallWork: vi.fn(async () => false), endInactive: vi.fn(async () => false), budget: { fence: async (_call: string, _owner: string, enqueue: () => void) => { enqueue(); return true; }, read: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), record: vi.fn(async () => ({ remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' })), limitMs: 3600000 }, owner: 'owner', config: { url: 'ws://local', apiKey: 'devkey', apiSecret: 'secret', brain: { answer } },
    access: vi.fn(async () => {}),
    lastActiveAgent: vi.fn(async () => undefined),
    humanCount: vi.fn(async () => 1), agents: vi.fn(async () => agents), recordHuman, recordAnswer: vi.fn(async () => {}),
    db: { query: vi.fn(async () => ({ rowCount: 1, rows: [] })) }, runtimeClosed: vi.fn() } as unknown as VoiceService;
  const runtime = await VoiceRoomRuntime.connect(service, 'call', 'room');
  // Exercise the turn boundary with transport/provider doubles, including actual playback selection.
  const play = vi.spyOn(runtime as any, 'play').mockImplementation(async (_text, _agent, _signal, firstAudio: any, boundary: any) => { await boundary?.(); firstAudio?.(); });
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
  let receive!: (event: any) => void;
  service.config.stt.mockImplementation(async (callback: any) => { receive = callback; return { send() {}, close() {} }; });
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
    state.streams = [new ReadableStream()];
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(receive).toBeDefined();
    receive({ event: 'EndOfTurn', transcript: 'Ruby this sentence is finished.', turn_index: 0, sequence_id: 0 });
    await vi.advanceTimersByTimeAsync(200);
    expect({ committed, audible }).toEqual({ committed: 1011, audible: 1076 });
    console.log('FINISHED-SENTENCE timing fixture:', JSON.stringify({ endOfTurnToCommitMs: committed - 1000, endOfTurnToFirstAudioMs: audible - 1000, eotThreshold: 0.7, eotTimeoutMs: 1000, providerAndTransport: 'controlled doubles' }));
  } finally { await runtime.close(); vi.useRealTimers(); }
});


it('Reproduction CONTINUATION-1: resumes during thinking without creating another message', async () => {
  const { service } = conversationService(1);
  const logs = vi.spyOn(console, 'info');
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
    const cancelled = logs.mock.calls.filter(([tag]) => tag === '[voice-draft-cancelled]').map(([, data]) => JSON.parse(String(data)));
    expect(cancelled).toEqual([expect.objectContaining({ reason: 'superseded', traceId: expect.any(String), elapsedMs: expect.any(Number) })]);
    console.log('CONTINUATION-1: one message, combined request, one reply');
  } finally { await runtime.close(); logs.mockRestore(); }
});


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


it('multi-human-silence-1: the same human can continue a pending pre-audio request', async () => {
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
    expect(service.reviseHuman).toHaveBeenCalledOnce();
    expect(service.config.brain.answer).toHaveBeenCalledTimes(2);
    expect(state.room.localParticipant.publishData.mock.calls.some(([bytes]: any[]) => JSON.parse(new TextDecoder().decode(bytes)).type === 'unaddressed')).toBe(false);
  } finally { await runtime.close(); }
});


it('quiet PCM keeps assembly open until a voiced answer is accepted', async () => {
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
    expect(state.audio.captureFrame).not.toHaveBeenCalled();
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
    expect(service.recordAnswer).toHaveBeenCalledOnce();
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
    const frames = state.audio.captureFrame.mock.calls.length;
    const second = runtime.utterance('human', 'Ruby another');
    await vi.waitFor(() => expect(state.audio.captureFrame.mock.calls.length).toBeGreaterThan(frames));
    expect(service.recordAnswer).toHaveBeenCalledOnce();
    persistence.resolve(); await Promise.all([first, second]);
    expect(service.recordHuman).toHaveBeenCalledTimes(2);
    expect(service.recordAnswer).toHaveBeenCalledTimes(2);
  } finally { persistence.resolve(); await runtime.close(); }
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
    expect(state.audio.captureFrame).not.toHaveBeenCalled();
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
    expect(state.audio.captureFrame).not.toHaveBeenCalled();
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
    expect(speech.synthesize.mock.calls.map(call => call[0])).toEqual(['An unheard partial answer.', 'One complete reply.']);
    expect(speech.synthesize.mock.calls[0]?.[2].aborted).toBe(true);
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
    await vi.waitFor(() => expect(service.recordAnswer).toHaveBeenCalledWith('room', 'ruby', 'I’m here. What do you need?', expect.any(Object)));
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
  const presence = new ConnectionPresence(db, live);
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
    const failed = (await db.query(`SELECT text FROM messages WHERE card_type='turn-failed'`)).rows;
    const status = (await db.query<{ body: { status: string } }>(`SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence'`, [agent])).rows[0]!.body.status;
    note(`after both replies: presence=${status}, offline notices=${failed.length}`);
    expect(failed).toEqual([]);
    expect(status).toBe('online');
    await runtime.close();
  } finally {
    console.log('Demonstration MULTI-1\n' + timeline.join('\n'));
    for (const [i, sample] of latency.entries()) console.log(`latency turn ${i}: end of speech -> brain start ${sample.brain.toFixed(1)} ms`);
    await presence.stop(); await voice.close(); await db.close();
  }
}, 30_000);
