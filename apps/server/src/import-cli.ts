import { readFile } from 'node:fs/promises';
import {
  PostgresDatabase,
  migrate,
  measureDatabase,
  measureDatabaseBreakdown,
} from './database.js';
import {
  SnapshotImporter,
  readOldPostgresSnapshot,
  type LegacyRegistry,
  type MediaManifestEntry,
} from './importer.js';

async function main() {
  const oldUrl = process.env.OLD_DATABASE_URL;
  const targetUrl = process.env.DATABASE_URL;
  const registryFile = process.env.OLD_PUSH_REGISTRY_JSON;
  const mediaFile = process.env.OLD_MEDIA_MANIFEST_JSON;
  if (!oldUrl || !targetUrl || !registryFile || !mediaFile)
    throw new Error(
      'OLD_DATABASE_URL, DATABASE_URL, OLD_PUSH_REGISTRY_JSON, and OLD_MEDIA_MANIFEST_JSON are required',
    );
  const oldDb = new PostgresDatabase(oldUrl, 1);
  const target = new PostgresDatabase(targetUrl, 5);
  try {
    await migrate(target);
    const registry = JSON.parse(await readFile(registryFile, 'utf8')) as LegacyRegistry;
    const media = JSON.parse(await readFile(mediaFile, 'utf8')) as MediaManifestEntry[];
    const snapshot = await readOldPostgresSnapshot(oldDb, registry, media);
    const report = await new SnapshotImporter(target).import(snapshot, process.env.IMPORT_ID);
    const measurement = await measureDatabase(target);
    const breakdown = await measureDatabaseBreakdown(target);
    process.stdout.write(`${JSON.stringify({ report, measurement, breakdown }, null, 2)}\n`);
    if (!measurement.fitsNeonFree) process.exitCode = 2;
  } finally {
    await oldDb.close();
    await target.close();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
