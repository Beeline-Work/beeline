/** L1 only. Read first; --stop writes only the four accepted schedule rows. */
import { spawnSync } from 'node:child_process';
const stop = process.argv.includes('--stop');
if (process.argv.slice(2).some(arg => arg !== '--stop')) throw new Error('Usage: node scripts/audit-decisions-schedules.mjs [--stop]');
const runner = `const pg=require('/app/node_modules/pg');
(async()=>{
 const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try{
  await c.query(${JSON.stringify(stop ? 'BEGIN' : 'BEGIN READ ONLY')});
  await c.query("SET LOCAL statement_timeout='20s'");await c.query("SET LOCAL lock_timeout='500ms'");
  const prefixes=['0487e469','e61b92db','fc1f2142','ea5594a0'];
  const where="split_part(id::text,'-',1)=ANY($1::text[])";
  const fields="id::text,title,max_runs,run_count,next_run_at::text,workflow_run IS NOT NULL AS workflow_running";
  const before=(await c.query('SELECT '+fields+' FROM agent_schedules WHERE '+where+' ORDER BY id'+${JSON.stringify(stop ? ' FOR UPDATE' : '')},[prefixes])).rows;
  if(before.length!==4||new Set(before.map(r=>r.id.split('-')[0])).size!==4)throw new Error('Expected exactly the four authorized schedules');
  if(${stop}){
   // max_runs marks a stopped schedule. A finite far-future deadline also parks it on older serving
   // images which only test the limit after firing and would delete the row.
   await c.query("UPDATE agent_schedules SET max_runs=run_count,next_run_at='9999-12-31 00:00:00+00'::timestamptz,updated_at=now() WHERE "+where,[prefixes]);
  }
  const after=(await c.query('SELECT '+fields+' FROM agent_schedules WHERE '+where+' ORDER BY id',[prefixes])).rows;
  await c.query(${JSON.stringify(stop ? 'COMMIT' : 'ROLLBACK')});
  console.log(JSON.stringify({mode:${JSON.stringify(stop ? 'stopped' : 'read-only')},before,after},null,2));
 }catch(e){await c.query('ROLLBACK');throw e}finally{await c.end()}
})().catch(e=>{console.error(e.message);process.exitCode=1});`;
const encoded = Buffer.from(runner).toString('base64');
const result = spawnSync('flyctl', ['ssh', 'console', '-a', 'beeline-server', '--machine', '8d04d0ce21d2d8', '-C',
  `node -e eval(Buffer.from(process.argv[1],String.fromCharCode(98,97,115,101,54,52)).toString()) ${encoded}`], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
