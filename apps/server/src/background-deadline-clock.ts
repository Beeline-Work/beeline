import type { SqlDatabase } from './database.js';

export async function backgroundDatabaseNow(db:Pick<SqlDatabase,'query'>):Promise<Date>{
  return (await db.query<{now:Date}>('SELECT clock_timestamp() now')).rows[0]!.now;
}
export async function backgroundDatabaseCut(db:Pick<SqlDatabase,'query'>):Promise<string>{
  return (await db.query<{stamp:string}>('SELECT clock_timestamp()::text stamp')).rows[0]!.stamp;
}

/** Only a stored future obligation arms a timer. A refused past obligation
 * parks until its source or real recovery changes; failure is never a due row. */
export async function backgroundNextDelay(db: Pick<SqlDatabase, 'query'>, selection: string, admittedAt?:string): Promise<number | undefined> {
  const row = (await db.query<{ delay_ms: number | null }>(`SELECT ceil(extract(epoch FROM (min(due_at)-clock_timestamp()))*1000)::float8 delay_ms
    FROM (${selection}) obligations WHERE due_at>COALESCE($1::timestamptz,clock_timestamp())`,[admittedAt??null])).rows[0];
  if(row?.delay_ms == null)return;
  const delay=Number(row.delay_ms);if(!Number.isFinite(delay))throw new Error('Invalid stored background deadline');
  return Math.max(0,delay);
}
