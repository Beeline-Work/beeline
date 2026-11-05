import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PgliteDatabase } from "../../../tests/helpers/server.js";
import { VoiceAudioMeter, VoiceBudgetStore, voiceBudgetDay } from './voice-budget.js';

const db = new PgliteDatabase();
const START = Date.UTC(2026, 9, 17, 12);
let now = START;
const budget = new VoiceBudgetStore(db, 180_000, () => now);
beforeAll(async () => {
  await db.query(`CREATE TABLE voice_calls(id text PRIMARY KEY, runtime_owner text,
    runtime_until timestamptz, ended_at timestamptz, room_id text);
    CREATE TABLE voice_participants(call_id text, identity_id text, left_at timestamptz, parked_at timestamptz);
    CREATE TABLE voice_workspace_usage(workspace_id text, call_id text, day_start bigint,
      audio int8multirange NOT NULL DEFAULT '{}', PRIMARY KEY(workspace_id,call_id,day_start));
    CREATE TABLE rooms(id text,workspace_id text);
    INSERT INTO rooms VALUES('room','human');
    INSERT INTO voice_calls VALUES('call','owner','2099-01-01',NULL,'room');
    INSERT INTO voice_participants VALUES('call','human',NULL,NULL),('call','second',NULL,NULL);`);
});
afterAll(() => db.close());

it('unions microphones within a call, adds concurrent calls, and keeps other workspaces independent', async () => {
  await db.query('DELETE FROM voice_workspace_usage');
  now = START + 60_000;
  await db.query(`INSERT INTO voice_calls VALUES('other','owner','2099-01-01',NULL,'room')`);
  try {
    await budget.record('call', 'owner', 'human', [[START, now]]);
    await budget.record('call', 'owner', 'human', [[START, now]]);
    expect((await budget.read('human')).remainingMs).toBe(120_000);
    await budget.record('other', 'owner', 'human', [[START, now]]);
    expect((await budget.read('human')).remainingMs).toBe(60_000);
    expect((await budget.read('another-workspace')).remainingMs).toBe(180_000);
  } finally {
    await db.query("DELETE FROM voice_calls WHERE id='other'");
    await db.query('DELETE FROM voice_workspace_usage');
  }
});

it('bounds uncommitted time to one second for the whole call with several microphones', async () => {
  await db.query('DELETE FROM voice_workspace_usage'); now = START;
  vi.useFakeTimers();
  const meter = new VoiceAudioMeter(budget, 'call', 'owner', 'human', await budget.read('human'), () => {}, () => {}, () => now);
  try {
    for (let i = 0; i < 50; i++) {
      now += 20;
      expect(meter.audio(20)).toBe(20);
      // A second live mic forwards its full PCM without charging it again.
      if (i < 49) expect(meter.audio(20)).toBe(20);
    }
    now += 20;
    expect(meter.audio(20)).toBe(0);
    expect(meter.audio(20)).toBe(0);
    expect((await new VoiceBudgetStore(db, 180_000, () => now).read('human')).remainingMs).toBe(180_000);
    await meter.flush();
    expect((await budget.read('human')).remainingMs).toBe(179_000);
  } finally { await meter.close(); vi.useRealTimers(); }
});

it('shares one budget across overlapping devices and idempotent checkpoints, excluding the no-audio gap', async () => {
  await db.query('DELETE FROM voice_workspace_usage');
  now = START + 70_000;
  await budget.record('call', 'owner', 'human', [[START, START + 60_000]]);
  await budget.record('call', 'owner', 'human', [[START + 30_000, START + 60_000]]);
  expect((await budget.read('human')).remainingMs).toBe(120_000);
  await budget.record('call', 'owner', 'human', [[START + 65_000, START + 70_000]]);
  expect((await budget.read('human')).remainingMs).toBe(115_000);
  expect((await budget.read('second')).remainingMs).toBe(180_000);
  expect(await budget.record('call', 'stale-owner', 'human', [[START, START + 70_000]])).toBeNull();
});

