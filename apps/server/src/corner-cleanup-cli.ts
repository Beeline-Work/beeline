import { assertSchemaCurrent, PostgresDatabase } from './database.js';
import { backfillArchivedCornerCleanup } from './corner-cleanup-backfill.js';

// Deliberately separate from release migrations: old serving workers must be gone before enqueueing history.
const apply = process.argv.includes('--apply');
if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('Usage: corner-cleanup-cli.ts [--apply]');
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL is required');
const database = new PostgresDatabase(url, 1, { mode: 'migration' });
try {
  await assertSchemaCurrent(database);
  if (apply) await backfillArchivedCornerCleanup(database);
  const counts = await database.query(`SELECT count(*) archived,
    count(*) FILTER (WHERE job.corner_id IS NULL) missing,
    count(*) FILTER (WHERE job.finished_at IS NULL AND job.corner_id IS NOT NULL) pending,
    count(*) FILTER (WHERE job.finished_at IS NOT NULL AND job.last_error IS NULL) deleted_or_already_absent,
    count(*) FILTER (WHERE job.last_error IS NOT NULL) kept_with_reason
    FROM rooms corner JOIN corner_facts fact ON fact.corner_id=corner.id
    LEFT JOIN corner_branch_deletions job ON job.corner_id=corner.id
    WHERE corner.archived_at IS NOT NULL AND fact.feature_branch IS NOT NULL`);
  const kept = await database.query(`SELECT corner_id,branch,last_error reason,finished_at,next_attempt_at
    FROM corner_branch_deletions WHERE last_error IS NOT NULL ORDER BY corner_id`);
  console.log(JSON.stringify({ applied: apply, counts: counts.rows[0], kept: kept.rows }, null, 2));
} finally {
  await database.close();
}
