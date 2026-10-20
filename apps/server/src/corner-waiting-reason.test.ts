import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cornerBlockerSql, cornerRowState, chatCornerCounts } from './chat-corner-counts.js';

const db = new PGlite();
beforeAll(async () => {
  await db.exec(`CREATE TABLE rooms(id text,parent_id text);
    CREATE TABLE messages(id text,card_type text);
    CREATE TABLE memberships(room_id text,identity_id text,removed_at timestamp);
    CREATE TABLE effective_memberships(room_id text,identity_id text,removed_at timestamp);
    CREATE TABLE identities(id text,kind text);
    CREATE TABLE corner_owed(corner_id text,message_id text,person_id text,created_at timestamp,blocking boolean,expires_at timestamp);
    CREATE TABLE corner_report_blockers(corner_id text,message_id text,report_id text,person_id text,created_at timestamp);
    CREATE TABLE corner_merge_holds(corner_id text,id text,actor_id text,set_at timestamp,released_at timestamp);
    INSERT INTO rooms VALUES('corner','room');
    INSERT INTO memberships VALUES('room','person',NULL);`);
});
afterAll(() => db.close());

it.each([
  ['squire-approval', 'approve'], ['permission', 'approve'], ['grant-request', 'approve'],
  ['connector-offer', 'connect'], ['app-sign-in', 'connect'], ['agent-sign-in', 'connect'],
  ['choice', 'question'], ['needs-decision:', 'question'], ['blocked:', 'question'],
])('R1: projects %s as waiting to %s from the indexed blocker', async (kind, reason) => {
  await db.exec('DELETE FROM corner_owed; DELETE FROM messages;');
  await db.query('INSERT INTO messages VALUES($1,$2)', ['item', kind]);
  await db.exec("INSERT INTO corner_owed VALUES('corner','item','person',now(),true,NULL)");
  const result = await db.query<{ item_id: string; reason: 'approve' | 'connect' | 'question' }>(
    `SELECT blocker.* FROM rooms c ${cornerBlockerSql()}`,
  );
  const blocker = result.rows[0]!;
  const row = { id: 'corner', name: 'Corner', parent_id: 'room', archived_at: null,
    lifecycle: null, latest_turn_status: null, blocking: true,
    waiting_item_id: blocker.item_id, waiting_reason: blocker.reason };
  expect(cornerRowState(row)).toEqual({ state: 'waiting', reason, itemId: 'item' });
  expect(chatCornerCounts([row]).get('room')?.openCorners[0]?.state).toBe('waiting');
});

it('R1: chooses the oldest blocker deterministically', async () => {
  await db.exec(`DELETE FROM corner_owed; DELETE FROM messages;
    INSERT INTO messages VALUES('older','permission'),('newer','connector-offer');
    INSERT INTO corner_owed VALUES('corner','older','person','2026-01-01',true,NULL),
      ('corner','newer','person','2026-01-02',true,NULL);`);
  const result = await db.query(`SELECT blocker.* FROM rooms c ${cornerBlockerSql()}`);
  expect(result.rows[0]).toMatchObject({ item_id: 'older', reason: 'approve' });
});

it.each(['done:', 'failed:', 'unreachable', 'addressed message'])(
  'R1: %s alone stays idle even when owed', () => {
    expect(cornerRowState({ archived_at: null, lifecycle: null, latest_turn_status: null,
      blocking: false, owed: true })).toEqual({ state: 'idle' });
  },
);
