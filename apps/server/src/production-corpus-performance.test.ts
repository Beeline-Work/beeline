import type { QueryResultRow } from 'pg';
import { expect, it } from 'vitest';
import type { QueryResult, SqlDatabase } from './database.js';
import { explainHotRead } from './production-corpus-performance.js';
import { PgliteDatabase } from './test-support.js';

it('times cached prepared plans after PostgreSQL finishes its automatic plan selection', async () => {
  const database = new PgliteDatabase();
  const plans = new Map<unknown, { generic_plans: number; custom_plans: number }>();
  const measured: SqlDatabase = {
    async query<Row extends QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<Row>> {
      const result = await database.query<Row>(sql, values);
      if (sql.startsWith('EXPLAIN')) {
        const counters = await database.query<{ generic_plans: number; custom_plans: number }>(
          `SELECT generic_plans::int,custom_plans::int FROM pg_prepared_statements
           WHERE name='hot_read_plan_selection'`,
        );
        plans.set(result.rows[0]?.['QUERY PLAN'], counters.rows[0]!);
      }
      return result;
    },
    transaction: (work) => database.transaction(work),
  };
  try {
    const result = await explainHotRead(
      measured, 'corner-facts', 'SELECT $1::integer AS value', [7], 5, 'plan-selection',
    );
    expect(result.samples).toHaveLength(5);
    const sampledPlans = result.samples.map((sample) => plans.get(sample.plan)!);
    // The timed window must reuse a chosen plan, rather than spending its
    // first samples compiling custom plans and its last one compiling generic.
    expect(sampledPlans.every((plan) => plan.custom_plans === 5)).toBe(true);
    expect(sampledPlans.map((plan) => plan.generic_plans)).toEqual([2, 3, 4, 5, 6]);
    expect((await database.query('SHOW plan_cache_mode')).rows).toEqual([{ plan_cache_mode: 'auto' }]);
    expect((await database.query('SELECT 1 FROM pg_prepared_statements')).rowCount).toBe(0);
  } finally {
    await database.close();
  }
});

it('still rejects an unsafe prepared message scan and releases the statement', async () => {
  const database = new PgliteDatabase();
  try {
    await database.query('CREATE TABLE messages(id integer)');
    await expect(explainHotRead(
      database, 'corner-facts', 'SELECT * FROM messages WHERE id=$1', [7], 5, 'unsafe-scan',
    )).rejects.toThrow(/sequential scan over messages/);
    expect((await database.query('SELECT 1 FROM pg_prepared_statements')).rowCount).toBe(0);
  } finally {
    await database.close();
  }
});
