import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresDatabase, type SqlDatabase } from './database.js';
import { DURABLE_LIVE_SCHEMA } from './durable-live.js';
import { ROUTER_PROJECTION_SCHEMA } from './router-projection-schema.js';
import { TRAY_SAVED_WINDOW_SCHEMA, readTraySavedWindow } from './tray-saved-window.js';
import { TRAY_SAVED_SOURCE_SCHEMA } from './tray-saved-source.js';
import { buildTraySavedFacts } from './tray-saved-projection.js';
import { routerSourcePlan } from './router-source-plan.js';

const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw new Error('Saved source proofs require isolated loopback PostgreSQL');
const a='a'.repeat(64),b='b'.repeat(64),author='c'.repeat(64),w1='11111111-1111-4111-8111-111111111111',w2='22222222-2222-4222-8222-222222222222';
const parent='33333333-3333-4333-8333-333333333333',child='44444444-4444-4444-8444-444444444444',otherRoom='55555555-5555-4555-8555-555555555555';
const format=(row:{id:string;kind:'human'|'agent';name:string})=>({pubkey:row.id,kind:row.kind,name:row.name});
const sources=async(db:SqlDatabase,workspace=w1)=>(await db.query<{event:Record<string,unknown>}>(`SELECT event FROM live_journal WHERE stream_id=$1
  AND event->>'sourceTable' IN ('tray-saved-window','tray-saved-source') ORDER BY sequence`,[`workspace:${workspace}`])).rows.map(row=>row.event);
