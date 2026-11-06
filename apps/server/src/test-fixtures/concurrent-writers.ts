import type { QueryResultRow } from 'pg';
import type { SqlDatabase } from '../database.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve=done; });
  return {promise,resolve};
}

/** Overlap two real transactions at their mutation, with no sleeps or polling. */
export async function concurrentWriters<T>(first: SqlDatabase, second: SqlDatabase, run: (db: SqlDatabase) => Promise<T>, claim: string): Promise<T[]> {
  const held = deferred(), release = deferred(), contending = deferred();
  let sqlClaimed = false;
  const wrap = (db: SqlDatabase, owner: boolean): SqlDatabase => ({
    ...db,
    query: async <Row extends QueryResultRow>(sql: string, values?: unknown[]) => {
      if (!owner && sql.includes(claim)) contending.resolve();
      const result = await db.query<Row>(sql, values);
      if (owner && sql.includes(claim)) { sqlClaimed = true; held.resolve(); }
      return result;
    },
    transaction: work => db.transaction(async tx => {
      const result = await work(wrap(tx, owner));
      if (owner && sqlClaimed) await release.promise;
      return result;
    }),
  });
  // Each test's first claimed transaction is held; earlier discovery
  // transactions (curator availability) must still commit normally.
  const a = run(wrap(first, true));
  try {
    await Promise.race([held.promise,a.then(()=>{ throw new Error("Claim was not executed"); })]);
    const b = run(wrap(second, false));
    try { await Promise.race([contending.promise,b.then(()=>undefined)]); }
    finally { release.resolve(); }
    return await Promise.all([a, b]);
  } finally { release.resolve(); }
}

