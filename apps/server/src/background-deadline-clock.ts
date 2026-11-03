import type { SqlDatabase } from './database.js';

/** Only a stored future obligation arms a timer. A refused past obligation
 * parks until its source or real recovery changes; failure is never a due row. */
export async function backgroundNextDelay(db: Pick<SqlDatabase, 'query'>, selection: string): Promise<number | undefined> {
  const row = (await db.query<{ delay_ms: number | null }>(`SELECT ceil(extract(epoch FROM (min(due_at)-clock_timestamp()))*1000)::float8 delay_ms
    FROM (${selection}) obligations WHERE due_at>clock_timestamp()`)).rows[0];
  return row?.delay_ms == null ? undefined : Math.max(0, Number(row.delay_ms));
}
