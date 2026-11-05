import { expect, it, vi, VoiceService, telemetry, VoiceRoomRuntime, spokenReport, AuraSpeech, state, roster, conversationService, deferred, multiCall } from './voice-room-runtime.test-support.js';



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



it('VOICE-TIMEOUT-1: a real stalled Aura request still publishes a plain retry message and is captured', async () => {
  const capture = vi.spyOn(telemetry, 'captureServerError').mockImplementation(() => {});
  const { service } = conversationService(1);
  service.agents.mockResolvedValue(roster.map(agent => ({ ...agent, voice: 'luna' })));
  const fetcher = vi.fn<typeof fetch>(async () => new Promise<Response>(() => {}));
  service.speech.mockResolvedValue(new AuraSpeech('test', 'account', fetcher) as any);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  vi.useFakeTimers();
  try {
    const work = (runtime as any).task(() => runtime.utterance('human', 'Ruby explain this'), 'human');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(5000); await work;
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ message: 'Voice provider timed out; please try again' }), expect.objectContaining({ surface: 'voice' }));
    const signals = state.room.localParticipant.publishData.mock.calls.map(([bytes]: any[]) => JSON.parse(new TextDecoder().decode(bytes)));
    expect(signals).toContainEqual({ type: 'error', message: 'Voice reply unavailable; please try again' });
  } finally { vi.useRealTimers(); await runtime.close(); capture.mockRestore(); }
});



it('Reproduction VOICE-DISPOSE-1: ending a call while synthesis unwinds never clears disposed audio', async () => {
  const { service, speech } = conversationService(1);
  const release = deferred<void>();
  const entered = deferred<void>();
  speech.synthesize.mockImplementation(async function* () {
    entered.resolve();
    await release.promise;
    throw new DOMException('Interrupted', 'AbortError');
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  let disposed = false;
  const audio = state.audio;
  audio.close = vi.fn(async () => { disposed = true; });
  audio.clearQueue.mockImplementation(() => {
    if (disposed) throw new Error('Invalid request: handle not found: ClearAudioBuffer source_handle 1');
  });
  const work = runtime.utterance('human', 'Ruby explain this');
  const outcome = work.catch(error => error);
  try {
    await entered.promise;
    await vi.waitFor(() => expect((runtime as any).speaking).toBeDefined());
    await new Promise<void>(resolve => setImmediate(resolve));
    await runtime.close();
    expect(disposed).toBe(true);
    const clears = audio.clearQueue.mock.calls.length;
    (runtime as any).interruptPlayback();
    release.resolve();
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    await (runtime as any).speechIdle;
    expect((runtime as any).speaking).toBeUndefined();
    expect(audio.clearQueue).toHaveBeenCalledTimes(clears);
    expect(service.runtimeClosed).toHaveBeenCalledOnce();
  } finally { release.resolve(); await outcome; await runtime.close(); }
});



it('VOICE-DISPOSE-1: live audio failures remain observable and release turn cleanup', async () => {
  const { service } = conversationService(1);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  const failure = new Error('unexpected live audio failure');
  state.audio.clearQueue.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw failure; });
  try {
    await expect(runtime.utterance('human', 'Ruby explain this')).rejects.toBe(failure);
    await (runtime as any).speechIdle;
    expect((runtime as any).speaking).toBeUndefined();
  } finally { await runtime.close(); }
});


