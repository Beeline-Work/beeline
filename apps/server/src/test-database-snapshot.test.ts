import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { migratedDatabase, PgliteDatabase } from './test-support.js';

it('clones compressed and raw schemas without sharing mutable state or transaction effects', async () => {
  const original = await migratedDatabase();
  const copies: PgliteDatabase[] = [];
  const workspace = randomUUID();
  try {
    await original.query(`INSERT INTO workspaces(id,name) VALUES($1,'Before snapshot')`, [workspace]);
    const gzip = await original.snapshot();
    const raw = await original.snapshot('none');
    expect([...new Uint8Array(await gzip.slice(0, 2).arrayBuffer())]).toEqual([0x1f, 0x8b]);
    expect([...new Uint8Array(await raw.slice(0, 2).arrayBuffer())]).not.toEqual([0x1f, 0x8b]);
    for (const image of [raw, gzip]) {
      const copy = PgliteDatabase.fromSnapshot(image);
      copies.push(copy);
      await copy.client.waitReady;
      expect((await copy.query(`SELECT name FROM workspaces WHERE id=$1`, [workspace])).rows)
        .toEqual([{ name: 'Before snapshot' }]);
    }
    await copies[0]!.query(`UPDATE workspaces SET name='Changed raw copy' WHERE id=$1`, [workspace]);
    await expect(copies[0]!.transaction(async transaction => {
      await transaction.query(`UPDATE workspaces SET name='Rolled back' WHERE id=$1`, [workspace]);
      throw new Error('rollback proof');
    })).rejects.toThrow('rollback proof');
    expect((await copies[0]!.query(`SELECT name FROM workspaces WHERE id=$1`, [workspace])).rows)
      .toEqual([{ name: 'Changed raw copy' }]);
    for (const database of [original, copies[1]!]) {
      expect((await database.query(`SELECT name FROM workspaces WHERE id=$1`, [workspace])).rows)
        .toEqual([{ name: 'Before snapshot' }]);
    }
    const independent = await migratedDatabase();
    copies.push(independent);
    expect((await independent.query(`SELECT id FROM workspaces WHERE id=$1`, [workspace])).rows).toEqual([]);
  } finally {
    for (const database of [...copies, original]) await database.close();
  }
});
