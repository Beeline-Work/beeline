import { expect, it } from 'vitest';
import { CornerAccessDatabase, CornerAccessStatement } from './corner-access-database.js';
import type { SqlDatabase } from './database.js';

it('resolves only membership read relations while preserving writes, literals and parameters', async () => {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const raw: SqlDatabase = {
    query: async (sql, values) => { calls.push({ sql, values }); return { rows: [], rowCount: 0 }; },
    transaction: work => work(raw),
  };
  const database = new CornerAccessDatabase(raw);
  const values = ['FROM memberships'];
  await database.transaction(db => db.query(
    `WITH allowed AS (SELECT 1 FROM memberships member WHERE member.identity_id=$1)
     INSERT INTO messages(id,text) SELECT 'proof','FROM memberships' FROM allowed`, values));
  expect(calls[0]!.sql).toContain('FROM effective_memberships member');
  expect(calls[0]!.sql).toContain("'FROM memberships'");
  expect(calls[0]!.values).toBe(values);
  expect(new CornerAccessStatement('DELETE FROM memberships WHERE identity_id=$1').sql)
    .toBe('DELETE FROM memberships WHERE identity_id=$1');
  expect(new CornerAccessStatement('INSERT INTO memberships(room_id) VALUES($1) ON CONFLICT DO NOTHING').sql)
    .toBe('INSERT INTO memberships(room_id) VALUES($1) ON CONFLICT DO NOTHING');
});

it('keeps row locks physical and resolves their inherited parent key', () => {
  const sql = new CornerAccessStatement(
    'SELECT member.* FROM memberships member WHERE member.room_id=$1 FOR SHARE OF member',
  ).sql;
  expect(sql).toContain('FROM memberships member');
  expect(sql).toContain('member.room_id=(SELECT COALESCE(parent_id,id) FROM rooms WHERE id=$1)');
  expect(sql).toContain('FOR SHARE OF member');
});

it('keeps parent-only mention projections on the physical roster', () => {
  const sql = new CornerAccessStatement(`SELECT tagged_member.identity_id FROM memberships tagged_member
    WHERE tagged_member.room_id=message.room_id AND NOT EXISTS(
      SELECT 1 FROM memberships rival_member WHERE rival_member.room_id=tagged_member.room_id)`).sql;
  expect(sql).toContain('FROM memberships tagged_member');
  expect(sql).toContain('FROM memberships rival_member');
  expect(sql).toContain('WHERE id=message.room_id');
});
