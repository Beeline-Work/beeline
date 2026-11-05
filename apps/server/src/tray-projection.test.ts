import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { routerAtomicGroup } from './router-projections.js';
import { routerSourcePlan } from './router-source-plan.js';
import { buildTrayProjection } from './tray-projection.js';
import {TRAY_SAVED_WINDOW_SCHEMA,readTraySavedWindow} from './tray-saved-window.js';
import type { RoomViewIdentity } from '@beeline/api-contract/phone';
const viewer='a'.repeat(64), author='b'.repeat(64);
const workspace='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222';
const toIdentity=(row:{id:string;kind:'human'|'agent';name:string;handle:string|null;avatar:string|null;face_id:string|null}):RoomViewIdentity=>({
  pubkey:row.id,kind:row.kind,name:row.name,...(row.handle?{handle:row.handle}:{}),
  ...(row.avatar?{avatar:row.avatar.startsWith('/')?`https://example.test${row.avatar}`:row.avatar}:{}),...(row.face_id?{face:row.face_id}:{}),
});
describe('pure complete Tray projection',()=>{
  let db:PgliteDatabase;
  beforeEach(async()=>{
    db=await migratedDatabase();await db.query(TRAY_SAVED_WINDOW_SCHEMA);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Ada','ada'),($2,'human','Author','author')`,[viewer,author]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic workspace')`,[workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Synthetic Room')`,[room,workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`,[workspace,viewer,author,room]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('ask',$1,$2,'@ada please review this?')`,[room,author]);
    await db.query(`INSERT INTO message_bookmarks(identity_id,workspace_id,room_id,message_id,source_room_name,source_room_kind,message_created_at)
      SELECT $1,$2,$3,id,'Synthetic Room','room',created_at FROM messages WHERE id='ask'`,[viewer,workspace,room]);
  });
  afterEach(async()=>{await db.close();});
  const build=()=>db.transaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return buildTrayProjection(tx,workspace,viewer,toIdentity);
  });
  it('matches both existing sections without seen marks, expiry starts, or journal writes',async()=>{
    const expected=await new PhoneService(db,'https://example.test').execute('readTray',{workspaceId:workspace,markSeen:false},viewer);
    const before=(await db.query(`SELECT id,epoch,sequence::text FROM live_streams ORDER BY id`)).rows;
    const value=await build();expect(value.needs).toEqual(expected.needs);expect(value.saved.rows.map(row=>row.value)).toEqual(expected.saved?.bookmarks);
    expect(value.needs?.items).toHaveLength(1);expect(value.saved?.rows).toHaveLength(1);
    expect((await db.query('SELECT * FROM needs_you_marks')).rows).toEqual([]);
    expect((await db.query(`SELECT id,epoch,sequence::text FROM live_streams ORDER BY id`)).rows).toEqual(before);
  });
  it('routes the complete projection in the count atomic group and scopes saved sources to their reader',async()=>{
    const input={family:'needs-you-tray',workspaceId:workspace} as const;
    const value=await db.transaction(tx=>new PhoneService(tx,'https://example.test').buildRouterValue(tx,input,viewer));
    expect(value).toEqual(await build());
    expect(routerAtomicGroup(input,viewer)).toBe(routerAtomicGroup({family:'needs-you-count',workspaceId:workspace},viewer));
    expect(routerSourcePlan([{sourceTable:'message_bookmarks',identityId:viewer,sourceRoomId:room}],viewer).families.has('needs-you-tray')).toBe(true);
    expect(routerSourcePlan([{sourceTable:'message_bookmarks',identityId:author,sourceRoomId:room}],viewer).families.size).toBe(0);
    expect((await db.query('SELECT * FROM needs_you_marks')).rows).toEqual([]);
  });
  it('classifies a closed mutable cause only for its canonical Workspace and reader',()=>{
    const cause={sourceTable:'tray-projection',trayReaderId:viewer,trayWorkspaceId:workspace,table:'agents',operation:'UPDATE',oldSourceId:author,newSourceId:author};
    expect([...routerSourcePlan([cause],viewer,workspace).families]).toEqual(['needs-you','needs-you-tray','needs-you-count']);
    expect(routerSourcePlan([cause],author,workspace).families.size).toBe(0);
    expect(()=>routerSourcePlan([cause],viewer,'other')).toThrow('dependency');
    expect(()=>routerSourcePlan([{...cause,extra:'unclassified'}],viewer,workspace)).toThrow('dependency');
  });
  it('preserves a real next-page cursor rather than claiming the first bookmark page is complete',async()=>{
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) SELECT 'saved-'||n,$1,$2,'saved' FROM generate_series(1,30)n`,[room,author]);
    await db.query(`INSERT INTO message_bookmarks(identity_id,workspace_id,room_id,message_id,source_room_name,source_room_kind,message_created_at)
      SELECT $1,$2,$3,id,'Synthetic Room','room',created_at FROM messages WHERE id LIKE 'saved-%'`,[viewer,workspace,room]);
    const value=await build();expect(value.saved?.rows).toHaveLength(30);expect(value.saved?.next).toBeDefined();
    const next=await readTraySavedWindow(db,{workspaceId:workspace,before:value.saved!.next},viewer,toIdentity);
    expect(next.rows).toHaveLength(1);expect(new Set([...value.saved!.rows,...next.rows].map(row=>row.value.messageId)).size).toBe(31);
  });
  it('reads every question beyond the former candidate cap',async()=>{
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) SELECT 'overflow-'||n,$1,$2,'@ada please review?' FROM generate_series(1,500)n`,[room,author]);
    expect((await build()).needs.items).toHaveLength(501);
    expect((await db.query('SELECT * FROM needs_you_marks')).rows).toEqual([]);
  });
  it('keeps only the unavailable saved reference after Room authority is revoked',async()=>{
    await db.query(`UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id=$1 AND identity_id=$2`,[room,viewer]);
    const value=await build();expect(value.needs?.items).toEqual([]);
    expect(value.saved?.rows).toHaveLength(1);expect(value.saved!.rows[0]!.value).toMatchObject({messageId:'ask',available:false});
    expect(value.saved!.rows[0]!.value).not.toHaveProperty('text');expect(value.saved!.rows[0]!.value).not.toHaveProperty('author');
  });
  it('refuses Workspace revocation and oversized content instead of returning a partial snapshot',async()=>{
    await db.query(`UPDATE messages SET text=$2 WHERE id=$1`,['ask','x'.repeat(65*1024)]);
    const bounded=await build();
    expect(bounded.saved.rows[0]!.value.text).toBeDefined();
    expect(Buffer.byteLength(bounded.saved.rows[0]!.value.text!)).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(64*1024);
    // Saved message text is a bounded excerpt. Oversized unbounded metadata
    // must still park the complete projection, never silently drop a row.
    await db.query(`UPDATE rooms SET name=$2 WHERE id=$1`,[room,'x'.repeat(65*1024)]);
    await expect(build()).rejects.toMatchObject({reason:'budget'});
    await db.query(`UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id IS NULL AND workspace_id=$1 AND identity_id=$2`,[workspace,viewer]);
    await expect(build()).rejects.toThrow('workspace membership required');
  });
});
