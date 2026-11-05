import { afterEach, beforeEach, expect, it } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';

const viewer = 'a'.repeat(64), author = 'b'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
let db: PgliteDatabase;
beforeEach(async () => {
  db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Reader','reader'),($2,'human','Author','author')`, [viewer, author]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Migration proof')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Source Room')`, [room, workspace]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
    ($1,NULL,$3,'owner'),($1,$2,$3,'member')`, [workspace, room, viewer]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('saved',$1,$2,'Saved text')`, [room, author]);
});
afterEach(async () => { await db.close(); });

const bookmark = () => db.query(`INSERT INTO message_bookmarks(identity_id,workspace_id,room_id,message_id,
  source_room_name,source_room_kind,message_created_at)
  SELECT $1,$2,$3,id,'Source Room','room',created_at FROM messages WHERE id='saved'
  ON CONFLICT(identity_id,message_id) DO NOTHING`, [viewer, workspace, room]);
const read = () => new PhoneService(db, 'https://synthetic.invalid').execute('readTray', {workspaceId:workspace}, viewer);

it('reads and clears populated canonical Tray after release migration alone', async () => {
  await bookmark();
  const snapshot = await read();
  expect(snapshot.saved!.bookmarks).toHaveLength(1);
  expect(snapshot.saved!.bookmarks[0]!).toMatchObject({messageId:'saved', text:'Saved text', available:true});
  await db.query(`UPDATE messages SET text='Edited saved text' WHERE id='saved'`);
  expect((await read()).saved!.bookmarks[0]!.text).toBe('Edited saved text');
  await db.query(`UPDATE identities SET name='Renamed author' WHERE id=$1`, [author]);
  expect((await read()).saved!.bookmarks[0]!.author?.name).toBe('Renamed author');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('question',$1,$2,'@reader please review?')`, [room, author]);
  expect((await read()).needs!.items.map(item => item.messageId)).toEqual(['question']);
  await new PhoneService(db, 'https://synthetic.invalid').execute('clearNeedsYouSection', {workspaceId:workspace}, viewer);
  expect((await read()).needs!.items).toEqual([]);
  await new PhoneService(db, 'https://synthetic.invalid').execute('clearMessageBookmarks', {workspaceId:workspace}, viewer);
  expect((await read()).saved!.bookmarks).toEqual([]);
  expect((await db.query('SELECT * FROM message_bookmarks')).rows).toEqual([]);
});
