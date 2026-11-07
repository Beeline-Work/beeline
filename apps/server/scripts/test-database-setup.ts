// Vitest global setup: migrates one database per run and shares its snapshot
// file, so each server test database loads the schema instead of migrating
// (see migratedDatabase in src/test-support.ts).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from 'node:inspector/promises';
import type { GlobalSetupContext } from 'vitest/node';
import type { PgliteDatabase } from '../src/test-support.js';

export default async function setup({ provide }: GlobalSetupContext) {
  const directory = await mkdtemp(join(tmpdir(), 'server-test-database-'));
  const coverage = process.env.SERVER_COVERAGE_MAP_DIR ? new Session() : undefined;
  let template: PgliteDatabase | undefined;
  try {
    // Record template dependencies once, before importing the migration modules.
    // Consumers inherit this coverage instead of rerunning the entire migration
    // in their first beforeEach, where its cost races the hook deadline.
    if (coverage) {
      coverage.connect();
      await coverage.post('Profiler.enable');
      await coverage.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
    }
    const { migrate } = await import('../src/database.js');
    const { PgliteDatabase } = await import('../src/test-support.js');
    template = new PgliteDatabase();
    await migrate(template);
    // Workers repeatedly clone this local template. Avoid decompressing the
    // same schema for every test database; this is never a published artifact.
    const path = join(directory, 'migrated.tar');
    await writeFile(path, Buffer.from(await (await template.snapshot('none')).arrayBuffer()));
    provide('serverTestDatabaseSnapshot', path);
    if (coverage) {
      const { result } = await coverage.post('Profiler.takePreciseCoverage');
      const repo = fileURLToPath(new URL('../../../', import.meta.url));
      const scripts = result.filter(script => {
        const path = script.url.startsWith('file://') ? fileURLToPath(script.url) : script.url;
        return path.startsWith(repo) && !path.includes('/node_modules/');
      });
      const path = join(directory, 'migration-coverage.json');
      await writeFile(path, JSON.stringify(scripts));
      provide('serverTestDatabaseSnapshotCoverage', path);
    }
  } finally {
    coverage?.disconnect();
    await template?.close();
  }
  return () => rm(directory, { recursive: true, force: true });
}