it('Reproduction R3: pins and unpins route only the participant who sent them', async () => {
  const call = multiCall(2);
  const runtime = await VoiceRoomRuntime.connect(call.service as unknown as VoiceService, 'call', 'room');
  try {
    call.roomData('alex', {type:'target',agentId:'ruby',tap:true});
    call.roomData('sam', {type:'target',agentId:'goose',tap:true});
    await vi.waitFor(() => expect((runtime as any).explicitTargets.size).toBe(2));
    await runtime.utterance('alex', 'Please help');
    await runtime.utterance('sam', 'Please help');
    call.roomData('alex', {type:'unpin'});
    await vi.waitFor(() => expect((runtime as any).explicitTargets.has('alex')).toBe(false));
    await runtime.utterance('alex', 'Please help');
    await runtime.utterance('sam', 'More please');
    expect(call.answered()).toEqual(['ruby','goose','goose']);
    expect(call.signals('alex')).toContainEqual({type:'unaddressed'});
    expect((runtime as any).explicitTargets.get('sam')).toBe('goose');
  } finally { await runtime.close(); }
});


it('Reproduction R1: the quick answer and search acknowledgement are clean before posting and synthesis', async () => {
  const { service, speech } = conversationService(1);
  service.config.brain.answer.mockImplementation(async (_agent, _history, _onText, _signal, context) => {
    await context!.announce('**Ruby:** Let me look.');
    return {text:'Ruby: Here is the answer.', order:false};
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    await runtime.utterance('human','Ruby, what is new?');
    expect(service.recordAnswer.mock.calls.map(call=>call[2])).toEqual(['Let me look.', 'Here is the answer.']);
    expect(speech.synthesize.mock.calls.map(call=>call[0])).toEqual(['Let me look.', 'Here is the answer.']);
  } finally { await runtime.close(); }
});


it('VOICE-TAG-1: only final replies route handles, while spoken audio uses names', async () => {
  const { service, speech } = conversationService(1);
  service.config.brain.answer.mockImplementation(async (_agent, _history, _onText, _signal, context) => {
    expect(context!.agents).toContainEqual({name:'Ruby',handle:'ruby'});
    await context!.announce('@ruby let me look.');
    return {text:'@ruby what are you up to?',order:false};
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService,'call','room');
  try {
    await runtime.utterance('human','Ruby, ask the other agent');
    expect(service.recordAnswer.mock.calls.map(call=>[call[2],(call[3] as any).routeMentions])).toEqual([
      ['@ruby let me look.',false],['@ruby what are you up to?',true],
    ]);
    expect(service.recordAnswer.mock.calls[1]?.[3]).toMatchObject({sourceId:'source',replyId:expect.any(String)});
    expect(speech.synthesize.mock.calls.map(call=>call[0])).toEqual(['Ruby let me look.','Ruby what are you up to?']);
  } finally { await runtime.close(); }
});


it('VOICE-TAG-1: order acknowledgements leave agent mentions to the heavy final reply', async () => {
  const {service} = conversationService(1);
  service.config.brain.answer.mockResolvedValue({text:'I will ask @ruby.',order:true});
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService,'call','room');
  try {
    await runtime.utterance('human','Ruby, do the work');
    expect(service.dispatch).toHaveBeenCalledOnce();
    expect(service.recordAnswer).toHaveBeenCalledWith('room','ruby','I will ask @ruby.',expect.objectContaining({routeMentions:false}));
  } finally { await runtime.close(); }
});


it.each([1.15, 1.3, 1.5].flatMap(speed => [1, 5].flatMap(silentFrames => [0, 1, -1, 150, -150].map(padding => ({ speed, silentFrames, padding })))))('VOICE-SPEED-ONSET: preserves first voiced publication ($speed x, $silentFrames frames, padding $padding)', async ({ speed, silentFrames, padding }) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  const { service, speech } = conversationService(1);
  service.config.brain.answer.mockImplementation(async () => ({ text: 'Hello there.', order: false }));
  speech.synthesize.mockImplementation(async function* () {
    for (let frame = 0; frame < silentFrames + 10; frame++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      const pcm = Buffer.alloc(960);
      if (frame < silentFrames) for (let i = 0; i < 480; i++) pcm.writeInt16LE(padding, i * 2);
      if (frame >= silentFrames) for (let i = 0; i < 480; i++)
        pcm.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * 220 * ((frame - silentFrames) * 480 + i) / 24000)), i * 2);
      yield pcm;
    }
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  let firstVoiced = -1;
  const start = performance.now();
  state.audio.captureFrame.mockImplementation(async (frame: { data: Int16Array }) => {
    if (firstVoiced < 0 && frame.data.some(value => Math.abs(value) > 150)) firstVoiced = performance.now() - start;
  });
  try {
    (runtime as any).speakingSpeeds.set('human', speed);
    const work = runtime.utterance('human', 'Ruby say hello');
    await vi.advanceTimersByTimeAsync(500); await work;
    expect(firstVoiced).toBe((silentFrames + 1) * 20);
    console.log('VOICE-SPEED-ONSET', { speed, silentFrames, padding, firstVoicedMs: firstVoiced });
  } finally { await runtime.close(); vi.useRealTimers(); }
});


