import { expect, it } from 'vitest';
import { PgliteDatabase } from './test-support.js';

it('finishes a deferred observer across successive queries before closing its database', async () => {
  const database = new PgliteDatabase();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const firstQuery = new Promise<void>(resolve => { started = resolve; });
  const values: number[] = [];
  database.backgroundWork.run(async () => {
    values.push(Number((await database.query('SELECT 1 AS value')).rows[0]!.value));
    started();
    await held;
    values.push(Number((await database.query('SELECT 2 AS value')).rows[0]!.value));
  });
  await firstQuery;
  let closed = false;
  const closing = database.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  expect(closed).toBe(false);
  release();
  await closing;
  expect(values).toEqual([1, 2]);
  expect(closed).toBe(true);
});
