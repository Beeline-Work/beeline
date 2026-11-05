// Vitest global setup: migrates one database per run and shares its snapshot
// file, so each server test database loads the schema instead of migrating
// (see migratedDatabase in src/test-support.ts).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GlobalSetupContext } from 'vitest/node';
import { migrate } from '../src/database.js';
import { PgliteDatabase } from '../src/test-support.js';

export default async function setup({ provide }: GlobalSetupContext) {
  // A coverage map run migrates inside each file so the map records it.
  if (process.env.SERVER_COVERAGE_MAP_DIR) return;
  const directory = await mkdtemp(join(tmpdir(), 'server-test-database-'));
  const template = new PgliteDatabase();
  try {
    await migrate(template);
    // Workers repeatedly clone this local template. Avoid decompressing the
    // same schema for every test database; this is never a published artifact.
    const path = join(directory, 'migrated.tar');
    await writeFile(path, Buffer.from(await (await template.snapshot('none')).arrayBuffer()));
    provide('serverTestDatabaseSnapshot', path);
  } finally {
    await template.close();
  }
  return () => rm(directory, { recursive: true, force: true });
}
