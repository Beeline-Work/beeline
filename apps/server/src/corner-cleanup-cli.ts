import { GitHubAppClient } from '@beeline/auth/github';
import { assertSchemaCurrent, PostgresDatabase } from './database.js';
import { backfillArchivedCornerCleanup } from './corner-cleanup-backfill.js';
import { cornerFeatureBranchSql } from './corner-branch.js';

const apply = process.argv.includes('--apply');
if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('Usage: corner-cleanup-cli.ts [--apply]');
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL is required');
const database = new PostgresDatabase(url, 1, { mode: 'migration' });
try {
  await assertSchemaCurrent(database);
  if (apply) {
    const { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_APP_SLUG: slug } = process.env;
    if (!appId || !privateKey || !slug) throw new Error('GitHub App configuration is required for --apply');
    const results = await backfillArchivedCornerCleanup(database, new GitHubAppClient({ appId, privateKey, slug }));
    console.log(JSON.stringify({ applied: true, results }, null, 2));
  } else {
    const corners = await database.query(`SELECT corner.id corner_id,${cornerFeatureBranchSql('corner')} branch
      FROM rooms corner JOIN corner_facts fact ON fact.corner_id=corner.id
      WHERE corner.parent_id IS NOT NULL AND corner.archived_at IS NOT NULL ORDER BY corner.id`);
    console.log(JSON.stringify({ applied: false, archived: corners.rowCount, corners: corners.rows }, null, 2));
  }
} finally {
  await database.close();
}
