import { PostgresDatabase } from './database.js';
import { readServiceReviewPage, reserveServiceReviewWorkspaces } from './service-review.js';

// Run only through the operator's granted database command. Never put raw
// content from this private output in public findings, issues or pull requests.
const [action, workspaceId, after] = process.argv.slice(2);
if (!process.env.DATABASE_URL) throw new Error('The granted database connection is required');
const database = new PostgresDatabase(process.env.DATABASE_URL, 1);
try {
  if (action === 'reserve') {
    console.log(JSON.stringify(await reserveServiceReviewWorkspaces(database)));
  } else if (action === 'read' && workspaceId) {
    const page = await readServiceReviewPage(database, workspaceId, after);
    console.log(JSON.stringify({ messages: page.rows, next: page.rows.at(-1)?.id ?? null }));
  } else {
    throw new Error('Usage: service-review-cli reserve | read <workspaceId> [afterId]');
  }
} finally {
  await database.close();
}