it('retains committed usage across a new store and resets at the documented UTC midnight', async () => {
  const replacement = new VoiceBudgetStore(db, 180_000, () => now);
  expect((await replacement.read('human')).remainingMs).toBe(115_000);
  now = voiceBudgetDay(now).resetAt;
  expect(await replacement.read('human')).toEqual({ remainingMs: 180_000,
    resetAt: now + 86_400_000, timeZone: 'UTC' });
});

it('does not forward uncommitted PCM before a crash snapshot, and caps captured audio to one second', async () => {
  await db.query('DELETE FROM voice_workspace_usage'); now = START;
  vi.useFakeTimers(); const send = vi.fn();
  const meter = new VoiceAudioMeter(budget,'call','owner','human',await budget.read('human'),()=>{},()=>{},()=>now);
  try {
    for (let i=0;i<50;i++) { now+=20; meter.capture(new Int16Array(320),now,send); }
    now+=20; meter.capture(new Int16Array(320),now,send);
    expect(send).not.toHaveBeenCalled();
    expect(meter.diagnostics()).toMatchObject({heldBytes:32_000,heldMilliseconds:1000,pendingMilliseconds:1000});
    const snapshot=PgliteDatabase.fromSnapshot(await db.snapshot());
    try {expect((await new VoiceBudgetStore(snapshot,180_000,()=>now).read('human')).remainingMs).toBe(180_000);}
    finally {await snapshot.close();}
    await meter.flush(); expect(send).toHaveBeenCalledTimes(50);
    expect((await budget.read('human')).remainingMs).toBe(179_000);
    expect(meter.diagnostics().heldBytes).toBe(0);
  }finally{await meter.close();vi.useRealTimers();}
});

it('parks failed exact intervals without accepting more PCM, then resumes only on actual recovery', async () => {
  await db.query('DELETE FROM voice_workspace_usage'); now=START; vi.useFakeTimers();
  const record=vi.spyOn(budget,'record'); const log=vi.fn(),send=vi.fn();
  const meter=new VoiceAudioMeter(budget,'call','owner','human',await budget.read('human'),()=>{},log,()=>now);
  try {
    now+=200;meter.capture(new Int16Array(3200),now,send);
    record.mockRejectedValueOnce(new Error('database temporarily unavailable'));
    await expect(meter.flush()).rejects.toThrow('temporarily');
    now+=200;meter.capture(new Int16Array(3200),now,send);
    expect(meter.diagnostics()).toMatchObject({parked:true,pendingMilliseconds:200,heldBytes:6400});
    await vi.advanceTimersByTimeAsync(86_400_000);await meter.flush();
    expect(record).toHaveBeenCalledOnce();expect(send).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
    await meter.recover(); expect(record).toHaveBeenCalledTimes(2);expect(send).toHaveBeenCalledOnce();
    expect(record.mock.calls[1]).toEqual(record.mock.calls[0]);
    expect((await budget.read('human')).remainingMs).toBe(179_800);
    expect(meter.diagnostics()).toMatchObject({parked:false,heldBytes:0});
    expect(log.mock.calls.map(([text])=>text)).toEqual(['Voice accounting checkpoint failed; awaiting database recovery']);
  }finally{record.mockRestore();await meter.close();vi.useRealTimers();}
});

it('makes one final close attempt, retains failed interval evidence and never retries a failed close', async () => {
  await db.query('DELETE FROM voice_workspace_usage');now=START;
  const record=vi.spyOn(budget,'record');const send=vi.fn();
  const meter=new VoiceAudioMeter(budget,'call','owner','human',await budget.read('human'),()=>{},()=>{},()=>now);
  now+=200;meter.capture(new Int16Array(3200),now,send);
  record.mockRejectedValueOnce(new Error('failure during leave'));
  try {
    const closed=meter.close();await expect(closed).rejects.toThrow('during leave');
    expect(meter.close()).toBe(closed);await expect(meter.close()).rejects.toThrow('during leave');
    await meter.recover();expect(record).toHaveBeenCalledOnce();expect(send).not.toHaveBeenCalled();
    expect(meter.diagnostics()).toMatchObject({closed:true,heldBytes:0,pendingMilliseconds:200});
    expect((await budget.read('human')).remainingMs).toBe(180_000);
  }finally{record.mockRestore();}
});

