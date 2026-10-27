import { PostgresDatabase } from '../apps/server/dist/database.js';
import { freeAgentConfigFromEnv } from '../apps/server/dist/free-agents.js';
import { backfillLuna } from '../apps/server/dist/luna-backfill.js';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--apply')) throw new Error('Usage: node scripts/backfill-luna.mjs [--apply]');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const apply = args.includes('--apply');
const db = new PostgresDatabase(process.env.DATABASE_URL, 1);
try {
  // Enforce a read-only transaction for the default production inventory.
  const run = tx => backfillLuna(tx, freeAgentConfigFromEnv(process.env, process.env.PUBLIC_ORIGIN ?? 'https://relay.buzzrouter.com'), {
    apply, intro: () => { throw new Error('Luna intro wording is awaiting confirmation'); },
  });
  const results = apply ? await run(db) : await db.transaction(async tx => {
    await tx.query('SET TRANSACTION READ ONLY');
    return run(tx);
  });
  console.log(apply ? 'Applied Luna backfill' : 'DRY RUN: no writes; --apply requires approval of this list after release');
  console.table(results);
} finally { await db.close(); }