it.each([false, true])('VOICE-SPEED-1: overlaps opening synthesis with generation (prefetch=%s)', async prefetch => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const { service, speech } = conversationService(1);
  let audible = -1, synthesized = -1;
  service.config.brain.answer.mockImplementation(async (_agent, _history, onText) => {
    await delay(40);
    if (prefetch) onText('Hello there. ');
    await delay(160);
    return { text: 'Hello there.', order: false };
  });
  speech.synthesize.mockImplementation(async function* () {
    synthesized = performance.now(); await delay(100); yield new Uint8Array([200, 1]);
  });
  state.audio = undefined;
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  state.audio.captureFrame.mockImplementation(async () => { audible = performance.now(); });
  const start = performance.now();
  try {
    const work = runtime.utterance('human', 'Ruby say hello');
    await vi.advanceTimersByTimeAsync(400); await work;
    expect(audible - start).toBe(prefetch ? 200 : 300);
    expect(synthesized - start).toBe(prefetch ? 40 : 200);
    console.log('VOICE-SPEED-1', { prefetch, firstAudioMs: audible - start, synthesisStartMs: synthesized - start });
  } finally { await runtime.close(); vi.useRealTimers(); }
});


it.each([false, true])('VOICE-SPEED-2: eager work stays inaudible until final and cancels on resumed speech (%s)', async resumed => {
  const { service, speech } = conversationService(1);
  let receive!: (event: any) => void;
  let speculativeSignal!: AbortSignal;
  const brainGate = deferred<void>();
  service.config.stt.mockImplementation(async callback => { receive = callback; return { send() {}, close() {} }; });
  service.config.brain.answer.mockImplementation(async (...args: any[]) => {
    speculativeSignal = args[3]; args[2]('Hello there. ');
    await brainGate.promise;
    return { text: 'Hello there.', order: false };
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  state.streams = [new ReadableStream()];
  const event = (kind: string, transcript = 'Ruby say hello') => receive({ event: kind, transcript, turn_index: 0, sequence_id: 0,
    words: [{ word: 'Ruby', confidence: .99, start: 0, end: .2 }, { word: 'hello', confidence: .99, start: .2, end: .5 }] });
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(receive).toBeDefined());
    event('EagerEndOfTurn');
    await vi.waitFor(() => expect(service.config.brain.answer).toHaveBeenCalledOnce());
    expect(service.recordHuman).not.toHaveBeenCalled();
    expect(speech.synthesize).not.toHaveBeenCalled();
    expect(state.audio.captureFrame).not.toHaveBeenCalled();
    if (resumed) {
      event('TurnResumed', '');
      await vi.waitFor(() => expect(speculativeSignal.aborted).toBe(true));
      brainGate.resolve();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(state.audio.captureFrame).not.toHaveBeenCalled();
      event('EndOfTurn');
      await vi.waitFor(() => expect(state.audio.captureFrame).toHaveBeenCalled());
      expect(service.config.brain.answer).toHaveBeenCalledTimes(2);
      expect(service.recordHuman).toHaveBeenCalledOnce();
    } else {
      brainGate.resolve();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(state.audio.captureFrame).not.toHaveBeenCalled();
      event('EndOfTurn');
      await vi.waitFor(() => expect(state.audio.captureFrame).toHaveBeenCalled());
      expect(service.config.brain.answer).toHaveBeenCalledOnce();
      expect(service.recordHuman).toHaveBeenCalledOnce();
    }
  } finally { brainGate.resolve(); await runtime.close(); }
});


