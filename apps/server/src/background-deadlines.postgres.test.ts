import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BackgroundWork } from './background-work.js';
import { BackgroundJobRunner, MediaExpiryLoop, PushDeliveryLoop } from './background.js';
import { repairDeadlineFamilies, retentionDeadlineFamilies, registerBackgroundDeadlineFamilies, subscribeBackgroundFamilies,
  BackgroundRecordDeadlines } from './background-deadlines.js';
import { NextDayCheckin } from './next-day-checkin.js';
import { FreeAgentService, freeAgentConfigFromEnv } from './free-agents.js';
import type { FreeAgentMachines } from './fly-machines.js';
import { LiveHub } from './live.js';
import type { SqlDatabase } from './database.js';
import { notifyCommandCompletion } from './command-completion.js';
import { backgroundDatabaseCut, backgroundNextDelay } from './background-deadline-clock.js';
import { groupBPostgresDatabase } from './test-fixtures/test-support-router-group-b-postgres.js';
import { PhoneService } from './phone-service.js';
import { INSTITUTIONAL_MEMORY_ON } from './institutional-memory-shadow.js';

const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
describe.skipIf(!url)('P12 actual background deadline composition, real PostgreSQL',()=>{
  let fixture:Awaited<ReturnType<typeof groupBPostgresDatabase>>,release:()=>Promise<void>;
  beforeAll(async()=>{fixture=await groupBPostgresDatabase(url!);release=await fixture.listenToCompletions();},60000);
  afterAll(async()=>{await release?.();await fixture?.close();});

  it('does zero idle-day SQL/provider work; a committed calendar/retention source runs only its family and takeover initializes once',async()=>{
    const statements:string[]=[],observe=(db:SqlDatabase):SqlDatabase=>({
      query:(sql,values)=>{statements.push(sql);return db.query(sql,values);},
      transaction:run=>db.transaction(tx=>run(observe(tx))),
    });
    const db=observe(fixture.database),provider=vi.fn(async()=>{throw new Error('Empty proof must never call a provider');});
    const machine={create:provider,find:provider,start:provider,suspend:provider,stop:provider,destroy:provider,state:provider,waitFor:provider} as unknown as FreeAgentMachines;
    const free=new FreeAgentService(db,freeAgentConfigFromEnv({BEELINE_FREE_AGENT_SEAL_KEY:'synthetic',FLY_FREE_AGENT_IMAGE:'synthetic'},'http://127.0.0.1')!,machine,provider);
    const checkin=new NextDayCheckin(db,'http://127.0.0.1',provider),push=new PushDeliveryLoop(db,undefined);
    let now=0;const work=new BackgroundWork(()=>now,()=>{}),runner=new BackgroundJobRunner();
    const live=new LiveHub();
    const families=[...repairDeadlineFamilies(db,{live,phone:new PhoneService(db,'http://127.0.0.1'),
      mediaExpiry:new MediaExpiryLoop(db),institutionalMemory:INSTITUTIONAL_MEMORY_ON,
      voiceDeadlines:new BackgroundRecordDeadlines('voice-call-recovery',work,()=>{},()=>now)}),
      {name:'next-day-checkin',run:()=>checkin.runOnce(),next:(cut?:string)=>checkin.nextDelayMs(cut)},
      {name:'push',run:async()=>{await push.runOnce();},next:(cut?:string)=>push.nextDelayMs(cut)},
      {name:'free-agents',run:async()=>{await free.sweep();},next:(cut?:string)=>free.nextDelayMs(cut)},
    ];
    const runs:string[]=[],wakes:string[]=[];
    registerBackgroundDeadlineFamilies(work,families,(name,run)=>{runs.push(name);return runner.run(name,run);},db);
    const stop=subscribeBackgroundFamilies(fixture.database,live,families.map(family=>family.name),name=>{wakes.push(name);work.wake(name);});
    try{
      expect(await work.run(true)).toBe(Infinity);expect(statements.length).toBeGreaterThan(20);
      statements.length=0;runs.length=0;
      now=86_400_000;expect(await work.run(false)).toBe(Infinity);
      expect(statements).toEqual([]);expect(runs).toEqual([]);expect(provider).not.toHaveBeenCalled();
      const human='a'.repeat(64);await fixture.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Synthetic')`,[human]);
      await fixture.database.query(`INSERT INTO next_day_checkin_candidates(identity_id,first_at,due_at) VALUES($1,clock_timestamp(),clock_timestamp()+interval '3 days')`,[human]);
      await vi.waitFor(()=>expect(wakes).toEqual(['next-day-checkin']));
      expect(await work.run(false)).toBeGreaterThan(0);expect(runs).toEqual(['next-day-checkin']);expect(provider).not.toHaveBeenCalled();
      runs.length=0;wakes.length=0;
      await fixture.database.query(`INSERT INTO phone_access_tokens(token_hash,identity_id,family_id,expires_at) VALUES($1,$2,'11111111-1111-4111-8111-111111111111',clock_timestamp()-interval '1 second')`,['c'.repeat(64),human]);
      await vi.waitFor(()=>expect(wakes).toEqual(['retention:phone_access_tokens']));
      await work.run(false);expect(runs).toEqual(['retention:phone_access_tokens']);
      expect((await fixture.database.query(`SELECT token_hash FROM phone_access_tokens WHERE token_hash=$1`,['c'.repeat(64)])).rows).toEqual([]);
      // Drain only the actual committed deletion hint before measuring idle.
      await vi.waitFor(()=>expect(wakes).toHaveLength(2));await work.run(false);
      runs.length=0;statements.length=0;now+=86_400_000;await work.run(false);
      expect(statements).toEqual([]);expect(runs).toEqual([]);
      await work.run(true);expect(runs).toEqual(families.map(family=>family.name));expect(provider).not.toHaveBeenCalled();
    }finally{stop();}
  });

  it('recovers actual retention lock contention and retries a deadline read without replaying the business callback',async()=>{
    const db=fixture.database,holder=await db.connectDedicated();
    const family=retentionDeadlineFamilies(db).find(value=>value.name==='retention:phone_access_tokens')!;
    let deletes=0;const observed:SqlDatabase={transaction:work=>db.transaction(work),query:async(sql,values)=>{
      try{return await db.transaction(async tx=>{await tx.query("SET LOCAL lock_timeout='30ms'");return tx.query(sql,values);});}catch(error){if(sql.startsWith('DELETE FROM phone_access_tokens')&&++deletes===1)await holder.query('COMMIT');throw error;}
    }};
    try{
      await holder.query('BEGIN; LOCK TABLE phone_access_tokens IN ACCESS EXCLUSIVE MODE');
      const retrying=retentionDeadlineFamilies(observed).find(value=>value.name===family.name)!;
      await retrying.run();expect(deletes).toBe(1);
      let effects=0,reads=0;const work=new BackgroundWork();
      registerBackgroundDeadlineFamilies(work,[{name:'proof',run:async()=>{effects++;},next:async()=>{
        reads++;return db.transaction(async tx=>{if(reads===1)await tx.query(`DO $$ BEGIN RAISE EXCEPTION 'known rollback' USING ERRCODE='40001'; END $$`);return undefined;});
      }}],async(_name,run)=>({ok:true,value:await run()}),db);
      await work.run(true);expect(reads).toBe(2);expect(effects).toBe(1);
    }finally{await holder.query('ROLLBACK');holder.release();}
  });

  it('retains a deadline that becomes due between the business scan and minimum query, while parking an older failed record',async()=>{
    const db=fixture.database,cut=await backgroundDatabaseCut(db);
    expect(await backgroundNextDelay(db,`SELECT clock_timestamp() due_at`,cut)).toBe(0);
    expect(await backgroundNextDelay(db,`SELECT $1::timestamptz-interval '1 microsecond' due_at`,cut)).toBeUndefined();
  });

  it('moves known voice expiry without recovery reads and fences a baseline against concurrent source evidence',async()=>{
    let now=0;const work=new BackgroundWork(()=>now,()=>{}),wake=vi.fn(),owner=new BackgroundRecordDeadlines('voice-call-recovery',work,wake,()=>now);
    const run=vi.fn(async()=>{});work.addDeadline('voice-call-recovery',async()=>{owner.consume();await run();return owner.next();});
    const stop=owner.subscribe();
    const evidence=(due:number,ended=false)=>notifyCommandCompletion({principal:'background-record',operation:'voice-call-recovery',commandId:JSON.stringify(['call',due,ended])});
    try{
      await work.run(true);run.mockClear();
      for(let tick=1;tick<=120;tick++){
        now=tick*5000;evidence(now+15000);expect(await work.run(false)).toBe(15000);
      }
      expect(run).not.toHaveBeenCalled();
      let finish!:(rows:{id:string;due:number}[])=>void;
      const capturing=owner.capture(()=>new Promise(resolve=>{finish=resolve;}));
      evidence(now+20000);finish([{id:'call',due:now+1000}]);await capturing;
      expect(owner.next()).toBe(20000);
      now+=20000;await work.run(false);expect(run).toHaveBeenCalledOnce();
      evidence(now+15000,true);expect(owner.next()).toBeUndefined();
    }finally{stop();}
  });

  it('consumes actual PostgreSQL voice lease/terminal notifications without admitting recovery reads on renewal',async()=>{
    const db=fixture.database,human='b'.repeat(64),workspace='22222222-2222-4222-8222-222222222222',room='33333333-3333-4333-8333-333333333333',call='44444444-4444-4444-8444-444444444444';
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Voice owner')`,[human]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic')`,[workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Synthetic')`,[room,workspace]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('voice-source',$1,$2,'Synthetic call')`,[room,human]);
    const now=Date.now(),work=new BackgroundWork(()=>now,()=>{}),wake=vi.fn(),run=vi.fn(async()=>{});
    const deadlines=new BackgroundRecordDeadlines('voice-call-recovery',work,wake,()=>now),stop=deadlines.subscribe();
    work.addDeadline('voice-call-recovery',async()=>{await run();return deadlines.next();});await work.run(true);run.mockClear();
    try{
      await db.query(`INSERT INTO voice_calls(id,room_id,message_id,runtime_owner,runtime_until) VALUES($1,$2,'voice-source','synthetic-owner',clock_timestamp()+interval '15 seconds')`,[call,room]);
      await vi.waitFor(()=>expect(wake).toHaveBeenCalledOnce());
      for(let renewal=1;renewal<=20;renewal++){
        await db.query(`UPDATE voice_calls SET runtime_until=clock_timestamp()+interval '15 seconds' WHERE id=$1`,[call]);
        await vi.waitFor(()=>expect(wake).toHaveBeenCalledTimes(renewal+1));
        expect(await work.run(false)).toBeGreaterThan(0);
      }
      expect(run).not.toHaveBeenCalled();
      const due=deadlines.next();
      await expect(db.transaction(async tx=>{await tx.query(`UPDATE voice_calls SET ended_at=clock_timestamp() WHERE id=$1`,[call]);throw new Error('rollback');})).rejects.toThrow('rollback');
      expect(deadlines.next()).toBe(due);expect(wake).toHaveBeenCalledTimes(21);
      await db.query(`UPDATE voice_calls SET ended_at=clock_timestamp() WHERE id=$1`,[call]);await vi.waitFor(()=>expect(wake).toHaveBeenCalledTimes(22));
      expect(deadlines.next()).toBeUndefined();expect(run).not.toHaveBeenCalled();
    }finally{stop();}
  });

  it('uses an actual free-agent idle record once and never manufactures a failed-stop retry deadline',async()=>{
    const db=fixture.database,agent='d'.repeat(64),human='b'.repeat(64),workspace='22222222-2222-4222-8222-222222222222';
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Synthetic idle agent')`,[agent]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[agent,human]);
    await db.query(`INSERT INTO free_agents(agent_id,owner_id,workspace_id,state,fly_machine_id,sealed_keys,last_activity_at,wake_requested_at)
      VALUES($1,$2,$3,'running','synthetic-machine','unused',clock_timestamp()-interval '10 minutes',clock_timestamp()-interval '10 minutes')`,[agent,human,workspace]);
    const refused=vi.fn(async()=>{throw new Error('Synthetic stop result unknown');});
    const unexpected=vi.fn(async()=>{throw new Error('Unexpected provider action');});
    const machines={create:unexpected,find:unexpected,start:unexpected,suspend:unexpected,stop:refused,destroy:unexpected,state:unexpected,waitFor:unexpected} as unknown as FreeAgentMachines;
    const free=new FreeAgentService(db,freeAgentConfigFromEnv({BEELINE_FREE_AGENT_SEAL_KEY:'synthetic',FLY_FREE_AGENT_IMAGE:'synthetic'},'http://127.0.0.1')!,machines,unexpected,()=>{});
    expect(await free.sweep()).toBe(1);expect(refused).toHaveBeenCalledOnce();
    const due=await free.nextDelayMs();expect(due).toBeGreaterThan(29*86_400_000);
    expect(await free.sweep()).toBe(0);expect(refused).toHaveBeenCalledOnce();expect(unexpected).not.toHaveBeenCalled();
  });
});
