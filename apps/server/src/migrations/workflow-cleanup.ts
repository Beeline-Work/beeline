import type { SqlDatabase } from '../database.js';

/** Commit a backfill and its marker together; a failed release can retry it. */
export async function workflowBackfillOnce(
  database: SqlDatabase,
  name: string,
  backfill: (db: SqlDatabase) => Promise<unknown>,
): Promise<void> {
  await database.transaction(async (db) => {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`workflow-backfill:${name}`]);
    const completed = await db.query(`SELECT name FROM workflow_backfills WHERE name=$1`, [name]);
    if (completed.rows.length) return;
    await backfill(db);
    await db.query(`INSERT INTO workflow_backfills(name) VALUES($1)`, [name]);
  });
}
