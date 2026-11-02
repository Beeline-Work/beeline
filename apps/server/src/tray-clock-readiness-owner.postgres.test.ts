import {LiveHub} from './live.js';
import {TrayClockWork,TRAY_CLOCK_WORK_SCHEMA} from './tray-clock-work.js';
import {randomUUID} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import {describe,expect,it} from 'vitest';
import {PostgresDatabase,type SqlDatabase} from './database.js';
import {BackgroundOwnership,BACKGROUND_OWNERSHIP_SCHEMA,BACKGROUND_LEADER_LOCK_KEY,type BackgroundEpoch} from './background-ownership.js';
import {DURABLE_LIVE_SCHEMA} from './durable-live.js';
import {TRAY_CLOCK_SOURCE_SCHEMA} from './tray-clock-source.js';
import {TRAY_CLOCK_OWNER_SCHEMA} from './tray-clock-owner.js';
import {TrayClockReadinessOwner} from './tray-clock-readiness-owner.js';
import {readTrayClockReadiness} from './tray-clock-readiness.js';
import {TrayClockHealth,readTrayClockHealth} from './tray-clock-health.js';

const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw new Error('Readiness owner proof requires isolated loopback PostgreSQL');
const WS='11111111-1111-4111-8111-111111111111',ROOM='22222222-2222-4222-8222-222222222222',AUTHOR='a'.repeat(64);
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
async function fixture(){
  const schema=`tray_ready_owner_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
  const config={connectionString:url,options:`-c search_path=${schema},public -c lock_timeout=100ms`,max:2};
  const first=new PostgresDatabase('',2,{pool:new Pool(config)}),second=new PostgresDatabase('',2,{pool:new Pool(config)});
  const locks=new Pool({connectionString:url,max:2,statement_timeout:0,options:'-c lock_timeout=0'}),held=new Set<PoolClient>();
  const scopes:Array<{owner:BackgroundOwnership;epoch:BackgroundEpoch}>=[];
  const close=async()=>{for(const{owner,epoch}of scopes)owner.revoke(epoch);for(const client of held)client.release(true);held.clear();
    await Promise.all([first.close(),second.close(),locks.end()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();};
  try{
    await first.query(`CREATE TABLE workspaces(id uuid PRIMARY KEY,name text);
      CREATE TABLE identities(id text PRIMARY KEY,kind text,handle text);
      CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,archived_at timestamptz);
      CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,removed_at timestamptz);
      CREATE TABLE messages(id text PRIMARY KEY,room_id uuid,author_id text,text text,presentation text DEFAULT 'message',card_type text,
        card jsonb,deleted_at timestamptz,created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE needs_you_marks(identity_id text,message_id text,workspace_id uuid,first_seen_at timestamptz,cleared_at timestamptz,PRIMARY KEY(identity_id,message_id));
      CREATE TABLE room_choices(id uuid PRIMARY KEY,workspace_id uuid,room_id uuid,status text,closes_at timestamptz);
      CREATE TABLE live_server_instances(instance_id text PRIMARY KEY,renewed_at timestamptz NOT NULL);
      INSERT INTO live_server_instances VALUES('first',clock_timestamp()),('second',clock_timestamp());`);
    await first.query(DURABLE_LIVE_SCHEMA);await first.query(BACKGROUND_OWNERSHIP_SCHEMA);
    await first.query(`INSERT INTO workspaces VALUES($1,'Synthetic')`,[WS]);
    await first.query(`INSERT INTO identities VALUES($1,'human','writer')`,[AUTHOR]);
    await first.query(`INSERT INTO rooms(id,workspace_id) VALUES($1,$2)`,[ROOM,WS]);
    await first.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('question',$1,$2,'@reader please?')`,[ROOM,AUTHOR]);
    await first.query(TRAY_CLOCK_SOURCE_SCHEMA);await first.query(TRAY_CLOCK_OWNER_SCHEMA);
  }catch(error){await close();throw error;}
  return{first,second,scopes,close,
    acquire:async()=>{const client=await locks.connect();held.add(client);await client.query('SELECT pg_advisory_lock($1)',[BACKGROUND_LEADER_LOCK_KEY]);return client;},
    drop:(client:PoolClient)=>{if(held.delete(client))client.release(true);},
  };
}
const inventory=async(db:SqlDatabase)=>({
  heads:(await db.query(`SELECT id,epoch,sequence::text FROM live_streams ORDER BY id`)).rows,
  progress:(await db.query(`SELECT * FROM tray_clock_readiness ORDER BY workspace_id`)).rows,
  clock:(await db.query(`SELECT * FROM tray_clock_state ORDER BY workspace_id`)).rows,
  sources:(await db.query(`SELECT * FROM tray_clock_sources ORDER BY source_kind,source_id,reader_id`)).rows,
  deadlines:(await db.query(`SELECT * FROM tray_clock_deadlines ORDER BY id`)).rows,
  floor:(await db.query(`SELECT * FROM tray_clock_readiness_floor`)).rows,
  health:(await db.query(`SELECT * FROM tray_clock_health`)).rows,
});

