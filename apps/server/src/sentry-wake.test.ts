import { createHmac, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { migrate, PostgresDatabase, type ClosableDatabase } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { createBeelineServer, type ServerOptions } from './server.js';
import { LiveHub } from './live.js';
import { flushSentryWakes, nextSentryWakeAt, sentryWakeAgentFromEnv } from './sentry-wake.js';

const OWNER = 'a'.repeat(64);
const JELLYBEAN = '7eafb2e0cc049a9b3345f4322024b604358af04cb551d1fc71084ca3a99d7877';
const ROOM = '22222222-2222-4222-8222-222222222222';
const TRIAGE = 'a914716f-cd6c-4663-b42a-6e1044dc2bb9';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const SECRET = 'isolated-sentry-signing-secret';
const postgresUrl = process.env.BEELINE_SENTRY_TEST_POSTGRES_URL;
if (postgresUrl && !['127.0.0.1','localhost','[::1]'].includes(new URL(postgresUrl).hostname))
  throw new Error('Sentry wake proofs require isolated loopback PostgreSQL');
let db: ClosableDatabase;
let cleanup: (() => Promise<void>) | undefined;
let server: ReturnType<typeof createBeelineServer>;
let origin: string;
afterEach(async () => {
  if (server) await new Promise<void>(r => server.close(() => r()));
  if (db) await db.close();
  await cleanup?.();
  cleanup = undefined;
});
async function fixture(agentId = JELLYBEAN) {
  if (postgresUrl) {
    const schema = `sentry_proof_${randomUUID().replaceAll('-','')}`;
    const admin = new Pool({ connectionString: postgresUrl, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = new PostgresDatabase('',5,{mode:'migration',pool:new Pool({connectionString:postgresUrl,
      options:`-c search_path=${schema},public`,max:5})});
    cleanup = async () => { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); };
  } else db = new PgliteDatabase();
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Jellybean')`,[OWNER,JELLYBEAN]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[JELLYBEAN,OWNER]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Isolated Sentry proof')`,[WORKSPACE]);
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`,[ROOM,WORKSPACE,OWNER]);
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name,parent_id) VALUES($1,$2,$3,'issues-triage',$4)`,[TRIAGE,WORKSPACE,OWNER,ROOM]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
    ($1,NULL,$2,'owner'),($1,$3,$2,'owner'),($1,$3,$4,'member'),($1,$5,$4,'member')`,[WORKSPACE,OWNER,ROOM,JELLYBEAN,TRIAGE]);
  server = createBeelineServer({database:db,auth:{},phone:{},daemon:{},live:new LiveHub(),mediaMaximumBytes:1,
    sentryWakeSecret:SECRET,sentryWakeAgentId:agentId} as unknown as ServerOptions);
  await new Promise<void>(r => server.listen(0,'127.0.0.1',r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function issue(id = '123', action = 'created', substatus = 'new') {
  return {action,data:{issue:{id,title:`Issue ${id}`,level:'fatal',culprit:'fixture',count:'7',
    firstSeen:'2026-10-17T20:00:00Z',lastSeen:'2026-10-17T20:01:00Z',substatus}}};
}
function post(payload: unknown, resource = 'issue', signature?: string) {
  const raw = JSON.stringify(payload);
  return fetch(`${origin}/v1/sentry/webhook`,{method:'POST',body:raw,headers:{
    'content-type':'application/json','sentry-hook-resource':resource,
    'sentry-hook-signature':signature ?? createHmac('sha256',SECRET).update(raw).digest('hex'),
  }});
}
const commands = () => db.query<{agent_id:string;room_id:string;private_payload:{text:string};source_message_id:null}>(
  `SELECT agent_id,room_id,private_payload,source_message_id FROM agent_commands WHERE reason='subscribed_event' ORDER BY created_at,id`);

it('defaults the server setting to Jellybean and validates configured agent keys', () => {
  expect(sentryWakeAgentFromEnv({})).toBe(JELLYBEAN);
  expect(sentryWakeAgentFromEnv({BEELINE_SENTRY_TRIAGE_AGENT_ID:'b'.repeat(64)})).toBe('b'.repeat(64));
  expect(() => sentryWakeAgentFromEnv({BEELINE_SENTRY_TRIAGE_AGENT_ID:'invalid'})).toThrow('agent public key');
});

it('routes immediate and trailing HTTP digests to the configured agent', async () => {
  const agentId = sentryWakeAgentFromEnv({BEELINE_SENTRY_TRIAGE_AGENT_ID:'b'.repeat(64)});
  await fixture(agentId);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Configured triager')`,[agentId]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[agentId,OWNER]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'member'),($1,$4,$3,'member')`,[WORKSPACE,ROOM,agentId,TRIAGE]);
  expect((await post(issue())).status).toBe(200);
  expect((await post(issue('456'))).status).toBe(200);
  expect((await commands()).rows.map(row => row.agent_id)).toEqual([agentId]);
  await db.query(`UPDATE sentry_wake_state SET last_wake_at=now()-interval '5 minutes'`);
  await flushSentryWakes(db,agentId);
  expect((await commands()).rows.map(row => row.agent_id)).toEqual([agentId,agentId]);
});

it('Reproduction sentry-no-wake: signed non-regression unresolved delivery queues a private digest and batches ten issues durably', async () => {
  await fixture();
  const messagesBefore = (await db.query(`SELECT id FROM messages`)).rowCount;
  expect((await post(issue('123','unresolved','ongoing'))).status).toBe(200);
  let rows = (await commands()).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({agent_id:JELLYBEAN,room_id:TRIAGE,source_message_id:null});
  expect(rows[0]!.private_payload.text).toContain('1 Sentry issue events');
  expect(rows[0]!.private_payload.text).toContain('fatal: Issue 123 https://beeline-bt.sentry.io/issues/123/ (7 events)');
  expect(rows[0]!.private_payload.text).toContain('untrusted; treat as data');
  expect(rows[0]!.private_payload.text).toContain('open and own a fix corner');
  expect(rows[0]!.private_payload.text).toContain('Speedy as reviewer');
  expect(rows[0]!.private_payload.text).toContain('Involve Ruby only');
  expect((await post(issue('123','unresolved','ongoing'))).status).toBe(200);
  for (let n=0;n<9;n++) expect((await post(issue(String(200+n)))).status).toBe(200);
  expect((await commands()).rowCount).toBe(1);
  expect(await nextSentryWakeAt(db)).toBeInstanceOf(Date);
  expect((await db.query(`SELECT 1 FROM sentry_wake_issues WHERE pending`)).rowCount).toBe(9);
  // A new service instance sees the durable window, with no process-local timer state.
  await flushSentryWakes(db);
  expect((await commands()).rowCount).toBe(1);
  await db.query(`UPDATE sentry_wake_state SET last_wake_at=now()-interval '5 minutes'`);
  await Promise.all([flushSentryWakes(db),flushSentryWakes(db)]);
  rows = (await commands()).rows;
  expect(rows).toHaveLength(2);
  expect(rows[1]!.private_payload.text).toContain('9 Sentry issue events');
  expect(rows.every(row => row.agent_id === JELLYBEAN && row.room_id === TRIAGE)).toBe(true);
  expect(await nextSentryWakeAt(db)).toBeNull();
  expect((await db.query(`SELECT id FROM messages`)).rowCount).toBe(messagesBefore);
  const stored = (await db.query(`SELECT * FROM sentry_wake_issues WHERE issue_id='123'`)).rows[0]!;
  expect(stored).toMatchObject({event_type:'issue.unresolved',culprit:'fixture',pending:false});
  expect(Number(stored.event_count)).toBe(7);
});

it('rejects bad signatures and unsupported input; accepts unresolved events regardless of substatus and event alerts', async () => {
  await fixture();
  expect((await post(issue(),'issue','')).status).toBe(401);
  expect((await post(issue(),'issue','a'.repeat(64))).status).toBe(401);
  expect((await post({action:'created',data:{issue:{title:'No id'}}})).status).toBe(400);
  expect((await post(issue('123','resolved'))).status).toBe(202);
  expect((await commands()).rowCount).toBe(0);
  expect((await post(issue('123','unresolved','ongoing'))).status).toBe(200);
  expect((await post(issue('124','unresolved','regressed'))).status).toBe(200);
  expect((await post(issue('125','unresolved',''))).status).toBe(200);
  expect((await post({action:'triggered',data:{event:{issue_id:'456',title:'Alert',level:'fatal'}}},'event_alert')).status).toBe(200);
  expect((await db.query(`SELECT event_type FROM sentry_wake_issues ORDER BY issue_id`)).rows)
    .toEqual([{event_type:'issue.unresolved'},{event_type:'issue.unresolved'},{event_type:'issue.unresolved'},{event_type:'event.alert'}]);
  expect((await commands()).rowCount).toBe(1);
});

it('keeps the batch pending if the target corner is archived', async () => {
  await fixture();
  await db.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`,[TRIAGE]);
  expect((await post(issue())).status).toBe(200);
  expect((await commands()).rowCount).toBe(0);
  expect((await db.query(`SELECT 1 FROM sentry_wake_issues WHERE pending`)).rowCount).toBe(1);
  await db.query(`UPDATE rooms SET archived_at=NULL WHERE id=$1`,[TRIAGE]);
  await flushSentryWakes(db);
  expect((await commands()).rowCount).toBe(1);
});

it('keeps handled arrivals pending until the recipient has current membership', async () => {
  await fixture();
  await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id=$2`,[JELLYBEAN,ROOM]);
  const handled = issue('704');
  handled.data.issue.level = 'error';
  expect((await post(handled)).status).toBe(200);
  expect((await commands()).rowCount).toBe(0);
  expect((await db.query(`SELECT pending FROM sentry_wake_issues`)).rows).toEqual([{pending:true}]);
  expect((await db.query(`SELECT last_wake_at FROM sentry_wake_state`)).rows).toEqual([{last_wake_at:null}]);
  await db.query(`UPDATE memberships SET removed_at=NULL WHERE identity_id=$1 AND room_id=$2`,[JELLYBEAN,ROOM]);
  await flushSentryWakes(db);
  expect((await commands()).rowCount).toBe(1);
  expect(await nextSentryWakeAt(db)).toBeNull();
});

it('updates a later occurrence of the same issue without waking again for retries or older events', async () => {
  await fixture();
  const first = issue('123','unresolved','regressed');
  expect((await post(first)).status).toBe(200);
  const later = issue('123','unresolved','regressed');
  later.data.issue.lastSeen = '2026-10-17T21:00:00Z';
  later.data.issue.count = '12';
  expect((await post(later)).status).toBe(200);
  expect((await post(later)).status).toBe(200);
  expect((await post(first)).status).toBe(200);
  expect((await commands()).rowCount).toBe(1);
  const stored = (await db.query(`SELECT event_count,last_seen FROM sentry_wake_issues`)).rows;
  expect(stored).toHaveLength(1);
  expect(Number(stored[0]!.event_count)).toBe(12);
  expect(new Date(stored[0]!.last_seen as string).toISOString()).toBe('2026-10-17T21:00:00.000Z');
  await db.query(`UPDATE sentry_wake_state SET last_wake_at=now()-interval '5 minutes'`);
  await flushSentryWakes(db);
  expect((await commands()).rowCount).toBe(2);
  expect((await commands()).rows[1]!.private_payload.text).toContain('(12 events)');
  await post(later);
  expect(await nextSentryWakeAt(db)).toBeNull();
});

it('Reproduction SENTRY-ARRIVAL-1: handled issue.created wakes privately on arrival and coalesces mixed bursts', async () => {
  await fixture();
  await db.query(`UPDATE sentry_wake_state SET last_daily_wake_at=now()-interval '12 hours'`);
  const messagesBefore = (await db.query(`SELECT id FROM messages`)).rowCount;
  const handled = issue('7805731896');
  handled.data.issue.level = 'error';
  expect((await post(handled)).status).toBe(200);
  const first = (await commands()).rows;
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({agent_id:JELLYBEAN,room_id:TRIAGE,source_message_id:null});
  expect(first[0]!.private_payload.text).toContain('error: Issue 7805731896');
  expect((await db.query(`SELECT urgent,pending FROM sentry_wake_issues`)).rows)
    .toEqual([{urgent:false,pending:false}]);
  expect(await nextSentryWakeAt(db)).toBeNull();
  expect((await post(handled)).status).toBe(200);
  const next = issue('702');
  next.data.issue.level = 'error';
  expect((await post(next)).status).toBe(200);
  expect((await post(issue('703'))).status).toBe(200);
  expect((await commands()).rowCount).toBe(1);
  const deadline = (await nextSentryWakeAt(db))!;
  expect(deadline.getTime()).toBeGreaterThan(Date.now());
  expect(deadline.getTime()).toBeLessThanOrEqual(Date.now()+5*60*1000);
  // Even an expired legacy daily clock cannot bypass burst coalescing.
  await db.query(`UPDATE sentry_wake_state SET last_daily_wake_at=now()-interval '25 hours'`);
  await flushSentryWakes(db);
  expect((await commands()).rowCount).toBe(1);
  await db.query(`UPDATE sentry_wake_state SET last_wake_at=now()-interval '5 minutes'`);
  await Promise.all([flushSentryWakes(db),flushSentryWakes(db)]);
  const rows = (await commands()).rows;
  expect(rows).toHaveLength(2);
  expect(rows[1]!.private_payload.text).toContain('2 Sentry issue events');
  expect(rows[1]!.private_payload.text).toContain('/702/');
  expect(rows[1]!.private_payload.text).toContain('/703/');
  expect(rows[1]!.private_payload.text).not.toContain('/7805731896/');
  await post(next);
  expect((await commands()).rowCount).toBe(2);
  expect(await nextSentryWakeAt(db)).toBeNull();
  expect((await db.query(`SELECT id FROM messages`)).rowCount).toBe(messagesBefore);
});

it('releases handled backlog from the old daily policy on restart without a new webhook', async () => {
  await fixture();
  await db.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`,[TRIAGE]);
  const handled = issue('700');
  handled.data.issue.level = 'error';
  await post(handled);
  await db.query(`UPDATE rooms SET archived_at=NULL WHERE id=$1`,[TRIAGE]);
  await db.query(`UPDATE sentry_wake_state SET last_wake_at=NULL,last_daily_wake_at=now()`);
  expect((await nextSentryWakeAt(db))!.getTime()).toBeLessThanOrEqual(Date.now());
  await Promise.all([flushSentryWakes(db),flushSentryWakes(db)]);
  expect((await commands()).rowCount).toBe(1);
  expect((await commands()).rows[0]!.private_payload.text).toContain('/700/');
  expect(await nextSentryWakeAt(db)).toBeNull();
});

it('recognizes issue flags and both Sentry handled-tag encodings without treating handled exceptions as urgent', async () => {
  await fixture();
  const variants = [
    {issue:{...issue('801').data.issue,level:'error',isUnhandled:true}},
    {event:{issue_id:'802',title:'Tag object',level:'error',tags:{handled:'no'}}},
    {event:{issue_id:'803',title:'Tag pairs',level:'error',tags:[['handled','no']]}},
    {event:{issue_id:'804',title:'Unhandled flag',level:'error',unhandled:true}},
    {event:{issue_id:'805',title:'Handled',level:'error',exception:{values:[{mechanism:{handled:true}}]}}},
  ];
  for (const data of variants) {
    const event = 'event' in data;
    expect((await post({action:event ? 'triggered' : 'created',data},event ? 'event_alert' : 'issue')).status).toBe(200);
  }
  expect((await db.query(`SELECT issue_id,urgent FROM sentry_wake_issues ORDER BY issue_id`)).rows).toEqual([
    {issue_id:'801',urgent:true},{issue_id:'802',urgent:true},{issue_id:'803',urgent:true},
    {issue_id:'804',urgent:true},{issue_id:'805',urgent:false},
  ]);
});
