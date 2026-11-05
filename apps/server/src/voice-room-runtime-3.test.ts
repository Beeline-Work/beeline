import { backgroundWork, expect, it, vi, voiceTempo, markdownToSpeech, VoiceService, VoiceRoomRuntime, spokenReport, AuraSpeech, OpenRouterVoiceBrain, RealVoiceService, migrate, PgliteDatabase, LiveHub, routeHumanMessage, PhoneService, state, roster, conversationService, deferred, multiCall } from './voice-room-runtime.test-support.js';



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
    const timer = vi.spyOn(backgroundWork, 'startConnectionWork').mockImplementation(() => () => {});
    const joined = await owner.join(room, human);
    const call = (await db.query<any>(`SELECT * FROM voice_calls WHERE id=$1`, [joined.call.id])).rows[0];
    const runtime = (await owner.ensureRuntime(call))!;
    state.room.remoteParticipants.clear();
    state.room.remoteParticipants.set(human, { identity: human, trackPublications: new Map() });
    const retainedRoom = state.room;
    const phone = new PhoneService(db, 'http://proof');
    const tick = () => (runtime as any).checkInactivity();
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
  const intervals=vi.spyOn(backgroundWork,'startConnectionWork').mockImplementation(() => () => {});
  const {service}=conversationService(1);
  const runtime=await VoiceRoomRuntime.connect(service as unknown as VoiceService,'call','room');
  const tick = () => (runtime as any).checkInactivity();
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
  const intervals=vi.spyOn(backgroundWork,'startConnectionWork').mockImplementation(() => () => {});
  const {service,speech}=conversationService(1);
  const held=new Promise<void>(resolve=>{release=resolve;});
  speech.synthesize.mockImplementation(async function*(){yield new Uint8Array(960).fill(5);await held;});
  const runtime=await VoiceRoomRuntime.connect(service as unknown as VoiceService,'call','room');
  const tick = () => (runtime as any).checkInactivity();
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
  const intervals=vi.spyOn(backgroundWork,'startConnectionWork').mockImplementation(() => () => {});
  const {service}=conversationService(2);
  const runtime=await VoiceRoomRuntime.connect(service as unknown as VoiceService,'call','room');
  const tick = () => (runtime as any).checkInactivity();
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


it('Reproduction VOICE-BOUND-2: two call audio pumps retain independent one-second bounds and one daily budget', async () => {
  const db = new PgliteDatabase();
  const { VoiceBudgetStore } = await import('./voice-budget.js');
  await db.query(`CREATE TABLE voice_calls(id text PRIMARY KEY,runtime_owner text,runtime_until timestamptz, room_id text,ended_at timestamptz);
    CREATE TABLE rooms(id text,workspace_id text);
    INSERT INTO rooms VALUES('room','human');
    CREATE TABLE voice_participants(call_id text,identity_id text);
    CREATE TABLE voice_workspace_usage(workspace_id text,call_id text,day_start bigint,audio int8multirange DEFAULT '{}',PRIMARY KEY(workspace_id,call_id,day_start));
    INSERT INTO voice_calls VALUES('a','owner','2099-01-01','room',NULL),('b','owner','2099-01-01','room',NULL);
    INSERT INTO voice_participants VALUES('a','human'),('b','human');`);
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const timers = vi.spyOn(backgroundWork, 'startConnectionWork').mockImplementation(() => () => {});
  const stores = [new VoiceBudgetStore(db), new VoiceBudgetStore(db)];
  const runtimes: VoiceRoomRuntime[] = [];
  const frames: ReadableStreamDefaultController<any>[] = [];
  const sends = [vi.fn(), vi.fn()];
  const failures: ReturnType<typeof vi.spyOn>[] = [];
  // Keep scheduled checkpoints frozen while exercising actual SDK-reader -> STT.send pumps.
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
    for (let i=0;i<2;i++) {
      now+=500;frames[i]!.enqueue({data:new Int16Array(8000)});
      await until(()=>(runtimes[i] as any).meter.diagnostics().heldBytes===16_000);
      expect(sends[i]).not.toHaveBeenCalled();
      await expect((runtimes[i] as any).meter.flush()).rejects.toThrow('outage');
    }
    now+=1000;for(const stream of frames)stream.enqueue({data:new Int16Array(16000)});
    await new Promise(resolve=>setImmediate(resolve));
    expect(sends.map(send=>send.mock.calls.length)).toEqual([0,0]);
    expect(runtimes.map(runtime=>(runtime as any).meter.diagnostics().heldBytes)).toEqual([16_000,16_000]);
    const snapshot=PgliteDatabase.fromSnapshot(await db.snapshot());
    try{expect((await new VoiceBudgetStore(snapshot).read('human')).remainingMs).toBe(3600000);}finally{await snapshot.close();}
    failures[0]!.mockRestore();await (runtimes[0] as any).meter.recover();
    expect(sends[0]).toHaveBeenCalledOnce();expect(sends[1]).not.toHaveBeenCalled();
    failures[1]!.mockRestore();await (runtimes[1] as any).meter.recover();
    expect(sends[1]).toHaveBeenCalledOnce();
    expect((await stores[0]!.read('human')).remainingMs).toBe(3599000);
    expect((await stores[1]!.read('human')).remainingMs).toBe(3599000);
  } finally {
    failures.forEach(spy => spy.mockRestore());
    for (const runtime of runtimes) await runtime.close();
    timers.mockRestore(); clock.mockRestore(); await db.close();
  }
});


it('CALL-ERROR-1: a database access outage retains the caller; confirmed denial removes them', async () => {
  const { service } = conversationService(1);
  const leave = vi.fn(async () => {});
  const runtime = await VoiceRoomRuntime.connect({ ...service, leave } as unknown as VoiceService, 'call', 'room');
  try {
    service.access.mockClear();
    service.access.mockRejectedValueOnce(Object.assign(new Error('network interrupted'), { code: 'ECONNRESET' }));
    await (runtime as any).heartbeat();
    expect(leave).not.toHaveBeenCalled(); expect(runtime.isClosed).toBe(false);
    expect(service.access).toHaveBeenCalledTimes(1);
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


it('CALL-ERROR-1: one failed lease attempt retains valid ownership, then expiry closes only the worker', async () => {
  const { service } = conversationService(1);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  vi.useFakeTimers();
  try {
    (runtime as any).nextLeaseAt=0;
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
    expect(Buffer.concat(frames)).toEqual(Buffer.concat(await Array.fromAsync(voiceTempo((async function* () { yield expected; })()))));
    expect(frames.slice(0, -1).every((frame: Buffer) => frame.length === 960)).toBe(true);
    expect(state.audio.waitForPlayout).toHaveBeenCalledOnce();
    console.log('AURA-413-1:', text.length, 'characters,', requests.length, 'requests,', frames.length, 'ordered PCM frames');
  } finally { await runtime.close(); }
});
