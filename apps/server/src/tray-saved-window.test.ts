import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlDatabase } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { DURABLE_LIVE_SCHEMA } from './durable-live.js';
import { readMessageBookmarks } from './tray-projection.js';
import { TRAY_SAVED_WINDOW_SCHEMA, readTraySavedCursor, readTraySavedWindow, readTraySavedWindowCause } from './tray-saved-window.js';

const viewer='a'.repeat(64),other='b'.repeat(64),author='c'.repeat(64);
const w1='11111111-1111-4111-8111-111111111111',w2='22222222-2222-4222-8222-222222222222';
const r1='33333333-3333-4333-8333-333333333333',r2='44444444-4444-4444-8444-444444444444',corner='55555555-5555-4555-8555-555555555555';
const ddl=`CREATE TABLE workspaces(id uuid PRIMARY KEY);
 CREATE TABLE identities(id text PRIMARY KEY,kind text,name text,handle text,avatar text,face_id text);
 CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,name text,archived_at timestamptz);
 CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,removed_at timestamptz);
 CREATE TABLE messages(id text PRIMARY KEY,room_id uuid,author_id text,text text,deleted_at timestamptz,created_at timestamptz DEFAULT now());
 CREATE TABLE message_bookmarks(identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
   workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,room_id uuid NOT NULL,message_id text NOT NULL,
   source_room_name text NOT NULL,source_room_kind text NOT NULL,message_created_at timestamptz NOT NULL,
   created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(identity_id,message_id));
 CREATE INDEX message_bookmarks_workspace_viewer_page_idx ON message_bookmarks(workspace_id,identity_id,created_at DESC,message_id);`;
