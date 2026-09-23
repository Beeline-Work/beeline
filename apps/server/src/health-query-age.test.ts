import { describe, expect, it } from 'vitest';
import { PostgresDatabase } from './database.js';
import type { Pool } from 'pg';

/**
 * The health check reports `oldestActiveQueryAgeMs` so a stuck query is
 * visible. It used to read `pg_stat_activity` for backends in state 'active',
 * which needs `pg_read_all_stats`; production's app role does not have it, so
 * Postgres blanked `state` on every row, the predicate matched nothing, and the
 * field was permanently null however badly the server was wedged. A monitor
 * that cannot fail is worse than none, so these tests assert it CAN.
 */
function poolStub(gate: Promise<unknown>): Pool {
  return {
    query: async () => {
      await gate;
      return { rows: [], rowCount: 0 };
    },
    connect: async () => {
      throw new Error('not used');
    },
    on: () => undefined,
    totalCount: 1,
    idleCount: 0,
    waitingCount: 0,
  } as unknown as Pool;
}

describe('health query age', () => {
  it('is null when this process has nothing in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const db = new PostgresDatabase('postgres://unused', 1, { pool: poolStub(gate) });
    expect(await db.oldestActiveQueryAgeMs()).toBeNull();
    release();
  });

  it('reports a rising age while a query is stuck, and clears when it finishes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const db = new PostgresDatabase('postgres://unused', 1, { pool: poolStub(gate) });

    const stuck = db.query('SELECT pg_sleep(600)');
    // Let the query reach the pool before measuring.
    await new Promise((r) => setTimeout(r, 25));

    const first = await db.oldestActiveQueryAgeMs();
    expect(first).not.toBeNull();
    expect(first!).toBeGreaterThanOrEqual(20);

    await new Promise((r) => setTimeout(r, 30));
    const second = await db.oldestActiveQueryAgeMs();
    // The whole point: it keeps climbing rather than reading as healthy.
    expect(second!).toBeGreaterThan(first!);

    release();
    await stuck;
    expect(await db.oldestActiveQueryAgeMs()).toBeNull();
  });

  it('reports the OLDEST of several in flight, not the newest', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const db = new PostgresDatabase('postgres://unused', 1, { pool: poolStub(gate) });

    const old = db.query('SELECT 1');
    await new Promise((r) => setTimeout(r, 40));
    const recent = db.query('SELECT 2');
    await new Promise((r) => setTimeout(r, 10));

    expect((await db.oldestActiveQueryAgeMs())!).toBeGreaterThanOrEqual(45);

    release();
    await Promise.all([old, recent]);
  });
});
