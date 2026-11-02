import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {describe,expect,it} from 'vitest';
import {PostgresDatabase,type SqlDatabase} from './database.js';
import {DURABLE_LIVE_SCHEMA} from './durable-live.js';
import {TRAY_CLOCK_SOURCE_SCHEMA} from './tray-clock-source.js';
import {TrayClockReadiness,readTrayClockReadiness} from './tray-clock-readiness.js';

const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw new Error('Readiness proof requires isolated loopback PostgreSQL');
const WS='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222',ROOM='33333333-3333-4333-8333-333333333333';
const AUTHOR='a'.repeat(64);
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
const observe=(db:SqlDatabase,after:(sql:string)=>Promise<void>):SqlDatabase=>({query:async(sql,args)=>{
  const result=await db.query(sql,args);await after(sql);return result;
},transaction:work=>db.transaction(tx=>work(observe(tx,after)))});
async function rig(run:(first:SqlDatabase,second:SqlDatabase,owner:TrayClockReadiness)=>Promise<void>){
  const schema=`tray_ready_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url,max:1});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const config={connectionString:url,options:`-c search_path=${schema},public`,max:2};
  const first=new PostgresDatabase('',2,{pool:new Pool(config)}),second=new PostgresDatabase('',2,{pool:new Pool(config)});
  try{
    await first.query(`CREATE TABLE workspaces(id uuid PRIMARY KEY,name text);
      CREATE TABLE identities(id text PRIMARY KEY,kind text,handle text);
      CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,archived_at timestamptz);
      CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,removed_at timestamptz);
      CREATE TABLE messages(id text PRIMARY KEY,room_id uuid,author_id text,text text,presentation text DEFAULT 'message',
        card_type text,card jsonb,deleted_at timestamptz,created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE needs_you_marks(identity_id text,message_id text,workspace_id uuid,first_seen_at timestamptz,cleared_at timestamptz,
        PRIMARY KEY(identity_id,message_id));
      CREATE TABLE room_choices(id uuid PRIMARY KEY,workspace_id uuid,room_id uuid,status text,closes_at timestamptz);`);
    await first.query(DURABLE_LIVE_SCHEMA);
    // Existing rows genuinely precede capture installation. No hand-written
    // source/deadline rows or test replacement production functions exist.
    await first.query(`INSERT INTO workspaces VALUES($1,'Old'),($2,'Other')`,[WS,OTHER]);
    await first.query(`INSERT INTO identities VALUES($1,'human','writer')`,[AUTHOR]);
    await first.query(`INSERT INTO rooms(id,workspace_id) VALUES($1,$2)`,[ROOM,WS]);
    await first.query(`INSERT INTO messages(id,room_id,author_id,text)
      SELECT 'old-'||lpad(n::text,3,'0'),$1,$2,'@reader please?' FROM generate_series(1,205)n`,[ROOM,AUTHOR]);
    await first.query(TRAY_CLOCK_SOURCE_SCHEMA);
    const owner=new TrayClockReadiness(first);await owner.initialize();
    expect(await owner.seed()).toEqual({processed:2,continuation:false});await run(first,second,owner);
  }finally{await Promise.all([first.close(),second.close()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
async function finish(owner:TrayClockReadiness){
  for(let n=0;n<30;n++){const result=await owner.step();if(!result||!result.continuation)return;}
  throw new Error('Readiness lifecycle did not exhaust finite fixture');
}
const heads=async(db:SqlDatabase)=>(await db.query(`SELECT id,epoch,sequence::text FROM live_streams ORDER BY id`)).rows;

describe.skipIf(!url)('real PostgreSQL bounded Tray readiness lifecycle',()=>{
  it('covers concurrent inserts on both sides of a persisted high watermark and a new empty Workspace',async()=>{
    await rig(async(first,second,owner)=>{
      await owner.step();expect(await owner.step()).toMatchObject({workspaceId:WS,processed:100,ready:false});
      await second.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES
        ('000-behind-cursor',$1,$2,'@reader please?'),('zz-after-high-watermark',$1,$2,'@reader please?')`,[ROOM,AUTHOR]);
      const fresh='00000000-0000-4000-8000-000000000001';
      await second.query(`INSERT INTO workspaces VALUES($1,'New empty')`,[fresh]);
      expect((await readTrayClockReadiness(second,fresh))?.ready).toBe(false);
      await finish(owner);
      for(const workspace of [WS,OTHER,fresh])expect((await readTrayClockReadiness(second,workspace))?.ready).toBe(true);
      expect((await first.query(`SELECT count(*)::int n FROM tray_clock_deadlines WHERE kind='question-age'`)).rows).toEqual([{n:207}]);
      expect((await first.query(`SELECT count(*)::int n FROM tray_clock_deadlines WHERE source_id IN('000-behind-cursor','zz-after-high-watermark')`)).rows).toEqual([{n:2}]);
      const before=await heads(first);expect(await owner.step()).toBe(null);expect(await heads(first)).toEqual(before);
    });
  });

  it('serializes a Room move against a real bounded batch, then invalidates both scopes until a new exhaustive generation',async()=>{
    await rig(async(first,second,owner)=>{
      await owner.step();const entered=deferred(),release=deferred();let paused=false;
      const gated=new TrayClockReadiness(observe(first,async sql=>{
        if(!paused&&sql.startsWith('SELECT beeline_tray_clock_reconcile')){paused=true;entered.resolve();await release.promise;}
      }));
      const batch=gated.step();
      try{
        await entered.promise;
        await expect(second.transaction(async tx=>{
          await tx.query(`SET LOCAL lock_timeout='100ms'`);
          await tx.query(`UPDATE rooms SET workspace_id=$1 WHERE id=$2`,[OTHER,ROOM]);
        })).rejects.toMatchObject({code:'55P03'});
        release.resolve();await batch;
      }finally{release.resolve();await batch;}
      const before=(await first.query(`SELECT workspace_id,generation FROM tray_clock_state ORDER BY workspace_id`)).rows;
      await second.query(`UPDATE rooms SET workspace_id=$1 WHERE id=$2`,[OTHER,ROOM]);
      const after=(await first.query<{workspace_id:string;generation:string;ready:boolean}>(`SELECT workspace_id,generation,ready FROM tray_clock_state ORDER BY workspace_id`)).rows;
      expect(after.every(row=>!row.ready)).toBe(true);
      expect(after.map(row=>row.generation)).not.toEqual(before.map(row=>row.generation));
      await finish(owner);
      expect((await readTrayClockReadiness(first,WS))?.ready).toBe(true);expect((await readTrayClockReadiness(first,OTHER))?.ready).toBe(true);
      expect((await first.query(`SELECT DISTINCT workspace_id::text FROM tray_clock_deadlines WHERE state<>'cancelled'`)).rows).toEqual([{workspace_id:OTHER}]);
    });
  });

  it('rolls final publication, canonical cut, and completion receipt back together before a later owned admission',async()=>{
    await rig(async(first,second,owner)=>{
      for(let n=0;n<12;n++){
        const phase=(await first.query<{phase:string}>(`SELECT phase FROM tray_clock_readiness WHERE workspace_id=$1`,[WS])).rows[0]!.phase;
        if(phase==='publish')break;await owner.step();
      }
      expect((await first.query(`SELECT phase FROM tray_clock_readiness WHERE workspace_id=$1`,[WS])).rows).toEqual([{phase:'publish'}]);
      const before=await heads(first),progress=(await first.query(`SELECT * FROM tray_clock_readiness WHERE workspace_id=$1`,[WS])).rows;
      let fail=true;const broken=new TrayClockReadiness(observe(first,async sql=>{
        if(fail&&sql.startsWith('SELECT beeline_tray_clock_publish_basis')){fail=false;throw new Error('synthetic publication failure');}
      }));
      await expect(broken.step()).rejects.toThrow('synthetic publication failure');
      expect(await heads(second)).toEqual(before);expect((await readTrayClockReadiness(second,WS))?.ready).toBe(false);
      expect((await second.query(`SELECT * FROM tray_clock_readiness WHERE workspace_id=$1`,[WS])).rows).toEqual(progress);
      await finish(owner);const ready=await readTrayClockReadiness(second,WS);expect(ready?.ready).toBe(true);
      expect((await second.query(`SELECT event->>'generation' generation,event->>'revision' revision FROM live_journal
        WHERE stream_id=$1 AND sequence=$2`,[`workspace:${WS}`,ready!.workspace_through])).rows)
        .toEqual([{generation:ready!.generation,revision:ready!.revision}]);
    });
  });
});