it('VOICE-SPEED-3: speculative order audio never plays before dispatch commits', async () => {
  const { service, speech } = conversationService(1);
  const decision = deferred<void>(), commit = deferred<void>();
  service.config.brain.answer.mockImplementation(async (_agent, _history, onText) => {
    onText('Checking now. '); await decision.promise;
    return { text: 'Checking now.', order: true };
  });
  service.dispatch.mockImplementation(async () => commit.promise);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  const work = runtime.utterance('human', 'Ruby check my latest report');
  try {
    await vi.waitFor(() => expect(speech.synthesize).toHaveBeenCalledOnce());
    expect(state.audio.captureFrame).not.toHaveBeenCalled(); expect(service.dispatch).not.toHaveBeenCalled();
    decision.resolve();
    await vi.waitFor(() => expect(service.dispatch).toHaveBeenCalledOnce());
    expect(state.audio.captureFrame).not.toHaveBeenCalled();
    commit.resolve(); await work;
    expect(state.audio.captureFrame).toHaveBeenCalledOnce();
    expect(speech.synthesize).toHaveBeenCalledOnce();
  } finally { decision.resolve(); commit.resolve(); await work; await runtime.close(); }
});


it('VOICE-SPEED-4: discards an opening changed by the final routing decision', async () => {
  const { service, speech } = conversationService(1);
  const decision = deferred<void>();
  service.config.brain.answer.mockImplementation(async (_agent, _history, onText) => {
    onText('I will do that. ');
    await decision.promise;
    return { text: 'Which report do you mean?', order: false };
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  const work = runtime.utterance('human', 'Ruby check a report');
  try {
    await vi.waitFor(() => expect(speech.synthesize).toHaveBeenCalledOnce());
    expect(state.audio.captureFrame).not.toHaveBeenCalled();
    const speculativeSignal = speech.synthesize.mock.calls[0]![2];
    decision.resolve(); await work;
    expect(speculativeSignal.aborted).toBe(true);
    expect(speech.synthesize.mock.calls.map(call => call[0])).toEqual(['I will do that.', 'Which report do you mean?']);
    expect(service.dispatch).not.toHaveBeenCalled();
    expect(state.audio.captureFrame).toHaveBeenCalledOnce();
  } finally { decision.resolve(); await work; await runtime.close(); }
});


it('VOICE-EXTERNAL-2: loads Room webhook names at input start for hints and both call prompt paths', async () => {
  const { service } = conversationService(1);
  const originalQuery = service.db.query.getMockImplementation()!;
  service.db.query.mockImplementation(async (sql, params) => sql.includes('FROM agent_subscriptions')
    ? { rowCount: 1, rows: [{ name: 'Grok bot' }] }
    : originalQuery(sql, params));
  let onSpeech!: (event: any) => void;
  service.config.stt.mockImplementation(async (callback: any) => {
    onSpeech = callback; return { send() {}, close() {} };
  });
  state.streams = [new ReadableStream()];
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(onSpeech).toBeDefined());
    expect(service.config.stt.mock.calls[0]?.[2]).toEqual([...roster.flatMap(agent => [agent.name, agent.handle]), 'Grok bot']);
    const reads = () => service.db.query.mock.calls.filter(([sql]) => sql.includes('FROM agent_subscriptions'));
    expect(reads()).toEqual([[expect.stringContaining("source='webhook'"), ['room']]]);
    onSpeech({ event: 'EagerEndOfTurn', turn_index: 0, transcript: 'Ruby, tell Grok bot hello',
      words: 'Ruby tell Grok bot hello'.split(' ').map((word, index) => ({ word, confidence: 0.99, start: index * 0.2, end: index * 0.2 + 0.2 })) });
    await vi.waitFor(() => expect(service.config.brain.answer).toHaveBeenCalled());
    expect((service.config.brain.answer.mock.calls.at(-1) as any)?.[4].externalContacts).toEqual(['Grok bot']);
    await runtime.utterance('human', 'Ruby, message Grok bot again');
    expect((service.config.brain.answer.mock.calls.at(-1) as any)?.[4].externalContacts).toEqual(['Grok bot']);
    expect(reads()).toHaveLength(1);
  } finally { await runtime.close(); }
});


