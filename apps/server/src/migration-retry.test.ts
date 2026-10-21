import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIGRATION_LOCK_TIMEOUT_MS, PostgresDatabase } from './database.js';
import { isDeadlock, lockedTables, logLockHolders, retryMigrationStep, retryOnDeadlock, splitMigrationStatements } from './migration-retry.js';

// Optional real PostgreSQL proof: loopback only, unique schema, never a shared account.
const postgresUrl = process.env.BEELINE_MIGRATION_LOCK_TEST_POSTGRES_URL;
if (postgresUrl && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(postgresUrl).hostname))
  throw new Error('migration lock proofs require an isolated loopback PostgreSQL');

const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' });

describe('retryOnDeadlock', () => {
  it('reruns the idempotent migration after a deadlock', async () => {
    let calls = 0;
    const waits: number[] = [];
    await retryOnDeadlock(
      async () => {
        calls += 1;
        if (calls < 3) throw deadlock();
      },
      { delayMs: () => 5, sleep: async (ms) => void waits.push(ms) },
    );
    expect(calls).toBe(3);
    expect(waits).toEqual([5, 5]);
  });

  it('gives up after the attempt budget', async () => {
    let calls = 0;
    await expect(
      retryOnDeadlock(
        async () => {
          calls += 1;
          throw deadlock();
        },
        { attempts: 2, sleep: async () => undefined },
      ),
    ).rejects.toThrow('deadlock detected');
    expect(calls).toBe(2);
  });

  it('does not retry other failures', async () => {
    let calls = 0;
    await expect(
      retryOnDeadlock(
        async () => {
          calls += 1;
          throw Object.assign(new Error('syntax error'), { code: '42601' });
        },
        { sleep: async () => undefined },
      ),
    ).rejects.toThrow('syntax error');
    expect(calls).toBe(1);
    expect(isDeadlock(deadlock())).toBe(true);
  });
});

describe('retryMigrationStep', () => {
  it('backs off across multiple push intervals with a bounded retry budget', async () => {
    const waits: number[] = [];
    let calls = 0;
    await expect(retryMigrationStep('burst reader', async () => {
      calls++;
      throw Object.assign(new Error('lock timeout'), { code: '55P03' });
    }, { sleep: async ms => { waits.push(ms); } })).rejects.toMatchObject({ code: '55P03' });
    expect(calls).toBe(20);
    expect(waits.reduce((total, ms) => total + ms, 0)).toBeGreaterThanOrEqual(145_000);
    expect(waits.reduce((total, ms) => total + ms, 0)).toBeLessThan(155_000);
    expect(Math.max(...waits)).toBeLessThan(10_500);
    expect(MIGRATION_LOCK_TIMEOUT_MS).toBe(1_000);
  });

  it.skipIf(!postgresUrl)('R-MIGRATION-READER retries burst reads and alters messages in a gap', async () => {
    const schema = `release_proof_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: postgresUrl, max: 1 });
    const reader = await admin.connect();
    const migration = new PostgresDatabase('', 1, { mode: 'migration', pool: new Pool({
      connectionString: postgresUrl, max: 1,
      options: `-c search_path=${schema} -c lock_timeout=30ms`,
    }) });
    try {
      await reader.query(`CREATE SCHEMA ${schema}`);
      await reader.query(`CREATE TABLE ${schema}.messages (id int)`);
      const ddl = 'ALTER TABLE messages ADD COLUMN delivered boolean';
      const runBursts = async (attempts?: number) => {
        let bursts = 0;
        let gaps = 0;
        await reader.query(`BEGIN; SELECT * FROM ${schema}.messages`);
        try {
          await retryMigrationStep('R-MIGRATION-READER', async () => {
            await migration.query(ddl);
          }, {
            attempts,
            // Compress the 12–30s cadence; use real, separate PostgreSQL sessions
            // and table locks. Release each read before starting the next burst.
            sleep: async () => {
              await reader.query('COMMIT');
              gaps++;
              if (gaps < 7) {
                await reader.query(`BEGIN; SELECT * FROM ${schema}.messages`);
                bursts++;
              }
            },
          });
        } finally { await reader.query('ROLLBACK'); }
        return { bursts, gaps };
      };
      // The old six-attempt policy exhausts while reads keep recurring.
      await expect(runBursts(6)).rejects.toMatchObject({ code: '55P03' });
      // The default policy reaches the seventh gap without changing the worker.
      await expect(runBursts()).resolves.toEqual({ bursts: 6, gaps: 7 });
      const columns = await reader.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='messages'`, [schema]);
      expect(columns.rows).toContainEqual({ column_name: 'delivered' });
    } finally {
      await reader.query('ROLLBACK');
      await migration.close();
      await reader.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      reader.release();
      await admin.end();
    }
  });

  it('keeps semicolons inside quoted strings, comments, and trigger bodies', () => {
    const script = `-- first; comment
CREATE TABLE sample (value text DEFAULT 'a;b');
/* second; comment */
CREATE FUNCTION sample_fn() RETURNS trigger AS $body$
BEGIN NEW.value := 'c;d'; RETURN NEW; END;
$body$ LANGUAGE plpgsql;
CREATE TRIGGER sample_trigger BEFORE INSERT ON sample
FOR EACH ROW EXECUTE FUNCTION sample_fn();`;
    const statements = splitMigrationStatements(script);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain("DEFAULT 'a;b'");
    expect(statements[1]).toContain("RETURN NEW; END;");
    expect(statements[2]).toContain('CREATE TRIGGER');
  });

  it('retries only the contended DDL step after a lock timeout', async () => {
    let priorStep = 0;
    let contendedStep = 0;
    const waits: number[] = [];
    await retryMigrationStep('schema', async () => { priorStep++; });
    await retryMigrationStep('index', async () => {
      contendedStep++;
      if (contendedStep < 3)
        throw Object.assign(new Error('lock timeout'), { code: '55P03' });
    }, { delayMs: () => 1, sleep: async (ms) => void waits.push(ms) });
    expect(priorStep).toBe(1);
    expect(contendedStep).toBe(3);
    expect(waits).toEqual([1, 1]);
  });

  it('does not retry a statement timeout or syntax error', async () => {
    for (const code of ['57014', '42601']) {
      let calls = 0;
      await expect(retryMigrationStep('schema', async () => {
        calls++;
        throw Object.assign(new Error(code), { code });
      }, { sleep: async () => undefined })).rejects.toThrow(code);
      expect(calls).toBe(1);
    }
  });
});

