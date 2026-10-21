/** Transaction-exclusive for release migrations; transaction-shared for jobs.
 * Advisory waits do not queue a table lock in front of app traffic. */
export const MIGRATION_JOB_GATE_KEY = 1_904_214_095;

export async function withMigrationJobGate<T>(
  database: { connectDedicated(): Promise<{
    query(sql: string): Promise<unknown>;
    release(destroy?: boolean): void;
  }> },
  work: () => Promise<T>,
): Promise<T> {
  const session = await database.connectDedicated();
  try {
    // Let current jobs finish; the queued exclusive advisory lock stops new
    // shared holders. Table DDL retains its separate one-second lock timeout.
    // Keep the dedicated connection pinned even through a transaction pooler.
    // This transaction owns only the advisory lock, never application tables.
    await session.query('BEGIN');
    await session.query(`SET LOCAL lock_timeout = '360000ms'`);
    await session.query(`SELECT pg_advisory_xact_lock(${MIGRATION_JOB_GATE_KEY})`);
    return await work();
  } finally {
    // Destroy rather than pool a session that might still own the gate.
    session.release(true);
  }
}
