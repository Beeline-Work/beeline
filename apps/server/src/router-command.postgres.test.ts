import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PostgresDatabase, type SqlDatabase } from './database.js';
import { RouterCommandLedger, ROUTER_COMMAND_SCHEMA, CommandDigestConflict } from './router-command-ledger.js';

const postgresUrl = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (postgresUrl && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(postgresUrl).hostname))
  throw new Error('command proofs require isolated loopback PostgreSQL');
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
/** PGlite serializes transactions; this optional proof exercises two real
 * PostgreSQL pools competing on the same uncommitted unique identity. */
describe.skipIf(!postgresUrl)('P7 real PostgreSQL competing server instances', () => {
  it('commits one effect under concurrent replay and rejects a conflicting digest', async () => {
    const schema = `command_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: postgresUrl, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const config = { connectionString: postgresUrl, options: `-c search_path=${schema},public`, max: 2 };
    const firstDb = new PostgresDatabase('', 2, { pool: new Pool(config) });
    const secondDb = new PostgresDatabase('', 2, { pool: new Pool(config) });
    try {
      await firstDb.query(ROUTER_COMMAND_SCHEMA);
      await firstDb.query('CREATE TABLE effects(id text PRIMARY KEY)');
      const reached = deferred(), release = deferred(), competing = deferred();
      const observed: SqlDatabase = {
        query: (sql, values) => secondDb.query(sql, values),
        transaction: work => secondDb.transaction(tx => work({
          transaction: nested => tx.transaction(nested),
          query: (sql, values) => {
            const pending = tx.query(sql, values);
            if (sql.includes('INSERT INTO router_commands')) competing.resolve();
            return pending;
          },
        })),
      };
      const first = new RouterCommandLedger(firstDb), second = new RouterCommandLedger(observed);
      const key = { principal: 'reader', operation: 'create', commandId: 'same-intent' };
      const firstEffect = vi.fn(async (tx: SqlDatabase) => {
        await tx.query("INSERT INTO effects VALUES('one')");
        reached.resolve(); await release.promise;
        return { effectId: 'one' };
      });
      const secondEffect = vi.fn(async () => ({ effectId: 'unexpected' }));
      const original = first.atomic(key, { target: 'one' }, firstEffect);
      await reached.promise;
      const replay = second.atomic(key, { target: 'one' }, secondEffect);
      await competing.promise;
      release.resolve();
      const receipts = await Promise.all([original, replay]);
      expect(receipts[0]).toEqual(receipts[1]);
      expect(secondEffect).not.toHaveBeenCalled();
      expect((await secondDb.query('SELECT * FROM effects')).rows).toEqual([{ id: 'one' }]);
      await expect(second.atomic(key, { target: 'different' }, secondEffect)).rejects.toBeInstanceOf(CommandDigestConflict);
      expect(secondEffect).not.toHaveBeenCalled();
    } finally {
      await Promise.all([firstDb.close(), secondDb.close()]);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
});
