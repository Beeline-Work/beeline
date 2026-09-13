import { AuthStore, type TransactionalDatabase } from '@beeline/auth/store';
import { markSchemaCurrent, migrate, PostgresDatabase } from './database.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the release migration step`);
  return value;
}

async function main(): Promise<void> {
  const database = new PostgresDatabase(required('MIGRATION_DATABASE_URL'), 1);
  try {
    await migrate(database);
    await new AuthStore(database as unknown as TransactionalDatabase).migrate();
    // This is deliberately last: boot may proceed only after both schema owners
    // and every data backfill completed successfully.
    await markSchemaCurrent(database);
    console.log('[migration] server and auth schemas are current');
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  console.error('[migration] failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