describe('lock holder diagnostic', () => {
  afterEach(() => vi.restoreAllMocks());

  const lockTimeout = () => Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
  const holder = {
    relation: 'identities', mode: 'RowExclusiveLock', granted: true, pid: 4242, state: 'idle in transaction',
    wait_event_type: 'Client', wait_event: 'ClientRead', xact_start: '2026-10-19 19:22:01+00',
    query_start: '2026-10-19 19:22:02+00', application_name: 'beeline_long_running',
    query: 'UPDATE identities SET name=$1 WHERE id=$2',
  };

  function fakeDatabase(fail = false) {
    const queries: { sql: string; values?: unknown[] }[] = [];
    const database = {
      async query(sql: string, values?: unknown[]) {
        queries.push({ sql, values });
        if (fail && sql.includes('pg_locks')) throw new Error('permission denied for pg_locks');
        return { rows: sql.includes('pg_locks') ? [holder] : [] };
      },
      async transaction<T>(work: (db: typeof database) => Promise<T>) { return work(database); },
    };
    return { database, queries };
  }

  it('names the tables a migration statement locks', () => {
    expect(lockedTables('ALTER TABLE identities ADD COLUMN IF NOT EXISTS hidden_from_roster boolean')).toEqual(['identities']);
    expect(lockedTables('DO $x$ BEGIN LOCK TABLE identities IN SHARE ROW EXCLUSIVE MODE; END $x$')).toContain('identities');
  });

  it('logs the sessions holding the blocked table on every lock timeout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { database, queries } = fakeDatabase();
    const sql = 'ALTER TABLE identities ADD COLUMN IF NOT EXISTS hidden_from_roster boolean';
    await expect(retryMigrationStep('server schema 3/567', async () => { throw lockTimeout(); }, {
      attempts: 2,
      sleep: async () => undefined,
      onLockTimeout: () => logLockHolders(database, 'server schema 3/567', sql),
    })).rejects.toMatchObject({ code: '55P03' });
    const diagnostics = queries.filter((query) => query.sql.includes('pg_locks'));
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]!.values).toEqual([['identities']]);
    expect(queries.some((query) => /SET LOCAL statement_timeout/.test(query.sql))).toBe(true);
    const logged = warn.mock.calls.filter(([message]) => message === '[migration] lock holder').map(([, row]) => row);
    expect(logged).toHaveLength(2);
    expect(Object.keys(logged[0] as object)).toEqual(expect.arrayContaining([
      'pid', 'state', 'wait_event', 'xact_start', 'query_start', 'application_name', 'query',
    ]));
  });

  it('keeps the original lock timeout when the diagnostic fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { database } = fakeDatabase(true);
    await expect(retryMigrationStep('schema', async () => { throw lockTimeout(); }, {
      attempts: 1,
      onLockTimeout: () => logLockHolders(database, 'schema', 'ALTER TABLE identities ADD COLUMN x int'),
    })).rejects.toThrow('canceling statement due to lock timeout');
    expect(warn).toHaveBeenCalledWith('[migration] schema lock holder diagnostic failed: permission denied for pg_locks');
  });

  it.skipIf(!postgresUrl)('names the second session that holds the table in real PostgreSQL', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const schema = `lock_proof_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: postgresUrl, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE TABLE ${schema}.lock_proof (id int)`);
    const holder = new Pool({ connectionString: postgresUrl, max: 1, application_name: 'lock_proof_holder' });
    const held = await holder.connect();
    const database = new PostgresDatabase('', 1, { mode: 'migration', pool: new Pool({
      connectionString: postgresUrl, max: 1, options: `-c search_path=${schema} -c lock_timeout=200ms`,
    }) });
    try {
      await held.query(`BEGIN; SELECT count(*) FROM ${schema}.lock_proof`);
      const holderPid = (await held.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
      const sql = 'ALTER TABLE lock_proof ADD COLUMN IF NOT EXISTS hidden boolean';
      await expect(retryMigrationStep('proof 1/1', async () => { await database.query(sql); }, {
        attempts: 1,
        onLockTimeout: () => logLockHolders(database, 'proof 1/1', sql),
      })).rejects.toMatchObject({ code: '55P03' });
      const logged = warn.mock.calls.filter(([message]) => message === '[migration] lock holder').map(([, row]) => row);
      expect(logged).toContainEqual(expect.objectContaining({
        relation: 'lock_proof', granted: true, pid: holderPid, application_name: 'lock_proof_holder',
        state: 'idle in transaction', query: 'SELECT pg_backend_pid() pid',
      }));
    } finally {
      await held.query('ROLLBACK');
      held.release();
      await holder.end();
      await database.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
});
