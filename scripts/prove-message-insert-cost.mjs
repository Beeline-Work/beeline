// Synthetic PostgreSQL insert profile; never point this at production.
// BEELINE_PUSH_TEST_POSTGRES_URL=postgres://.../isolated_db NODE_OPTIONS=--max-old-space-size=4096 \
//   node --import tsx scripts/prove-message-insert-cost.mjs activation [source-worktree]
// Use a separate clean database for each source. A label beginning with main selects rollback mode.
// Runs the unchanged R-PUSH-SCAN-LOCK 50,000-row seed and a 120-second SQL ceiling.
// EXPLAIN and pg_stat_user_functions evidence is saved under .beeline-proof/.
import { Pool } from 'pg';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const [label='activation', source='.']=process.argv.slice(2);
if(!/^[a-z][a-z0-9-]*$/.test(label))throw new Error('Use a simple evidence label');
if(resolve(execFileSync('git',['rev-parse','--show-toplevel'],{cwd:source,encoding:'utf8'}).trim())!==resolve(source))throw new Error('Source must be an exact worktree root for trustworthy provenance');
const count=50000, schema='seed_'+randomUUID().replaceAll('-','');
const connectionString=process.env.BEELINE_PUSH_TEST_POSTGRES_URL;
if(!connectionString||!['127.0.0.1','localhost','[::1]'].includes(new URL(connectionString).hostname))throw new Error('An isolated loopback PostgreSQL URL is required');
await mkdir('.beeline-proof',{recursive:true});
process.env.BEELINE_NETWORK_ROUTER_V1=label.startsWith('main')?'0':'1';
const {migrate,PostgresDatabase}=await import(pathToFileURL(resolve(source,'apps/server/src/database.ts')));
const admin=new Pool({connectionString,max:1});
await admin.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
await admin.query(`CREATE SCHEMA ${schema}`);
const pool=new Pool({connectionString,max:1,options:`-c search_path=${schema},public -c statement_timeout=120000 -c track_functions=all`});
const db=new PostgresDatabase('',1,{mode:'migration',pool});
const person='a'.repeat(64),author='b'.repeat(64),workspace='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222';
const result={label,source:resolve(source),count,schema,router:process.env.BEELINE_NETWORK_ROUTER_V1,
 head:execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim(),
 dirty:execFileSync('git',['status','--short'],{cwd:source,encoding:'utf8'}).trim()};
try {
 const migrationBegan=performance.now();
 await migrate(db);
 result.migrationMs=performance.now()-migrationBegan;
 await db.query(`INSERT INTO identities(id,kind,name,handle,push_level) VALUES($1,'human','Owner','owner','full'),($2,'human','Peer','peer','full')`,[person,author]);
 await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`,[workspace]);
 await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Proof')`,[room,workspace]);
 await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`,[workspace,room,person,author]);
 await db.query(`INSERT INTO push_devices(token,identity_id,platform,environment,registered_at) VALUES('proof-device',$1,'android','physical',now()-interval '1 day')`,[person]);
 await db.query(`INSERT INTO push_delivery_floors(id,started_at) VALUES('message-delivery',now()-interval '1 day')`);
 await db.query('ALTER TABLE messages DISABLE TRIGGER message_push_outbox');
 await db.query('ALTER TABLE messages DISABLE TRIGGER beeline_notify_live_messages');
 result.triggers=(await db.query(`SELECT tgname,pg_get_triggerdef(oid) definition FROM pg_trigger WHERE tgrelid='messages'::regclass AND NOT tgisinternal`)).rows;
 console.log(JSON.stringify({label,schema,stage:'seed',count}));
 const pid=(await db.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 const ticks=Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'}));
 const cpu=async()=>{const stat=(await readFile(`/proc/${pid}/stat`,'utf8')).split(' ');return (Number(stat[13])+Number(stat[14]))*1000/ticks;};
 const beforeCpu=await cpu();
 const began=performance.now();
 try {
  result.plan=(await db.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) INSERT INTO messages(id,room_id,author_id,text,created_at) SELECT 'history-'||n,$1,$2,repeat('@owner historical message ',100),now()-interval '1 day' FROM generate_series(1,${count}) n`,[room,author])).rows;
 } catch(e) {result.error={message:e.message,where:e.where,code:e.code};}
 result.elapsedMs=performance.now()-began;
 result.backendCpuMs=(await cpu())-beforeCpu;
 await db.query('SELECT pg_stat_force_next_flush()');
 result.functions=(await db.query(`SELECT funcname,calls,total_time,self_time FROM pg_stat_user_functions WHERE schemaname=$1 ORDER BY total_time DESC`,[schema])).rows;
 console.log(JSON.stringify({label,elapsedMs:result.elapsedMs,backendCpuMs:result.backendCpuMs,error:result.error}));
 await writeFile(resolve('.beeline-proof',`seed-${label}-${count}.json`),JSON.stringify(result,null,2));
 if(result.error)process.exitCode=1;
} finally {await db.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
