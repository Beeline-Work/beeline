import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {describe,expect,it} from 'vitest';
import {PostgresDatabase,type SqlDatabase} from './database.js';
import {DURABLE_LIVE_SCHEMA} from './durable-live.js';
import {ROUTER_PROJECTION_SCHEMA} from './router-projection-schema.js';
import {readRouterBuildTicket,RouterBuildCoordinator} from './router-build-coordinator.js';
const postgresUrl=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(postgresUrl&&!['127.0.0.1','localhost','[::1]'].includes(new URL(postgresUrl).hostname))throw new Error('coordinator proofs require isolated loopback PostgreSQL');
const WORKSPACE='11111111-1111-4111-8111-111111111111',VIEWER='synthetic-reader';
const input={family:'needs-you-count' as const,workspaceId:WORKSPACE};
const basis={schema:1 as const,databaseScope:'isolated-proof',version:'membership-count-v1',publicOrigin:'https://example.test',clockVersion:'no-clock-dependencies'};
async function fixture(){
  const schema=`coordinate_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:postgresUrl,max:1});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const config={connectionString:postgresUrl,options:`-c search_path=${schema},public`,max:2};
  const a=new PostgresDatabase('',2,{pool:new Pool(config)}),b=new PostgresDatabase('',2,{pool:new Pool(config)});
  const close=async()=>{await Promise.all([a.close(),b.close()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();};
  try{
  await a.query(`CREATE TABLE workspaces(id uuid PRIMARY KEY);
    CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,archived_at timestamptz);
    CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);`);
  await a.query(DURABLE_LIVE_SCHEMA);await a.query(ROUTER_PROJECTION_SCHEMA);
  await a.query(`INSERT INTO workspaces VALUES($1)`,[WORKSPACE]);
  await a.query(`INSERT INTO memberships VALUES($1,NULL,$2,'member',NULL)`,[WORKSPACE,VIEWER]);
    return {a,b,close};
  }catch(error){await close();throw error;}
}
describe.skipIf(!postgresUrl)('PostgreSQL projection build capacity',()=>{
  it('queues burst builds and returns an uncached large-Workspace result across actual PostgreSQL snapshots',async()=>{
    const {a,b,close}=await fixture(),coordinator=new RouterBuildCoordinator({flights:1,waiters:1,bytes:1024});
    try{
      await a.query(`INSERT INTO rooms(id,workspace_id,parent_id,archived_at)
        SELECT md5(n::text)::uuid,$1,NULL,CASE WHEN n%2=0 THEN now() ELSE NULL END FROM generate_series(1,1895)n`,[WORKSPACE]);
      const values=await Promise.all(Array.from({length:129},()=>b.transaction(async tx=>{
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        return coordinator.build(await readRouterBuildTicket(tx,input,VIEWER,basis),async db=>({count:(await db.query<{count:number}>('SELECT count(*)::int count FROM rooms')).rows[0]!.count,context:'rich context '.repeat(30000)}));
      })));
      expect(values).toHaveLength(129);expect(values.every(value=>(value.value as {count:number}).count===1895)).toBe(true);
      expect(coordinator.stats().bytes).toBeLessThanOrEqual(1024);
    }finally{await close();}
  },30000);

});