it('VOICE-EXTERNAL-2: Room agents keep priority inside the speech hint cap', async () => {
  const { service } = conversationService(1);
  const originalQuery = service.db.query.getMockImplementation()!;
  service.db.query.mockImplementation(async (sql, params) => sql.includes('FROM agent_subscriptions')
    ? { rowCount: 80, rows: Array.from({ length: 80 }, (_, i) => ({ name: `Contact ${i}` })) }
    : originalQuery(sql, params));
  service.config.stt.mockResolvedValue({ send() {}, close() {} });
  state.streams = [new ReadableStream()];
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(service.config.stt).toHaveBeenCalled());
    const hints = service.config.stt.mock.calls[0]?.[2] as string[];
    expect(hints).toHaveLength(80);
    expect(hints.slice(0, roster.length * 2)).toEqual(roster.flatMap(agent => [agent.name, agent.handle]));
    expect(hints.at(-1)).toBe(`Contact ${79 - roster.length * 2}`);
  } finally { await runtime.close(); }
});


it('VOICE-EXTERNAL-2: the contact read overlaps existing input startup reads', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  const { service } = conversationService(1);
  state.streams = [new ReadableStream()];
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const originalQuery = service.db.query.getMockImplementation()!;
  service.agents.mockImplementation(async () => { await delay(20); return roster; });
  service.budget.read.mockImplementation(async () => {
    await delay(15); return { remainingMs: 3600000, resetAt: Date.now() + 86400000, timeZone: 'UTC' };
  });
  service.db.query.mockImplementation(async (sql, params) => {
    if (sql.includes('FROM agent_subscriptions')) {
      await delay(10); return { rowCount: 1, rows: [{ name: 'Grok bot' }] };
    }
    return originalQuery(sql, params);
  });
  let readyAt = -1;
  service.config.stt.mockImplementation(async () => {
    readyAt = performance.now(); return { send() {}, close() {} };
  });
  const began = performance.now();
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.advanceTimersByTimeAsync(40);
    expect(readyAt - began).toBe(20);
    console.log('VOICE-EXTERNAL-2 input startup controlled reads', { inputReadyMs: readyAt - began });
  } finally { await runtime.close(); vi.useRealTimers(); }
});


