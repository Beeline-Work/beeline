import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresDatabase, type SqlDatabase } from './database.js';
import { DURABLE_LIVE_SCHEMA } from './durable-live.js';
import { ROUTER_PROJECTION_SCHEMA } from './router-projection-schema.js';
import { buildRouterSnapshot, fenceRouterEnqueue } from './router-projections.js';

const postgresUrl=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(postgresUrl && !['127.0.0.1','localhost','[::1]'].includes(new URL(postgresUrl).hostname))
  throw new Error('projection proofs require isolated loopback PostgreSQL');
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
const WORKSPACE='11111111-1111-4111-8111-111111111111';
const ROOM='22222222-2222-4222-8222-222222222222';
const VIEWER='reader';
const input={family:'needs-you-count' as const,workspaceId:WORKSPACE};

describe.skipIf(!postgresUrl)('P6 real PostgreSQL current-authority enqueue linearization',()=>{
  it('holds the shared fence through enqueue, then rejects content built before committed revoke',async()=>{
    const schema=`projection_${randomUUID().replaceAll('-','')}`;
    const admin=new Pool({connectionString:postgresUrl,max:1});
    await admin.query(`CREATE SCHEMA ${schema}`);
    const config={connectionString:postgresUrl,options:`-c search_path=${schema},public`,max:2};
    const database=new PostgresDatabase('',2,{pool:new Pool(config)});
    const revoker=new PostgresDatabase('',2,{pool:new Pool(config)});
    const reached=deferred(),release=deferred();let enqueued=0;
    try{
      await database.query(`CREATE TABLE workspaces(id uuid PRIMARY KEY);
        CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid NOT NULL,parent_id uuid,archived_at timestamptz);
        CREATE TABLE memberships(workspace_id uuid NOT NULL,room_id uuid,identity_id text NOT NULL,role text NOT NULL,removed_at timestamptz);`);
      await database.query(DURABLE_LIVE_SCHEMA);
      await database.query(ROUTER_PROJECTION_SCHEMA);
      await database.query(`INSERT INTO workspaces VALUES($1)`,[WORKSPACE]);
      await database.query(`INSERT INTO rooms(id,workspace_id) VALUES($1,$2)`,[ROOM,WORKSPACE]);
      await database.query(`INSERT INTO memberships VALUES($1,NULL,$2,'member',NULL)`,[WORKSPACE,VIEWER]);
      const initial=await buildRouterSnapshot(database,input,VIEWER,async()=>({count:0}));
      const observed:SqlDatabase={query:(sql,args)=>database.query(sql,args),transaction:work=>database.transaction(tx=>work({
        transaction:nested=>tx.transaction(nested),
        query:async(sql,args)=>{const result=await tx.query(sql,args);if(sql.includes('pg_advisory_xact_lock_shared')){reached.resolve();await release.promise;}return result;},
      }))};
      const pendingFence=fenceRouterEnqueue(observed,input,VIEWER,initial.authority,()=>{enqueued++;return undefined;});
      await reached.promise;
      // One bounded failed write proves contention while the fence is held.
      // No sleep or repeated observation discovers lock state.
      await expect(revoker.transaction(async tx=>{
        await tx.query("SET LOCAL lock_timeout='100ms'");
        await tx.query(`UPDATE memberships SET removed_at=now() WHERE workspace_id=$1 AND identity_id=$2`,[WORKSPACE,VIEWER]);
      })).rejects.toMatchObject({code:'55P03'});
      expect(enqueued).toBe(0);
      release.resolve();await pendingFence;expect(enqueued).toBe(1);
      await revoker.query(`UPDATE memberships SET removed_at=now() WHERE workspace_id=$1 AND identity_id=$2`,[WORKSPACE,VIEWER]);
      await expect(fenceRouterEnqueue(database,input,VIEWER,initial.authority,()=>{enqueued++;return undefined;})).rejects.toThrow('authority');
      expect(enqueued).toBe(1);
    }finally{
      release.resolve();
      await Promise.all([database.close(),revoker.close()]);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
    }
  });
});
