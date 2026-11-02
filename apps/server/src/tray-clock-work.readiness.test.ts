import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {migratedDatabase,type PgliteDatabase} from './test-support.js';
import type {SqlDatabase} from './database.js';
import {BackgroundOwnership,BACKGROUND_OWNERSHIP_SCHEMA} from './background-ownership.js';
import {TRAY_CLOCK_OWNER_SCHEMA} from './tray-clock-owner.js';
import {TRAY_CLOCK_SOURCE_SCHEMA} from './tray-clock-source.js';
import {TrayClockReadiness,readTrayClockReadiness} from './tray-clock-readiness.js';
import {TrayClockWork,TRAY_CLOCK_WORK_SCHEMA} from './tray-clock-work.js';
import {LiveHub} from './live.js';
import {installBackgroundOwnerTestProof,backgroundOwnerTestLock} from './test-fixtures/background-owner-test-support.js';

const WS='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222',ROOM='33333333-3333-4333-8333-333333333333',AUTHOR='a'.repeat(64);
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
type After=(sql:string,args?:unknown[])=>Promise<void>;
describe('actual-schema aggregate-owned Tray readiness composition',()=>{
  let db:PgliteDatabase,live:LiveHub,runner:TrayClockWork,ownership:BackgroundOwnership,controller:AbortController;
  let statements:string[],after:After|undefined,listenerReady:boolean,recovery:(()=>void)|undefined,stop:()=>Promise<void>;
  let attach:()=>Promise<void>,wake:ReturnType<typeof vi.fn>;
  beforeEach(async()=>{
    db=await migratedDatabase();live=new LiveHub();statements=[];after=undefined;listenerReady=true;recovery=undefined;
    await db.query(`DO $$DECLARE item record;BEGIN FOR item IN SELECT t.tgname,c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname=current_schema() AND NOT t.tgisinternal AND t.tgname LIKE 'beeline_tray_clock_%'
      LOOP EXECUTE format('DROP TRIGGER %I ON %I',item.tgname,item.relname);END LOOP;END $$;`);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Synthetic','reader')`,[AUTHOR]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Existing'),($2,'Empty')`,[WS,OTHER]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Synthetic')`,[ROOM,WS]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) SELECT 'old-'||lpad(n::text,3,'0'),$1,$2,'@reader please?' FROM generate_series(1,205)n`,[ROOM,AUTHOR]);
    await db.query(BACKGROUND_OWNERSHIP_SCHEMA);await db.query(TRAY_CLOCK_SOURCE_SCHEMA);await db.query(TRAY_CLOCK_OWNER_SCHEMA);await db.query(TRAY_CLOCK_WORK_SCHEMA);
    await installBackgroundOwnerTestProof(db);const proof=await backgroundOwnerTestLock(db);
    await db.query(`INSERT INTO live_server_instances(instance_id) VALUES('tray-ready')`);
    const observed=(database:SqlDatabase):SqlDatabase=>({query:async(sql,args)=>{
      statements.push(sql);const result=await database.query(sql,args);await after?.(sql,args);return result;
    },transaction:work=>database.transaction(tx=>work(observed(tx)))});
    const database={...observed(db),onRecovery:(listener:()=>void)=>{recovery=listener;return()=>{recovery=undefined;};}};
    ownership=new BackgroundOwnership(database,'tray-ready');wake=vi.fn();
    runner=new TrayClockWork(database,live,ownership,{listenerReady:()=>listenerReady,wake,unavailable:vi.fn(),now:()=>0});
    controller=new AbortController();const connection={...proof,release:()=>{}};
    attach=()=>runner.leadership.acquired(connection,controller.signal);
    stop=await db.client.listen('beeline_live_v1',raw=>{const value=JSON.parse(raw);if(Array.isArray(value.journalStreams))live.journalChanged(value.journalStreams);});
  });
  afterEach(async()=>{runner.close();await stop();vi.restoreAllMocks();await db.close();});
  const finish=async()=>{for(let n=0;n<40;n++){const delay=await runner.run();if(delay!==0)return delay;}throw new Error('Finite lifecycle fixture did not exhaust');};
  const heads=async()=>(await db.query(`SELECT id,epoch,sequence::text FROM live_streams ORDER BY id`)).rows;

  it('backfills205 pre-feature sources and an empty Workspace under one epoch, then becomes read-idle',async()=>{
    const step=vi.spyOn(TrayClockReadiness.prototype,'step'),init=vi.spyOn(TrayClockReadiness.prototype,'initialize'),owned=vi.spyOn(ownership,'withTransaction');
    await attach();expect(await finish()).toBeGreaterThan(0);
    expect((await readTrayClockReadiness(db,WS))?.ready).toBe(true);expect((await readTrayClockReadiness(db,OTHER))?.ready).toBe(true);
    expect((await db.query(`SELECT count(*)::int n FROM tray_clock_deadlines WHERE kind='question-age'`)).rows).toEqual([{n:205}]);
    expect(init).toHaveBeenCalledOnce();expect(owned.mock.calls.filter(call=>call[1]==='tray.readiness').length).toBeGreaterThan(5);
    for(const result of step.mock.results){const batch=await result.value;if(batch)expect(batch.processed).toBeLessThanOrEqual(100);}
    expect((await db.query(`SELECT * FROM tray_clock_owner_fences`)).rows).toEqual([]);
    const count=statements.length;for(let n=0;n<20;n++)await runner.run();expect(statements).toHaveLength(count);
    runner.observeServerLease('tray-ready',Date.now()+1000);live.journalChanged([`workspace:${WS}`]);await runner.run();expect(statements).toHaveLength(count);
    expect((await db.query(`SELECT generation::text FROM background_leader_owners`)).rows).toEqual([{generation:'1'}]);
  });

  it('takes genuine new-empty-Workspace and OLD/NEW Room-move work from the same existing source owner',async()=>{
    await attach();await finish();const unrelated=(await readTrayClockReadiness(db,OTHER))!.generation;
    const fresh='44444444-4444-4444-8444-444444444444';
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'New empty')`,[fresh]);
    expect((await readTrayClockReadiness(db,fresh))?.ready).toBe(false);await finish();expect((await readTrayClockReadiness(db,fresh))?.ready).toBe(true);
    expect((await readTrayClockReadiness(db,OTHER))?.generation).toBe(unrelated);
    await db.query(`UPDATE rooms SET workspace_id=$1 WHERE id=$2`,[fresh,ROOM]);
    expect((await readTrayClockReadiness(db,WS))?.ready).toBe(false);expect((await readTrayClockReadiness(db,fresh))?.ready).toBe(false);
    await finish();expect((await readTrayClockReadiness(db,WS))?.ready).toBe(true);expect((await readTrayClockReadiness(db,fresh))?.ready).toBe(true);
    expect((await db.query(`SELECT DISTINCT workspace_id::text FROM tray_clock_deadlines WHERE state<>'cancelled'`)).rows).toEqual([{workspace_id:fresh}]);
    expect((await readTrayClockReadiness(db,OTHER))?.generation).toBe(unrelated);
  });

  it('coalesces opening hints received after source-head SELECT before local adoption',async()=>{
    const fresh='44444444-4444-4444-8444-444444444444';let once=true;
    after=async(sql,args)=>{if(once&&sql.startsWith('SELECT epoch,sequence::text FROM live_streams')&&args?.[0]==='jobs:tray-clock-readiness'){
      once=false;await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Opening race')`,[fresh]);
    }};
    await attach();await finish();expect((await readTrayClockReadiness(db,fresh))?.ready).toBe(true);
    const head=(await db.query<{epoch:string;through:string}>(`SELECT epoch,sequence::text through FROM live_streams WHERE id='jobs:tray-clock-readiness'`)).rows[0]!;
    expect(runner.status().readinessSource).toEqual({epoch:head.epoch,through:Number(head.through)});
  });

  it('rolls a stopped batch and its cursor/source cuts back, then refuses recovery on the aborted connection',async()=>{
    await attach();expect(await runner.run()).toBe(0);
    const before=await heads(),progress=(await db.query(`SELECT * FROM tray_clock_readiness ORDER BY workspace_id`)).rows;
    const reached=deferred(),release=deferred();let pause=true;
    after=async sql=>{if(pause&&sql.startsWith('SELECT beeline_tray_clock_reconcile')){pause=false;reached.resolve();await release.promise;}};
    const flight=runner.run();
    try{await reached.promise;controller.abort();expect(runner.status()).toEqual({state:'parked'});release.resolve();expect(await flight).toBe(Infinity);}
    finally{release.resolve();await flight;}
    expect(await heads()).toEqual(before);expect((await db.query(`SELECT * FROM tray_clock_readiness ORDER BY workspace_id`)).rows).toEqual(progress);
    const count=statements.length;live.journalChanged(['jobs:tray-clock-readiness']);runner.observeServerLease('tray-ready',Date.now()+1000);await runner.run();expect(statements).toHaveLength(count);
    // An aborted connection cannot be reclaimed by a resync. New actual
    // connection acquisition supplies the distinct ownership admission.
    live.resync();await runner.run();expect(statements).toHaveLength(count);
  });

  it('parks a capture-audit failure without retries; one actual recovery admits one fresh audit/epoch',async()=>{
    await db.query(`ALTER TABLE messages DISABLE TRIGGER beeline_tray_clock_message_change`);await attach();expect(await runner.run()).toBe(Infinity);
    expect(runner.status()).toEqual({state:'parked'});const count=statements.length;
    for(let n=0;n<10;n++){runner.observeServerLease('tray-ready',Date.now()+n*30000);live.journalChanged(['jobs:tray-clock-readiness']);await runner.run();}
    expect(statements).toHaveLength(count);expect((await db.query(`SELECT * FROM tray_clock_readiness_floor`)).rows).toEqual([]);
    await db.query(TRAY_CLOCK_SOURCE_SCHEMA);recovery?.();recovery?.();await finish();expect((await readTrayClockReadiness(db,WS))?.ready).toBe(true);
    expect((await db.query(`SELECT generation::text FROM background_leader_owners`)).rows).toEqual([{generation:'2'}]);
  });

  it.each(['gap','unknown'] as const)('rejects %s readiness history independently and cannot continue from routine evidence',async kind=>{
    await attach();await finish();
    await db.query(`SELECT beeline_journal('jobs:tray-clock-readiness',$1::jsonb)`,[JSON.stringify({sourceTable:'tray-clock-readiness-work',version:1,
      workspaceId:WS,generation:'a'.repeat(32),phase:kind==='unknown'?'unknown':'sources'})]);
    if(kind==='gap')await db.query(`DELETE FROM live_journal WHERE stream_id='jobs:tray-clock-readiness' AND sequence=(SELECT sequence FROM live_streams WHERE id='jobs:tray-clock-readiness')`);
    live.journalChanged(['jobs:tray-clock-readiness']);expect(await runner.run()).toBe(Infinity);expect(runner.status()).toEqual({state:'parked'});
    const count=statements.length;await runner.run();live.journalChanged(['jobs:tray-clock']);await runner.run();expect(statements).toHaveLength(count);
  });
});