it('splits audio at midnight and refuses exhausted callers until reset', async () => {
  await db.query('DELETE FROM voice_workspace_usage');
  const midnight = voiceBudgetDay(START).resetAt;
  now = midnight + 100;
  const tiny = new VoiceBudgetStore(db, 100, () => now);
  await tiny.record('call', 'owner', 'human', [[midnight - 50, midnight + 100]]);
  await expect(tiny.require('human')).rejects.toThrow('Calls resume at 12:00 AM');
  expect((await db.query('SELECT day_start FROM voice_workspace_usage')).rowCount).toBe(2);
  now += 86_400_000;
  expect((await tiny.require('human')).remainingMs).toBe(100);
});

it('restores a persisted database into a new server store and fences the previous lease owner', async () => {
  await db.query('DELETE FROM voice_workspace_usage'); now = START + 60_000;
  await budget.record('call', 'owner', 'human', [[START, now]]);
  const restored = PgliteDatabase.fromSnapshot(await db.snapshot());
  try {
    const successor = new VoiceBudgetStore(restored, 180_000, () => now);
    expect((await successor.read('human')).remainingMs).toBe(120_000);
    await restored.query(`UPDATE voice_calls SET runtime_owner='successor' WHERE id='call'`);
    now += 250;
    expect(await successor.record('call', 'owner', 'human', [[now - 250, now]])).toBeNull();
    await successor.record('call', 'successor', 'human', [[now - 250, now]]);
    expect((await successor.read('human')).remainingMs).toBe(119_750);
  } finally { await restored.close(); }
});

it('owns no timer or database observation while audio is empty, then commits one actual batch', async () => {
  // Keep native database/worker callbacks outside this fake-clock block.
  // Async timer advancement yields to I/O and can count unrelated timers.
  vi.useFakeTimers();
  const initial={remainingMs:180_000,resetAt:START+86_400_000,timeZone:'UTC'};
  const record=vi.fn(async()=>initial);
  const store={fence: async (_call: string, _owner: string, enqueue: () => void) => { enqueue(); return true; },limitMs:180_000,record} as unknown as VoiceBudgetStore;
  let clock=START;
  const meter=new VoiceAudioMeter(store,'idle-call','owner','workspace',initial,()=>{},()=>{},()=>clock);
  try{
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    await meter.flush();expect(record).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
    clock+=100;expect(meter.audio(100)).toBe(100);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(249);expect(record).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(record).toHaveBeenCalledOnce();expect(record.mock.calls[0]).toEqual(['idle-call','owner','workspace',[[START,START+100]]]);
    // The deadline must start the write before flush joins its completion.
    await meter.flush();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);await meter.flush();expect(record).toHaveBeenCalledOnce();
  }finally{await meter.close();vi.useRealTimers();}
});

it('latches real recovery during a failing in-flight commit once, without a failed accounting clock', async () => {
  vi.useFakeTimers();const initial={remainingMs:180_000,resetAt:START+86_400_000,timeZone:'UTC'};
  let reject!: (error:Error)=>void;
  const record=vi.fn().mockImplementationOnce(()=>new Promise((_resolve,no)=>{reject=no;})).mockResolvedValue(initial);
  const store={fence: async (_call: string, _owner: string, enqueue: () => void) => { enqueue(); return true; },limitMs:180_000,record} as unknown as VoiceBudgetStore;
  const send=vi.fn();let clock=START;
  const meter=new VoiceAudioMeter(store,'call','owner','workspace',initial,()=>{},()=>{},()=>clock);
  try {
    clock+=200;meter.capture(new Int16Array(3200),clock,send);
    const failed=meter.flush();const rejected=expect(failed).rejects.toThrow('failed');
    const recovered=meter.recover();reject(new Error('commit failed'));await rejected;await recovered;
    for(let i=0;i<10;i++)await Promise.resolve();
    expect(record).toHaveBeenCalledTimes(2);expect(record.mock.calls[1]).toEqual(record.mock.calls[0]);
    expect(send).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(86_400_000);expect(record).toHaveBeenCalledTimes(2);
  }finally{await meter.close();vi.useRealTimers();}
});