async function rig(run:(reader:SqlDatabase,writer:SqlDatabase)=>Promise<void>){
  const schema=`saved_source_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
  const config={connectionString:url,options:`-c search_path=${schema},public`,max:2};
  const reader=new PostgresDatabase('',2,{pool:new Pool(config)}),writer=new PostgresDatabase('',2,{pool:new Pool(config)});
  try{
    await reader.query(`CREATE TABLE workspaces(id uuid PRIMARY KEY);
      CREATE TABLE identities(id text PRIMARY KEY,kind text,name text,handle text,avatar text,face_id text,hidden_from_roster boolean DEFAULT false);
      CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
        parent_id uuid REFERENCES rooms(id) ON DELETE CASCADE,name text,archived_at timestamptz);
      CREATE TABLE memberships(workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
        room_id uuid REFERENCES rooms(id) ON DELETE CASCADE,identity_id text REFERENCES identities(id) ON DELETE CASCADE,role text,removed_at timestamptz);
      CREATE TABLE messages(id text PRIMARY KEY,room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        author_id text NOT NULL REFERENCES identities(id),text text,deleted_at timestamptz,created_at timestamptz DEFAULT now());
      CREATE TABLE message_bookmarks(identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
        workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,room_id uuid NOT NULL,message_id text NOT NULL,
        source_room_name text NOT NULL,source_room_kind text NOT NULL,message_created_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(identity_id,message_id));`);
    await reader.query(DURABLE_LIVE_SCHEMA);await reader.query(ROUTER_PROJECTION_SCHEMA);
    await reader.query(TRAY_SAVED_WINDOW_SCHEMA);await reader.query(TRAY_SAVED_SOURCE_SCHEMA);
    await reader.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Reader A'),($2,'human','Reader B'),($3,'agent','Author')`,[a,b,author]);
    await reader.query(`INSERT INTO workspaces VALUES($1),($2)`,[w1,w2]);
    await reader.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Parent'),($3,$4,'Other')`,[parent,w1,otherRoom,w2]);
    await reader.query(`INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Child')`,[child,w1,parent]);
    await reader.query(`INSERT INTO memberships VALUES($1,NULL,$3,'member',NULL),($1,$2,$3,'member',NULL),($4,NULL,$6,'member',NULL),($4,$5,$6,'member',NULL)`,[w1,parent,a,w2,otherRoom,b]);
    await reader.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('one',$1,$3,'Original one'),('two',$2,$3,'Original two')`,[child,otherRoom,author]);
    await reader.query(`INSERT INTO message_bookmarks(identity_id,workspace_id,room_id,message_id,source_room_name,source_room_kind,message_created_at)
      VALUES($1,$2,$3,'one','Remembered Child','corner',now()),($4,$5,$6,'two','Remembered Other','room',now())`,[a,w1,child,b,w2,otherRoom]);
    await reader.query(`DELETE FROM live_journal WHERE event->>'sourceTable' IN ('tray-saved-window','tray-saved-source')`);
    await run(reader,writer);
  }finally{await Promise.all([reader.close(),writer.close()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}

describe.skipIf(!url)('real PostgreSQL precise sealed Saved source facts',()=>{
  it('binds source keys, complete row and cut to the same read-only snapshot across a concurrent edit',async()=>{
    await rig(async(reader,writer)=>{
      const baseline=(await readTraySavedWindow(reader,{workspaceId:w1},a,format)).rows[0]!;
      await writer.query(`UPDATE messages SET text='First committed' WHERE id='one'`);
      await reader.transaction(async tx=>{
        await tx.query(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
        const captured=routerSourcePlan(await sources(tx),a,w1);
        const cut=(await tx.query(`SELECT epoch,sequence::text FROM live_streams WHERE id=$1`,[`workspace:${w1}`])).rows;
        await writer.query(`UPDATE messages SET text='Later committed' WHERE id='one'`);
        const facts=await buildTraySavedFacts(tx,w1,a,captured.savedTargets,format);
        expect(facts).toHaveLength(1);expect(facts[0]!.payload).toMatchObject({kind:'saved-row-replace',row:{bookmarkId:baseline.bookmarkId,value:{text:'First committed'}}});
        expect((await tx.query(`SELECT epoch,sequence::text FROM live_streams WHERE id=$1`,[`workspace:${w1}`])).rows).toEqual(cut);
      });
      const current=await buildTraySavedFacts(reader,w1,a,routerSourcePlan(await sources(reader),a,w1).savedTargets,format);
      expect(current[0]!.payload).toMatchObject({kind:'saved-row-replace',row:{value:{text:'Later committed'}}});
      expect(await sources(reader,w2)).toEqual([]);
    });
  });

  it('retains parent-deletion audiences before actual FK cascades and never substitutes an older unheld row',async()=>{
    await rig(async(reader,writer)=>{
      const old=(await readTraySavedWindow(reader,{workspaceId:w1},a,format)).rows[0]!;
      await writer.query(`DELETE FROM rooms WHERE id=$1`,[parent]);
      expect((await reader.query(`SELECT 1 FROM rooms WHERE id=$1`,[child])).rows).toEqual([]);
      const plan=routerSourcePlan(await sources(reader),a,w1);expect(plan.savedTargets).toEqual([{bookmarkId:old.bookmarkId,messageId:'one'}]);
      const facts=await buildTraySavedFacts(reader,w1,a,plan.savedTargets,format);expect(facts).toHaveLength(1);
      expect(facts[0]!.payload).toMatchObject({kind:'saved-row-replace',row:{bookmarkId:old.bookmarkId,value:{available:false,roomName:'Remembered Child'}}});
      expect(JSON.stringify(facts)).not.toContain('Original one');expect(await sources(reader,w2)).toEqual([]);
    });
  });

  it('keeps bookmark move evidence atomic and old-incarnation removals distinct from new-reader replacements',async()=>{
    await rig(async(reader,writer)=>{
      const old=(await readTraySavedWindow(reader,{workspaceId:w1},a,format)).rows[0]!;
      await expect(writer.transaction(async tx=>{await tx.query(`UPDATE message_bookmarks SET identity_id=$1,workspace_id=$2,room_id=$3 WHERE message_id='one'`,[b,w2,otherRoom]);throw new Error('synthetic rollback');})).rejects.toThrow('synthetic rollback');
      expect(await sources(reader)).toEqual([]);
      await writer.query(`UPDATE message_bookmarks SET identity_id=$1,workspace_id=$2,room_id=$3 WHERE message_id='one'`,[b,w2,otherRoom]);
      const before=routerSourcePlan(await sources(reader),a,w1),after=routerSourcePlan(await sources(reader,w2),b,w2);
      const removals=await buildTraySavedFacts(reader,w1,a,before.savedTargets,format);
      expect(removals[0]!.payload).toEqual({kind:'saved-row-remove',scope:w1,bookmarkId:old.bookmarkId,messageId:'one'});
      const replacements=await buildTraySavedFacts(reader,w2,b,after.savedTargets,format);
      expect(replacements).toHaveLength(1);expect(replacements[0]!.payload).toMatchObject({kind:'saved-row-replace',row:{value:{messageId:'one',available:false}}});
      expect(replacements[0]!.payload.kind==='saved-row-replace'&&replacements[0]!.payload.row.bookmarkId).not.toBe(old.bookmarkId);
    });
  });
});
