import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { PostgresDatabase, migrate } from '../apps/server/dist/database.js';
import { GitHubOperations } from '../apps/server/dist/github-operations.js';

import { CommanderWakeDeadlines } from '../apps/server/dist/commander-wakes.js';

import { LiveHub } from '../apps/server/dist/live.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { createBeelineServer } from '../apps/server/dist/server.js';
import { PostgresLiveListener } from '../apps/server/dist/postgres-live.js';
import { MACHINE_SOCKET_PROTOCOL } from '../apps/server/dist/daemon-live.js';

// Real HTTP, helper and database boundaries; only provider/auth and optional RTT are fixtures.
const baselineRef = process.env.BEELINE_WEBHOOK_BASELINE_REF ?? '7f44162ed';
for (const file of ['github-operations','commander-wakes']) {
 const source = execFileSync('git',['show',`${baselineRef}:apps/server/src/${file}.ts`],{encoding:'utf8'});
 writeFileSync(new URL(`../apps/server/dist/${file}.burst-before.js`,import.meta.url),
  ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText);
}
const {GitHubOperations: BeforeGitHub} = await import('../apps/server/dist/github-operations.burst-before.js');
const {CommanderWakeDeadlines: BeforeDeadlines} = await import('../apps/server/dist/commander-wakes.burst-before.js');

