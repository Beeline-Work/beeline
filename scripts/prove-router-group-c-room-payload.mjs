// Run with BEELINE_COMMAND_TEST_POSTGRES_URL pointing to isolated loopback PG:
// node --import tsx scripts/prove-router-group-c-room-payload.mjs
// This is a closure gate, not an expected-failure test. A nonzero exit leaves
// F07 OPEN; its assertions must not be converted to accept budget refusal.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { readRoomView } from '@beeline/api-contract/phone';
import { migrate, PostgresDatabase } from '../apps/server/src/database.ts';
import { readRoomTools } from '../apps/server/src/room-tool-projection.ts';
import { fenceRouterEnqueue } from '../apps/server/src/router-projections.ts';
import { PhoneService } from '../apps/server/src/phone-service.ts';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
assert.ok(url, 'BEELINE_COMMAND_TEST_POSTGRES_URL is required; this proof cannot skip');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname), 'isolated loopback PostgreSQL is required');
const schema = `group_c_payload_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: url, max: 1 });
await admin.query(`CREATE SCHEMA ${schema}`);
// Keep the extension available to all connections in this private test DB.
await admin.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
const db = new PostgresDatabase('', 2, { pool: new Pool({ connectionString: url, options: `-c search_path=${schema},public`, max: 2 }) });
const viewer = 'a'.repeat(64), agent = 'b'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111', parent = '22222222-2222-4222-8222-222222222222', corner = '33333333-3333-4333-8333-333333333333';
const result = { finding: 'F07', proof: 'P8/P11 200 large tools absent initial DTO', tools: 200, toolOutputBytes: 32768 };
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Reader'),($2,'agent','Worker')`, [viewer, agent]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [agent, viewer]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic payload')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,parent_id) VALUES($1,$3,'Parent',NULL),($2,$3,'Corner',$1)`, [parent, corner, workspace]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner')`, [workspace, parent, viewer]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,activity,created_at)
    SELECT md5('large-tool-'||n)||md5('large-tool-'||n),$1,$2,'','activity',jsonb_build_array(jsonb_build_object('kind','tool','title','Synthetic tool',
      'output',repeat('x',$3::int))),now()-interval '1 second'*n FROM generate_series(1,200)n`, [corner, agent, result.toolOutputBytes]);
  const phone = new PhoneService(db, 'https://synthetic.test'), input = { family: 'room-head', workspaceId: workspace, roomId: corner };
  if(process.env.BEELINE_GROUP_C_COST_PROOF==='1'){
    const measure=async(candidate)=>{
      let statements=0,queryResultBytes=0;
      const wrap=database=>({transaction:work=>database.transaction(tx=>work(wrap(tx))),query:async(sql,args)=>{
        statements++;const result=await database.query(sql,args);queryResultBytes+=Buffer.byteLength(JSON.stringify(result.rows));return result;
      }});
      const reader=new PhoneService(wrap(db),'https://synthetic.test');
      const walBefore=(await admin.query('SELECT pg_current_wal_insert_lsn()::text position')).rows[0].position;
      const cpu=process.cpuUsage(),start=performance.now();
      const value=await(candidate?reader.readRouterSnapshot(input,viewer):reader.readRoom(corner,viewer));
      const elapsedMs=performance.now()-start,used=process.cpuUsage(cpu);
      const walAfter=(await admin.query('SELECT pg_current_wal_insert_lsn()::text position')).rows[0].position;
      return {statements,queryResultBytes,wireBytes:Buffer.byteLength(JSON.stringify(value)),elapsedMs,
        nodeCpuMicros:used.user+used.system,walBytes:Number((await admin.query('SELECT pg_wal_lsn_diff($1,$2)::text bytes',[walAfter,walBefore])).rows[0].bytes)};
    };
    const samples=[];for(let n=0;n<5;n++)samples.push({legacy:await measure(false),candidate:await measure(true)});
    result.readWorkload={samples,scope:'Same authorized 200-tool collapsed Room open; local Node CPU/elapsed, not production PostgreSQL CPU or native paint'};
    result.finding='F13';result.proof='P11 equal-workload initial Room statement/WAL/bytes gate';
    assert.ok(samples.every(sample=>sample.candidate.statements<=sample.legacy.statements),
      `candidate statements ${samples[0].candidate.statements} exceed legacy ${samples[0].legacy.statements}`);
    assert.ok(samples.every(sample=>sample.candidate.walBytes<=sample.legacy.walBytes),'candidate WAL regression');
    assert.ok(samples.every(sample=>sample.candidate.queryResultBytes<=sample.legacy.queryResultBytes),'candidate SQL result byte regression');
  }
  const raw = await db.transaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return phone.buildRouterValue(tx, input, viewer);
  });
  result.initialToolRows = raw?.toolRows?.length ?? 0;
  result.initialValueBytes = Buffer.byteLength(JSON.stringify(raw));
  // Both requirements are binding: a budget exception is not an acceptable
  // bounded baseline, and silently dropping tool information is not expansion.
  const snapshot = await phone.readRouterSnapshot(input, viewer);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 64 * 1024, 'initial Room envelope exceeds 64 KiB');
  assert.equal(snapshot.value.toolRows?.length ?? 0, 0, 'collapsed tool groups leaked their full rows into initial DTO');
  const parsed=readRoomView(snapshot.value);
  assert.ok(parsed,'the bounded baseline must pass the actual client DTO guard');
  assert.equal(parsed.messages.length,snapshot.value.messages.length,'the client guard must not discard a malformed source ID');
  const reference=parsed.messages.flatMap(message=>message.activity??[]).find(item=>item.toolGroup)?.toolGroup;
  assert.equal(reference?.count,200,'aggregate must preserve the exact count of deferred tools');
  const ids=[];let before;
  do{
    const page=await readRoomTools(db,{...reference,...(before?{before}:{})},viewer);
    assert.ok(page.messages.length<=50,'tool page row budget');
    assert.ok(Buffer.byteLength(JSON.stringify(page))<=64*1024,'tool page byte budget');
    for(const message of page.messages){
      ids.push(message.id);
      for(const item of message.activity??[])assert.ok(Buffer.byteLength(JSON.stringify(item.output??''))<=1024,'bounded tool excerpt');
    }
    before=page.next;
    if(ids.length===50)await db.query(`INSERT INTO messages(id,room_id,author_id,text)
      SELECT md5('new-head-'||n)||md5('new-head-'||n),$1,$2,'Unrelated head arrival' FROM generate_series(1,100)n`,[corner,viewer]);
  }while(before);
  assert.equal(ids.length,200);assert.equal(new Set(ids).size,200,'stable continuation cannot duplicate or omit tools');
  const full=await readRoomTools(db,{...reference,messageId:ids[0]},viewer);
  assert.equal(full.messages[0].activity[0].output,'x'.repeat(32768),'explicit Open returns full stored output');
  let enqueued=0;
  await db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2',[parent,viewer]);
  await assert.rejects(()=>fenceRouterEnqueue(db,input,viewer,full.authority,()=>{enqueued++;}),{reason:'authority'});
  assert.equal(enqueued,0,'revoked full output must never enqueue');
  result.expandedToolRows=ids.length;result.fullOutputBytes=32768;result.revokeEnqueues=enqueued;
  result.status = 'PASS';
} catch (error) {
  result.status = 'FAIL'; result.error = { name: error.name, message: error.message, reason: error.reason };
  process.exitCode = 1;
} finally {
  await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
}
console.log(JSON.stringify(result));
