import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresDatabase, type SqlDatabase } from './database.js';
import { DURABLE_LIVE_SCHEMA } from './durable-live.js';
import { ROUTER_PROJECTION_SCHEMA } from './router-projection-schema.js';
import { buildRouterSnapshot, fenceRouterEnqueue } from './router-projections.js';
import { TRAY_MUTABLE_SOURCE_SCHEMA } from './tray-mutable-source.js';

const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw new Error('Tray source proof requires isolated loopback PostgreSQL');
const a='a'.repeat(64),b='b'.repeat(64),agent='c'.repeat(64);
const workspace='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222';
const grant='33333333-3333-4333-8333-333333333333';
const input={family:'needs-you-tray' as const,workspaceId:workspace};
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};

async function rig(run:(reader:SqlDatabase,writer:SqlDatabase)=>Promise<void>){
  const schema=`tray_source_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url,max:1});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const config={connectionString:url,options:`-c search_path=${schema},public`,max:2};
  const reader=new PostgresDatabase('',2,{pool:new Pool(config)}),writer=new PostgresDatabase('',2,{pool:new Pool(config)});
  try{
    await reader.query(`CREATE TABLE workspaces(id uuid PRIMARY KEY);
      CREATE TABLE identities(id text PRIMARY KEY,kind text,name text,handle text,avatar text,face_id text,hidden_from_roster boolean);
      CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,archived_at timestamptz);
      CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);
      CREATE TABLE agents(agent_id text PRIMARY KEY,owner_id text);
      CREATE TABLE workspace_apps(id uuid PRIMARY KEY,workspace_id uuid,owner_identity_id text);
      CREATE TABLE agent_grants(id uuid PRIMARY KEY,agent_id text,workspace_id uuid,room_id uuid,kind text,target text,app_id uuid,status text,superseded_at timestamptz);
      CREATE TABLE permission_authority(permission_id text PRIMARY KEY,room_id uuid,principal_id text,status text);
      CREATE TABLE messages(id text PRIMARY KEY,room_id uuid,author_id text,card_type text,card jsonb,deleted_at timestamptz);
      CREATE TABLE room_choices(id uuid PRIMARY KEY,workspace_id uuid,room_id uuid,message_id text,mode text,status text,closes_at timestamptz);
      CREATE TABLE connector_offers(id uuid PRIMARY KEY,workspace_id uuid,room_id uuid,message_id text,addressee_id text,connector_type text,status text);
      CREATE TABLE message_bookmarks(identity_id text,workspace_id uuid,room_id uuid,message_id text);
      CREATE TABLE needs_you_marks(identity_id text,workspace_id uuid,message_id text);`);
    await reader.query(DURABLE_LIVE_SCHEMA);await reader.query(ROUTER_PROJECTION_SCHEMA);await reader.query(TRAY_MUTABLE_SOURCE_SCHEMA);
    await reader.query(`INSERT INTO workspaces VALUES($1)`,[workspace]);
    await reader.query(`INSERT INTO rooms(id,workspace_id) VALUES($1,$2)`,[room,workspace]);
    for(const person of[a,b])await reader.query(`INSERT INTO memberships VALUES($1,NULL,$3,'member',NULL),($1,$2,$3,'member',NULL)`,[workspace,room,person]);
    await reader.query(`INSERT INTO agents VALUES($1,$2)`,[agent,a]);
    await reader.query(`INSERT INTO agent_grants(id,agent_id,workspace_id,room_id,kind,target,status) VALUES($1,$2,$3,$4,'path','/synthetic','pending')`,[grant,agent,workspace,room]);
    await reader.query(`INSERT INTO messages(id,room_id,author_id,card_type,card) VALUES('grant-card',$1,$2,'grant-request',$3::jsonb)`,[room,agent,JSON.stringify({grants:[{grantId:grant,kind:'path',target:'/synthetic'}]})]);
    await run(reader,writer);
  }finally{await Promise.all([reader.close(),writer.close()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
const snapshot=(db:SqlDatabase)=>buildRouterSnapshot(db,input,a,async()=>({needs:{items:[{
  messageId:'grant-card',workspaceId:workspace,roomId:room,roomName:'Synthetic Room',text:'private approval',createdAt:1,
}]},saved:{bookmarks:[]}}));

describe.skipIf(!url)('real PostgreSQL Tray owner mutation and final enqueue',()=>{
  it('rejects old private content after another pool commits owner transfer',async()=>{
    await rig(async(reader,writer)=>{
      const old=await snapshot(reader);let sent=0;
      await writer.query(`UPDATE agents SET owner_id=$2 WHERE agent_id=$1`,[agent,b]);
      await expect(fenceRouterEnqueue(reader,input,a,old.authority,()=>{sent++;return undefined;})).rejects.toThrow('authority');
      expect(sent).toBe(0);
      const causes=(await reader.query<{event:{trayReaderId:string}}>(`SELECT event FROM live_journal
        WHERE stream_id=$1 AND event->>'sourceTable'='tray-projection' ORDER BY sequence`,[`workspace:${workspace}`])).rows;
      expect(causes.map(row=>row.event.trayReaderId)).toEqual([a,b]);
    });
  });

  it('holds the exact authority fence through synchronous enqueue and blocks a racing owner mutation',async()=>{
    await rig(async(reader,writer)=>{
      const old=await snapshot(reader),reached=deferred(),release=deferred();let sent=0;
      const observed:SqlDatabase={query:(sql,args)=>reader.query(sql,args),transaction:work=>reader.transaction(tx=>work({
        transaction:nested=>tx.transaction(nested),query:async(sql,args)=>{const result=await tx.query(sql,args);
          if(sql.includes('pg_advisory_xact_lock_shared')){reached.resolve();await release.promise;}return result;},
      }))};
      const delivery=fenceRouterEnqueue(observed,input,a,old.authority,()=>{sent++;return undefined;});
      try{
        await reached.promise;
        await expect(writer.transaction(async tx=>{
          await tx.query(`SET LOCAL lock_timeout='100ms'`);await tx.query(`UPDATE agents SET owner_id=$2 WHERE agent_id=$1`,[agent,b]);
        })).rejects.toMatchObject({code:'55P03'});
        expect(sent).toBe(0);release.resolve();await delivery;expect(sent).toBe(1);
        await writer.query(`UPDATE agents SET owner_id=$2 WHERE agent_id=$1`,[agent,b]);
        await expect(fenceRouterEnqueue(reader,input,a,old.authority,()=>{sent++;return undefined;})).rejects.toThrow('authority');
        expect(sent).toBe(1);
      }finally{release.resolve();await delivery;}
    });
  });

  it('waits for an in-flight authority mutation then observes its committed epoch before callback',async()=>{
    await rig(async(reader,writer)=>{
      const old=await snapshot(reader),mutated=deferred(),commit=deferred(),fenceStarted=deferred();let sent=0;
      const mutation=writer.transaction(async tx=>{
        await tx.query(`UPDATE agents SET owner_id=$2 WHERE agent_id=$1`,[agent,b]);mutated.resolve();await commit.promise;
      });
      await mutated.promise;
      const observed:SqlDatabase={query:(sql,args)=>reader.query(sql,args),transaction:work=>reader.transaction(tx=>work({
        transaction:nested=>tx.transaction(nested),query:(sql,args)=>{
          if(sql.includes('pg_advisory_xact_lock_shared'))fenceStarted.resolve();return tx.query(sql,args);
        },
      }))};
      const rejected=expect(fenceRouterEnqueue(observed,input,a,old.authority,()=>{sent++;return undefined;})).rejects.toThrow('authority');
      try{await fenceStarted.promise;expect(sent).toBe(0);commit.resolve();await mutation;await rejected;expect(sent).toBe(0);}
      finally{commit.resolve();await mutation;}
    });
  });
});
