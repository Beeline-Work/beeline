import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migratedDatabase, PgliteDatabase } from './test-support.js';
import type { SqlDatabase } from './database.js';
import { TRAY_SAVED_WINDOW_SCHEMA, readTraySavedWindow } from './tray-saved-window.js';
import { TRAY_SAVED_SOURCE_SCHEMA, readTraySavedSourceCause } from './tray-saved-source.js';
import { buildTraySavedFacts, readTraySavedTargets } from './tray-saved-projection.js';
import { routerSourcePlan } from './router-source-plan.js';
import { PhoneService } from './phone-service.js';

const a='a'.repeat(64),b='b'.repeat(64),author='c'.repeat(64);
const w1='11111111-1111-4111-8111-111111111111',w2='22222222-2222-4222-8222-222222222222';
const r1='33333333-3333-4333-8333-333333333333',r2='44444444-4444-4444-8444-444444444444',child='55555555-5555-4555-8555-555555555555';
const format=(row:{id:string;kind:'human'|'agent';name:string})=>({pubkey:row.id,kind:row.kind,name:row.name});
const base=await(async()=>{const db=await migratedDatabase();try{return await db.snapshot();}finally{await db.close();}})();
describe('uninstalled precise Saved source and sealed-row projection',()=>{
  let db:PgliteDatabase;
  const causes=async(workspace=w1)=>(await db.query<{event:Record<string,unknown>}>(`SELECT event FROM live_journal WHERE stream_id=$1
    AND event->>'sourceTable' IN ('tray-saved-source','tray-saved-window') ORDER BY sequence`,[`workspace:${workspace}`])).rows.map(row=>row.event);
  const reset=()=>db.query(`DELETE FROM live_journal WHERE event->>'sourceTable' IN ('tray-saved-source','tray-saved-window')`);
  const plan=async(reader=a,workspace=w1)=>routerSourcePlan(await causes(workspace),reader,workspace);
  const facts=async(reader=a,workspace=w1)=>buildTraySavedFacts(db,workspace,reader,(await plan(reader,workspace)).savedTargets,format);
  const save=async(id:string,person=a,workspace=w1,room=r1)=>{
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`,[id,room,author,`Original ${id}`]);
    await db.query(`INSERT INTO message_bookmarks(identity_id,workspace_id,room_id,message_id,source_room_name,source_room_kind,message_created_at)
      VALUES($1,$2,$3,$4,'Remembered Room','room',now())`,[person,workspace,room,id]);
  };
  beforeEach(async()=>{
    db=PgliteDatabase.fromSnapshot(base);await db.query(TRAY_SAVED_WINDOW_SCHEMA);await db.query(TRAY_SAVED_SOURCE_SCHEMA);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Reader A','a'),($2,'human','Reader B','b'),($3,'agent','Author','writer')`,[a,b,author]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'One'),($2,'Two')`,[w1,w2]);
    await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$3,NULL,'Room A'),($2,$4,NULL,'Room B'),($5,$3,$1,'Child')`,[r1,r2,w1,w2,child]);
    for(const [person,workspace,room]of[[a,w1,r1],[b,w2,r2]])await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,[workspace,person,room]);await reset();
  });
  afterEach(()=>db.close());

  it('builds only the exact changed older bookmark row and never reruns a window or fills its hole',async()=>{
    for(let i=0;i<31;i++)await save(`m-${String(i).padStart(2,'0')}`);
    const window=await readTraySavedWindow(db,{workspaceId:w1},a,format);await reset();
    const tail=(await db.query<{message_id:string;bookmark_id:string}>(`SELECT message_id,bookmark_id::text FROM message_bookmarks ORDER BY created_at,message_id LIMIT 1`)).rows[0]!;
    await db.query(`UPDATE messages SET text='Edited source' WHERE id=$1`,[tail.message_id]);
    const projection=await plan();expect(projection.savedTargets).toEqual([{bookmarkId:tail.bookmark_id,messageId:tail.message_id}]);
    const query=vi.fn(db.query.bind(db)),observed:SqlDatabase={query,transaction:work=>db.transaction(work)};
    const changed=await buildTraySavedFacts(observed,w1,a,projection.savedTargets,format);
    expect(changed).toHaveLength(1);expect(changed[0]!.payload).toMatchObject({kind:'saved-row-replace',scope:w1,row:{bookmarkId:tail.bookmark_id,value:{text:'Edited source'}}});
    expect(query.mock.calls.some(([sql])=>sql.includes('unnest($3::uuid[],$4::text[])'))).toBe(true);
    expect(query.mock.calls.every(([sql])=>!sql.includes('LIMIT 31'))).toBe(true);
    await reset();await db.query(`DELETE FROM message_bookmarks WHERE message_id=$1`,[window.rows[0]!.value.messageId]);
    const removals=await facts();expect(removals).toHaveLength(1);expect(removals[0]!.payload).toEqual({kind:'saved-row-remove',scope:w1,
      bookmarkId:window.rows[0]!.bookmarkId,messageId:window.rows[0]!.value.messageId});
  });

  it('uses the same bounded explicit excerpt for head and held-row edits and clears the marker on a short edit',async()=>{
    await save('large');await reset();await db.query(`UPDATE messages SET text=$1 WHERE id='large'`,['😀'.repeat(20000)]);
    const changed=await facts();expect(changed).toHaveLength(1);
    const payload=changed[0]!.payload;expect(payload.kind).toBe('saved-row-replace');
    if(payload.kind!=='saved-row-replace')throw new Error('Expected exact row');
    expect(payload.row.value).toMatchObject({messageId:'large',roomId:r1,text:'😀'.repeat(254)+'…',textTruncated:true});
    expect(payload.row).toEqual((await readTraySavedWindow(db,{workspaceId:w1},a,format)).rows[0]);
    await reset();await db.query(`UPDATE messages SET text='Short' WHERE id='large'`);
    const next=(await facts())[0]!.payload;
    if(next.kind!=='saved-row-replace')throw new Error('Expected exact row');
    expect(next.row.value.text).toBe('Short');expect(next.row.value).not.toHaveProperty('textTruncated');
  });

  it('rebuilds only the bounded canonical head for a new incarnation, never an anchored page',async()=>{
    for(let i=0;i<31;i++)await save(`m-${String(i).padStart(2,'0')}`);
    const before=await readTraySavedWindow(db,{workspaceId:w1},a,format);await reset();
    await save('new');const source=await plan();expect(source.savedHeadChanged).toBe(true);
    expect((await plan(b,w2)).savedHeadChanged).toBe(false);
    const query=vi.fn(db.query.bind(db)),observed:SqlDatabase={query,transaction:work=>db.transaction(work)};
    const value=await new PhoneService(observed,'https://example.test').buildRouterValue(observed,
      {family:'needs-you-saved-page',workspaceId:w1},a) as import('@beeline/api-contract/router-protocol').SavedWindow;
    expect(value.windowId).toBe(before.windowId);
    expect(value.rows).toHaveLength(30);expect(value.rows[0]!.value.messageId).toBe('new');
    expect(value.before).toBeUndefined();expect(value.next).toBe(value.rows.at(-1)!.before);
    const windows=query.mock.calls.filter(([sql])=>sql.includes('LIMIT 31'));
    expect(windows).toHaveLength(1);expect(windows[0]![1]).toEqual([w1,a]);
    await reset();await db.query(`UPDATE messages SET text='edit' WHERE id='new'`);
    expect((await plan()).savedHeadChanged).toBe(false);
    await reset();await db.query(`DELETE FROM message_bookmarks WHERE message_id='new'`);
    expect((await plan()).savedHeadChanged).toBe(false);
  });

  it('coalesces repeated changes to one exact current row and preserves the shared reader consistency group',async()=>{
    await save('m');await reset();await db.query(`UPDATE messages SET text='First' WHERE id='m'`);await db.query(`UPDATE messages SET text='Final' WHERE id='m'`);
    const result=await facts();expect(result).toHaveLength(1);expect(result[0]!.atomicGroup).toBe(`needs-you:${w1}:${a}`);
    expect(result[0]!.authority.scopes.map(scope=>scope.authorityScope).sort()).toEqual([`reader:${a}:workspace:${w1}`,`reader:${a}:workspace:${w1}:visibility`]);
    expect(result[0]!.payload).toMatchObject({kind:'saved-row-replace',row:{value:{text:'Final'}}});
  });

  it('captures original and formerly unavailable message keys on a raw message id move',async()=>{
    await save('old');await db.query(`INSERT INTO message_bookmarks(identity_id,workspace_id,room_id,message_id,source_room_name,source_room_kind,message_created_at)
      VALUES($1,$2,$3,'new','Remembered Room','room',now())`,[a,w1,r1]);await reset();
    await db.query(`UPDATE messages SET id='new' WHERE id='old'`);const changes=await facts();expect(changes).toHaveLength(2);
    const values=changes.flatMap(fact=>fact.payload.kind==='saved-row-replace'?[fact.payload.row.value]:[]);
    expect(values.find(value=>value.messageId==='old')).toMatchObject({available:false});
    expect(values.find(value=>value.messageId==='new')).toMatchObject({available:true,text:'Original old'});
  });

  it('turns deletion into an unavailable pointer, and an actual source restoration replaces that same incarnation',async()=>{
    await save('m');const original=(await readTraySavedWindow(db,{workspaceId:w1},a,format)).rows[0]!;await reset();
    await db.query(`DELETE FROM messages WHERE id='m'`);expect((await facts())[0]!.payload).toMatchObject({kind:'saved-row-replace',row:{bookmarkId:original.bookmarkId,value:{available:false}}});
    await reset();await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('m',$1,$2,'Restored')`,[r1,author]);
    expect((await facts())[0]!.payload).toMatchObject({kind:'saved-row-replace',row:{bookmarkId:original.bookmarkId,value:{available:true,text:'Restored'}}});
  });

  it('captures author edits/deletion before FK effects, but hidden-only, handle-unrelated and unbookmarked source writes emit no Saved cause',async()=>{
    await save('m');await reset();await db.query(`UPDATE identities SET name='Renamed' WHERE id=$1`,[author]);
    expect((await facts())[0]!.payload).toMatchObject({kind:'saved-row-replace',row:{value:{author:{name:'Renamed'}}}});
    await reset();await db.query(`UPDATE identities SET hidden_from_roster=true WHERE id=$1`,[author]);expect(await causes()).toEqual([]);
    await db.query(`UPDATE identities SET handle='unrelated-reader-name' WHERE id=$1`,[b]);expect(await causes()).toEqual([]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('not-bookmarked',$1,$2,'Unrelated')`,[r1,author]);
    await db.query(`UPDATE messages SET text='Still unrelated' WHERE id='not-bookmarked'`);expect(await causes()).toEqual([]);
    // Canonical messages retain a NOT NULL author FK: a raw author deletion
    // cannot commit until its messages are removed. Failed BEFORE evidence
    // must roll back rather than pretending this impossible state is current.
    await expect(db.query(`DELETE FROM identities WHERE id=$1`,[author])).rejects.toMatchObject({code:'23503'});
    expect(await causes()).toEqual([]);await db.query(`DELETE FROM messages WHERE author_id=$1`,[author]);
    await db.query(`DELETE FROM identities WHERE id=$1`,[author]);
    const result=await facts();expect(result).toHaveLength(1);expect(result[0]!.payload.kind).toBe('saved-row-replace');
    if(result[0]!.payload.kind==='saved-row-replace')expect(result[0]!.payload.row.value).not.toHaveProperty('author');
  });

  it('does not wake a revoked Room reader for private text, author or Room-name edits',async()=>{
    await save('m');await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,[r1,a]);await reset();
    await db.query(`UPDATE messages SET text='PRIVATE' WHERE id='m'`);await db.query(`UPDATE identities SET name='PRIVATE AUTHOR' WHERE id=$1`,[author]);
    await db.query(`UPDATE rooms SET name='PRIVATE ROOM' WHERE id=$1`,[r1]);expect(await causes()).toEqual([]);
  });

  it('captures effective parent membership loss without unrelated Workspace data and can publish only the unavailable row',async()=>{
    await save('child',a,w1,child);await save('other',b,w2,r2);await reset();
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,[r1,a]);
    expect(await causes(w2)).toEqual([]);expect((await plan()).savedTargets).toHaveLength(1);
    const result=await facts();expect(result[0]!.payload).toMatchObject({kind:'saved-row-replace',row:{value:{messageId:'child',available:false,roomName:'Remembered Room'}}});
    expect((await plan(b,w2)).savedTargets).toEqual([]);
  });

  it('treats a raw membership reader/key move using both old/new target sets, while role/bookkeeping edits remain no-ops',async()=>{
    await save('a');await save('b',b,w2,r2);await reset();
    await db.query(`UPDATE memberships SET role='admin' WHERE room_id=$1 AND identity_id=$2`,[r1,a]);expect(await causes()).toEqual([]);
    // A Room member's workspace_id is bookkeeping; effective Room access uses
    // room_id + reader. Its standalone update cannot invent Saved work.
    await db.query(`UPDATE memberships SET workspace_id=$1 WHERE room_id=$2 AND identity_id=$3`,[w2,r1,a]);expect(await causes()).toEqual([]);
    await db.query(`UPDATE memberships SET workspace_id=$1,room_id=$2,identity_id=$3 WHERE room_id=$4 AND identity_id=$5`,[w1,r1,b,r2,b]);
    expect((await plan(b,w2)).savedTargets).toHaveLength(1);
  });

  it('captures private bookmark incarnation moves as old removal/new replacement without retargeting either reader',async()=>{
    await save('m');await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,[w1,b,r1]);await reset();
    const old=(await readTraySavedWindow(db,{workspaceId:w1},a,format)).rows[0]!;
    await db.query(`UPDATE message_bookmarks SET identity_id=$1 WHERE identity_id=$2`,[b,a]);
    expect((await facts())[0]!.payload).toEqual({kind:'saved-row-remove',scope:w1,bookmarkId:old.bookmarkId,messageId:'m'});
    expect((await facts(b))[0]!.payload).toMatchObject({kind:'saved-row-replace',row:{value:{messageId:'m'}}});
    expect((await plan()).savedTargets[0]!.bookmarkId).not.toBe((await plan(b)).savedTargets[0]!.bookmarkId);
  });

  it('does not silently truncate >256 source targets and bounds an interval union before any row build',async()=>{
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) SELECT 'm-'||n,$1,$2,'Original' FROM generate_series(1,257)n`,[r1,author]);
    await db.query(`INSERT INTO message_bookmarks(identity_id,workspace_id,room_id,message_id,source_room_name,source_room_kind,message_created_at)
      SELECT $1,$2,$3,'m-'||n,'Remembered Room','room',now() FROM generate_series(1,257)n`,[a,w1,r1]);await reset();
    await db.query(`UPDATE identities SET name='Changed' WHERE id=$1`,[author]);const [source]=await causes();expect(source).toMatchObject({classification:'unavailable',reason:'budget'});
    expect(source).not.toHaveProperty('targets');expect(readTraySavedSourceCause(source!)).toBeTruthy();
    expect(await plan()).toMatchObject({savedTargets:[],savedUnavailable:'budget'});
    const pieces=Array.from({length:3},(_,batch)=>({sourceTable:'tray-saved-source',trayReaderId:a,trayWorkspaceId:w1,
      table:'messages',operation:'UPDATE',classification:'complete',targets:Array.from({length:100},(_,n)=>({
        bookmarkId:`00000000-0000-4000-8000-${String(batch*100+n).padStart(12,'0')}`,messageId:`m-${batch*100+n}`}))}));
    expect(routerSourcePlan(pieces,a,w1)).toMatchObject({savedTargets:[],savedUnavailable:'budget'});
  });

  it('keeps source evidence transactional and strictly parses only bounded exact targets',async()=>{
    await save('m');await reset();await expect(db.transaction(async tx=>{await tx.query(`UPDATE messages SET text='Rolled back' WHERE id='m'`);throw new Error('rollback');})).rejects.toThrow('rollback');
    expect(await causes()).toEqual([]);await db.query(`UPDATE messages SET text='Committed' WHERE id='m'`);const [cause]=await causes();
    expect(readTraySavedSourceCause(cause!)).toBeTruthy();expect(readTraySavedSourceCause({...cause,inventory:[]})).toBeUndefined();
    expect(readTraySavedTargets([{bookmarkId:'invalid',messageId:'m'}])).toBeUndefined();
    const target=(await plan()).savedTargets[0]!;expect(readTraySavedTargets([target,target])).toBeUndefined();
    expect(()=>routerSourcePlan([{...cause,trayWorkspaceId:w2}],a,w1)).toThrow('dependency');
  });
});
