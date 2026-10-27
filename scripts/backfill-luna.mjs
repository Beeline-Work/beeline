import { PostgresDatabase } from '../apps/server/dist/database.js';
import { freeAgentConfigFromEnv, LUNA_BACKFILL_HELLO_APPROVED } from '../apps/server/dist/free-agents.js';
import { backfillLuna } from '../apps/server/dist/luna-backfill.js';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--apply')) throw new Error('Usage: node scripts/backfill-luna.mjs [--apply]');
const apply = args.includes('--apply');
if (apply && !LUNA_BACKFILL_HELLO_APPROVED) throw new Error('Luna intro text pending owner approval; --apply is disabled');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const db = new PostgresDatabase(process.env.DATABASE_URL, 1);
try {
  // Enforce a read-only transaction for the default production inventory.
  const run = tx => backfillLuna(tx, freeAgentConfigFromEnv(process.env, process.env.PUBLIC_ORIGIN ?? 'https://relay.buzzrouter.com'), {
    apply,
  });
  const results = apply ? await run(db) : await db.transaction(async tx => {
    await tx.query('SET TRANSACTION READ ONLY');
    return run(tx);
  });
  console.log(apply ? 'Applied Luna backfill' : 'DRY RUN: no writes; --apply requires approval of this list after release');
  console.table(results);
} finally { await db.close(); }
