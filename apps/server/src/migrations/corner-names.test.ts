import { afterEach, beforeEach, expect, it } from 'vitest';
import { migrate, migrateData } from '../database.js';
import { PgliteDatabase } from '../test-support.js';

const WORKSPACE = '00000000-0000-4000-8000-000000000001';
const ROOM = '00000000-0000-4000-8000-000000000010';
const OTHER_ROOM = '00000000-0000-4000-8000-000000000020';
const corner = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
const AUTHOR = 'a'.repeat(64);

let database: PgliteDatabase;

beforeEach(async () => {
  database = new PgliteDatabase();
  await migrate(database, { deferData: true });
  await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Author')`, [
    AUTHOR,
  ]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,name) VALUES($2,$1,'beeline'),($3,$1,'other')`,
    [WORKSPACE, ROOM, OTHER_ROOM],
  );
  const rows: [string, string, string, string][] = [
    [corner(1), ROOM, 'fix-ledger', '2026-09-01'],
    [corner(2), ROOM, 'Fix ledger', '2026-09-02'],
    [corner(3), ROOM, 'fix  ledger drift and more words', '2026-09-03'],
    [corner(4), ROOM, 'fix ledger', '2026-09-04'],
    [corner(5), OTHER_ROOM, 'fix ledger', '2026-09-05'],
    [corner(6), ROOM, '   ', '2026-09-06'],
  ];
  for (const [id, parent, name, at] of rows) {
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,name,created_at) VALUES($1,$2,$3,$4,$5)`,
      [id, WORKSPACE, parent, name, at],
    );
  }
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text,card_type,card) VALUES
       ('m1',$1,$2,'','daemon-fact',jsonb_build_object('cornerId',$3::text,'name','Fix ledger')),
       ('m2',$1,$2,'','daemon-fact',jsonb_build_object('cornerId',$3::text,'objective','x'))`,
    [ROOM, AUTHOR, corner(2)],
  );
});

afterEach(async () => {
  await database.close();
});

async function names() {
  const result = await database.query<{ id: string; name: string }>(
    `SELECT id,name FROM rooms WHERE parent_id IS NOT NULL ORDER BY id`,
  );
  return Object.fromEntries(result.rows.map((row) => [row.id, row.name]));
}

it('hyphenates spaced corner names once, with deterministic suffixes per Room', async () => {
  await migrateData(database);
  expect(await names()).toEqual({
    [corner(1)]: 'fix-ledger',
    [corner(2)]: 'Fix-ledger-2',
    [corner(3)]: 'fix-ledger-drift',
    [corner(4)]: 'fix-ledger-3',
    [corner(5)]: 'fix-ledger',
    [corner(6)]: 'corner-00000000',
  });
  const cards = await database.query<{ id: string; card: Record<string, unknown> }>(
    `SELECT id,card FROM messages ORDER BY id`,
  );
  expect(cards.rows.map((row) => row.card.name)).toEqual(['Fix-ledger-2', undefined]);

  await database.query(`UPDATE rooms SET name='spaced again' WHERE id=$1`, [corner(1)]);
  await migrateData(database);
  expect((await names())[corner(1)]).toBe('spaced again');
  console.log('Demonstrated corner-names backfill:', JSON.stringify(await names()));
});