describe.skipIf(!url)('real PostgreSQL readiness at the existing aggregate-owner COMMIT boundary',()=>{
  it('a parked runner retires health for the other application pool without a new lease or timer',async()=>{
    const f=await fixture();let runner:TrayClockWork|undefined;
    try{
      await f.first.query(TRAY_CLOCK_WORK_SCHEMA);
      const lock=await f.acquire(),live=new LiveHub(),owner=new BackgroundOwnership(f.first,'first');
      let listenerReady=true;
      runner=new TrayClockWork(f.first,live,owner,{listenerReady:()=>listenerReady,wake:()=>{},unavailable:()=>{}});
      await runner.leadership.acquired(lock,new AbortController().signal);
      for(let n=0;n<20;n++)if(await runner.run()!==0)break;
      expect(await readTrayClockHealth(f.second,WS)).toBe(true);
      listenerReady=false;live.projectionUnavailable();await runner.run();
      expect(await readTrayClockHealth(f.second,WS)).toBe(false);
      expect((await f.second.query(`SELECT generation::text,released_at IS NOT NULL released FROM background_leader_owners`)).rows)
        .toEqual([{generation:'1',released:true}]);
      for(let n=0;n<10;n++){runner.observeServerLease('first',Date.now()+1000);live.journalChanged(['jobs:tray-clock']);await runner.run();}
      expect(await readTrayClockHealth(f.second,WS)).toBe(false);
      listenerReady=true;live.resync();
      for(let n=0;n<20;n++)if(await runner.run()!==0)break;
      expect(await readTrayClockHealth(f.second,WS)).toBe(true);
      expect((await f.second.query(`SELECT generation::text FROM background_leader_owners`)).rows).toEqual([{generation:'2'}]);
    }finally{await runner?.close();await f.close();}
  });

  it('bounds the actual health overdue probe with cold and generic plans across33024 pending deadlines',async()=>{
    const f=await fixture();
    try{
      const lock=await f.acquire(),owner=new BackgroundOwnership(f.first,'first'),epoch=await owner.claim(lock);f.scopes.push({owner,epoch});
      const readiness=new TrayClockReadinessOwner(owner);
      for(let n=0;n<20;n++)if(!(await readiness.run(epoch)).continuation)break;
      await new TrayClockHealth(owner).publish(epoch);
      // Physical access fixture only. Capture/eligibility semantics use the
      // separate real-source proofs; here unrelated pending work must not scan.
      await f.first.query(`INSERT INTO tray_clock_sources(source_kind,source_id,desired)
        SELECT 'message','health:'||n,'[]'::jsonb FROM generate_series(1,33024)n`);
      await f.first.query(`INSERT INTO tray_clock_deadlines(id,source_kind,source_id,reader_id,incarnation,revision,kind,workspace_id,room_id,due_at,state)
        SELECT source_id,'message',source_id,'',incarnation,revision,'question-age',
          CASE WHEN substring(source_id FROM 8)::integer<=256 THEN $1::uuid ELSE '44444444-4444-4444-8444-444444444444'::uuid END,
          $2,clock_timestamp()+interval '1 day','pending' FROM tray_clock_sources WHERE source_id LIKE 'health:%'`,[WS,ROOM]);
      let sql='';const observed:SqlDatabase={query:(statement,args)=>{sql=statement;return f.second.query(statement,args);},transaction:work=>f.second.transaction(work)};
      expect(await readTrayClockHealth(observed,WS)).toBe(true);
      type Plan={['Node Type']:string;['Index Name']?:string;['Relation Name']?:string;['Actual Rows']?:number;['Shared Hit Blocks']?:number;['Shared Read Blocks']?:number;Plans?:Plan[]};
      const flatten=(node:Plan):Plan[]=>[node,...(node.Plans??[]).flatMap(flatten)];
      const inspect=async(db:SqlDatabase,statement:string,args?:unknown[])=>{
        const result=await db.query<{'QUERY PLAN':Array<{Plan:Plan}>}>(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${statement}`,args);
        const plans=flatten(result.rows[0]!['QUERY PLAN'][0]!.Plan);
        const due=plans.filter(node=>node['Relation Name']==='tray_clock_deadlines');
        expect(due).toHaveLength(1);expect(due[0]!['Index Name']).toBe('tray_clock_workspace_due_idx');
        expect(due[0]!['Node Type']).toMatch(/^Index (Only )?Scan$/);expect(due[0]!['Actual Rows']).toBeLessThanOrEqual(1);
        expect((due[0]!['Shared Hit Blocks']??0)+(due[0]!['Shared Read Blocks']??0)).toBeLessThanOrEqual(16);
      };
      await inspect(f.second,sql,[WS]);
      await f.second.transaction(async tx=>{
        await tx.query('SET LOCAL plan_cache_mode=force_generic_plan');await tx.query(`PREPARE health_probe AS ${sql}`);
        await inspect(tx,`EXECUTE health_probe('${WS}')`);await tx.query('DEALLOCATE health_probe');
      });
    }finally{await f.close();}
  },30000);

  it('requires the completed initial drain on both servers and refuses an old owner after takeover',async()=>{
    const f=await fixture();
    try{
      const lockA=await f.acquire(),ownerA=new BackgroundOwnership(f.first,'first'),epochA=await ownerA.claim(lockA);
      f.scopes.push({owner:ownerA,epoch:epochA});const healthA=new TrayClockHealth(ownerA),readinessA=new TrayClockReadinessOwner(ownerA);
      await expect(healthA.publish(epochA)).rejects.toThrow('initial drain');
      for(let n=0;n<20;n++)if(!(await readinessA.run(epochA)).continuation)break;
      expect((await readTrayClockReadiness(f.second,WS))?.ready).toBe(true);
      expect(await readTrayClockHealth(f.first,WS)).toBe(false);expect(await readTrayClockHealth(f.second,WS)).toBe(false);
      await healthA.publish(epochA);const before=await inventory(f.second);
      expect(await readTrayClockHealth(f.first,WS)).toBe(true);expect(await readTrayClockHealth(f.second,WS)).toBe(true);
      expect(await inventory(f.second)).toEqual(before);
      for(const stream of ['jobs:tray-clock','jobs:tray-clock-readiness'])for(const reset of ['epoch','sequence']){
        await expect(f.first.transaction(async tx=>{
          await tx.query(reset==='epoch'?`UPDATE live_streams SET epoch='reset-epoch' WHERE id=$1`:
            `UPDATE live_streams SET sequence=0 WHERE id=$1`,[stream]);
          expect(await readTrayClockHealth(tx,WS)).toBe(false);
          expect(await readTrayClockHealth(f.second,WS)).toBe(true);
          throw new Error('Synthetic rollback');
        })).rejects.toThrow('Synthetic rollback');
      }
      // A future captured source advances the global stream without forcing
      // unrelated observation or making already committed clock truth stale.
      await f.first.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('future',$1,$2,'@reader please?')`,[ROOM,AUTHOR]);
      expect(await readTrayClockHealth(f.second,WS)).toBe(true);
      const other='44444444-4444-4444-8444-444444444444',otherRoom='55555555-5555-4555-8555-555555555555';
      await f.first.query(`INSERT INTO workspaces VALUES($1,'Other')`,[other]);
      await f.first.query(`INSERT INTO rooms(id,workspace_id) VALUES($1,$2)`,[otherRoom,other]);
      await f.first.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('other',$1,$2,'@reader please?')`,[otherRoom,AUTHOR]);
      await f.first.query(`UPDATE tray_clock_deadlines SET due_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1`,[other]);
      expect(await readTrayClockHealth(f.second,other)).toBe(false);
      expect(await readTrayClockHealth(f.second,WS)).toBe(true);
      // Retire this synthetic overdue obligation, then complete its captured
      // migration before testing a new aggregate owner's initial drain.
      await f.first.query(`DELETE FROM messages WHERE id='other'`);
      for(let n=0;n<20;n++)if(!(await readinessA.run(epochA)).continuation)break;
      ownerA.revoke(epochA);f.drop(lockA);const lockB=await f.acquire();
      expect(await readTrayClockHealth(f.first,WS)).toBe(false);
      const ownerB=new BackgroundOwnership(f.second,'second'),epochB=await ownerB.claim(lockB);f.scopes.push({owner:ownerB,epoch:epochB});
      expect(await readTrayClockHealth(f.first,WS)).toBe(false);
      await new TrayClockHealth(ownerB).publish(epochB);
      expect(await readTrayClockHealth(f.first,WS)).toBe(true);
      await f.second.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '91 seconds' WHERE instance_id='second'`);
      expect(await readTrayClockHealth(f.first,WS)).toBe(false);
    }finally{await f.close();}
  },30000);

  it.each(['question-age','question-seen','agent-sign-in','squire-approval','choice-close'] as const)(
    'refuses a missed %s due boundary without mutating committed clock state',async kind=>{
      const f=await fixture();
      try{
        const lock=await f.acquire(),owner=new BackgroundOwnership(f.first,'first'),epoch=await owner.claim(lock);f.scopes.push({owner,epoch});
        const readiness=new TrayClockReadinessOwner(owner);
        for(let n=0;n<20;n++)if(!(await readiness.run(epoch)).continuation)break;
        await new TrayClockHealth(owner).publish(epoch);
        // Exercise the availability guard against a committed pending row for
        // every kind. Source-capture semantics are proved separately; this
        // synthetic due transition deliberately does not run the expiry owner.
        await f.first.query(`UPDATE tray_clock_deadlines SET kind=$1,state='pending',due_at=clock_timestamp()-interval '1 second'`,[kind]);
        const before=await inventory(f.second);
        expect(await readTrayClockHealth(f.second,WS)).toBe(false);
        expect(await inventory(f.second)).toEqual(before);
        await expect(new TrayClockHealth(owner).publish(epoch)).rejects.toThrow('initial drain');
      }finally{await f.close();}
    },30000);

  it.each(['initialize','sources','publish','health'] as const)('rolls back %s if the exact advisory backend dies after the final owner SELECT',async stage=>{
    const f=await fixture(),returned=deferred(),release=deferred();let armed=false;
    const observed:SqlDatabase={query:(sql,args)=>f.first.query(sql,args),transaction:work=>f.first.transaction(async tx=>{
      let target=false;const scoped:SqlDatabase={query:async(sql,args)=>{
        const result=await tx.query(sql,args);
        if(armed&&(stage==='health'?sql.startsWith('INSERT INTO tray_clock_health'):stage==='initialize'?sql.startsWith('INSERT INTO tray_clock_readiness_floor'):
          stage==='sources'?sql.startsWith('SELECT beeline_tray_clock_reconcile'):sql.startsWith('SELECT beeline_tray_clock_publish_basis')))target=true;
        return result;
      },transaction:work=>tx.transaction(work)};
      const result=await work(scoped);if(target){returned.resolve();await release.promise;}return result;
    })};
    let flight:Promise<unknown>|undefined;
    try{
      const lockA=await f.acquire(),coreA=new BackgroundOwnership(observed,'first'),epochA=await coreA.claim(lockA);f.scopes.push({owner:coreA,epoch:epochA});
      const ownerA=new TrayClockReadinessOwner(coreA);
      if(stage!=='initialize'){
        expect(await ownerA.run(epochA)).toEqual({continuation:true});
        if(stage==='publish')for(let n=0;n<10;n++){
          const phase=(await f.first.query<{phase:string}>(`SELECT phase FROM tray_clock_readiness WHERE workspace_id=$1`,[WS])).rows[0]!.phase;
          if(phase==='publish')break;await ownerA.run(epochA);
        }
      }
      if(stage==='health')for(let n=0;n<20;n++)if(!(await ownerA.run(epochA)).continuation)break;
      if(stage==='publish')expect((await f.first.query(`SELECT phase FROM tray_clock_readiness WHERE workspace_id=$1`,[WS])).rows).toEqual([{phase:'publish'}]);
      const before=await inventory(f.second);armed=true;flight=stage==='health'?new TrayClockHealth(coreA).publish(epochA):ownerA.run(epochA);await returned.promise;
      // Domain callback and final lockEpoch have returned. Actual driver
      // COMMIT has not run; second-pool state is exactly the prior receipt.
      expect(await inventory(f.second)).toEqual(before);
      f.drop(lockA);const lockB=await f.acquire(),coreB=new BackgroundOwnership(f.second,'second');
      await expect(coreB.claim(lockB)).rejects.toMatchObject({code:'55P03'});
      expect((await f.second.query(`SELECT renewed_at>clock_timestamp()-interval '90 seconds' fresh FROM live_server_instances WHERE instance_id='first'`)).rows).toEqual([{fresh:true}]);
      const rejected=expect(flight).rejects.toMatchObject({code:'23514'});release.resolve();await rejected;armed=false;
      expect(await inventory(f.second)).toEqual(before);expect((await f.second.query(`SELECT * FROM tray_clock_owner_fences`)).rows).toEqual([]);
      const epochB=await coreB.claim(lockB);f.scopes.push({owner:coreB,epoch:epochB});const ownerB=new TrayClockReadinessOwner(coreB);
      for(let n=0;n<15;n++)if(!(await ownerB.run(epochB)).continuation)break;
      expect((await readTrayClockReadiness(f.second,WS))?.ready).toBe(true);
      if(stage==='health'){await new TrayClockHealth(coreB).publish(epochB);expect(await readTrayClockHealth(f.first,WS)).toBe(true);}
      expect((await f.second.query(`SELECT count(*)::int n FROM tray_clock_deadlines WHERE source_id='question'`)).rows).toEqual([{n:1}]);
    }finally{release.resolve();await flight?.catch(()=>{});await f.close();}
  });
});
