import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { BackgroundJobRunner } from './background.js';
import { PostgresDatabase } from './database.js';
import { flushOperatorSystemDms } from './operator-system-dm.js';
import { captureServerError } from './sentry.js';

vi.mock('./sentry.js', () => ({ captureServerError: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), release: vi.fn(),
  });
  const connect = vi.fn().mockResolvedValue(client);
  const pool = { connect, on: vi.fn(), end: vi.fn() } as unknown as Pool;
  const database = new PostgresDatabase('', 1, { pool, pause: async () => {} });
  const failCheckout = () => {
    for (let i = 0; i < 4; i++) connect.mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'));
  };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(captureServerError).mockClear();
  return { database, client, failCheckout, runner: new BackgroundJobRunner() };
}

it('R-SENTRY-CONNECT: defers one failed operator checkout and recovers on the next leader loop', async () => {
  const { database, client, failCheckout, runner } = fixture();
  const run = () => runner.run('operator-system-dms', () => flushOperatorSystemDms(database));
  failCheckout();
  expect(await run()).toEqual({ ok: false });
  expect(client.query).not.toHaveBeenCalled();
  expect(captureServerError).not.toHaveBeenCalled();
  expect(console.warn).toHaveBeenCalledOnce();
  expect(await run()).toEqual({ ok: true, value: 0 });
  expect(client.query).toHaveBeenCalledWith('COMMIT');
  expect(runner.snapshot()['operator-system-dms']?.consecutiveFailures).toBe(0);
  failCheckout();
  await run();
  expect(captureServerError).not.toHaveBeenCalled();
});

it('R-SENTRY-CONNECT: reports continuing operator checkout failures and other affected jobs', async () => {
  const { database, failCheckout, runner } = fixture();
  failCheckout();
  failCheckout();
  await runner.run('operator-system-dms', () => flushOperatorSystemDms(database));
  await runner.run('operator-system-dms', () => flushOperatorSystemDms(database));
  expect(captureServerError).toHaveBeenCalledOnce();
  expect(captureServerError).toHaveBeenLastCalledWith(expect.any(Error), { background_job: 'operator-system-dms' });
  failCheckout();
  await runner.run('push', () => database.transaction(async () => {}));
  expect(captureServerError).toHaveBeenCalledTimes(2);
});

it('R-SENTRY-CONNECT: reports failures after BEGIN immediately, even with a connection error message', async () => {
  const { database, runner } = fixture();
  await runner.run('operator-system-dms', () => database.transaction(async () => {
    throw new Error('Connection terminated unexpectedly');
  }));
  expect(captureServerError).toHaveBeenCalledOnce();
});

it('R-SENTRY-DEADLINE: identifies the transaction caller while destroying the expired connection', async () => {
  const { client } = fixture();
  const pool = { connect: async () => client, on: vi.fn(), end: vi.fn() } as unknown as Pool;
  const database = new PostgresDatabase('', 1, { pool, transactionDeadlineMs: 10 });
  async function overrunTransaction() {
    return database.transaction(async () => new Promise(() => {}));
  }
  const error = await overrunTransaction().catch((cause: unknown) => cause) as Error;
  expect(error.message).toBe('database transaction deadline exceeded');
  expect(error.stack).toContain('overrunTransaction');
  expect(error.stack).not.toContain('Timeout.');
  expect(client.release).toHaveBeenCalledWith(error);
  expect(database.transactionDeadlineCount()).toBe(1);
  expect(database.oldestActiveTransactionAgeMs()).toBeNull();
});