it('a committed batch with a lost acknowledgement is charged once, and delivered only after a current acknowledged recovery', async () => {
  await db.query('DELETE FROM voice_workspace_usage');now=START;vi.useFakeTimers();
  const original=budget.record.bind(budget);let lost=true;
  const record=vi.spyOn(budget,'record').mockImplementation(async(...args)=>{
    const result=await original(...args);if(lost){lost=false;throw new Error('lost commit acknowledgment');}return result;
  });
  const send=vi.fn();const meter=new VoiceAudioMeter(budget,'call','owner','human',await budget.read('human'),()=>{},()=>{},()=>now);
  try {
    now+=20;meter.capture(new Int16Array([1,...new Array(319).fill(0)]),now,send);
    await expect(meter.flush()).rejects.toThrow('lost commit');expect(send).not.toHaveBeenCalled();
    expect((await new VoiceBudgetStore(db,180_000,()=>now).read('human')).remainingMs).toBe(179_980);
    await meter.recover();expect(send).toHaveBeenCalledOnce();
    expect((await budget.read('human')).remainingMs).toBe(179_980);
    expect(record.mock.calls[1]).toEqual(record.mock.calls[0]);
  }finally{record.mockRestore();await meter.close();vi.useRealTimers();}
});

it('close synchronously revokes a delayed committed PCM callback and does not deadlock receipt-driven close', async () => {
  const initial={remainingMs:180_000,resetAt:START+86_400_000,timeZone:'UTC'};
  let finish!: (value:typeof initial)=>void;const record=vi.fn(()=>new Promise<typeof initial>(resolve=>{finish=resolve;}));
  const store={fence: async (_call: string, _owner: string, enqueue: () => void) => { enqueue(); return true; },limitMs:180_000,record} as unknown as VoiceBudgetStore;const send=vi.fn();let clock=START;
  let meter!:VoiceAudioMeter;meter=new VoiceAudioMeter(store,'call','owner','workspace',initial,()=>{void meter.close();},()=>{},()=>clock);
  clock+=20;meter.capture(new Int16Array(320),clock,send);const commit=meter.flush();
  const close=meter.close();expect(meter.diagnostics().heldBytes).toBe(0);finish(initial);
  await Promise.all([commit,close]);expect(send).not.toHaveBeenCalled();expect(record).toHaveBeenCalledOnce();
});

it('shares byte and duration limits with authorization buffers and rejects malicious frame sizes before copying', async () => {
  const initial={remainingMs:180_000,resetAt:START+86_400_000,timeZone:'UTC'};
  const record=vi.fn(async()=>initial);const store={fence: async (_call: string, _owner: string, enqueue: () => void) => { enqueue(); return true; },limitMs:180_000,record} as unknown as VoiceBudgetStore;
  const meter=new VoiceAudioMeter(store,'call','owner','workspace',initial,()=>{},()=>{},()=>START+1000);const send=vi.fn();
  const held=meter.retain(600,19_200)!;
  expect(meter.retain(500,16_000)).toBeUndefined();expect(meter.retain(1,32_001)).toBeUndefined();
  meter.capture(new Int16Array(8000),START+1000,send);expect(meter.diagnostics().heldBytes).toBe(19_200);
  meter.capture(new Int16Array(6400),START+1000,send);expect(meter.diagnostics().heldBytes).toBe(32_000);
  meter.capture(new Int16Array(16001),START+1000,send);expect(meter.diagnostics().heldBytes).toBe(32_000);
  held();await meter.flush();expect(send).toHaveBeenCalledOnce();await meter.close();
});

