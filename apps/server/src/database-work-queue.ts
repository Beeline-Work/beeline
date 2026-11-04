import { CornerAccessDatabase } from './corner-access-database.js';
import type { SqlDatabase } from './database.js';

const queues = new WeakMap<SqlDatabase, Map<string, Promise<void>>>();

/** Wait for the same command's writer before acquiring a database connection.
 * PostgreSQL still owns cross-machine locks and all authorization checks. */
export async function queueDatabaseWork<T>(database: SqlDatabase, key: string, work: () => Promise<T>): Promise<T> {
  const physical = CornerAccessDatabase.physical(database);
  let entries = queues.get(physical);
  if (!entries) queues.set(physical, entries = new Map());
  const previous = entries.get(key);
  let finish!: () => void;
  const current = new Promise<void>(resolve => { finish = resolve; });
  entries.set(key, current);
  try {
    await previous;
    return await work();
  } finally {
    finish();
    if (entries.get(key) === current) entries.delete(key);
  }
}
