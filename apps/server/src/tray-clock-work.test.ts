import {EventEmitter} from 'node:events';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {migratedDatabase,type PgliteDatabase} from './test-support.js';
import type {SqlDatabase} from './database.js';
import {BackgroundLeader,type LeaderConnection} from './background-leader.js';
import {BackgroundOwnership,BACKGROUND_OWNERSHIP_SCHEMA} from './background-ownership.js';
import {TrayClockOwner,TRAY_CLOCK_OWNER_SCHEMA} from './tray-clock-owner.js';
import {TrayChoiceClockOwner} from './tray-choice-clock-owner.js';
import {TRAY_CLOCK_SOURCE_SCHEMA} from './tray-clock-source.js';
import {TrayClockWork,TRAY_CLOCK_WORK_SCHEMA} from './tray-clock-work.js';
import {TrayClockHealth} from './tray-clock-health.js';
import {TrayClockReadinessOwner} from './tray-clock-readiness-owner.js';
import {postRoomChoice} from './room-choice.js';
import {LiveHub} from './live.js';
import {installBackgroundOwnerTestProof,backgroundOwnerTestLock} from './test-fixtures/background-owner-test-support.js';
vi.mock('./sentry.js',()=>({captureServerError:vi.fn()}));
const VIEWER='a'.repeat(64),AUTHOR='b'.repeat(64),ROOM='11111111-1111-4111-8111-111111111111',WS='22222222-2222-4222-8222-222222222222';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
const settle=async()=>{for(let n=0;n<60;n++)await Promise.resolve();};
class Lock extends EventEmitter implements LeaderConnection{
  constructor(private readonly proof:Awaited<ReturnType<typeof backgroundOwnerTestLock>>){super();}
  held=false;statements:string[]=[];
  async query<Row>(sql:string,values?:unknown[]):Promise<{rows:Row[]}>{this.statements.push(sql);
    if(sql.includes('pg_advisory_lock('))this.held=true;
    if(sql.includes('FROM pg_catalog.pg_locks')){
      const result=await this.proof.query<Row>(sql,values);
      return this.held?result:{rows:result.rows.map(row=>({...row as Record<string,unknown>,held:false} as unknown as Row))};
    }
    return {rows:[]};
  }
  release=vi.fn(()=>{this.held=false;});
}
describe('unselected existing-leader Tray clock composition',()=>{
  let db:PgliteDatabase,live:LiveHub,statements:string[],ready:boolean,now:number,recovery:(()=>void)|undefined;
  let after:((sql:string)=>Promise<void>)|undefined,fail:boolean;
  let lockProof:Awaited<ReturnType<typeof backgroundOwnerTestLock>>;
  const runners:TrayClockWork[]=[],leaders:BackgroundLeader[]=[],cleanups:Array<()=>Promise<void>>=[];
  beforeEach(async()=>{
    db=await migratedDatabase();live=new LiveHub();statements=[];ready=true;now=0;recovery=undefined;after=undefined;fail=false;
    // These existing expiry tests deliberately replace the installed semantic
    // SQL clock. They cannot attest the canonical capture manifest. The real
    // readiness composition is exercised separately with unchanged SQL in
    // tray-clock-work.readiness.test.ts, including ownership/loss/source paths.
    vi.spyOn(TrayClockReadinessOwner.prototype,'run').mockResolvedValue({continuation:false});
    vi.spyOn(TrayClockHealth.prototype,'publish').mockResolvedValue();
    await db.query(`CREATE TABLE tray_work_test_clock(now_at timestamptz);INSERT INTO tray_work_test_clock VALUES('2000-01-08');
      CREATE FUNCTION tray_work_test_now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$SELECT now_at FROM tray_work_test_clock$$;`);
    await db.query(BACKGROUND_OWNERSHIP_SCHEMA);await db.query(TRAY_CLOCK_SOURCE_SCHEMA.replaceAll('clock_timestamp()','tray_work_test_now()'));
    await db.query(TRAY_CLOCK_OWNER_SCHEMA);await db.query(TRAY_CLOCK_WORK_SCHEMA);
    await installBackgroundOwnerTestProof(db);lockProof=await backgroundOwnerTestLock(db);
    await db.query(`INSERT INTO live_server_instances(instance_id) VALUES('tray-work');
      INSERT INTO identities(id,kind,name,handle) VALUES('${VIEWER}','human','Synthetic reader','reader'),('${AUTHOR}','agent','Synthetic author','writer');
      INSERT INTO workspaces(id,name) VALUES('${WS}','Synthetic');INSERT INTO rooms(id,workspace_id,name) VALUES('${ROOM}','${WS}','Synthetic');
      INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES('${WS}',NULL,'${VIEWER}','owner'),('${WS}','${ROOM}','${VIEWER}','owner');`);
  });
  afterEach(async()=>{
    for(const runner of runners.splice(0))await runner.close();
    for(const leader of leaders.splice(0))await leader.stop();
    for(const close of cleanups.splice(0))await close();vi.restoreAllMocks();await db.close();
  });
  const wrap=(database:SqlDatabase):SqlDatabase=>({query:async(sql,args)=>{
    statements.push(sql);
    if(fail&&sql.includes('FROM tray_clock_deadlines')&&sql.includes('LIMIT 100'))throw new Error('synthetic source failure');
    const wire=sql.includes('tray_clock_deadlines')?sql.replaceAll('clock_timestamp()','tray_work_test_now()'):sql;
    const result=await database.query(wire,args);await after?.(sql);return result;
  },transaction:work=>database.transaction(tx=>work(wrap(tx)))});
  const make=()=>{
    const observed={...wrap(db),onRecovery:(listener:()=>void)=>{recovery=listener;return()=>{recovery=undefined;};}};
    // The owning lease/COMMIT clock stays real. Only semantic job time and
    // runner scheduling are controlled; there is no synthetic lease renewal.
    const ownership=new BackgroundOwnership(observed,'tray-work'),wake=vi.fn(),unavailable=vi.fn();
    const runner=new TrayClockWork(observed,live,ownership,{listenerReady:()=>ready,wake,unavailable,now:()=>now});runners.push(runner);
    const connection=new Lock(lockProof),controller=new AbortController();connection.held=true;
    return {runner,ownership,wake,unavailable,connection,controller,attach:()=>runner.leadership.acquired(connection,controller.signal)};
  };
  const question=(id='question',remainingMs=6*86400000)=>db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
    VALUES($1,$2,$3,'@reader please?',tray_work_test_now()-interval '7 days'+$4::double precision*interval '1 millisecond')`,[id,ROOM,AUTHOR,remainingMs]);
  const advance=(at='2000-01-14')=>db.query(`UPDATE tray_work_test_clock SET now_at=$1`,[at]);
  const clockRows=async()=>(await db.query(`SELECT event FROM live_journal WHERE event->>'sourceTable'='tray-clock'`)).rows;
  const createChoice=()=>db.transaction(tx=>postRoomChoice(tx,{roomId:ROOM,agentId:VIEWER,mode:'question',prompt:'Synthetic choice?',
    options:[{label:'One',consequence:'One'},{label:'Two',consequence:'Two'}],ttlSeconds:300}));

  it('initializes an empty source only in migration, then acquires/inspects once and stays read-idle',async()=>{
    const before=(await db.query(`SELECT epoch,sequence::text FROM live_streams WHERE id='jobs:tray-clock'`)).rows;
    await db.query(TRAY_CLOCK_WORK_SCHEMA);expect((await db.query(`SELECT epoch,sequence::text FROM live_streams WHERE id='jobs:tray-clock'`)).rows).toEqual(before);
    const c=make();await c.attach();expect(await c.runner.run()).toBe(Infinity);const count=statements.length;
    now=86400000;expect(await c.runner.run()).toBe(Infinity);expect(statements).toHaveLength(count);
    live.journalChanged([`workspace:${WS}`]);expect(c.wake).not.toHaveBeenCalled();expect(c.runner.status().state).toBe('live');
  });
  it.each(['listener','owner'] as const)('durably retires a claim completed after %s loss',async loss=>{
    const c=make(),reached=deferred(),release=deferred();
    const claim=c.ownership.claim.bind(c.ownership);
    vi.spyOn(c.ownership,'claim').mockImplementation(async connection=>{
      const epoch=await claim(connection);reached.resolve();await release.promise;return epoch;
    });
    const attaching=c.attach();
    try{
      await reached.promise;
      if(loss==='listener'){ready=false;live.projectionUnavailable();}else c.controller.abort();
      expect(c.runner.status().state).toBe('parked');
    }finally{release.resolve();await attaching;}
    expect((await db.query('SELECT released_at IS NOT NULL AS released FROM background_leader_owners')).rows)
      .toEqual([{released:true}]);
    const count=statements.length;
    await c.runner.run();live.journalChanged(['jobs:tray-clock']);await c.runner.run();
    expect(statements).toHaveLength(count);expect(c.runner.status().state).toBe('parked');
  });

  it('executes real question expiry100 then a due continuation1, never an invented repair deadline',async()=>{
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
      SELECT 'q-'||n,$1,$2,'@reader please?','2000-01-07' FROM generate_series(1,101)n`,[ROOM,AUTHOR]);
    await advance();const display=vi.spyOn(TrayClockOwner.prototype,'drain'),choice=vi.spyOn(TrayChoiceClockOwner.prototype,'drain'),c=make();await c.attach();
    expect(await c.runner.run()).toBe(0);expect(display).toHaveBeenCalledOnce();expect(choice).toHaveBeenCalledOnce();
    expect(await c.runner.run()).toBe(Infinity);expect(display).toHaveBeenCalledTimes(2);expect(choice).toHaveBeenCalledOnce();expect(await clockRows()).toHaveLength(101);
    const count=statements.length;expect(await c.runner.run()).toBe(Infinity);expect(statements).toHaveLength(count);
  });
  it('runs the actual existing choice terminal handler once, independently of the display expiry adapter',async()=>{
    const created=await createChoice();await db.query(`UPDATE room_choices SET closes_at='2000-01-10' WHERE id=$1`,[created.choiceId]);await advance();
    const c=make();await c.attach();expect(await c.runner.run()).toBe(Infinity);
    expect((await db.query(`SELECT status FROM room_choices WHERE id=$1`,[created.choiceId])).rows).toEqual([{status:'skipped'}]);
    expect((await db.query(`SELECT state FROM tray_clock_deadlines WHERE kind='choice-close'`)).rows).toEqual([{state:'cancelled'}]);
    expect((await db.query(`SELECT * FROM tray_clock_owner_fences`)).rows).toEqual([]);
  });
  it('consumes committed jobs:tray-clock records through the existing live owner and targets only their domain',async()=>{
    const c=make();await c.attach();await c.runner.run();const display=vi.spyOn(TrayClockOwner.prototype,'drain'),choice=vi.spyOn(TrayChoiceClockOwner.prototype,'drain');
    const woke=deferred();c.wake.mockImplementation(()=>{woke.resolve();});
    const stop=await db.client.listen('beeline_live_v1',raw=>{const value=JSON.parse(raw);if(value.journalStreams)live.journalChanged(value.journalStreams);});cleanups.push(stop);
    await question();await woke.promise;await c.runner.run();expect(display).toHaveBeenCalledOnce();expect(choice).not.toHaveBeenCalled();
    display.mockClear();const next=deferred();c.wake.mockImplementation(()=>{next.resolve();});await createChoice();await next.promise;await c.runner.run();
    expect(display).not.toHaveBeenCalled();expect(choice).toHaveBeenCalledOnce();
  });
  it('uses only the exact returned future row/version and makes zero reads on premature or duplicate wakes',async()=>{
    await question('future',5000);const c=make();await c.attach();expect(await c.runner.run()).toBe(5000);
    const deadline=c.runner.status().display;expect(deadline).toMatchObject({kind:'question-age',remainingMs:5000});const count=statements.length;
    now=4999;expect(await c.runner.run()).toBe(1);expect(statements).toHaveLength(count);
    live.journalChanged(['jobs:tray-clock']);live.journalChanged(['jobs:tray-clock']);const display=vi.spyOn(TrayClockOwner.prototype,'drain');
    await Promise.all([c.runner.run(),c.runner.run()]);expect(display).not.toHaveBeenCalled();
    await db.query(`UPDATE tray_work_test_clock SET now_at=now_at+interval '5 seconds'`);now=5000;
    expect(await c.runner.run()).toBe(Infinity);expect(display).toHaveBeenCalledOnce();expect(await clockRows()).toHaveLength(1);
  });
  it('parks a failed run with no deadline/retry and routine aggregate evidence cannot reclaim it',async()=>{
    await question();const c=make();await c.attach();fail=true;expect(await c.runner.run()).toBe(Infinity);
    expect(c.runner.status()).toEqual({state:'parked'});const count=statements.length;
    for(let n=1;n<=10;n++){c.runner.observeServerLease('tray-work',Date.now()+n*30000);live.journalChanged(['jobs:tray-clock']);expect(await c.runner.run()).toBe(Infinity);}
    expect(statements).toHaveLength(count);expect(c.unavailable).toHaveBeenCalledOnce();expect(c.wake).not.toHaveBeenCalled();
    fail=false;live.resync();live.resync();await c.runner.run();expect(c.runner.status().state).toBe('live');
    expect((await db.query(`SELECT generation::text FROM background_leader_owners`)).rows).toEqual([{generation:'2'}]);
  });
  it('rejects a missing retained cause, hides old deadlines and admits one new baseline only on actual recovery',async()=>{
    const c=make();await c.attach();await c.runner.run();await question();
    await db.query(`DELETE FROM live_journal WHERE stream_id='jobs:tray-clock'`);live.journalChanged(['jobs:tray-clock']);await c.runner.run();
    expect(c.runner.status()).toEqual({state:'parked'});const count=statements.length;
    live.journalChanged(['jobs:tray-clock']);await c.runner.run();expect(statements).toHaveLength(count);
    recovery?.();recovery?.();await c.runner.run();expect(c.runner.status()).toMatchObject({state:'live',generation:'2',display:{kind:'question-age'}});
  });
  it('actual listener loss cancels/hides deadlines and future work until the same source reports recovery',async()=>{
    await question('future',5000);const c=make();await c.attach();await c.runner.run();ready=false;live.projectionUnavailable();
    expect(c.runner.status()).toEqual({state:'parked'});const count=statements.length;
    now=10000;await c.runner.run();live.resync();await c.runner.run();expect(statements).toHaveLength(count);
    ready=true;live.resync();await c.runner.run();expect(c.runner.status().state).toBe('live');
  });
  it('does not initialize a missing durable stream during acquisition or ordinary source notifications',async()=>{
    await db.query(`DELETE FROM live_streams WHERE id='jobs:tray-clock'`);const c=make();await c.attach();
    expect(c.runner.status()).toEqual({state:'parked'});const count=statements.length;
    live.journalChanged(['jobs:tray-clock']);await c.runner.run();expect(statements).toHaveLength(count);
    expect((await db.query(`SELECT 1 FROM live_streams WHERE id='jobs:tray-clock'`)).rowCount).toBe(0);
    await db.query(TRAY_CLOCK_WORK_SCHEMA);live.resync();await c.runner.run();expect(c.runner.status().state).toBe('live');
  });
  it('same-leader stop aborts the opaque epoch immediately but retains its actual connection until the active transaction rolls back',async()=>{
    await question();await advance();const c=make(),reached=deferred(),release=deferred();let pause=true;
    after=async sql=>{if(pause&&sql.includes('SELECT beeline_tray_clock_consume')){pause=false;reached.resolve();await release.promise;}};
    const connection=new Lock(lockProof),leader=new BackgroundLeader({connectDedicated:async()=>connection},()=>c.runner.run(),c.runner.leadership);leaders.push(leader);
    let stopped:Promise<void>|undefined;
    try{void leader.run();await reached.promise;stopped=leader.stop();
      expect(c.runner.status()).toEqual({state:'parked'});expect(connection.release).not.toHaveBeenCalled();
    }finally{release.resolve();await(stopped??leader.stop());}
    expect(connection.release).toHaveBeenCalledOnce();expect(await clockRows()).toEqual([]);
    expect((await db.query(`SELECT state FROM tray_clock_deadlines WHERE source_id='question'`)).rows).toEqual([{state:'pending'}]);
  });
  it('coalesces a real source wake during an active drain into one followup, not a per-hint queue',async()=>{
    await question();await advance();const c=make();await c.attach();let queued=true;
    after=async sql=>{if(queued&&sql.includes('SELECT beeline_tray_clock_consume')){queued=false;live.journalChanged(['jobs:tray-clock']);live.journalChanged(['jobs:tray-clock']);}};
    expect(await c.runner.run()).toBe(0);expect(await c.runner.run()).toBe(Infinity);expect(await clockRows()).toHaveLength(1);
    const count=statements.length;await c.runner.run();expect(statements).toHaveLength(count);
  });
});
