import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresDatabase, type SqlDatabase } from './database.js';
import { DURABLE_LIVE_SCHEMA } from './durable-live.js';
import { readMessageBookmarks } from './tray-projection.js';
import { TRAY_SAVED_WINDOW_SCHEMA, readTraySavedWindow, readTraySavedWindowCause } from './tray-saved-window.js';

const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw new Error('Saved window proofs require isolated loopback PostgreSQL');
const viewer='a'.repeat(64),other='b'.repeat(64),author='c'.repeat(64),w1='11111111-1111-4111-8111-111111111111',w2='22222222-2222-4222-8222-222222222222';
const r1='33333333-3333-4333-8333-333333333333',r2='44444444-4444-4444-8444-444444444444';
const format=(row:{id:string;kind:'human'|'agent';name:string})=>({pubkey:row.id,kind:row.kind,name:row.name});
const read=(db:SqlDatabase,before?:string,reader=viewer,workspace=w1)=>readTraySavedWindow(db,{workspaceId:workspace,...(before?{before}:{})},reader,format);
async function fixture(run:(reader:SqlDatabase,writer:SqlDatabase)=>Promise<void>){
  const schema=`tray_saved_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
  const config={connectionString:url,options:`-c search_path=${schema},public`,max:2};
  const reader=new PostgresDatabase('',2,{pool:new Pool(config)}),writer=new PostgresDatabase('',2,{pool:new Pool(config)});
  try{
    await reader.query(`CREATE TABLE workspaces(id uuid PRIMARY KEY);
      CREATE TABLE identities(id text PRIMARY KEY,kind text,name text,handle text,avatar text,face_id text);
      CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,name text,archived_at timestamptz);
      CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,removed_at timestamptz);
      CREATE TABLE messages(id text PRIMARY KEY,room_id uuid,author_id text,text text,deleted_at timestamptz,created_at timestamptz DEFAULT now());
      CREATE TABLE message_bookmarks(identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
        workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,room_id uuid NOT NULL,message_id text NOT NULL,
        source_room_name text NOT NULL,source_room_kind text NOT NULL,message_created_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(identity_id,message_id));
      CREATE INDEX message_bookmarks_workspace_viewer_page_idx ON message_bookmarks(workspace_id,identity_id,created_at DESC,message_id);`);
    await reader.query(DURABLE_LIVE_SCHEMA);
    await reader.query(`INSERT INTO workspaces VALUES($1),($2)`,[w1,w2]);
    await reader.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Reader'),($2,'human','Other'),($3,'agent','Author')`,[viewer,other,author]);
    await reader.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Visible Room'),($3,$4,'Private Room')`,[r1,w1,r2,w2]);
    await reader.query(`INSERT INTO memberships VALUES($1,NULL,$3,NULL),($1,$2,$3,NULL),($4,NULL,$5,NULL),($4,$6,$5,NULL)`,[w1,r1,viewer,w2,other,r2]);
    await reader.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('a',$1,$2,'Visible a'),('b',$1,$2,'Visible b')`,[r1,author]);
    // Existing legacy rows precede metadata installation/backfill.
    await reader.query(`INSERT INTO message_bookmarks(identity_id,workspace_id,room_id,message_id,source_room_name,source_room_kind,message_created_at,created_at)
      VALUES($1,$2,$3,'a','Remembered Room','room','2020-01-01','2300-01-01T00:00:00.000002Z'),
        ($1,$2,$3,'b','Remembered Room','room','2020-01-01','2300-01-01T00:00:00.000001Z')`,[viewer,w1,r1]);
    const legacy=await readMessageBookmarks(reader,{workspaceId:w1},viewer,format);
    await reader.query(TRAY_SAVED_WINDOW_SCHEMA);
    expect(await readMessageBookmarks(reader,{workspaceId:w1},viewer,format)).toEqual(legacy);
    await run(reader,writer);
  }finally{await Promise.all([reader.close(),writer.close()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}

describe.skipIf(!url)('real two-pool PostgreSQL stable Saved query and incarnations',()=>{
  it('returns explicit bounded Unicode previews without changing legacy text or leaking preview metadata after revocation',async()=>{
    await fixture(async(reader,writer)=>{
      const original='😀'.repeat(20000);await writer.query(`UPDATE messages SET text=$1 WHERE id='a'`,[original]);
      await reader.transaction(async tx=>{
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const value=(await read(tx)).rows.find(row=>row.value.messageId==='a')!.value;
        expect(value).toMatchObject({text:'😀'.repeat(254)+'…',textTruncated:true,roomId:r1});
        expect(Buffer.byteLength(JSON.stringify(value.text))).toBeLessThanOrEqual(1024);
      });
      expect((await readMessageBookmarks(reader,{workspaceId:w1},viewer,format)).bookmarks.find(row=>row.messageId==='a')!.text).toBe(original);
      await writer.query(`UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id=$1 AND identity_id=$2`,[r1,viewer]);
      const hidden=(await read(reader)).rows.find(row=>row.value.messageId==='a')!.value;
      expect(hidden.available).toBe(false);expect(hidden).not.toHaveProperty('text');expect(hidden).not.toHaveProperty('textTruncated');
    });
  });

  it('builds one pure repeatable-read window with coherent precise metadata while another pool changes the source',async()=>{
    await fixture(async(reader,writer)=>{
      await reader.transaction(async tx=>{
        await tx.query(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
        const before=await read(tx);expect(before.rows.map(row=>row.order)).toEqual(['10413792000000002,a','10413792000000001,b']);
        await writer.query(`UPDATE message_bookmarks SET created_at=created_at+interval '1 microsecond' WHERE message_id='a'`);
        expect(await read(tx)).toEqual(before);
      });
      const fresh=await read(reader);expect(fresh.rows[0]!.order).toBe('10413792000000003,a');
      expect((await read(reader,fresh.rows[0]!.before)).rows.map(row=>row.value.messageId)).toEqual(['b']);
      const changes=(await reader.query<{event:Record<string,unknown>}>(`SELECT event FROM live_journal WHERE event->>'sourceTable'='tray-saved-window'`)).rows;
      expect(changes).toHaveLength(1);expect(readTraySavedWindowCause(changes[0]!.event)).toBeTruthy();
      expect(changes[0]!.event).toMatchObject({oldOrder:'10413792000000002,a',newOrder:'10413792000000003,a'});
      expect(changes[0]!.event.newBookmarkId).not.toBe(changes[0]!.event.oldBookmarkId);
    });
  });

  it('preserves deleted anchors, refuses caller incarnation replay, and retains exact committed old/new evidence',async()=>{
    await fixture(async(reader,writer)=>{
      const first=(await read(reader)).rows[0]!;
      await writer.transaction(async tx=>{
        await tx.query(`DELETE FROM message_bookmarks WHERE identity_id=$1 AND message_id='a'`,[viewer]);
        await tx.query(`INSERT INTO message_bookmarks(identity_id,workspace_id,room_id,message_id,source_room_name,source_room_kind,message_created_at,created_at,bookmark_id)
          VALUES($1,$2,$3,'a','Remembered Room','room','2020-01-01','2300-01-01T00:00:00.000002Z',$4)`,[viewer,w1,r1,first.bookmarkId]);
      });
      const second=(await read(reader)).rows[0]!;expect(second.order).toBe(first.order);expect(second.bookmarkId).not.toBe(first.bookmarkId);expect(second.before).not.toBe(first.before);
      expect((await read(reader,first.before)).rows.map(row=>row.value.messageId)).toEqual(['b']);
      await expect(writer.query(`UPDATE message_bookmarks SET bookmark_id=$1 WHERE message_id='a'`,[first.bookmarkId])).rejects.toMatchObject({code:'23514'});
      const events=(await reader.query<{event:Record<string,unknown>}>(`SELECT event FROM live_journal WHERE event->>'sourceTable'='tray-saved-window' ORDER BY sequence`)).rows.map(row=>row.event);
      expect(events).toHaveLength(2);expect(events[0]).toMatchObject({operation:'DELETE',oldBookmarkId:first.bookmarkId});
      expect(events[1]).toMatchObject({operation:'INSERT',newBookmarkId:second.bookmarkId});expect(events.every(event=>readTraySavedWindowCause(event))).toBe(true);
    });
  });

  it('captures both raw moved audiences and keeps a private incoherent source unavailable in an actual read-only query',async()=>{
    await fixture(async(reader,writer)=>{
      const first=(await read(reader)).rows[0]!;
      await writer.query(`UPDATE message_bookmarks SET identity_id=$1,workspace_id=$2,room_id=$3,message_id='private-pointer' WHERE message_id='a'`,[other,w2,r2]);
      const events=(await reader.query<{event:Record<string,unknown>}>(`SELECT event FROM live_journal WHERE event->>'sourceTable'='tray-saved-window' ORDER BY stream_id,sequence`)).rows.map(row=>row.event);
      expect(events).toHaveLength(2);expect(events.every(event=>readTraySavedWindowCause(event))).toBe(true);
      for(const event of events)expect(event).toMatchObject({oldBookmarkId:first.bookmarkId,oldReaderId:viewer,newReaderId:other,oldWorkspaceId:w1,newWorkspaceId:w2,oldRoomId:r1,newRoomId:r2});
      await writer.query(`UPDATE messages SET text='PRIVATE NEW TEXT' WHERE id='b'`);
      await writer.query(`UPDATE memberships SET removed_at=clock_timestamp() WHERE identity_id=$1 AND room_id=$2`,[viewer,r1]);
      await writer.query(`UPDATE rooms SET name='PRIVATE RENAMED ROOM' WHERE id=$1`,[r1]);
      const heads=(await reader.query(`SELECT * FROM live_streams ORDER BY id`)).rows;
      await reader.transaction(async tx=>{
        await tx.query(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
        const unavailable=await read(tx);expect(unavailable.rows).toHaveLength(1);expect(unavailable.rows[0]!.value).toMatchObject({available:false,roomName:'Remembered Room'});
        expect(JSON.stringify(unavailable)).not.toContain('PRIVATE');
      });
      expect((await reader.query(`SELECT * FROM live_streams ORDER BY id`)).rows).toEqual(heads);
      await expect(read(reader,first.before,other,w2)).rejects.toThrow('invalid_saved_cursor');
      expect((await read(reader,undefined,other,w2)).rows[0]!.value.available).toBe(false);
    });
  });
});