it('rejects a takeover between durable commit and enqueue while retaining the charged interval', async () => {
  await db.query('DELETE FROM voice_workspace_usage');now=START;vi.useFakeTimers();
  const original=budget.record.bind(budget);const record=vi.spyOn(budget,'record').mockImplementation(async(...args)=>{
    const result=await original(...args);await db.query("UPDATE voice_calls SET runtime_owner='successor' WHERE id='call'");return result;
  });
  const send=vi.fn();const meter=new VoiceAudioMeter(budget,'call','owner','human',await budget.read('human'),()=>{},()=>{},()=>now);
  try{
    now+=20;meter.capture(new Int16Array(320),now,send);await meter.flush();
    expect(send).not.toHaveBeenCalled();expect(meter.diagnostics()).toMatchObject({fenced:true,heldBytes:0});
    expect((await budget.read('human')).remainingMs).toBe(179_980);
  }finally{record.mockRestore();await meter.close();await db.query("UPDATE voice_calls SET runtime_owner='owner' WHERE id='call'");vi.useRealTimers();}
});

it('a fence failure after synchronous enqueue never restores or replays the delivered PCM', async () => {
  await db.query('DELETE FROM voice_workspace_usage');now=START;vi.useFakeTimers();
  const original=budget.fence.bind(budget);const fence=vi.spyOn(budget,'fence').mockImplementation(async(...args)=>{
    await original(...args);throw new Error('fence acknowledgment lost after enqueue');
  });
  const send=vi.fn();const meter=new VoiceAudioMeter(budget,'call','owner','human',await budget.read('human'),()=>{},()=>{},()=>now);
  try{
    now+=20;meter.capture(new Int16Array(320),now,send);
    await expect(meter.flush()).rejects.toThrow('after enqueue');expect(send).toHaveBeenCalledOnce();
    expect(meter.diagnostics()).toMatchObject({parked:true,heldBytes:0,pendingMilliseconds:0});
    fence.mockRestore();await meter.recover();expect(send).toHaveBeenCalledOnce();
    expect((await budget.read('human')).remainingMs).toBe(179_980);
  }finally{fence.mockRestore();await meter.close();vi.useRealTimers();}
});

it('actual PCM owns at most four scheduled accounting commits per second, with no empty followup', async () => {
  vi.useFakeTimers();const initial={remainingMs:180_000,resetAt:START+86_400_000,timeZone:'UTC'};
  const record=vi.fn(async()=>initial);const store={limitMs:180_000,record,
    fence:async(_call:string,_owner:string,enqueue:()=>void)=>{enqueue();return true;}} as unknown as VoiceBudgetStore;
  let clock=START;const meter=new VoiceAudioMeter(store,'call','owner','workspace',initial,()=>{},()=>{},()=>clock);
  try{
    for(let i=0;i<50;i++){clock+=20;meter.capture(new Int16Array(320),clock,()=>{});await vi.advanceTimersByTimeAsync(20);}
    expect(record.mock.calls.length).toBeLessThanOrEqual(4);
    await vi.advanceTimersByTimeAsync(1000);const complete=record.mock.calls.length;
    await vi.advanceTimersByTimeAsync(86_400_000);expect(record).toHaveBeenCalledTimes(complete);expect(vi.getTimerCount()).toBe(0);
  }finally{await meter.close();vi.useRealTimers();}
});

