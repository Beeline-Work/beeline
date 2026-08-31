import { PostgresDatabase, measureDatabase, measureDatabaseBreakdown } from './database.js';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const db = new PostgresDatabase(url, 1);
Promise.all([measureDatabase(db), measureDatabaseBreakdown(db)])
  .then(([measurement, breakdown]) => {
    process.stdout.write(`${JSON.stringify({ measurement, breakdown }, null, 2)}\n`);
    if (!measurement.fitsNeonFree) process.exitCode = 2;
  })
  .finally(() => db.close());
