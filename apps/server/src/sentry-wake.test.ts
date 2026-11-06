import { createHmac, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { migrate, PostgresDatabase, type ClosableDatabase } from './database.js';
import { migratedDatabase } from './test-support.js';
import { createBeelineServer, type ServerOptions } from './server.js';
import { LiveHub } from './live.js';
import { flushSentryWakes, sentryWakeAgentFromEnv } from './sentry-wake.js';

const OWNER = 'a'.repeat(64);
const JELLYBEAN = '7eafb2e0cc049a9b3345f4322024b604358af04cb551d1fc71084ca3a99d7877';
const ROOM = '22222222-2222-4222-8222-222222222222';
const TRIAGE = 'a914716f-cd6c-4663-b42a-6e1044dc2bb9';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const SECRET = 'isolated-sentry-signing-secret';
// Native cases include the complete release migration before sending requests.
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
    await migrate(db);
  } else db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Jellybean')`,[OWNER,JELLYBEAN]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[JELLYBEAN,OWNER]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Isolated Sentry proof')`,[WORKSPACE]);
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`,[ROOM,WORKSPACE,OWNER]);
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name,parent_id) VALUES($1,$2,$3,'issues-triage',$4)`,[TRIAGE,WORKSPACE,OWNER,ROOM]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
    ($1,NULL,$2,'owner'),($1,$3,$2,'owner'),($1,$3,$4,'member')`,[WORKSPACE,OWNER,ROOM,JELLYBEAN]);
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

it('routes HTTP event digests immediately to the configured agent', async () => {
  const agentId = sentryWakeAgentFromEnv({BEELINE_SENTRY_TRIAGE_AGENT_ID:'b'.repeat(64)});
  await fixture(agentId);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Configured triager')`,[agentId]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[agentId,OWNER]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'member')`,[WORKSPACE,ROOM,agentId]);
  expect((await post(issue())).status).toBe(200);
  expect((await post(issue('456'))).status).toBe(200);
  expect((await commands()).rows.map(row => row.agent_id)).toEqual([agentId, agentId]);
  await flushSentryWakes(db,agentId);
  expect((await commands()).rows.map(row => row.agent_id)).toEqual([agentId,agentId]);
}, postgresUrl ? 60_000 : 20_000);

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
  expect((await commands()).rowCount).toBe(4);
}, postgresUrl ? 60_000 : 20_000);

it('keeps the batch pending if the target corner is archived', async () => {
  await fixture();
  await db.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`,[TRIAGE]);
  expect((await post(issue())).status).toBe(200);
  expect((await commands()).rowCount).toBe(0);
  expect((await db.query(`SELECT 1 FROM sentry_wake_issues WHERE pending`)).rowCount).toBe(1);
  await db.query(`UPDATE rooms SET archived_at=NULL WHERE id=$1`,[TRIAGE]);
  await flushSentryWakes(db);
  expect((await commands()).rowCount).toBe(1);
}, postgresUrl ? 60_000 : 20_000);

it('accepts each distinct issue and event-alert source without an urgency gate', async () => {
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
  expect((await db.query(`SELECT issue_id FROM sentry_wake_issues ORDER BY issue_id`)).rows).toEqual([
    {issue_id:'801'},{issue_id:'802'},{issue_id:'803'},{issue_id:'804'},{issue_id:'805'},
  ]);
}, postgresUrl ? 60_000 : 20_000);
