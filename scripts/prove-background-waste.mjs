import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { Pool } from 'pg';
import { BackgroundWork } from '../apps/server/dist/background-work.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { PostgresDatabase, migrate } from '../apps/server/dist/database.js';
import { roomWorkingSql } from '../apps/server/dist/chat-corner-counts.js';

// Replay the actual index wiring with provider/database jobs replaced at their boundary.
// No server, helper, provider, or production connection is started.
const names = ['voice','githubJobs','push','backgroundJobs','jobsDatabase','schedules','sentryWakeAgentId',
  'choiceExpiry','deadlineExpiry','reconcileConfiguredCornerReviewers','flushOperatorSystemDms',
  'flushSentryWakes','nextSentryWakeAt','freeAgents','FREE_AGENT_SWEEP_MS','mediaExpiry','runMaintenance',
  'noteBlockedCornerChecks','reclaimExpiredCommandLeases','live','phone','runInstitutionalCuratorCycle',
  'institutionalMemory','institutionalAnchors','BackgroundWork'];
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
async function replay(source, legacy) {
  const counts = {};
  const job = new Proxy({}, { get: (_,name) => async () => name === 'query' ? {rows:[{due:null}]} : null });
  const runner = { run: async (name,fn) => {
    counts[name] = (counts[name] ?? 0) + 1;
    return {ok:true,value:await fn()};
  }};
  const args = names.map(name => name === 'BackgroundWork' ? BackgroundWork : name === 'backgroundJobs' ? runner
    : name === 'FREE_AGENT_SWEEP_MS' ? 60_000
    : ['sentryWakeAgentId','live','institutionalMemory','institutionalAnchors','freeAgents'].includes(name) ? undefined
    : ['reconcileConfiguredCornerReviewers','flushOperatorSystemDms','flushSentryWakes','nextSentryWakeAt',
      'runMaintenance','noteBlockedCornerChecks','reclaimExpiredCommandLeases','runInstitutionalCuratorCycle'].includes(name) ? async()=>null : job);
  let body;
  if (legacy) {
    const callback = source.split('async (newLeader) => {')[1].split('\n    },\n    reconciliationMs,')[0];
    body = `let lastReconciliationAt=-Infinity,pushPending=true,repairedPromotedCorners=false,reconciledMergeability=false,reconciledPendingChecks=false;const reconciliationMs=60000;return async(newLeader)=>{${callback}}`;
  } else {
    body = source.slice(source.indexOf('  let repairedPromotedCorners = false;'), source.indexOf('  const leader = new BackgroundLeader')) + '\nreturn work;';
  }
  const realNow = Date.now;
  let clock = 0;
  Date.now = () => clock;
  try {
    const compiled = ts.transpileModule(body, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
    const run = await new AsyncFunction(...names, compiled)(...args);
    for (;clock<60_000;clock+=1000) {
      if (legacy) await run(clock===0);
      else { if(clock) run.wake('deadlines','owed'); await run.run(clock===0); }
    }
    return counts;
  } finally { Date.now = realNow; }
}
const current = readFileSync('apps/server/src/index.ts','utf8');
const baselineRef = process.env.BEELINE_BACKGROUND_BASELINE_REF;
const before = baselineRef ? await replay(execFileSync('git',['show',`${baselineRef}:apps/server/src/index.ts`],{encoding:'utf8'}),true) : null;
const after = await replay(current,false);
assert.equal(after['corner-reviewers'],1);
assert.equal(after['github-check-refresh'],1);
assert.equal(after['push'],1);
assert.equal(after['sentry-wakes'],1);
assert.equal(after['schedules'],1);
assert.equal(after['deadline-expiry'],60);
if(before) assert.equal(before['corner-reviewers'],60);
console.log(JSON.stringify({reproduction:'R-BACKGROUND-WASTE',replaySeconds:60,wakeSource:'owed',before,after}));

const url = process.env.BEELINE_BACKGROUND_TEST_POSTGRES_URL;
if (!url) throw new Error('Set BEELINE_BACKGROUND_TEST_POSTGRES_URL to an isolated loopback database');
if(!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname)) throw new Error('Loopback PostgreSQL required');
const schema = `background_proof_${Date.now()}`;
const admin = new Pool({connectionString:url,max:1});
await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
await admin.query(`CREATE SCHEMA ${schema}`);
const pool = new Pool({connectionString:url,max:1,options:`-c search_path=${schema},public`});
const db = new PostgresDatabase('',1,{mode:'long-running',pool});
const owner = 'a'.repeat(64), agent = 'b'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const corner = '33333333-3333-4333-8333-333333333333';
const legacyWorking = `EXISTS(SELECT 1 FROM agent_turns t WHERE t.status='working' AND (t.room_id=r.id OR t.room_id IN (SELECT id FROM rooms WHERE parent_id=r.id AND archived_at IS NULL)))`;
let readQuery;
const query = db.query.bind(db);
let legacy = false;
db.query = async (sql,values) => {
  if(sql.includes('WITH visible_workspace AS')) {
    if(legacy) sql = sql.replace(roomWorkingSql('r'),legacyWorking);
    readQuery = {sql,values};
  }
  return query(sql,values);
};
const visit = (node,found=[]) => {
  if(node['Relation Name']==='agent_turns') found.push({type:node['Node Type'],loops:node['Actual Loops'],index:node['Index Name']});
  for(const child of node.Plans??[])visit(child,found);
  return found;
};
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Agent','agent')`,[owner,agent]);
  await db.query(`INSERT INTO identities(id,kind,name,handle) SELECT md5(n::text)||md5(n::text),'human','Fixture '||n,'fixture'||n FROM generate_series(1,140) n`);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Background proof')`,[workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`,[room,workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,parent_id) VALUES($1,$2,'Corner',$3)`,[corner,workspace,room]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,parent_id,archived_at) SELECT md5('room'||n)::uuid,$1,'History '||n,$2,now() FROM generate_series(1,1594) n`,[workspace,room]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner'),($1,$2,$4,'member')`,[workspace,room,owner,agent]);
  await db.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status,created_at)
    SELECT md5('room'||(1+(n%1594)))::uuid,'turn-'||n,$1,'complete',now()-n*interval '1 second' FROM generate_series(1,25717) n`,[agent]);
  await db.query('ANALYZE');
  const phone = new PhoneService(db,'https://proof.invalid');
  const stats = async () => {
    await query('SELECT pg_stat_force_next_flush()');
    return Number((await admin.query(`SELECT seq_scan FROM pg_stat_user_tables WHERE schemaname=$1 AND relname='agent_turns'`,[schema])).rows[0].seq_scan);
  };
  const results = {};
  for(const mode of ['before','after']) {
    legacy = mode==='before';
    const view = await phone.readChats(workspace,owner);
    assert(view);
    const plan = await query('EXPLAIN (ANALYZE,FORMAT JSON) '+readQuery.sql,readQuery.values);
    const nodes = visit(plan.rows[0]['QUERY PLAN'][0].Plan);
    if(legacy) assert(nodes.some(n=>n.type==='Seq Scan' && n.loops>0));
    else assert(!nodes.some(n=>n.type==='Seq Scan' && n.loops>0));
    const scans = await stats();
    const started = performance.now();
    for(let n=0;n<110;n++) {
      await phone.readChats(workspace,owner);
      const remaining=(n+1)*1000/11-(performance.now()-started);
      if(remaining>0)await new Promise(resolve=>setTimeout(resolve,remaining));
    }
    const seconds=(performance.now()-started)/1000;
    const delta=await stats()-scans;
    results[mode]={reads:110,seconds,seqScans:delta,seqScansPerSecond:delta/seconds,nodes};
  }
  assert.equal(results.after.seqScans,0);
  await db.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,'active',$2,'working')`,[corner,agent]);
  const working = await phone.readChats(workspace,owner);
  assert.equal(working.chats.find(chat=>chat.room.id===room)?.agentState,'working');
  await db.query('UPDATE rooms SET archived_at=now() WHERE id=$1',[corner]);
  const archived = await phone.readChats(workspace,owner);
  assert.notEqual(archived.chats.find(chat=>chat.room.id===room)?.agentState,'working');
  console.log(JSON.stringify({reproduction:'R-BACKGROUND-WASTE',fixture:{turns:25717,identities:142,rooms:1596},results,workingCorner:'working',archivedCorner:'not working'}));
} finally {
  await db.close();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