const url = process.env.BEELINE_BACKGROUND_TEST_POSTGRES_URL;
if (!url || !['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname)) throw new Error('Isolated loopback PostgreSQL required');
const lagMs = Number(process.env.BEELINE_BURST_QUERY_DELAY_MS ?? 80);
const owner='a'.repeat(64),worker='b'.repeat(64),peer='c'.repeat(64);
const workspace='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222',corner='33333333-3333-4333-8333-333333333333';
const head='1'.repeat(40),branch='feature/corner-333333333333';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async fn=>{const end=Date.now()+30000;while(!fn()){if(Date.now()>end)throw new Error('proof did not settle');await pause(10)}};
const percentile=values=>values.sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1]??0;
const hash=sql=>createHash('sha256').update(sql.replace(/\s+/g,' ').trim()).digest('hex').slice(0,16);
// Delay the earlier installation write to expose completion-order reversal.
async function installationOrder(Operations) {
 let started, release;
 const suspended = new Promise(resolve => { started = resolve; });
 const gate = new Promise(resolve => { release = resolve; });
 let status = 'active';
 const writes = [];
 const database = {query: async sql => {
  if (sql.includes("SET status='suspended'")) { started(); await gate; status='suspended'; writes.push(status); }
  else if (sql.includes("SET status='revoked'")) { status='revoked'; writes.push(status); }
  else if (sql.includes('UPDATE github_repositories SET active=false')) writes.push('repositories inactive');
  else throw new Error('unexpected installation query');
  return {rows:[],rowCount:1};
 }};
 const operations = new Operations(database,{}, {}, 'fixture');
 const first = operations.processWebhook('installation',{action:'suspend',installation:{id:77}});
 await suspended;
 const second = operations.processWebhook('installation',{action:'deleted',installation:{id:77}});
 await new Promise(resolve => setImmediate(resolve));
 release();
 await Promise.all([first,second]);
 return {status,writes};
}
async function crossInstanceOrder(Operations, database) {
 let started, release;
 const suspended = new Promise(resolve => { started = resolve; });
 const gate = new Promise(resolve => { release = resolve; });
 const slow = {query: async (sql,values) => {
  if (sql.includes("SET status='suspended'")) { started(); await gate; }
  return database.query(sql,values);
 }};
 const firstServer = new Operations(slow,{}, {}, 'fixture');
 const secondServer = new Operations(database,{}, {}, 'fixture');
 const first = firstServer.processWebhook('installation',{action:'suspend',installation:{id:77}});
 await suspended;
 await secondServer.processWebhook('installation',{action:'deleted',installation:{id:77}});
 release(); await first;
 const status = (await database.query('SELECT status FROM github_installations WHERE installation_id=77')).rows[0].status;
 const repositoriesActive = (await database.query('SELECT active FROM github_repositories WHERE repository_id=101')).rows[0].active;
 await database.query("UPDATE github_installations SET status='active' WHERE installation_id=77");
 await database.query('UPDATE github_repositories SET active=true WHERE repository_id=101');
 return {status,repositoriesActive};
}
const admin=new Pool({connectionString:url,max:1});
const results={};
for(const [phase,Operations,Deadlines]of[['before',BeforeGitHub,BeforeDeadlines],['after',GitHubOperations,CommanderWakeDeadlines]]) {
 const ordering = await installationOrder(Operations);
 const schema=`webhook_burst_${phase}_${Date.now()}`;
 await admin.query('CREATE EXTENSION IF NOT EXISTS vector');await admin.query(`CREATE SCHEMA ${schema}`);
 const fixture=new PostgresDatabase('',1,{mode:'migration',pool:new Pool({connectionString:url,max:1,options:`-c search_path=${schema},public -c jit=off`})});
 let db,server,listener,deadlines,socket;const frames=[];
 const checkouts=[],slow=[],fingerprints=new Map(),commandReads=new Map();let measuring=false,activeQueries=0;
 try {
 await migrate(fixture);
 await fixture.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Worker','worker'),($3,'agent','Peer','peer')`,[owner,worker,peer]);
 await fixture.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`,[worker,peer,owner]);
 await fixture.query(`INSERT INTO workspaces(id,name) VALUES($1,'Burst proof')`,[workspace]);
 await fixture.query(`INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status) VALUES(77,$1,'42','owner','User','selected','active')`,[owner]);
 await fixture.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch) VALUES(101,77,'owner/widgets','main')`);
 await fixture.query(`INSERT INTO rooms(id,workspace_id,created_by,name,repository_key,repository_remote,repository_resolution,github_installation_id) VALUES($1,$2,$3,'Room','owner/widgets','https://github.com/owner/widgets.git','repository',77)`,[room,workspace,owner]);
 await fixture.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Corner')`,[corner,workspace,room,worker]);
 await fixture.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,NULL,$4,'member'),($1,NULL,$5,'member'),($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member')`,[workspace,room,owner,worker,peer]);
 await fixture.query(`INSERT INTO corner_facts(corner_id,owner_agent_id,feature_branch,lifecycle,workflow_state) VALUES($1,$2,$3,$4::jsonb,'checks')`,[corner,worker,branch,JSON.stringify({checks:'pending',pr:{number:1,headSha:head,url:'https://github.com/owner/widgets/pull/1'}})]);
 const crossInstanceOrdering = await crossInstanceOrder(Operations, fixture);
 const pool=new Pool({connectionString:url,max:5,options:`-c search_path=${schema},public -c jit=off`});
 const connect=pool.connect.bind(pool);
 pool.connect=async()=>{const began=performance.now();const client=await connect();if(measuring)checkouts.push(performance.now()-began);
  const query=client.query.bind(client),release=client.release.bind(client);
  client.query=async(...args)=>{const sql=typeof args[0]==='string'?args[0]:args[0].text;activeQueries++;
   try{if(measuring&&lagMs)await pause(lagMs);return await query(...args)}finally{activeQueries--;if(measuring){const fp=hash(sql);fingerprints.set(fp,(fingerprints.get(fp)??0)+1);if(sql.includes('WITH recovery_scope AS MATERIALIZED'))commandReads.set(fp,sql);}}};
  client.release=(...args)=>{client.query=query;client.release=release;return release(...args)};return client;};
 db=new PostgresDatabase('',5,{pool});
 const live=new LiveHub(),phone=new PhoneService(db,'http://proof.invalid'),daemon=new DaemonService(db,live);
 const app={installationToken:async()=>({token:'fixture',expiresAt:'2030-01-01T00:00:00Z'}),readCommitCheckRollup:async()=>({state:'pending',total:15,failing:[],checks:[{name:'Checks',status:'pending'}]})};
 const operations=new Operations(db,{},app,'fixture',undefined,id=>live.publish({type:'invalidate',roomId:id,reason:'github'}));
 deadlines=new Deadlines(db,live,error=>{throw error});
 server=createBeelineServer({database:db,auth:{authenticateDaemon:async token=>token==='bdt_fixture'?worker:null,retiredDaemonAgent:async()=>null,authenticatePhone:async()=>null},phone,daemon,live,mediaMaximumBytes:1,github:{webhookSecret:'fixture',onWebhook:(...args)=>operations.processWebhook(...args)}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
 socket=new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`,[MACHINE_SOCKET_PROTOCOL]);socket.on('message',data=>frames.push(JSON.parse(data.toString())));
 await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject)});
 socket.send(JSON.stringify({type:'register',agentId:worker,token:'bdt_fixture',lifecycleId:'burst-proof'}));await until(()=>frames.some(frame=>frame.type==='registered'));
 socket.send(JSON.stringify({type:'subscribe',agentId:worker,roomId:corner}));await until(()=>frames.some(frame=>frame.type==='subscribed'));
 listener=PostgresLiveListener.forConnectionString(url,db,live);void listener.run();await pause(300);
 await until(()=>activeQueries===0&&pool.waitingCount===0);await pause(100);
 const warn=console.warn;console.warn=(...args)=>{if(args[0]==='[database] slow query'&&measuring)slow.push(args[1]);else warn(...args)};
 const started=performance.now();measuring=true;
 try {
  const requests=Array.from({length:15},async(_,n)=>{
   await pause(n*50);
   const payload=JSON.stringify({action:'in_progress',installation:{id:77},repository:{full_name:'owner/widgets'},check_run:{name:`Job ${n}`,status:'in_progress',head_sha:head,html_url:`https://github.com/owner/widgets/actions/runs/${n+1}`,check_suite:{head_branch:branch,head_sha:head}}});
   const response=await fetch(`http://127.0.0.1:${port}/v1/github/webhook`,{method:'POST',headers:{'x-github-delivery':`${phase}-${n}`,'x-github-event':'check_run','x-hub-signature-256':'sha256='+createHmac('sha256','fixture').update(payload).digest('hex')},body:payload});
   assert.equal(response.status,202);
  });
  const navigation=[];
  for(let n=0;n<5;n++){await pause(150);navigation.push(phone.execute('readNeedsYou',{workspaceId:workspace,markSeen:false},owner));}
  await Promise.all([...requests,...navigation]);
  await until(()=>activeQueries===0&&pool.waitingCount===0);await pause(200);await until(()=>activeQueries===0&&pool.waitingCount===0);
  const seconds=(performance.now()-started)/1000;
  results[phase]={ordering,crossInstanceOrdering,requests:15,seconds,queryDelayMs:lagMs,poolSize:5,slowQueries:slow.length,slowQueriesPerMinute:slow.length*60/seconds,checkoutWaitP95Ms:percentile(checkouts),checkoutCount:checkouts.length,fingerprints:Object.fromEntries(fingerprints),commandReadFingerprints:[...commandReads.keys()],inboxFrames:frames.filter(f=>f.type==='inbox').length};
  assert.equal(Number((await fixture.query('SELECT count(*) n FROM github_webhook_deliveries')).rows[0].n),15);
 }finally{measuring=false;console.warn=warn;}
 }finally{socket?.terminate();deadlines?.stop();await listener?.stop();if(server)await new Promise(resolve=>server.close(resolve));await db?.close();await fixture.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);}
}
// Main may evolve command recovery SQL; still require the exact recovery path to execute.
for (const result of Object.values(results)) {
 assert(result.commandReadFingerprints.length>0);
 for (const fingerprint of ['d9831d171473d1fb','ca61a04a12b9b235']) assert(result.fingerprints[fingerprint]>0);
}
await admin.end();console.log(JSON.stringify({reproduction:'R-WEBHOOK-BURST',results}));
assert(results.after.checkoutWaitP95Ms<results.before.checkoutWaitP95Ms);
assert(results.after.slowQueries<results.before.slowQueries);

assert.equal(results.before.ordering.status,'suspended');
assert.equal(results.after.ordering.status,'revoked');
assert.deepEqual(results.after.ordering.writes,['suspended','revoked','repositories inactive']);

assert.equal(results.before.crossInstanceOrdering.status,'suspended');
assert.equal(results.after.crossInstanceOrdering.status,'revoked');
assert.equal(results.after.crossInstanceOrdering.repositoriesActive,false);
