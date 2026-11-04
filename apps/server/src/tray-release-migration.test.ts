import { afterEach, beforeEach, expect, it } from 'vitest';
import type { RouterSnapshot } from '@beeline/api-contract/router-protocol';
import { migrate } from './database.js';
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
const read = () => new PhoneService(db, 'https://synthetic.invalid').readRouterSnapshot(
  { family: 'needs-you-tray', workspaceId: workspace }, viewer) as Promise<RouterSnapshot<'needs-you-tray'>>;

it('reads and clears populated canonical Tray after release migration alone', async () => {
  await bookmark();
  const snapshot = await read();
  expect(snapshot.value.saved.rows).toHaveLength(1);
  expect(snapshot.value.saved.rows[0]!.value).toMatchObject({messageId:'saved', text:'Saved text', available:true});
  await db.query(`UPDATE messages SET text='Edited saved text' WHERE id='saved'`);
  expect((await read()).value.saved.rows[0]!.value.text).toBe('Edited saved text');
  const sources = (await db.query<{event: {sourceTable:string; table?:string}}>(
    `SELECT event FROM live_journal WHERE event->>'sourceTable'='tray-saved-source'`)).rows;
  expect(sources.some(row => row.event.table === 'messages')).toBe(true);
  await db.query(`UPDATE identities SET name='Renamed author' WHERE id=$1`, [author]);
  expect((await read()).value.saved.rows[0]!.value.author?.name).toBe('Renamed author');
  expect((await db.query(`SELECT event FROM live_journal WHERE event->>'sourceTable'='tray-projection'
    AND event->>'table'='identities' AND event->>'trayReaderId'=$1`, [viewer])).rows.length).toBeGreaterThan(0);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('question',$1,$2,'@reader please review?')`, [room, author]);
  expect((await read()).value.needs.items.map(item => item.messageId)).toEqual(['question']);
  await new PhoneService(db, 'https://synthetic.invalid').execute('clearNeedsYouSection', {workspaceId:workspace}, viewer);
  expect((await read()).value.needs.items).toEqual([]);
  await new PhoneService(db, 'https://synthetic.invalid').execute('clearMessageBookmarks', {workspaceId:workspace}, viewer);
  expect((await read()).value.saved.rows).toEqual([]);
  expect((await db.query('SELECT * FROM message_bookmarks')).rows).toEqual([]);
});

it('upgrades legacy bookmarks idempotently while preserving old writers', async () => {
  // Recreate the release's pre-canonical Saved schema in this isolated database.
  await db.query(`DROP FUNCTION beeline_saved_source_capture() CASCADE;
    DROP FUNCTION beeline_saved_window_capture() CASCADE;
    DROP FUNCTION beeline_saved_window_identity() CASCADE;
    ALTER TABLE message_bookmarks DROP COLUMN bookmark_id;`);
  await bookmark();
  await migrate(db);
  const upgraded = (await read()).value.saved.rows[0]!;
  expect(upgraded.value).toMatchObject({messageId:'saved', text:'Saved text', available:true});
  expect(upgraded.bookmarkId).toBeTruthy();
  await migrate(db);
  await bookmark();
  expect((await read()).value.saved.rows).toEqual([upgraded]);
  await new PhoneService(db, 'https://synthetic.invalid').execute('clearMessageBookmarks', {workspaceId:workspace}, viewer);
  await bookmark();
  const recreated = (await read()).value.saved.rows[0]!;
  expect(recreated.bookmarkId).not.toBe(upgraded.bookmarkId);
  expect(recreated.value.messageId).toBe('saved');
});
