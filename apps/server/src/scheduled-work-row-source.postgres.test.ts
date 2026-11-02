import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {describe,expect,it} from 'vitest';
import {PostgresDatabase,type SqlDatabase} from './database.js';
import {POSTGRES_LIVE_SCHEMA} from './postgres-live.js';
import {routerSourcePlan} from './router-source-plan.js';
const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw new Error('Scheduled row source proof requires isolated loopback PostgreSQL');
const legacy=await readFile(new URL('./test-fixtures/scheduled-work-legacy-source.sql',import.meta.url),'utf8');
const WS='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const ROOM='33333333-3333-4333-8333-333333333333',OTHER_ROOM='44444444-4444-4444-8444-444444444444';
const FIRST='55555555-5555-4555-8555-555555555555',SECOND='66666666-6666-4666-8666-666666666666',VIEWER='a'.repeat(64);
const current=POSTGRES_LIVE_SCHEMA.slice(0,POSTGRES_LIVE_SCHEMA.indexOf('-- Memory jobs'));
async function fixture(db:SqlDatabase){
  await db.query(`CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid NOT NULL,parent_id uuid,direct_participants jsonb);
    CREATE TABLE corner_github_cache(corner_id uuid PRIMARY KEY REFERENCES rooms(id),lifecycle jsonb NOT NULL DEFAULT '{}'::jsonb);
    CREATE TABLE agent_schedules(id uuid PRIMARY KEY,workspace_id uuid NOT NULL,room_id uuid NOT NULL,agent_id text NOT NULL,
      creator_id text,title text,max_runs integer,cadence jsonb,message text,next_run_at timestamptz,created_at timestamptz,
      workflow_slug text,run_count integer DEFAULT 0,workflow_run text);
    CREATE TABLE agent_subscriptions(id uuid PRIMARY KEY,workspace_id uuid NOT NULL,room_id uuid NOT NULL,agent_id text NOT NULL,prompt text);`);
  await db.query(current);
  for(const table of ['agent_schedules','agent_subscriptions'])await db.query(`CREATE TRIGGER beeline_notify_live_${table} AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION beeline_notify_live()`);
  await db.query(`INSERT INTO rooms VALUES($1,$3,NULL,NULL),($2,$4,NULL,NULL)`,[ROOM,OTHER_ROOM,WS,OTHER]);
  await db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,message) VALUES($1,$3,$5,$7,'One'),($2,$4,$6,$7,'Two')`,[FIRST,SECOND,WS,OTHER,ROOM,OTHER_ROOM,VIEWER]);
}
async function isolated(work:(db:PostgresDatabase)=>Promise<void>){
  const schema=`scheduled_fold_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
  const db=new PostgresDatabase('',4,{pool:new Pool({connectionString:url,max:4,options:`-c search_path=${schema},public`})});
  try{await fixture(db);await work(db);}finally{await db.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
describe.skipIf(!url)('real PostgreSQL canonical Scheduled Work row source',()=>{
  it('concurrent opposite Workspace moves take every Workspace lock before any legacy Room lock and preserve exact OLD/NEW targets',async()=>{
    await isolated(async db=>{
      // Test-only call trace surrounds the actual production journal. It is
      // not used by the WAL workload; no source implementation is substituted.
      await db.query(`CREATE TABLE proof_calls(position bigserial PRIMARY KEY,tx bigint,stream text);
        ALTER FUNCTION beeline_journal(text,jsonb) RENAME TO beeline_journal_proof_original;
        CREATE FUNCTION beeline_journal(stream text,body jsonb) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
          PERFORM beeline_journal_proof_original(stream,body);INSERT INTO proof_calls(tx,stream) VALUES(txid_current(),stream);END $$;`);
      const before=(await db.query(`SELECT id,sequence::text FROM live_streams WHERE id LIKE 'workspace:%' ORDER BY id`)).rows;
      await Promise.all([
        db.transaction(async tx=>{await tx.query(`SET LOCAL lock_timeout='2000ms'`);await tx.query(`UPDATE agent_schedules SET room_id=$1,workspace_id=$2 WHERE id=$3`,[OTHER_ROOM,OTHER,FIRST]);}),
        db.transaction(async tx=>{await tx.query(`SET LOCAL lock_timeout='2000ms'`);await tx.query(`UPDATE agent_schedules SET room_id=$1,workspace_id=$2 WHERE id=$3`,[ROOM,WS,SECOND]);}),
      ]);
      const calls=(await db.query<{tx:string;stream:string}>(`SELECT tx::text,stream FROM proof_calls ORDER BY position`)).rows;
      const transactions=[...new Set(calls.map(row=>row.tx))];expect(transactions).toHaveLength(2);
      for(const tx of transactions){
        const streams=calls.filter(row=>row.tx===tx).map(row=>row.stream);
        expect(streams.slice(0,2)).toEqual([`workspace:${WS}`,`workspace:${OTHER}`]);
        expect(streams.slice(2).every(stream=>stream.startsWith('room:'))).toBe(true);
      }
      for(const head of before){
        const rows=(await db.query(`SELECT event FROM live_journal WHERE stream_id=$1 AND sequence>$2 ORDER BY live_journal.sequence`,[head.id,head.sequence])).rows;
        expect(rows).toHaveLength(2);
        const expectedRoom=head.id===`workspace:${WS}`?ROOM:OTHER_ROOM;
        expect(routerSourcePlan(rows.map(row=>row.event),VIEWER).scheduledWorkCauses).toEqual([{roomId:expectedRoom,readers:null}]);
        for(const row of rows)expect(row.event.scheduledWorkSource.targets).toEqual([{roomId:expectedRoom,readers:null}]);
      }
    });
  });
  it('actual old/new installer order preserves canonical coverage when duplicates return, then converges without dropping a write',async()=>{
    await isolated(async db=>{
      const write=async(expected:number)=>{
        const before=(await db.query(`SELECT sequence::text FROM live_streams WHERE id=$1`,[`workspace:${WS}`])).rows[0]!.sequence;
        await db.query(`UPDATE agent_schedules SET run_count=run_count+1 WHERE id=$1`,[FIRST]);
        const causes=(await db.query(`SELECT event FROM live_journal WHERE stream_id=$1 AND sequence>$2 ORDER BY live_journal.sequence`,[`workspace:${WS}`,before])).rows.map(row=>row.event);
        expect(causes).toHaveLength(expected);expect(causes.filter(cause=>cause.scheduledWorkSource)).toHaveLength(1);
        expect(routerSourcePlan(causes,VIEWER).scheduledWorkCauses).toEqual([{roomId:ROOM,readers:null}]);
      };
      await write(1);await db.query(legacy);await write(3);
      // Exact two-table removal performed by ROOM_SCHEDULES_CAPTURE_SCHEMA;
      // unrelated product tables are absent from this isolated SQL fixture.
      await db.query(current);
      for(const table of ['agent_schedules','agent_subscriptions'])await db.query(`DROP TRIGGER zz_beeline_scheduled_work_capture ON ${table}`);
      await write(1);await db.query(legacy);await write(3);
    });
  });
});
