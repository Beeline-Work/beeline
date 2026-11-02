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
});

describe.skipIf(!url)('real PostgreSQL readiness at the existing aggregate-owner COMMIT boundary',()=>{
  it.each(['initialize','sources','publish'] as const)('rolls back %s if the exact advisory backend dies after the final owner SELECT',async stage=>{
    const f=await fixture(),returned=deferred(),release=deferred();let armed=false;
    const observed:SqlDatabase={query:(sql,args)=>f.first.query(sql,args),transaction:work=>f.first.transaction(async tx=>{
      let target=false;const scoped:SqlDatabase={query:async(sql,args)=>{
        const result=await tx.query(sql,args);
        if(armed&&(stage==='initialize'?sql.startsWith('INSERT INTO tray_clock_readiness_floor'):
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
      if(stage==='publish')expect((await f.first.query(`SELECT phase FROM tray_clock_readiness WHERE workspace_id=$1`,[WS])).rows).toEqual([{phase:'publish'}]);
      const before=await inventory(f.second);armed=true;flight=ownerA.run(epochA);await returned.promise;
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
      expect((await f.second.query(`SELECT count(*)::int n FROM tray_clock_deadlines WHERE source_id='question'`)).rows).toEqual([{n:1}]);
    }finally{release.resolve();await flight?.catch(()=>{});await f.close();}
  });
});
