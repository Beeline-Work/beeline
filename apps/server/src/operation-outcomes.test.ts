import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TokenAuth } from './auth.js';
import { BackgroundJobRunner } from './background.js';
import type { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { OPERATION_REFUSALS_SQL, OperationOutcomes, startOperationOutcomeFlush } from './operation-outcomes.js';
import * as phoneOperations from './phone-operations.js';
import { PhoneService } from './phone-service.js';
import { phoneSocketRequests } from './phone-socket.js';
import { createBeelineServer } from './server.js';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';

let db: PgliteDatabase;
beforeEach(async () => { db = await migratedDatabase(); });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await db.close(); });

function counts() {
  return db.query(`SELECT hour,op,status,code,release,count::int FROM operation_outcomes_hourly ORDER BY hour,release,op,status`);
}

it('C3 counts refusals and successes from the real socket handler without binding a port', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const outcomes = new OperationOutcomes('transport-test');
  const viewer = 'a'.repeat(64), room = '11111111-1111-4111-8111-111111111111';
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Viewer')`, [viewer]);
  const live = new LiveHub();
  const dispatcher = vi.spyOn(phoneOperations, 'createPhoneOperationDispatcher');
  const server = createBeelineServer({ database: db, operationOutcomes: outcomes, live,
    phone: new PhoneService(db, 'http://fixture.test', undefined, undefined, live),
    auth: { authenticatePhone: async () => viewer } as unknown as TokenAuth,
    daemon: {} as DaemonService, mediaMaximumBytes: 1,
  });
  const dispatch = dispatcher.mock.results[0]!.value as phoneOperations.PhoneOperationDispatcher;
  const client = Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1 });
  let reply!: (frame: string) => void;
  const accept = phoneSocketRequests(client as unknown as WebSocket, viewer, dispatch,
    frame => reply(frame), () => 403);
  let requestId = 0;
  async function socket(op: string, args: object) {
    return new Promise<unknown>(resolve => {
      reply = frame => resolve(JSON.parse(frame));
      accept({ t: 'req', id: String(++requestId), op, args });
    });
  }
  try {
    expect(await socket('listRoomWorkflowRuns', { roomId: room }))
      .toMatchObject({ok:false,error:{code:'access_denied'}});
    expect(await socket('listRoomWorkflowRuns', { roomId: room }))
      .toMatchObject({ ok: false, error: { code: 'access_denied', retryable: false } });
    expect(await socket('readWorkspaces', {})).toMatchObject({ok:true});
    expect(await socket('readWorkspaces', {})).toMatchObject({ ok: true });
    expect((await counts()).rows).toEqual([]);
    await outcomes.flush(db);
    expect((await counts()).rows).toEqual([
      expect.objectContaining({ op: 'listRoomWorkflowRuns', status: 403, code: 'Error', count: 2 }),
      expect.objectContaining({ op: 'readWorkspaces', status: 200, code: '', count: 2 }),
    ]);
  } finally {
    client.emit('close');
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('C3 upserts and accumulates by UTC hour, operation, status, code and server release', async () => {
  const hour = new Date().setUTCMinutes(0, 0, 0);
  let now = hour;
  const outcomes = new OperationOutcomes('release-a', () => now);
  outcomes.record('readRoom', 200, '');
  outcomes.record('readRoom', 403, 'ExpectedRefusalError');
  outcomes.record('readRoom', 403, 'ExpectedRefusalError');
  await outcomes.flush(db);
  outcomes.record('readRoom', 403, 'ExpectedRefusalError');
  await outcomes.flush(db);
  await outcomes.flush(db); // An empty flush must never replay a batch.
  const nextRelease = new OperationOutcomes('release-b', () => now);
  nextRelease.record('readRoom', 403, 'ExpectedRefusalError');
  await nextRelease.flush(db);
  now += 3_600_000;
  outcomes.record('readRoom', 404, 'not_found');
  await outcomes.flush(db);
  expect((await counts()).rows).toEqual([
    { hour: new Date(hour), op: 'readRoom', status: 200, code: '', release: 'release-a', count: 1 },
    { hour: new Date(hour), op: 'readRoom', status: 403, code: 'ExpectedRefusalError', release: 'release-a', count: 3 },
    { hour: new Date(hour), op: 'readRoom', status: 403, code: 'ExpectedRefusalError', release: 'release-b', count: 1 },
    { hour: new Date(now), op: 'readRoom', status: 404, code: 'not_found', release: 'release-a', count: 1 },
  ]);
});

it('C3 deletes only expired rows, in bounded retention batches even without requests', async () => {
  await db.query(`INSERT INTO operation_outcomes_hourly
    SELECT now()-interval '15 days','op'||n,403,'Error','old',1 FROM generate_series(1,2001) n`);
  await db.query(`INSERT INTO operation_outcomes_hourly VALUES(now()-interval '13 days','readRoom',200,'','recent',1)`);
  const outcomes = new OperationOutcomes('');
  await outcomes.flush(db);
  expect((await db.query(`SELECT count(*)::int AS n FROM operation_outcomes_hourly WHERE release='old'`)).rows)
    .toEqual([{ n: 1 }]);
  await outcomes.flush(db);
  expect((await counts()).rows).toEqual([expect.objectContaining({ release: 'recent', count: 1 })]);
});

it('C3 bounds keys and folds excess cardinality by status across hours and failed flushes', async () => {
  let now = new Date().setUTCMinutes(0, 0, 0);
  const outcomes = new OperationOutcomes('', () => now);
  for (let i = 0; i < 5000; i++) outcomes.record(`operation${i}`, 403, `code${i}`);
  outcomes.record('operation0', 403, 'code0');
  now += 3_600_000;
  for (let i = 0; i < 100; i++) outcomes.record(`newOperation${i}`, 429, 'other_code');
  outcomes.record('overflowSuccess', 200, '');
  for (let status = 100; status <= 599; status++) outcomes.record(`overflow${status}`, status, 'code');
  const query = vi.spyOn(db, 'query');
  query.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(outcomes.flush(db)).rejects.toThrow('database unavailable');
  await outcomes.flush(db);
  const rows = (await counts()).rows;
  expect(rows).toHaveLength(2000);
  expect(rows.find(row => row.op === 'operation0')).toMatchObject({ count: 2 });
  const overflow = rows.filter(row => row.op === '(other)');
  expect(overflow).toHaveLength(500);
  expect(overflow.find(row => row.status === 403)).toMatchObject({ code: 'overflow', count: 3501 });
  expect(overflow.find(row => row.status === 200)).toMatchObject({ code: 'overflow', count: 2 });
  expect(overflow.find(row => row.status === 429)).toMatchObject({ code: 'overflow', count: 101 });
  expect(rows.reduce((total, row) => total + row.count, 0)).toBe(5602);
  expect(query.mock.calls.filter(([sql]) => sql.startsWith('INSERT')).every(([, values]) =>
    JSON.parse(values![0] as string).length <= 100)).toBe(true);
});

it('C3 retains arrivals during a flush, serializes flushes and retries only uncommitted batches', async () => {
  const outcomes = new OperationOutcomes('');
  for (let i = 0; i < 101; i++) outcomes.record(`op${i}`, 403, 'Error');
  const actualQuery = db.query.bind(db);
  let entered!: () => void, resume!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { resume = resolve; });
  let inserts = 0;
  vi.spyOn(db, 'query').mockImplementation(async (sql, values) => {
    if (sql.startsWith('INSERT')) {
      if (++inserts === 1) { entered(); await held; }
      else if (inserts === 2) throw new Error('second batch failed');
    }
    return actualQuery(sql, values);
  });
  const first = outcomes.flush(db);
  await started;
  expect(outcomes.flush(db)).toBe(first);
  outcomes.record('op0', 403, 'Error');
  resume();
  await expect(first).rejects.toThrow('second batch failed');
  await outcomes.flush(db);
  const rows = (await counts()).rows;
  expect(rows).toHaveLength(101);
  expect(rows.find(row => row.op === 'op0')).toMatchObject({ count: 2 });
  expect(rows.reduce((total, row) => total + row.count, 0)).toBe(102);
});

