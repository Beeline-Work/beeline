import { expect, it, vi, VoiceService, VoiceRoomRuntime, RealVoiceService, SYSTEM_IDENTITY_ID, migrate, PgliteDatabase, LiveHub, PhoneService, groupBPostgresDatabase, state, conversationService, inputOwnerPostgresUrl } from './voice-room-runtime.test-support.js';



it.each([0, 1, 2, 3])('SPEEDY-CONTACT-2: silent contact then tell it hello retains recipient through service and phone reads (run %s)', async () => {
  const db = new PgliteDatabase(), live = new LiveHub();
  const human = 'a'.repeat(64), agent = 'b'.repeat(64);
  const workspace = '11111111-1111-4111-8111-111111111111', room = '22222222-2222-4222-8222-222222222222';
  const { service: fixture, speech } = conversationService(1);
  let receive!: (event: any) => void;
  fixture.config.stt.mockImplementation(async callback => { receive = callback; return { send() {}, close() {} }; });
  fixture.config.brain.answer.mockImplementation(async (_agent, history) => {
    expect(history.at(-1)?.content).toBe('Grok bot tell it hello');
    return { text: 'On it.', order: true };
  });
  const voice = new RealVoiceService(db, live, { ...fixture.config, speech });
  try {
    await migrate(db);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Human','human'),($2,'agent','Ruby','ruby')`, [human, agent]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, human]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Contact continuation proof')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [room, workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`, [workspace, human, agent, room]);
    await db.query(`INSERT INTO agent_subscriptions(id,workspace_id,room_id,agent_id,source,event,prompt,title)
      VALUES('33333333-3333-4333-8333-333333333333',$1,$2,$3,'webhook','webhook.called','Reply','Grok bot')`, [workspace, room, agent]);
    const joined = await voice.join(room, human);
    await voice.ensureRuntime((await db.query<any>(`SELECT * FROM voice_calls WHERE id=$1`, [joined.call.id])).rows[0]);
    state.streams = [new ReadableStream()];
    state.room.emit('track', { kind: 1 }, {}, { identity: human });
    await vi.waitFor(() => expect(receive).toBeDefined());
    const event = (transcript: string, turn: number) => receive({ event: 'EndOfTurn', transcript, turn_index: turn,
      words: transcript.split(' ').map(word => ({ word, confidence: .99, start: 0, end: .4 })) });
    const phone = new PhoneService(db, 'http://proof');
    event('Grok bot', 0);
    await vi.waitFor(async () => expect((await phone.readRoom(room, human))!.messages.filter(m => m.author.pubkey === human)).toHaveLength(1));
    expect(fixture.config.brain.answer).not.toHaveBeenCalled();
    expect(speech.synthesize).not.toHaveBeenCalled();
    expect(state.audio.captureFrame).not.toHaveBeenCalled();
    expect((await db.query(`SELECT * FROM agent_commands WHERE room_id=$1`, [room])).rowCount).toBe(0);
    event('tell it hello', 1);
    await vi.waitFor(async () => expect((await db.query(`SELECT * FROM agent_commands WHERE room_id=$1`, [room])).rowCount).toBe(1));
    await vi.waitFor(async () => expect((await phone.readRoom(room, human))!.messages.filter(m => m.author.pubkey === agent)).toHaveLength(1));
    const view = (await phone.readRoom(room, human))!;
    expect(view.messages.filter(m => m.author.pubkey === human).map(m => m.text)).toEqual(['@ruby Grok bot tell it hello']);
    expect(view.messages.filter(m => m.author.pubkey === agent).map(m => m.text)).toEqual(['On it.']);
    const sources = await db.query<{ text: string }>(`SELECT m.text FROM agent_commands c JOIN messages m ON m.id=c.source_message_id WHERE c.room_id=$1`, [room]);
    expect(sources.rows.map(row => row.text)).toEqual(['@ruby Grok bot tell it hello']);
    expect(fixture.config.brain.answer).toHaveBeenCalledOnce();
    expect(speech.synthesize.mock.calls.map(call => call[0])).toEqual(['On it.']);
    expect(state.audio.captureFrame).toHaveBeenCalledOnce();
  } finally { await voice.close(); await db.close(); }
}, 30_000);


it.each([
  ['stop', 'tell it hello', 'ruby'],
  ['Goosey', 'tell it hello', 'goose'],
  ['Claude bot', 'Claude bot tell it hello', 'ruby'],
  ['Grok bot', 'Grok bot tell it hello', 'ruby'],
])('SPEEDY-CONTACT-3: %s resets or refreshes a silent contact before the next task', async (next, expected, target) => {
  const { service, speech } = conversationService(1);
  const original = service.db.query.getMockImplementation()!;
  service.db.query.mockImplementation(async (sql, args) => sql.includes("source='webhook'")
    ? { rowCount: 2, rows: [{ name: 'Grok bot' }, { name: 'Claude bot' }] } : original(sql, args));
  let receive!: (event: any) => void;
  service.config.stt.mockImplementation(async callback => { receive = callback; return { send() {}, close() {} }; });
  service.config.brain.answer.mockResolvedValue({ text: 'On it.', order: true });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  state.streams = [new ReadableStream()];
  const emit = (transcript: string, turn: number) => receive({ event: 'EndOfTurn', transcript, turn_index: turn,
    words: transcript.split(' ').map(word => ({ word, confidence: .99, start: 0, end: .4 })) });
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(receive).toBeDefined());
    emit('Grok bot', 0);
    await vi.waitFor(() => expect(service.recordHuman).toHaveBeenCalledOnce());
    emit(next!, 1);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(service.config.brain.answer).not.toHaveBeenCalled();
    expect(service.dispatch).not.toHaveBeenCalled();
    expect(speech.synthesize).not.toHaveBeenCalled();
    expect(service.recordAnswer).not.toHaveBeenCalled();
    emit('tell it hello', 2);
    await vi.waitFor(() => expect(service.dispatch).toHaveBeenCalledOnce());
    const call = service.config.brain.answer.mock.calls[0]!;
    expect(call[0].id).toBe(target);
    expect(call[1].at(-1)?.content).toBe(expected);
    const recorded = service.reviseHuman.mock.calls.at(-1)?.[5] ?? service.recordHuman.mock.calls.at(-1)?.[4];
    expect(recorded).toBe(expected);
    expect(service.config.brain.answer).toHaveBeenCalledOnce();
  } finally { await runtime.close(); }
});


it.each([9999, 10000])('SPEEDY-CONTACT-4: silent contact draft has a ten-second idle limit (%s ms)', async delay => {
  const { service, speech } = conversationService(1);
  const original = service.db.query.getMockImplementation()!;
  service.db.query.mockImplementation(async (sql, args) => sql.includes("source='webhook'")
    ? { rowCount: 1, rows: [{ name: 'Grok bot' }] } : original(sql, args));
  service.config.stt.mockResolvedValue({ send() {}, close() {} });
  service.config.brain.answer.mockResolvedValue({ text: 'On it.', order: true });
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  state.streams = [new ReadableStream()];
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(service.config.stt).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    await runtime.utterance('human', 'Grok bot');
    await vi.advanceTimersByTimeAsync(delay);
    expect(service.config.brain.answer).not.toHaveBeenCalled();
    expect(service.dispatch).not.toHaveBeenCalled();
    expect(speech.synthesize).not.toHaveBeenCalled();
    expect(state.audio.captureFrame).not.toHaveBeenCalled();
    await runtime.utterance('human', 'tell it hello');
    const expected = delay < 10000 ? 'Grok bot tell it hello' : 'tell it hello';
    expect(service.config.brain.answer.mock.calls[0]?.[1].at(-1)?.content).toBe(expected);
    expect(service.dispatch).toHaveBeenCalledOnce();
    expect(service.recordHuman).toHaveBeenCalledTimes(delay < 10000 ? 1 : 2);
  } finally { await runtime.close(); vi.useRealTimers(); }
});



it('inactivity deadlines read only at warning, tone and end, then park until real activity', async () => {
  vi.useFakeTimers();
  const start = Date.now();
  const now = vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - start);
  const { service } = conversationService(2);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  try {
    await vi.advanceTimersByTimeAsync(0);
    service.callWorkState.mockClear();
    await vi.advanceTimersByTimeAsync(44_999);
    expect(service.callWorkState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(service.callWorkState).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(service.callWorkState).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(service.callWorkState).toHaveBeenCalledTimes(3);
    expect(service.endInactive).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.callWorkState).toHaveBeenCalledTimes(3);
    (runtime as any).markCallActivity();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(service.callWorkState).toHaveBeenCalledTimes(4);
  } finally { await runtime.close(); now.mockRestore(); vi.useRealTimers(); }
});



it('voice access failure stays parked until an independent resumed action', async () => {
  const { service } = conversationService(1);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  vi.useFakeTimers();
  service.access.mockClear();
  service.access.mockRejectedValue(Object.assign(new Error('Synthetic unavailable'), { code: 'ECONNRESET' }));
  try {
    await (runtime as any).heartbeat();
    // Lease ownership is measured separately; this proof counts access reads.
    clearInterval((runtime as any).leaseRenewal);
    clearTimeout((runtime as any).leaseExpiry);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(service.access).toHaveBeenCalledOnce();
    service.access.mockResolvedValue(undefined);
    state.room.remoteParticipants.set('human', { identity: 'human', trackPublications: new Map() });
    await runtime.resume('human');
    expect(service.access).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); await runtime.close(); }
});


it('F17: five-second owner evidence is serialized and contains no participant, budget or projection observation',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','Date','performance']});const {service}=conversationService(1);
  const runtime=await VoiceRoomRuntime.connect(service as unknown as VoiceService,'call','room');
  try{
    service.db.query.mockClear();service.access.mockClear();service.humanCount.mockClear();service.budget.read.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(service.db.query).toHaveBeenCalledTimes(2);
    expect(service.db.query.mock.calls.every(([sql])=>sql.includes("UPDATE voice_calls SET runtime_until=clock_timestamp()+interval '15 seconds'"))).toBe(true);
    expect(service.access).not.toHaveBeenCalled();expect(service.humanCount).not.toHaveBeenCalled();expect(service.budget.read).not.toHaveBeenCalled();
  }finally{await runtime.close();vi.useRealTimers();}
});


it('F17: failed control evidence owns no failure retry; actual recovery duringflight is latched once behind the quota',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','Date','performance']});const {service}=conversationService(1);let recover!:()=>void;
  const runtime=await VoiceRoomRuntime.connect({...service,onDatabaseRecovery:(callback:()=>void)=>{recover=callback;return()=>{};}} as unknown as VoiceService,'call','room');
  const original=service.db.query.getMockImplementation()!;let reject!:(error:Error)=>void;
  try{
    service.db.query.mockImplementationOnce(()=>new Promise((_resolve,no)=>{reject=no;}));
    (runtime as any).nextLeaseAt=0;
    const attempt=(runtime as any).renewLease();const failed=expect(attempt).rejects.toThrow('controlled outage');
    recover();reject(new Error('controlled outage'));await failed;
    service.db.query.mockClear();service.db.query.mockImplementation(original);
    await vi.advanceTimersByTimeAsync(4999);expect(service.db.query).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);expect(service.db.query).toHaveBeenCalledOnce();
    expect(service.db.query.mock.calls[0]![0]).toContain('UPDATE voice_calls SET runtime_until');
    expect(runtime.isClosed).toBe(false);
  }finally{await runtime.close();vi.useRealTimers();}
});


it('F17: an absence deadline carries the exact participant session and cannot remove its replacement',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','Date','performance']});const {service}=conversationService(1);let session='old';
  service.db.query.mockImplementation(async(sql:string)=>({rowCount:1,rows:sql.includes('SELECT identity_id,session_id')
    ?[{identity_id:'human',session_id:session}]:[] as any}));
  const runtime=await VoiceRoomRuntime.connect(service as unknown as VoiceService,'call','room');
  try{
    const human={identity:'human'};state.room.remoteParticipants.delete('human');state.room.emit('left',human);
    await vi.advanceTimersByTimeAsync(60_000);session='replacement';await runtime.reconcileParticipants();
    await vi.advanceTimersByTimeAsync(60_000);expect(service.leave).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.leave).toHaveBeenCalledTimes(1);expect(service.leave).toHaveBeenCalledWith('call','human',true,'replacement',undefined,'owner');
  }finally{await runtime.close();vi.useRealTimers();}
});


it('F17: a failed absence expiry parks that exact source version instead of creating another observation deadline',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','Date','performance']});const {service}=conversationService(1);
  service.db.query.mockImplementation(async(sql:string)=>({rowCount:1,rows:sql.includes('SELECT identity_id,session_id')
    ?[{identity_id:'human',session_id:'same'}]:[] as any}));
  service.leave.mockRejectedValue(new Error('controlled expiry outage'));
  const runtime=await VoiceRoomRuntime.connect(service as unknown as VoiceService,'call','room');
  try{
    state.room.remoteParticipants.delete('human');state.room.emit('left',{identity:'human'});
    await vi.advanceTimersByTimeAsync(120_000);expect(service.leave).toHaveBeenCalledOnce();
    await runtime.reconcileParticipants();await vi.advanceTimersByTimeAsync(240_000);
    expect(service.leave).toHaveBeenCalledOnce();
  }finally{await runtime.close();vi.useRealTimers();}
});


it('F17: one thousand participant source wakes retain one actor and at most one covering followup',async()=>{
  const {service}=conversationService(1);const runtime=await VoiceRoomRuntime.connect(service as unknown as VoiceService,'call','room');
  let release!:(result:any)=>void;let reads=0;
  const original=service.db.query.getMockImplementation()!;
  service.db.query.mockImplementation((sql,params)=>{
    if(sql.includes('SELECT identity_id,session_id')){reads++;if(reads===1)return new Promise(resolve=>{release=resolve;});}
    return original(sql,params);
  });
  try{
    const first=runtime.reconcileParticipants();
    for(let i=0;i<1000;i++)expect(runtime.reconcileParticipants()).toBe(first);
    expect(reads).toBe(1);release({rowCount:0,rows:[]});await first;expect(reads).toBe(2);
    expect((runtime as any).participantsRefresh).toBeUndefined();
  }finally{await runtime.close();}
});


it('F17: a failed participant actor parks its burst without rearming until another actual source wake',async()=>{
  const {service}=conversationService(1);const runtime=await VoiceRoomRuntime.connect(service as unknown as VoiceService,'call','room');
  let reject!:(error:Error)=>void;let reads=0;const original=service.db.query.getMockImplementation()!;
  service.db.query.mockImplementation((sql,params)=>{
    if(sql.includes('SELECT identity_id,session_id')){reads++;if(reads===1)return new Promise((_resolve,no)=>{reject=no;});}
    return original(sql,params);
  });
  try{
    const first=runtime.reconcileParticipants();const failed=expect(first).rejects.toThrow('participant outage');
    for(let i=0;i<1000;i++)expect(runtime.reconcileParticipants()).toBe(first);
    reject(new Error('participant outage'));await failed;
    await new Promise(resolve=>setImmediate(resolve));expect(reads).toBe(1);
    await runtime.reconcileParticipants();expect(reads).toBe(2);
  }finally{await runtime.close();}
});


it.each(['closed','replaced','exhausted'])('F17: %s preauthorization input frees its raw PCM references without waiting for the old pump',async(reason)=>{
  const {service}=conversationService(1);let authorize!:()=>void;
  service.access.mockImplementationOnce(()=>new Promise<void>(resolve=>{authorize=resolve;}));
  service.config.stt.mockResolvedValue({send:vi.fn(),close:vi.fn()});
  const runtime=await VoiceRoomRuntime.connect(service as unknown as VoiceService,'call','room');
  let frames!:ReadableStreamDefaultController<any>;
  state.streams=[new ReadableStream({start(controller){frames=controller;}}),new ReadableStream()];
  try{
    state.room.emit('track',{kind:1},{},{identity:'human'});frames.enqueue({data:new Int16Array(320)});
    await vi.waitFor(()=>expect((runtime as any).meter.diagnostics().heldBytes).toBe(640));
    const raw=(runtime as any).inputs.get('human').buffered;expect(raw).toHaveLength(1);
    if(reason==='closed'){
      const close=runtime.close();expect(raw).toHaveLength(0);authorize();await close;
    }else if(reason==='replaced'){
      state.room.emit('track',{kind:1},{},{identity:'human'});expect(raw).toHaveLength(0);authorize();
    }else{
      service.budget.read.mockResolvedValue({remainingMs:0,resetAt:Date.now()+86400000,timeZone:'UTC'});
      authorize();await vi.waitFor(()=>expect(raw).toHaveLength(0));
    }
    expect((runtime as any).meter.diagnostics().heldBytes).toBe(0);
  }finally{authorize?.();await runtime.close();}
});


it.each([false,true])('F17: explicit Resume waits for its one admitted owner-evidence attempt before effects; failure=%s',async(fail)=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','Date','performance']});const {service}=conversationService(1);
  const runtime=await VoiceRoomRuntime.connect(service as unknown as VoiceService,'call','room');
  state.room.remoteParticipants.set('human',{identity:'human',trackPublications:new Map()});
  clearInterval((runtime as any).leaseRenewal);(runtime as any).leaseRenewal=undefined;
  (runtime as any).leaseParked=true;(runtime as any).nextLeaseAt=performance.now()+5000;
  service.db.query.mockClear();service.access.mockClear();state.room.localParticipant.publishData.mockClear();
  if(fail)service.db.query.mockRejectedValueOnce(new Error('Resume owner evidence unavailable'));
  try{
    const resume=runtime.resume('human');expect(runtime.resume('human')).toBe(resume);
    const outcome=fail?expect(resume).rejects.toThrow('evidence unavailable'):resume;
    await vi.advanceTimersByTimeAsync(4999);expect(service.access).not.toHaveBeenCalled();expect(service.db.query).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);await outcome;
    const updates=()=>service.db.query.mock.calls.filter(([sql])=>sql.includes('UPDATE voice_calls SET runtime_until=clock_timestamp()')).length;
    expect(updates()).toBe(1);
    if(fail){await vi.advanceTimersByTimeAsync(5000);expect(updates()).toBe(1);expect(service.access).not.toHaveBeenCalled();}
    else expect(service.access).toHaveBeenCalledOnce();
  }finally{await runtime.close();vi.useRealTimers();}
});


it('F17: participant departure cancels a quota-waiting Resume intent before owner or action effects',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','Date','performance']});const {service}=conversationService(1);
  const runtime=await VoiceRoomRuntime.connect(service as unknown as VoiceService,'call','room');
  state.room.remoteParticipants.set('human',{identity:'human',trackPublications:new Map()});
  clearInterval((runtime as any).leaseRenewal);(runtime as any).leaseRenewal=undefined;
  (runtime as any).leaseParked=true;(runtime as any).nextLeaseAt=performance.now()+5000;
  service.db.query.mockClear();service.access.mockClear();
  try{
    const resume=runtime.resume('human');const canceled=expect(resume).rejects.toMatchObject({name:'AbortError'});
    runtime.participantLeft('human');await canceled;await vi.advanceTimersByTimeAsync(5000);
    expect(service.db.query).not.toHaveBeenCalled();expect(service.access).not.toHaveBeenCalled();
  }finally{await runtime.close();vi.useRealTimers();}
});


it('F17: concurrent inactivity callers join the full end boundary instead of returning before cleanup',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','Date','performance']});
  const {service}=conversationService(1);const runtime=await VoiceRoomRuntime.connect(service as unknown as VoiceService,'call','room');
  let finish!:()=>void;let entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  service.endInactive.mockImplementationOnce(async()=>{entered();await new Promise<void>(resolve=>{finish=resolve;});return true;});
  try{
    (runtime as any).lastActivity=performance.now()-60_000;
    const first=(runtime as any).checkInactivity();await started;
    const second=(runtime as any).checkInactivity();expect(second).toBe(first);
    let completed=false;void second.then(()=>{completed=true;});
    await Promise.resolve();expect(completed).toBe(false);expect(service.endInactive).toHaveBeenCalledOnce();
    finish();await Promise.all([first,second]);expect(completed).toBe(true);
  }finally{finish?.();await runtime.close();vi.useRealTimers();}
});


it('F17: authority sources select only the exact Workspace or inherited parent Room, with zero unrelated call observations',async()=>{
  const live=new LiveHub(),denied=new Set<string>();
  const scopes:Record<string,{workspace_id:string;authority_room_id:string}>={
    'child-a':{workspace_id:'workspace-a',authority_room_id:'parent-a'},
    'room-b':{workspace_id:'workspace-b',authority_room_id:'room-b'},
  };
  const query=vi.fn(async(sql:string,values?:unknown[])=>{
    if(sql.startsWith('SELECT workspace_id,COALESCE'))return {rowCount:1,rows:[scopes[String(values?.[0])]]};
    if(sql.includes('FROM voice_workspace_usage'))return {rowCount:1,rows:[{used:'0'}]};
    if(sql.includes('count(*)::int count FROM voice_participants'))return {rowCount:1,rows:[{count:1}]};
    if(sql.startsWith('SELECT r.id FROM rooms'))return {rowCount:denied.has(String(values?.[0]))?0:1,
      rows:denied.has(String(values?.[0]))?[]:[{id:values?.[0]}]};
    return {rowCount:1,rows:[]};
  });
  const database={query,transaction:async(work:any)=>work(database)};
  const fixture=conversationService(1);const service=new RealVoiceService(database as any,live,{...fixture.service.config,speech:fixture.speech});
  const leave=vi.spyOn(service,'leave').mockResolvedValue(undefined);
  let first:VoiceRoomRuntime|undefined,second:VoiceRoomRuntime|undefined;
  try{
    first=await service.ensureRuntime({id:'call-a',room_id:'child-a',message_id:'card-a',started_at:new Date(),ended_at:null}) as VoiceRoomRuntime;
    const roomA=state.room;roomA.remoteParticipants.set('human',{identity:'human',trackPublications:new Map()});
    second=await service.ensureRuntime({id:'call-b',room_id:'room-b',message_id:'card-b',started_at:new Date(),ended_at:null}) as VoiceRoomRuntime;
    state.room.remoteParticipants.set('human',{identity:'human',trackPublications:new Map()});
    query.mockClear();
    live.publish({type:'invalidate',roomId:'',reason:'postgres:memberships',workspaceId:'workspace-unrelated',readerId:'human'});
    await new Promise(resolve=>setImmediate(resolve));expect(query).not.toHaveBeenCalled();expect(leave).not.toHaveBeenCalled();
    denied.add('child-a');
    live.publish({type:'invalidate',roomId:'',reason:'postgres:memberships',workspaceId:'workspace-a',readerId:'human'});
    await new Promise(resolve=>setImmediate(resolve));
    expect(query).toHaveBeenCalledTimes(1);expect(query.mock.calls[0]![1]).toEqual(['child-a','human',SYSTEM_IDENTITY_ID]);
    expect(leave).toHaveBeenCalledTimes(1);expect(leave.mock.calls[0]![0]).toBe('call-a');expect(second.isClosed).toBe(false);
    query.mockClear();leave.mockClear();
    live.publish({type:'invalidate',roomId:'parent-a',reason:'postgres:memberships',workspaceId:'workspace-a',targetAgentId:'human'});
    await new Promise(resolve=>setImmediate(resolve));expect(query).toHaveBeenCalledTimes(1);expect(leave.mock.calls[0]![0]).toBe('call-a');
    query.mockClear();leave.mockClear();
    // Explicit legacy incomplete source parks only input, with no blanket DB
    // read or permanent call close. Real Resume reauthorizes its own scope.
    live.publish({type:'invalidate',roomId:'',reason:'postgres:memberships',readerId:'human'});
    await new Promise(resolve=>setImmediate(resolve));expect(query).not.toHaveBeenCalled();expect(leave).not.toHaveBeenCalled();
    expect(first.isClosed).toBe(false);expect(second.isClosed).toBe(false);
    await second.resume('human');expect((second as any).authorityPaused.has('human')).toBe(false);
    expect((first as any).authorityPaused.has('human')).toBe(true);
  }finally{leave.mockRestore();await service.close();}
});

it.each(['local', ...(inputOwnerPostgresUrl ? ['postgres'] : [])].flatMap(backend =>
  ['authorization', 'membership'].map(boundary => ({ backend, boundary }))))(
  'F17: replaced input cannot continue from a held $boundary read into provider setup or stop its successor ($backend)', async ({ backend, boundary }) => {
  const { service } = conversationService(1);
  const runtime = await VoiceRoomRuntime.connect(service as unknown as VoiceService, 'call', 'room');
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const original = service.db.query.getMockImplementation()!;
  const postgres = backend === 'postgres' ? await groupBPostgresDatabase(inputOwnerPostgresUrl!, false) : undefined;
  if (postgres) {
    await postgres.database.query('CREATE TABLE voice_participants(call_id text,identity_id text,left_at timestamptz)');
    if (boundary === 'authorization') await postgres.database.query("INSERT INTO voice_participants VALUES('call','human',NULL)");
    service.db.query.mockImplementation((sql, args) => sql.includes('SELECT 1 FROM voice_participants')
      ? postgres.database.query(sql, args) as any : original(sql, args));
  }
  if (boundary === 'authorization') service.access.mockImplementationOnce(async () => { entered(); await held; });
  else service.db.query.mockImplementationOnce(async (sql, args) => {
    if (!sql.includes('SELECT 1 FROM voice_participants')) throw new Error('Expected participant admission');
    const result = postgres ? await postgres.database.query(sql, args) : { rowCount: 0, rows: [] };
    entered(); await held; return result as any;
  });
  service.config.stt.mockResolvedValue({ send: vi.fn(), close: vi.fn() });
  state.streams = [new ReadableStream(), new ReadableStream()];
  const oldTrack = { kind: 1 }, newTrack = { kind: 1 }, participant = { identity: 'human' };
  try {
    const old = (runtime as any).listen(oldTrack, participant); await paused;
    if (postgres && boundary === 'membership') await postgres.database.query("INSERT INTO voice_participants VALUES('call','human',NULL)");
    void (runtime as any).listen(newTrack, participant);
    await vi.waitFor(() => expect(service.config.stt).toHaveBeenCalledOnce());
    const queries = service.db.query.mock.calls.length;
    release(); await old;
    expect((runtime as any).inputs.get('human')?.track).toBe(newTrack);
    expect(service.config.stt).toHaveBeenCalledOnce();
    expect(service.db.query.mock.calls).toHaveLength(queries);
    expect(service.agents).toHaveBeenCalledOnce();
    service.db.query.mockImplementation(original);
  } finally { release(); await runtime.close(); await postgres?.close(); }
});