const format=vi.fn((row:{id:string;kind:'human'|'agent';name:string})=>({pubkey:row.id,kind:row.kind,name:row.name}));
describe('uninstalled stable Saved window identity and pure query',()=>{
  let db:PgliteDatabase;
  const scope={workspaceId:w1,readerId:viewer};
  const read=(before?:string,person=viewer,workspace=w1)=>readTraySavedWindow(db,{workspaceId:workspace,...(before===undefined?{}:{before})},person,format);
  const bookmark=async(id='message',created='2300-01-01T00:00:00.000001Z',person=viewer,workspace=w1,room=r1)=>{
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,$4,'2020-01-01') ON CONFLICT DO NOTHING`,[id,room,author,`Visible ${id}`]);
    await db.query(`INSERT INTO message_bookmarks(identity_id,workspace_id,room_id,message_id,source_room_name,source_room_kind,message_created_at,created_at)
      VALUES($1,$2,$3,$4,'Remembered Room','room','2020-01-01',$5)`,[person,workspace,room,id,created]);
  };
  const causes=async()=>(await db.query<{event:Record<string,unknown>}>(`SELECT event FROM live_journal WHERE event->>'sourceTable'='tray-saved-window' ORDER BY stream_id,sequence`)).rows.map(row=>row.event);
  const clearCauses=()=>db.query(`DELETE FROM live_journal WHERE event->>'sourceTable'='tray-saved-window'`);
  beforeEach(async()=>{
    db=new PgliteDatabase();await db.query(ddl);await db.query(DURABLE_LIVE_SCHEMA);await db.query(TRAY_SAVED_WINDOW_SCHEMA);
    await db.query(`INSERT INTO workspaces VALUES($1),($2)`,[w1,w2]);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Reader'),($2,'human','Other'),($3,'agent','Author')`,[viewer,other,author]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name,parent_id) VALUES($1,$3,'Visible Room',NULL),($2,$4,'Private Room',NULL),($5,$3,'Corner',$1)`,[r1,r2,w1,w2,corner]);
    await db.query(`INSERT INTO memberships VALUES($1,NULL,$3,NULL),($2,NULL,$3,NULL),($1,$4,$3,NULL),($1,NULL,$5,NULL),($2,NULL,$5,NULL),($2,$6,$5,NULL)`,[w1,w2,viewer,r1,other,r2]);
    format.mockClear();
  });
  afterEach(()=>db.close());

  it.each([0,30,31])('returns a bounded %i-row source window and explicit continuation only when a 31st row exists',async count=>{
    for(let i=0;i<count;i++)await bookmark(`m-${String(i).padStart(2,'0')}`);
    const result=await read();expect(result.rows).toHaveLength(Math.min(30,count));expect(!!result.next).toBe(count>30);
    if(result.next){expect(result.next).toBe(result.rows.at(-1)!.before);const older=await read(result.next);expect(older.rows.map(row=>row.value.messageId)).toEqual(['m-30']);expect(older.next).toBeUndefined();}
    expect(await read()).toEqual(result);
  });

  it('retains full microseconds beyond a float timestamp round trip and uses the exact ID tie-break',async()=>{
    await bookmark('a','2300-01-01T00:00:00.000002Z');await bookmark('b','2300-01-01T00:00:00.000001Z');await bookmark('c','2300-01-01T00:00:00.000001Z');
    const first=await read();expect(first.rows.map(row=>row.value.messageId)).toEqual(['a','b','c']);
    expect(first.rows.map(row=>readTraySavedCursor(row.before,scope).bookmarkedUs)).toEqual(['10413792000000002','10413792000000001','10413792000000001']);
    expect((await read(first.rows[0]!.before)).rows.map(row=>row.value.messageId)).toEqual(['b','c']);
    expect((await read(first.rows[1]!.before)).rows.map(row=>row.value.messageId)).toEqual(['c']);
    expect(first.rows[0]!.value.bookmarkedAt).toBe(first.rows[1]!.value.bookmarkedAt);
  });

  it('binds cursor to exact scope/reader/schema and rejects malformed or noncanonical tokens before any query',async()=>{
    await bookmark();const token=(await read()).rows[0]!.before,query=vi.fn(db.query.bind(db));const observed:SqlDatabase={query,transaction:work=>db.transaction(work)};
    for(const [before,workspaceId,person]of[[token,w2,viewer],[token,w1,other],['0,message',w1,viewer],[token+'=',w1,viewer],[token.replace('saved1.','saved2.'),w1,viewer]]as const)
      await expect(readTraySavedWindow(observed,{workspaceId,before},person,format)).rejects.toThrow('invalid_saved_cursor');
    expect(query).not.toHaveBeenCalled();
    const raw=JSON.parse(Buffer.from(token.slice(7),'base64url').toString()) as unknown[];
    for(const change of[[3,'01'],[3,'-0'],[4,'a,b'],[5,'not-uuid'],[0,2]]as const){const bad=[...raw];bad[change[0]]=change[1];expect(()=>readTraySavedCursor(`saved1.${Buffer.from(JSON.stringify(bad)).toString('base64url')}`,scope)).toThrow('invalid_saved_cursor');}
  });

  it('always owns INSERT UUIDs, keeps display-edit identities and preserves old-writer do-nothing upserts',async()=>{
    await bookmark();const first=(await read()).rows[0]!;
    await db.query(`INSERT INTO message_bookmarks(identity_id,workspace_id,room_id,message_id,source_room_name,source_room_kind,message_created_at,bookmark_id)
      VALUES($1,$2,$3,'second','Remembered Room','room','2020-01-01',$4)`,[viewer,w1,r1,first.bookmarkId]);
    expect((await db.query(`SELECT bookmark_id::text FROM message_bookmarks WHERE message_id='second'`)).rows[0]!.bookmark_id).not.toBe(first.bookmarkId);
    await db.query(`UPDATE message_bookmarks SET source_room_name='Updated pointer' WHERE message_id='message'`);
    expect((await db.query(`SELECT bookmark_id::text FROM message_bookmarks WHERE message_id='message'`)).rows[0]!.bookmark_id).toBe(first.bookmarkId);
    await clearCauses();await db.query(`INSERT INTO message_bookmarks(identity_id,workspace_id,room_id,message_id,source_room_name,source_room_kind,message_created_at)
      VALUES($1,$2,$3,'message','Ignored','room','2020-01-01') ON CONFLICT(identity_id,message_id) DO NOTHING`,[viewer,w1,r1]);
    expect(await causes()).toEqual([]);
    await expect(db.query(`UPDATE message_bookmarks SET bookmark_id=gen_random_uuid() WHERE message_id='message'`)).rejects.toMatchObject({code:'23514'});
  });

  it('gives raw order A→B→A moves new incarnations and distinct cursor/window identities',async()=>{
    await bookmark();const first=(await read()).rows[0]!;
    await db.query(`UPDATE message_bookmarks SET created_at=created_at+interval '1 microsecond'`);const middle=(await read()).rows[0]!;
    await db.query(`UPDATE message_bookmarks SET created_at=created_at-interval '1 microsecond',bookmark_id=$1`,[first.bookmarkId]);const last=(await read()).rows[0]!;
    expect(new Set([first.bookmarkId,middle.bookmarkId,last.bookmarkId]).size).toBe(3);expect(last.order).toBe(first.order);expect(last.before).not.toBe(first.before);
    expect((await read(last.before)).windowId).not.toBe((await read(first.before)).windowId);
  });

  it('keeps deleted anchors valid, rejects incarnation reuse on recreation and emits exact old/new tombstones',async()=>{
    await bookmark('a');await bookmark('b','2300-01-01T00:00:00Z');const first=(await read()).rows[0]!;await clearCauses();
    await db.query(`DELETE FROM message_bookmarks WHERE message_id='a'`);
    expect((await read(first.before)).rows.map(row=>row.value.messageId)).toEqual(['b']);
    const deleted=(await causes())[0]!;expect(deleted).toMatchObject({operation:'DELETE',oldBookmarkId:first.bookmarkId,oldMessageId:'a',oldOrder:first.order});expect(readTraySavedWindowCause(deleted)).toBeTruthy();
    await db.query(`INSERT INTO message_bookmarks(identity_id,workspace_id,room_id,message_id,source_room_name,source_room_kind,message_created_at,created_at,bookmark_id)
      VALUES($1,$2,$3,'a','Remembered Room','room','2020-01-01','2300-01-01T00:00:00.000001Z',$4)`,[viewer,w1,r1,first.bookmarkId]);
    const latest=(await read()).rows[0]!;expect(latest.order).toBe(first.order);expect(latest.bookmarkId).not.toBe(first.bookmarkId);
  });

  it('captures OLD/NEW identities, audiences and precise ordering for raw reader/Workspace/Room/message moves',async()=>{
    await bookmark();const old=(await read()).rows[0]!;await clearCauses();
    await db.query(`UPDATE message_bookmarks SET identity_id=$1,workspace_id=$2,room_id=$3,message_id='moved'`,[other,w2,r2]);
    const changed=await causes();expect(changed).toHaveLength(2);
    for(const cause of changed){expect(readTraySavedWindowCause(cause)).toBeTruthy();expect(cause).toMatchObject({oldBookmarkId:old.bookmarkId,
      oldReaderId:viewer,newReaderId:other,oldWorkspaceId:w1,newWorkspaceId:w2,oldRoomId:r1,newRoomId:r2,oldMessageId:'message',newMessageId:'moved',oldOrder:old.order});expect(cause.newBookmarkId).not.toBe(old.bookmarkId);}
    for(const bad of[{...changed[0],inventory:[]},{...changed[0],oldOrder:'01,message'},{...changed[0],oldOrder:'1,another'},
      {...changed[0],oldBookmarkId:'invalid'},{...changed[0],trayReaderId:'unrelated'}])expect(readTraySavedWindowCause(bad)).toBeUndefined();
    expect(new Set(changed.map(cause=>cause.trayWorkspaceId))).toEqual(new Set([w1,w2]));
    expect((await read()).rows).toEqual([]);expect((await read(undefined,other,w2)).rows[0]!.value.available).toBe(false);
  });

  it('retains an authorized unavailable pointer without current private text, author or renamed Room leakage',async()=>{
    await bookmark();await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id=$2`,[viewer,r1]);
    await db.query(`UPDATE rooms SET name='PRIVATE RENAMED ROOM' WHERE id=$1`,[r1]);await db.query(`UPDATE identities SET name='PRIVATE AUTHOR' WHERE id=$1`,[author]);
    await db.query(`UPDATE messages SET text='PRIVATE NEW TEXT'`);format.mockClear();
    const value=await read();expect(value.rows[0]!.value).toMatchObject({messageId:'message',roomName:'Remembered Room',available:false});
    expect(value.rows[0]!.value).not.toHaveProperty('text');expect(value.rows[0]!.value).not.toHaveProperty('author');expect(format).not.toHaveBeenCalled();expect(JSON.stringify(value)).not.toContain('PRIVATE');
    await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id IS NULL AND workspace_id=$2`,[viewer,w1]);
    await expect(read()).rejects.toThrow('workspace membership required');
  });

  it('requires exact source Room coherence and effective parent access, preserving deletion placeholders',async()=>{
    await bookmark('corner-message',undefined,viewer,w1,corner);expect((await read()).rows[0]!.value.available).toBe(true);
    await db.query(`UPDATE messages SET room_id=$1 WHERE id='corner-message'`,[r2]);format.mockClear();
    expect((await read()).rows[0]!.value.available).toBe(false);expect(format).not.toHaveBeenCalled();
    await db.query(`UPDATE messages SET room_id=$1,deleted_at=now() WHERE id='corner-message'`,[corner]);
    expect((await read()).rows[0]!.value.available).toBe(false);
    await db.query(`DELETE FROM messages WHERE id='corner-message'`);expect((await read()).rows[0]!.value.available).toBe(false);
  });

  it('is one read-only bounded query with zero source/storage writes and leaves legacy DTO/cursor behavior unchanged',async()=>{
    await bookmark();const previous=(await db.query(`SELECT bookmark_id::text,ctid::text FROM message_bookmarks`)).rows;
    const heads=(await db.query(`SELECT * FROM live_streams ORDER BY id`)).rows;const query=vi.fn(db.query.bind(db));
    const value=await readTraySavedWindow({query,transaction:work=>db.transaction(work)},{workspaceId:w1},viewer,format);
    expect(query).toHaveBeenCalledOnce();expect(query.mock.calls[0]![0]).toMatch(/^WITH authorized/);
    expect((await db.query(`SELECT bookmark_id::text,ctid::text FROM message_bookmarks`)).rows).toEqual(previous);expect((await db.query(`SELECT * FROM live_streams ORDER BY id`)).rows).toEqual(heads);
    expect((await readMessageBookmarks(db,{workspaceId:w1},viewer,format)).bookmarks).toEqual(value.rows.map(row=>row.value));
  });

  it('rolls incarnation and exact source evidence back with a failed key mutation and ignores no-op metadata',async()=>{
    await bookmark();const initial=(await read()).rows[0]!;await clearCauses();
    await db.query(`UPDATE message_bookmarks SET created_at=created_at,source_room_name=source_room_name`);expect(await causes()).toEqual([]);
    await expect(db.transaction(async tx=>{await tx.query(`UPDATE message_bookmarks SET created_at=created_at+interval '1 second'`);throw new Error('synthetic rollback');})).rejects.toThrow('synthetic rollback');
    expect((await read()).rows[0]).toEqual(initial);expect(await causes()).toEqual([]);
  });

  it.each([{label:'Unicode',glyph:'😀',kept:254},{label:'escaped controls',glyph:'\u0001',kept:169}])('bounds a full $label preview page in SQL and retains explicit source targets without another read',async({glyph,kept})=>{
    for(let n=0;n<31;n++)await bookmark(`long-${n}`);
    await db.query(`UPDATE messages SET text=$1`,[glyph.repeat(4096)]);
    const query=vi.fn(db.query.bind(db));
    const value=await readTraySavedWindow({query,transaction:work=>db.transaction(work)},{workspaceId:w1},viewer,format);
    expect(query).toHaveBeenCalledOnce();expect(value.rows).toHaveLength(30);expect(value.next).toBeTruthy();
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(64*1024);
    for(const entry of value.rows){
      expect(entry.value).toMatchObject({text:glyph.repeat(kept)+'…',textTruncated:true,roomId:r1,workspaceId:w1,available:true});
      expect(entry.value.messageId).toMatch(/^long-/);
      expect(Buffer.byteLength(JSON.stringify(entry.value.text))).toBeLessThanOrEqual(1024);
    }
    const result=await query.mock.results[0]!.value;
    for(const record of result.rows[0]!.bookmarks)expect(Buffer.byteLength(record.text)).toBeLessThanOrEqual(1024);
  });
  it.each([255,256,257])('marks truncation only past the %s-codepoint boundary',async length=>{
    await bookmark();await db.query(`UPDATE messages SET text=$1`,['x'.repeat(length)]);
    const value=(await read()).rows[0]!.value;
    expect(value.text).toBe('x'.repeat(Math.min(length,256))+(length>256?'…':''));
    expect(value.textTruncated).toBe(length>256?true:undefined);
  });
  it('still refuses oversized non-preview metadata instead of returning a partial window',async()=>{
    await bookmark();await db.query(`UPDATE rooms SET name=$1`,['x'.repeat(64*1024)]);await expect(read()).rejects.toThrow('saved_window_budget');
  });
});