it('C3 uses an empty release when unset and stores short codes rather than error messages', async () => {
  vi.stubEnv('BEELINE_RELEASE_SHA', undefined);
  const outcomes = new OperationOutcomes();
  outcomes.record('readRoom', 403, 'a long error message with details');
  await outcomes.flush(db);
  expect((await counts()).rows).toEqual([expect.objectContaining({ code: 'Error', release: '' })]);
});

it('C3 arms one pending-count deadline per instance and drains admitted work on shutdown', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const runner = new BackgroundJobRunner();
  const first = new OperationOutcomes('first'), second = new OperationOutcomes('second');
  // No leader acquisition: both instances must independently persist their local counts.
  const stopFirst = startOperationOutcomeFlush(db, first, runner);
  const stopSecond = startOperationOutcomeFlush(db, second, runner);
  await Promise.all([first.flush(db), second.flush(db)]);
  first.record('readRoom', 200, ''); second.record('readRoom', 403, 'Error');
  await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
  expect((await counts()).rows).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  await Promise.all([stopFirst(), stopSecond()]);
  expect((await counts()).rows).toEqual([
    expect.objectContaining({ release: 'first', status: 200, count: 1 }),
    expect.objectContaining({ release: 'second', status: 403, count: 1 }),
  ]);
  expect(runner.snapshot()['operation-outcomes']).toMatchObject({ consecutiveFailures: 0, lastSuccessAt: expect.any(Number) });
  first.record('readRoom', 200, '');
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect((await counts()).rows[0]!.count).toBe(1);
});

