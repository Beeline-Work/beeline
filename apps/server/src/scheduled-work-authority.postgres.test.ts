import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {describe,expect,it} from 'vitest';
import {PostgresDatabase,type SqlDatabase} from './database.js';
import {DURABLE_LIVE_SCHEMA} from './durable-live.js';
import {ROUTER_PROJECTION_SCHEMA} from './router-projection-schema.js';
import {SCHEDULED_WORK_AUTHORITY_SCHEMA} from './scheduled-work-authority.js';
import {buildRouterSnapshot,fenceRouterEnqueue} from './router-projections.js';
const postgresUrl=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(postgresUrl&&!['127.0.0.1','localhost','[::1]'].includes(new URL(postgresUrl).hostname))
  throw new Error('Scheduled Work proofs require isolated loopback PostgreSQL');
const WS='11111111-1111-4111-8111-111111111111',ROOM='22222222-2222-4222-8222-222222222222',PARENT='33333333-3333-4333-8333-333333333333';
const VIEWER='a'.repeat(64);
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
describe.skipIf(!postgresUrl)('Scheduled Work real PostgreSQL policy/enqueue linearization',()=>{
  it.each([
    ['public Workspace membership',false,`UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id IS NULL`,[VIEWER]],
    ['principal visibility',false,`UPDATE identities SET hidden_from_roster=true WHERE id=$1`,[VIEWER]],
    ['principal kind',false,`UPDATE identities SET kind='agent' WHERE id=$1`,[VIEWER]],
    ['own-DM participant',true,`UPDATE rooms SET direct_participants='[]'::jsonb WHERE id=$1`,[ROOM]],
    ['own-DM membership',true,`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,[ROOM,VIEWER]],
    ['Room parent policy',false,`UPDATE rooms SET parent_id=$1 WHERE id=$2`,[PARENT,ROOM]],
  ] as const)('%s writer cannot pass an admitted enqueue, and committed policy loss rejects its older certificate',async(_label,direct,mutation,args)=>{
    const schema=`scheduled_fence_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:postgresUrl,max:1});
    await admin.query(`CREATE SCHEMA ${schema}`);
    const config={connectionString:postgresUrl,options:`-c search_path=${schema},public`,max:2};
    const db=new PostgresDatabase('',2,{pool:new Pool(config)}),writer=new PostgresDatabase('',2,{pool:new Pool(config)});
    const reached=deferred(),release=deferred();let sent=0;
    try{
      await db.query(`CREATE TABLE identities(id text PRIMARY KEY,kind text NOT NULL,hidden_from_roster boolean NOT NULL DEFAULT false);
        CREATE TABLE workspaces(id uuid PRIMARY KEY);
        CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid NOT NULL,parent_id uuid,archived_at timestamptz,direct_participants jsonb);
        CREATE TABLE memberships(workspace_id uuid NOT NULL,room_id uuid,identity_id text NOT NULL,role text NOT NULL,removed_at timestamptz);`);
      await db.query(DURABLE_LIVE_SCHEMA);await db.query(ROUTER_PROJECTION_SCHEMA);await db.query(SCHEDULED_WORK_AUTHORITY_SCHEMA);
      await db.query(`INSERT INTO identities(id,kind) VALUES($1,'human')`,[VIEWER]);await db.query(`INSERT INTO workspaces VALUES($1)`,[WS]);
      await db.query(`INSERT INTO rooms(id,workspace_id,direct_participants) VALUES($1,$3,$4::jsonb),($2,$3,NULL)`,[ROOM,PARENT,WS,direct?JSON.stringify([VIEWER]):null]);
      // The own-DM case deliberately has no Workspace membership.
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,$4)`,[WS,direct?ROOM:null,VIEWER,direct?'member':'owner']);
      if(!direct)await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,[WS,ROOM,VIEWER]);
      const input={family:'room-scheduled-work' as const,roomId:ROOM,workspaceId:WS};
      const snapshot=await buildRouterSnapshot(db,input,VIEWER,async()=>({roomName:'Synthetic',isDirectMessage:direct,agentNames:[],schedules:[],subscriptions:[]}));
      const observed:SqlDatabase={query:(sql,values)=>db.query(sql,values),transaction:work=>db.transaction(tx=>work({
        transaction:nested=>tx.transaction(nested),query:async(sql,values)=>{const result=await tx.query(sql,values);
          if(sql.includes('pg_advisory_xact_lock_shared')){reached.resolve();await release.promise;}return result;},
      }))};
      const pending=fenceRouterEnqueue(observed,input,VIEWER,snapshot.authority,()=>{sent++;return undefined;});await reached.promise;
      await expect(writer.transaction(async tx=>{await tx.query("SET LOCAL lock_timeout='100ms'");await tx.query(mutation,[...args]);})).rejects.toMatchObject({code:'55P03'});
      expect(sent).toBe(0);release.resolve();await pending;expect(sent).toBe(1);
      await writer.query(mutation,[...args]);
      await expect(fenceRouterEnqueue(db,input,VIEWER,snapshot.authority,()=>{sent++;return undefined;})).rejects.toMatchObject({reason:'authority'});
      expect(sent).toBe(1);
    }finally{release.resolve();await Promise.all([db.close(),writer.close()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
  });
});