it.each(Array.from({ length: 4 }, (_, run) => [
  { contact: 'Grok', fragment: 'Grok', run },
  ...['Grok', 'Grok bot', 'Grok Bot?'].map(fragment => ({ contact: 'Grok bot', fragment, run })),
]).flat())('SPEEDY-CONTACT-1: stored contact fragment $fragment ($contact, run $run) waits silently without eager or final handoff', async ({ contact, fragment, run }) => {
  const { service, speech } = conversationService(1);
  const original = service.db.query.getMockImplementation()!;
  service.db.query.mockImplementation(async (sql, args) => sql.includes("source='webhook'")
    ? { rowCount: 1, rows: [{ name: contact }] } : original(sql, args));
  let receive!: (event: any) => void;
  service.config.stt.mockImplementation(async callback => { receive = callback; return { send() {}, close() {} }; });
  service.config.brain.answer.mockResolvedValue({ text: 'On it.', order: true });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  state.streams = [new ReadableStream()];
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(receive).toBeDefined());
    const words = fragment.split(' ').map(word => ({ word, confidence: .99, start: 0, end: .4 }));
    receive({ event: 'EagerEndOfTurn', transcript: fragment, turn_index: 0, words });
    receive({ event: 'EndOfTurn', transcript: fragment, turn_index: 0, words });
    await vi.waitFor(() => expect(service.recordHuman).toHaveBeenCalledOnce());
    expect(service.recordHuman.mock.calls[0]?.[4]).toBe(fragment);
    expect(service.recordAnswer).not.toHaveBeenCalled();
    expect(speech.synthesize).not.toHaveBeenCalled();
    expect(state.audio.captureFrame).not.toHaveBeenCalled();
    expect(service.config.brain.answer).not.toHaveBeenCalled();
    expect(service.dispatch).not.toHaveBeenCalled();
    const message = ['Tell Grok bot hello', 'Tell Crock Pot hello', 'Email Alex hello', 'Message Alex on Telegram'][run]!;
    receive({ event: 'EndOfTurn', transcript: message, turn_index: 1,
      words: message.split(' ').map(word => ({ word, confidence: .99, start: 0, end: .4 })) });
    await vi.waitFor(() => expect(service.dispatch).toHaveBeenCalledOnce());
    expect(service.config.brain.answer).toHaveBeenCalledOnce();
    expect(service.dispatch).toHaveBeenCalledOnce();
    expect(service.recordHuman).toHaveBeenCalledOnce();
    expect(service.reviseHuman.mock.calls[0]?.[5]).toBe(`${fragment} ${message}`);
    await vi.waitFor(() => expect(service.recordAnswer).toHaveBeenCalledOnce());
    expect(speech.synthesize.mock.calls.map(call => call[0])).toEqual(['On it.']);
    expect(state.audio.captureFrame).toHaveBeenCalledOnce();
  } finally { await runtime.close(); }
});