it('C3 compares refusal counts and rates with exposed historical days for the same release', async () => {
  await db.query(`INSERT INTO operation_outcomes_hourly
    SELECT date_trunc('hour',now())-interval '1 hour'-day*interval '1 day',
      'readRoom',200,'','released',100 FROM generate_series(0,7) day`);
  await db.query(`INSERT INTO operation_outcomes_hourly
    SELECT date_trunc('hour',now())-interval '1 hour'-day*interval '1 day',
      'readRoom',403,'Error','released',CASE WHEN day=0 THEN 10 ELSE day END
    FROM generate_series(0,7) day WHERE day<>1`);
  await db.query(`INSERT INTO operation_outcomes_hourly VALUES
    (date_trunc('hour',now())-interval '1 hour','readRoom',403,'Error','new-release',2),
    (date_trunc('hour',now()),'readRoom',403,'Error','released',999),
    (date_trunc('hour',now())-interval '1 hour','(other)',403,'overflow','released',999)`);
  const rows = (await db.query(OPERATION_REFUSALS_SQL)).rows;
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ op: 'readRoom', release: 'released', baseline_days: 7, median_daily_refused: 4 });
  expect(Number(rows[0]!.calls)).toBe(110);
  expect(Number(rows[0]!.refused)).toBe(10);
  expect(Number(rows[0]!.refusal_rate)).toBeCloseTo(10 / 110);
  expect(Number(rows[0]!.median_refusal_rate)).toBeCloseTo(4 / 104);
  expect(rows[1]).toMatchObject({ release: 'new-release', baseline_days: 0, median_daily_refused: null, median_refusal_rate: null });
});


it('an empty outcome owner performs no repeated database work during an idle day', async () => {
  vi.useFakeTimers();
  const query = vi.spyOn(db, 'query');
  const stop = startOperationOutcomeFlush(db, new OperationOutcomes('idle'), new BackgroundJobRunner());
  await db.query('SELECT 1'); await vi.advanceTimersByTimeAsync(0);
  query.mockClear();
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
  expect(query).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  await stop();
});

it('failed outcome persistence parks until a genuinely new outcome supplies work', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
  const outcomes = new OperationOutcomes('parked');
  const stop = startOperationOutcomeFlush(db, outcomes, new BackgroundJobRunner());
  await db.query('SELECT 1'); await vi.advanceTimersByTimeAsync(0);
  const query = vi.spyOn(db, 'query'); query.mockRejectedValueOnce(new Error('synthetic database failure'));
  outcomes.record('readRoom', 200, '');
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  const attempts = query.mock.calls.length;
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
  expect(query).toHaveBeenCalledTimes(attempts);
  expect(vi.getTimerCount()).toBe(0);
  outcomes.record('readRoom', 403, 'denied');
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  await stop();
  expect((await counts()).rows.reduce((sum, row) => sum + Number(row.count), 0)).toBe(2);
});


it('durable expired outcome rows drain in bounded batches and the empty owner then parks', async () => {
  await db.query(`INSERT INTO operation_outcomes_hourly
    SELECT now()-interval '15 days','expired'||n,403,'Error','old',1 FROM generate_series(1,2001) n`);
  vi.useFakeTimers();
  const query = vi.spyOn(db, 'query');
  const stop = startOperationOutcomeFlush(db, new OperationOutcomes('expiry'), new BackgroundJobRunner());
  await db.query('SELECT 1'); await vi.advanceTimersByTimeAsync(60_000);
  expect((await counts()).rows).toEqual([]);
  expect(query.mock.calls.filter(([sql]) => sql.startsWith('DELETE'))).toHaveLength(2);
  query.mockClear();
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
  expect(query).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  await stop();
});
