import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';

// The storage registry (`storage` in architecture/invariants.json) must match
// the schema the real migrations build: every table, column and jsonb column.
// scripts/check-architecture.mjs checks writers, readers and jsonb keys.
const registry = JSON.parse(readFileSync(new URL('../../../architecture/invariants.json', import.meta.url), 'utf8')) as {
  storage: { tables: Record<string, { columns: Record<string, string> }>; jsonb: Record<string, Record<string, string>> };
};
const HOW = 'Register it in architecture/invariants.json under storage.tables (owner module and a one-line reason it cannot be derived), or derive it instead of storing it.';

let db: PgliteDatabase;
let schema: { table_name: string; column_name: string; data_type: string }[];
beforeAll(async () => {
  db = await migratedDatabase();
  schema = (await db.query<{ table_name: string; column_name: string; data_type: string }>(
    `SELECT c.table_name,c.column_name,c.data_type FROM information_schema.columns c
     JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name AND t.table_type='BASE TABLE'
     WHERE c.table_schema='public' ORDER BY c.table_name,c.ordinal_position`)).rows;
}, 120_000);
afterAll(async () => { await db.close(); });

describe('storage registry', () => {
  it('registers every table and column the migrations create, and nothing else', () => {
    const live = schema.map(row => `${row.table_name}.${row.column_name}`);
    const registered = Object.entries(registry.storage.tables)
      .flatMap(([table, entry]) => Object.keys(entry.columns).map(column => `${table}.${column}`));
    const unregistered = live.filter(column => !registered.includes(column));
    const gone = registered.filter(column => !live.includes(column));
    expect(unregistered, `Unregistered storage. ${HOW}`).toEqual([]);
    expect(gone, 'Registered storage the schema no longer has. Remove these entries from architecture/invariants.json.').toEqual([]);
  });

  it('lists every jsonb column, so the keys read from it are registered', () => {
    const live = [...new Set(schema.filter(row => row.data_type === 'jsonb').map(row => row.column_name))].sort();
    expect(Object.keys(registry.storage.jsonb).sort(),
      'Each jsonb column needs an entry under storage.jsonb in architecture/invariants.json listing the keys it holds.').toEqual(live);
  });
});