it('admits distinct simultaneous microphone PCM while charging their overlapping wall-clock interval once',async()=>{
  await db.query('DELETE FROM voice_workspace_usage');now=START;vi.useFakeTimers();
  const first=vi.fn(),second=vi.fn();
  const meter=new VoiceAudioMeter(budget,'call','owner','human',await budget.read('human'),()=>{},()=>{},()=>now);
  try{
    now+=20;meter.capture(new Int16Array(320).fill(11),now,first);
    meter.capture(new Int16Array(320).fill(22),now,second);
    expect(meter.diagnostics()).toMatchObject({pendingMilliseconds:20,heldMilliseconds:40,heldBytes:1280});
    expect(first).not.toHaveBeenCalled();expect(second).not.toHaveBeenCalled();
    await meter.flush();
    expect(first).toHaveBeenCalledTimes(1);expect(first).toHaveBeenCalledWith(new Int16Array(320).fill(11));
    expect(second).toHaveBeenCalledTimes(1);expect(second).toHaveBeenCalledWith(new Int16Array(320).fill(22));
    expect((await new VoiceBudgetStore(db,180_000,()=>now).read('human')).remainingMs).toBe(179_980);
    expect(meter.diagnostics()).toMatchObject({heldMilliseconds:0,heldBytes:0});
  }finally{await meter.close();vi.useRealTimers();}
});

it('an ended call cannot admit or charge a staged batch before its enqueue fence',async()=>{
  await db.query('DELETE FROM voice_workspace_usage');now=START;vi.useFakeTimers();
  const send=vi.fn();const meter=new VoiceAudioMeter(budget,'call','owner','human',await budget.read('human'),()=>{},()=>{},()=>now);
  try{
    now+=20;meter.capture(new Int16Array(320),now,send);
    await db.query("UPDATE voice_calls SET ended_at=clock_timestamp() WHERE id='call'");
    await meter.flush();expect(send).not.toHaveBeenCalled();
    expect(meter.diagnostics()).toMatchObject({fenced:true,heldBytes:0});
    expect((await budget.read('human')).remainingMs).toBe(180_000);
  }finally{await meter.close();await db.query("UPDATE voice_calls SET ended_at=NULL WHERE id='call'");vi.useRealTimers();}
});

it('transfers an owned authorization buffer without a second allocation or releasing its live quota early',async()=>{
  await db.query('DELETE FROM voice_workspace_usage');now=START;vi.useFakeTimers();
  const send=vi.fn();const meter=new VoiceAudioMeter(budget,'call','owner','human',await budget.read('human'),()=>{},()=>{},()=>now);
  const owned=new Int16Array(16_000).fill(31),slice=vi.spyOn(owned,'slice');const reservation=meter.retain(1000,32_000)!;
  try{
    now+=1000;meter.captureReserved(owned,now,send,reservation);
    expect(slice).not.toHaveBeenCalled();expect(meter.diagnostics()).toMatchObject({heldBytes:32_000,heldMilliseconds:1000});
    expect(meter.retain(1,32)).toBeUndefined();
    meter.captureReserved(owned,now,send,reservation); // The same reservation cannot be transferred twice.
    await meter.flush();expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].buffer).toBe(owned.buffer);
    expect(meter.diagnostics()).toMatchObject({heldBytes:0,heldMilliseconds:0});
  }finally{slice.mockRestore();await meter.close();vi.useRealTimers();}
});

it('a shortened transferred view retains its full backing-buffer quota and close revokes it before commit completes',async()=>{
  vi.useFakeTimers();const initial={remainingMs:20,resetAt:START+86_400_000,timeZone:'UTC'};
  let finish!:(budget:typeof initial)=>void;const store={limitMs:180_000,record:()=>new Promise<typeof initial>(resolve=>{finish=resolve;}),
    fence:async(_call:string,_owner:string,enqueue:()=>void)=>{enqueue();return true;}} as unknown as VoiceBudgetStore;
  let clock=START;const meter=new VoiceAudioMeter(store,'call','owner','workspace',initial,()=>{},()=>{},()=>clock);
  const owned=new Int16Array(1600),reservation=meter.retain(100,3200)!,send=vi.fn();
  clock+=100;meter.captureReserved(owned,clock,send,reservation);
  expect(meter.diagnostics()).toMatchObject({pendingMilliseconds:20,heldBytes:3200,heldMilliseconds:100});
  const commit=meter.flush();const close=meter.close();expect(meter.diagnostics().heldBytes).toBe(0);
  finish(initial);await Promise.all([commit,close]);expect(send).not.toHaveBeenCalled();vi.useRealTimers();
});
