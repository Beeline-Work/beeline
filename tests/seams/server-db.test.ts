import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  assertSchemaCurrent, markSchemaCurrent, migrate, migrateData, postgresPoolConfig, PostgresDatabase,
  type ClosableDatabase, type DatabaseFailureKind,
} from '../../apps/server/src/database.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (!url || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error('The server-db seam requires isolated loopback PostgreSQL');
const fixtureUrl = new URL(url);
const name = `beeline_seam_${randomUUID().replaceAll('-', '')}`;
fixtureUrl.pathname = '/' + name;
const admin = new Pool({ connectionString: url, max: 1 });
const observer = new Pool({ connectionString: fixtureUrl.href, max: 1 });
let pool: Pool;
let database: PostgresDatabase;

// Fresh PostgreSQL setup runs the complete migration before the seam cases.
beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${name}`);
  const bootstrap = new PostgresDatabase(fixtureUrl.href, 2, { mode: 'migration' });
  try {
    await migrate(bootstrap);
    // The release owner stamps readiness after schema and data steps complete.
    await markSchemaCurrent(bootstrap);
  } finally { await bootstrap.close(); }
  await observer.query('CREATE TABLE seam_effects(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, value text)');
}, 60_000);
beforeEach(async () => {
  await observer.query('TRUNCATE seam_effects');
  pool = new Pool(postgresPoolConfig(fixtureUrl.href, 2));
  database = new PostgresDatabase('', 2, { pool });
});
afterEach(async () => { await database?.close(); });
afterAll(async () => {
  await observer.end();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.end();
});

// Lose the reply after PostgreSQL commits the real effect. There is no unique
// constraint or in-memory effect counter that could conceal a replay.
async function lostReply(kind: DatabaseFailureKind, boundary: 'INSERT' | 'COMMIT') {
  await observer.query('TRUNCATE seam_effects');
  const failure = Object.assign(new Error('injected driver failure'), { code: kind === 'unknown' ? 'XX000' : kind });
  const connect = pool.connect.bind(pool);
  let lost = false;
  let acquisitions = 0;
  pool.connect = (async () => {
    acquisitions++;
    const client = await connect();
    const query = client.query.bind(client);
    client.query = (async (sql: string, values?: unknown[]) => {
      const result = await query(sql, values);
      if (!lost && (boundary === 'COMMIT' ? sql === 'COMMIT' : sql.startsWith('INSERT'))) {
        lost = true;
        throw failure;
      }
      return result;
    }) as typeof client.query;
    return client;
  }) as typeof pool.connect;
  const insert = 'INSERT INTO seam_effects(value) VALUES($1) RETURNING id';
  const work = boundary === 'COMMIT'
    ? database.transaction(tx => tx.query(insert, ['committed']))
    : database.query(insert, ['committed']);
  await expect(work).rejects.toBe(failure);
  expect(lost).toBe(true);
  expect(acquisitions).toBe(1);
  expect((await observer.query('SELECT value FROM seam_effects')).rows).toEqual([{ value: 'committed' }]);
}

type MigrationEntry = keyof Pick<typeof import('../../apps/server/src/database.js'),
  'migrate' | 'migrateData' | 'markSchemaCurrent' | 'assertSchemaCurrent'>;
const cases = {
  query: async () => {
    expect((await database.query('SELECT $1::text value', ['received'])).rows).toEqual([{ value: 'received' }]);
    await lostReply('08006', 'INSERT');
  },
  transaction: async () => {
    await database.transaction(async tx => { await tx.query("INSERT INTO seam_effects(value) VALUES('committed')"); });
    const failure = new Error('rollback');
    await expect(database.transaction(async tx => {
      await tx.query("INSERT INTO seam_effects(value) VALUES('rolled back')");
      throw failure;
    })).rejects.toBe(failure);
    expect((await observer.query('SELECT value FROM seam_effects')).rows).toEqual([{ value: 'committed' }]);
    await lostReply('08006', 'COMMIT');
  },
  connectDedicated: async () => {
    for (const mode of ['app', 'enrichment', 'diagnostics', 'long-running', 'migration'] as const) {
      const configured = new PostgresDatabase(fixtureUrl.href, 2, { mode });
      try {
        const first = await configured.connectDedicated();
        try {
          const second = await configured.connectDedicated();
          try {
            expect((await first.query('SHOW jit')).rows).toEqual([{ jit: 'off' }]);
            expect((await second.query('SHOW jit')).rows).toEqual([{ jit: 'off' }]);
          } finally { second.release(); }
        } finally { first.release(); }
        expect((await configured.query('SHOW jit')).rows).toEqual([{ jit: 'off' }]);
      } finally { await configured.close(); }
    }
  },
  backgroundWork: async () => {
    database.backgroundWork.run(async () => { await database.query("INSERT INTO seam_effects(value) VALUES('detached')"); });
    await database.backgroundWork.drain();
    expect(database.backgroundWork.isEmpty).toBe(true);
    expect((await observer.query('SELECT value FROM seam_effects')).rows).toEqual([{ value: 'detached' }]);
  },
  close: async () => {
    database.backgroundWork.run(async () => { await database.query("INSERT INTO seam_effects(value) VALUES('before close')"); });
    await database.close();
    expect((await observer.query('SELECT value FROM seam_effects')).rows).toEqual([{ value: 'before close' }]);
    await expect(database.query('SELECT 1')).rejects.toThrow();
  },
  poolCounts: async () => {
    await database.query('SELECT 1');
    expect(database.poolCounts()).toEqual({ total: 1, idle: 1, waiting: 0 });
  },
  poolTelemetry: async () => {
    await database.query('SELECT 1');
    expect(database.poolTelemetry()).toMatchObject({ checkouts: 1, checkoutFailures: 0, deadlocks: 0 });
  },
  oldestActiveQueryAgeMs: async () => {
    const pending = database.query('SELECT 1');
    expect(await database.oldestActiveQueryAgeMs()).toBeTypeOf('number');
    await pending;
    expect(await database.oldestActiveQueryAgeMs()).toBeNull();
  },
  queryProfiles: async () => {
    await database.query('SELECT 1');
    expect(database.queryProfiles()).toMatchObject({ top: [{ calls: 1, errors: 0 }], overflow: 0 });
  },
  queryWindow: async () => {
    await database.query('SELECT 1');
    expect(database.queryWindow()).toMatchObject({ queryCount: 1, checkoutCount: 1 });
  },
  oldestActiveTransactionAgeMs: async () => {
    await database.transaction(async tx => {
      expect(database.oldestActiveTransactionAgeMs()).toBeTypeOf('number');
      await tx.query('SELECT 1');
    });
    expect(database.oldestActiveTransactionAgeMs()).toBeNull();
  },
  transactionDeadlineCount: async () => {
    await database.transaction(tx => tx.query('SELECT 1'));
    expect(database.transactionDeadlineCount()).toBe(0);
  },
  onRecovery: async () => {
    let recoveries = 0;
    const remove = database.onRecovery(() => { recoveries++; });
    await lostReply('08006', 'INSERT');
    expect(recoveries).toBe(0);
    await database.query('SELECT 1');
    await database.query('SELECT 1');
    expect(recoveries).toBe(1);
    remove();
  },
  migrate: async () => {
    const id = 'c'.repeat(64);
    await database.query("INSERT INTO identities(id,kind,name) VALUES($1,'human','Seam person')", [id]);
    try {
      await migrate(database);
      await assertSchemaCurrent(database);
      expect((await database.query('SELECT name FROM identities WHERE id=$1', [id])).rows).toEqual([{ name: 'Seam person' }]);
    } finally { await database.query('DELETE FROM identities WHERE id=$1', [id]); }
  },
  migrateData: async () => {
    await migrateData(database);
    await migrateData(database);
    await assertSchemaCurrent(database);
  },
  markSchemaCurrent: async () => {
    await database.query('DELETE FROM beeline_schema_state');
    await markSchemaCurrent(database);
    await expect(assertSchemaCurrent(database)).resolves.toBeUndefined();
  },
  assertSchemaCurrent: async () => {
    await database.query('UPDATE beeline_schema_state SET version=0');
    try { await expect(assertSchemaCurrent(database)).rejects.toThrow('schema'); }
    finally { await markSchemaCurrent(database); }
  },
  '57P01': () => lostReply('57P01', 'INSERT'),
  '57P03': () => lostReply('57P03', 'INSERT'),
  '53300': () => lostReply('53300', 'INSERT'),
  '08006': () => lostReply('08006', 'INSERT'),
  '08003': () => lostReply('08003', 'INSERT'),
  '08000': () => lostReply('08000', 'INSERT'),
  ETIMEDOUT: () => lostReply('ETIMEDOUT', 'INSERT'),
  EAI_AGAIN: () => lostReply('EAI_AGAIN', 'INSERT'),
  '40P01': () => lostReply('40P01', 'INSERT'),
  '55P03': () => lostReply('55P03', 'INSERT'),
  '57014': () => lostReply('57014', 'INSERT'),
  unknown: () => lostReply('unknown', 'INSERT'),
} satisfies Record<keyof ClosableDatabase | MigrationEntry | DatabaseFailureKind, () => Promise<void>>;

it.each(Object.entries(cases))('%s', async (_member, run) => { await run(); });