it.each([1.15, 1.3, 1.5])('SPEAKING-SPEED-1: input loads %sx once; next reply uses refreshed preference', async speed => {
  const { service, speech } = conversationService(1);
  let preference = speed;
  let reads = 0;
  const originalQuery = service.db.query.getMockImplementation()!;
  service.db.query.mockImplementation(async (sql, parameters) => {
    if (sql.includes('speaking_speed')) { reads++; return {rowCount:1,rows:[{speaking_speed:preference}]}; }
    return originalQuery(sql, parameters);
  });
  service.config.stt.mockResolvedValue({send() {}, close() {}});
  service.config.brain.answer.mockResolvedValue({text:'Hello there.',order:false});
  speech.synthesize.mockImplementation(async function* () {
    const pcm = Buffer.alloc(24000 * 2);
    for (let i = 0; i < 24000; i++) pcm.writeInt16LE(Math.round(12000 * Math.sin(2*Math.PI*220*i/24000)),i*2);
    yield pcm;
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService,'call','room');
  state.streams = [new ReadableStream()];
  try {
    state.room.emit('track',{kind:1},{},{identity:'human'});
    await vi.waitFor(() => expect(service.config.stt).toHaveBeenCalledOnce());
    expect(reads).toBe(1);
    const play = async (expected: number) => {
      state.audio.captureFrame.mockClear();
      await runtime.utterance('human','Ruby say hello');
      const samples = state.audio.captureFrame.mock.calls.reduce((n: number, [frame]: any[]) => n + frame.data.length, 0);
      expect(samples).toBe(Math.round(24000/expected));
    };
    await play(speed); await play(speed);
    expect(reads).toBe(1);
    preference = speed === 1.5 ? 1.15 : 1.5;
    await runtime.refreshSpeakingSpeed('human');
    await play(preference);
    expect(reads).toBe(2);
    service.db.query.mockImplementation(async (sql, parameters) => {
      if (sql.includes('speaking_speed')) throw new Error('Preference unavailable');
      return originalQuery(sql, parameters);
    });
    await runtime.refreshSpeakingSpeed('human');
    await play(1.15);
  } finally { await runtime.close(); }
});


it('SPEEDY-SEARCH-1: resuming during search acknowledgement revises the original request', async () => {
  const {service} = conversationService(1);
  let receive: any;
  service.config.stt.mockImplementation(async callback => { receive = callback; return {send() {}, close() {}}; });
  const gate = deferred<void>();
  service.config.brain.answer.mockImplementation(async (...args: any[]) => {
    if (service.config.brain.answer.mock.calls.length === 1) {
      await args[4].announce('Let me look.');
      await gate.promise;
    }
    return {text:'Here is the result.', order:false};
  });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  state.streams = [new ReadableStream()];
  let work: Promise<void> | undefined;
  try {
    state.room.emit('track', {kind:1}, {}, {identity:'human'});
    await vi.waitFor(() => expect(receive).toBeDefined());
    work = runtime.utterance('human', 'Ruby search the weather').catch(() => {});
    await vi.waitFor(() => expect(service.recordAnswer).toHaveBeenCalledOnce());
    receive({event:'StartOfTurn', transcript:'in Istanbul', turn_index:1, sequence_id:1,
      words:[{word:'in',confidence:.99,start:0,end:.2},{word:'Istanbul',confidence:.99,start:.2,end:.5}]});
    await new Promise(resolve => setTimeout(resolve, 10));
    receive({event:'EndOfTurn', transcript:'in Istanbul', turn_index:1, sequence_id:2});
    await vi.waitFor(() => expect(service.config.brain.answer).toHaveBeenCalledTimes(2));
    expect(service.recordHuman).toHaveBeenCalledOnce();
    expect(service.config.brain.answer.mock.calls[0]![3].aborted).toBe(true);
    expect(service.reviseHuman.mock.calls.at(-1)?.[5]).toBe('Ruby search the weather in Istanbul');
  } finally {gate.resolve(); await work; await runtime.close();}
});


it.each(['to', ''])('SPEEDY-RESUME-1: same-turn final after filtered resume %s completes the joined request', async word => {
  const {service} = conversationService(1);
  let receive: any;
  service.config.stt.mockImplementation(async callback => {receive=callback;return {send(){},close(){}};});
  const gate=deferred<void>();
  service.config.brain.answer.mockImplementation(async (...args:any[]) => {
    if(service.config.brain.answer.mock.calls.length===1) await gate.promise;
    return {text:'Fine.',order:false};
  });
  const runtime=await VoiceRoomRuntime.connect(service as unknown as VoiceService,'call','room');
  state.streams=[new ReadableStream()];
  try {
    state.room.emit('track',{kind:1},{},{identity:'human'});
    await vi.waitFor(()=>expect(receive).toBeDefined());
    receive({event:'EndOfTurn',transcript:'Ruby send a message',turn_index:0,sequence_id:0});
    await vi.waitFor(()=>expect(service.config.brain.answer).toHaveBeenCalledOnce());
    receive({event:'TurnResumed',transcript:word,turn_index:0,sequence_id:1,words:word ? [{word,confidence:.99,start:0,end:.2}] : []});
    receive({event:'EndOfTurn',transcript:'Ruby send a message to Grok Bot',turn_index:0,sequence_id:2});
    await new Promise(resolve=>setTimeout(resolve,20));
    expect(service.config.brain.answer).toHaveBeenCalledTimes(2);
    expect(service.config.brain.answer.mock.calls[0]![3].aborted).toBe(true);
    expect(service.reviseHuman.mock.calls.at(-1)?.[5]).toBe('Ruby send a message to Grok Bot');
  } finally {gate.resolve();await runtime.close();}
});
