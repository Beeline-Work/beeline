import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backfillAgentHandles, migrate, migrateData, MIGRATION_LOCK_TIMEOUT_MS, PostgresDatabase } from './database.js';
import { alreadySatisfied, lockedTables, logLockHolders, normalizeTriggerDefinition, runMigrationStep, satisfiedCheck, splitMigrationStatements, triggerAlreadyCurrent, triggerPair } from './migration-steps.js';

const postgresUrl = process.env.BEELINE_MIGRATION_LOCK_TEST_POSTGRES_URL;
if (postgresUrl && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(postgresUrl).hostname))
  throw new Error('migration lock proofs require an isolated loopback PostgreSQL');

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('release-owned migration steps', () => {
  it.each(['40P01', '55P03', '57014', '42601'])('returns %s once and stays idle until another release command', async code => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = Object.assign(new Error(code), { code });
    const run = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const prior = vi.fn(async () => {});
    await runMigrationStep('prior', prior);
    await expect(runMigrationStep('contended', run)).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(run).toHaveBeenCalledOnce();
    expect(prior).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    // A new explicit release invocation owns this attempt.
    await runMigrationStep('contended', run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(prior).toHaveBeenCalledOnce();
    expect(MIGRATION_LOCK_TIMEOUT_MS).toBe(1_000);
  });

  it.skipIf(!postgresUrl)('a real contended DDL step resumes only on an explicit invocation after lock release', async () => {
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
      await reader.query(`BEGIN; SELECT * FROM ${schema}.messages`);
      const run = vi.fn(async () => { await migration.query('ALTER TABLE messages ADD COLUMN delivered boolean'); });
      await expect(runMigrationStep('reader contention', run)).rejects.toMatchObject({ code: '55P03' });
      expect(run).toHaveBeenCalledOnce();
      await reader.query('COMMIT');
      const columns = async () => (await reader.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='messages'`, [schema])).rows;
      expect(await columns()).not.toContainEqual({ column_name: 'delivered' });
      await runMigrationStep('reader contention', run);
      expect(run).toHaveBeenCalledTimes(2);
      expect(await columns()).toContainEqual({ column_name: 'delivered' });
    } finally {
      await reader.query('ROLLBACK');
      await migration.close();
      await reader.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      reader.release();
      await admin.end();
    }
  });

  it.skipIf(!postgresUrl)('R-MIGRATION-DATA stops each contended backfill and resumes only on a new release invocation', async () => {
    const schema = `backfill_proof_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: postgresUrl, max: 1 });
    const holder = await admin.connect();
    const database = new PostgresDatabase('', 1, { mode: 'migration', pool: new Pool({
      connectionString: postgresUrl, max: 1,
      options: `-c search_path=${schema},public -c lock_timeout=30ms`,
    }) });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await holder.query(`CREATE SCHEMA ${schema}`);
      await migrate(database);
      // Lock acquisition happens only when the targeted step starts, so earlier
      // completed steps remain outside the contended step.
      const steps = [
        { name: 'archived corner holds', table: 'corner_merge_holds',
          matches: (sql: string, _values: unknown[]) => sql.startsWith('SELECT 1 FROM corner_merge_holds hold JOIN rooms corner'),
          run: () => migrateData(database) },
        { name: 'corner hold messages', table: 'corner_merge_holds',
          matches: (sql: string, _values: unknown[]) => sql.includes('SELECT hold.corner_id,hold.id,COALESCE'),
          run: () => migrateData(database) },
        { name: 'welcome video workflow', table: 'workflow_backfills',
          matches: (sql: string, values: unknown[]) => sql.startsWith('SELECT name FROM workflow_backfills') && values[0] === 'welcome-video-v1',
          run: () => migrateData(database) },
        { name: 'agent handle candidates', table: 'identities',
          matches: (sql: string, _values: unknown[]) => sql.startsWith('SELECT id,created_at FROM identities'),
          run: () => backfillAgentHandles(database) },
      ];
      for (const step of steps) {
        let calls = 0;
        const query = database.query.bind(database);
        const querySpy = vi.spyOn(database, 'query').mockImplementation(async (sql, values = []) => {
          if (step.matches(sql, values) && ++calls === 1)
            await holder.query(`BEGIN; LOCK TABLE ${schema}.${step.table} IN ACCESS EXCLUSIVE MODE`);
          return query(sql, values);
        });
        try {
          await expect(step.run()).rejects.toMatchObject({ code: '55P03' });
          expect(calls, step.name).toBe(1);
          // A full data migration resumes from its entry point, so release
          // the lock before the next explicit invocation can reach this step.
          await holder.query('COMMIT');
          await step.run();
          expect(calls, step.name).toBe(2);
        } finally {
          querySpy.mockRestore();
          await holder.query('ROLLBACK');
        }
        // Failure leaves no aborted transaction or stranded pool slot.
        await expect(database.query('SELECT 1')).resolves.toMatchObject({ rowCount: 1 });
      }
    } finally {
      vi.restoreAllMocks();
      await holder.query('ROLLBACK');
      await database.close();
      await holder.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      holder.release();
      await admin.end();
    }
  }, 60_000);

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
    await expect(runMigrationStep('server schema 3/567', async () => { throw lockTimeout(); }, {
      onLockTimeout: () => logLockHolders(database, 'server schema 3/567', sql),
    })).rejects.toMatchObject({ code: '55P03' });
    const diagnostics = queries.filter((query) => query.sql.includes('pg_locks'));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.values).toEqual([['identities']]);
    expect(queries.some((query) => /SET LOCAL statement_timeout/.test(query.sql))).toBe(true);
    const logged = warn.mock.calls.filter(([message]) => message === '[migration] lock holder').map(([, row]) => row);
    expect(logged).toHaveLength(1);
    expect(Object.keys(logged[0] as object)).toEqual(expect.arrayContaining([
      'pid', 'state', 'wait_event', 'xact_start', 'query_start', 'application_name', 'query',
    ]));
  });

  it('keeps the original lock timeout when the diagnostic fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { database } = fakeDatabase(true);
    await expect(runMigrationStep('schema', async () => { throw lockTimeout(); }, {
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
      await expect(runMigrationStep('proof 1/1', async () => { await database.query(sql); }, {
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

describe('already-satisfied idempotent DDL', () => {
  it('reads back only plain IF NOT EXISTS creates', () => {
    expect(satisfiedCheck('ALTER TABLE identities ADD COLUMN IF NOT EXISTS hidden_from_roster boolean NOT NULL DEFAULT false;'))
      .toEqual({ relation: 'identities', columns: ['hidden_from_roster'] });
    expect(satisfiedCheck(`-- note\nALTER TABLE t ADD COLUMN IF NOT EXISTS a text DEFAULT 'x,y', ADD COLUMN IF NOT EXISTS b numeric(10,2)`))
      .toEqual({ relation: 't', columns: ['a', 'b'] });
    expect(satisfiedCheck('CREATE TABLE IF NOT EXISTS rooms (id uuid PRIMARY KEY)')).toEqual({ relation: 'rooms', columns: [] });
    expect(satisfiedCheck('CREATE UNIQUE INDEX IF NOT EXISTS rooms_slug ON rooms(slug)')).toEqual({ relation: 'rooms_slug', columns: [] });
    expect(satisfiedCheck('CREATE INDEX CONCURRENTLY IF NOT EXISTS rooms_slug ON rooms(slug)')).toBeNull();
    expect(satisfiedCheck('ALTER TABLE t ADD COLUMN IF NOT EXISTS a text, DROP COLUMN b')).toBeNull();
    expect(satisfiedCheck('ALTER TABLE t ADD COLUMN a text')).toBeNull();
    expect(satisfiedCheck('ALTER TABLE t ALTER COLUMN a SET NOT NULL')).toBeNull();
    expect(satisfiedCheck('UPDATE t SET a = 1')).toBeNull();
  });

  it('skips only when every named object exists, without touching the table', async () => {
    const query = vi.fn(async (_sql: string, values?: unknown[]) => ({
      rows: [{ relation: true, columns: (values?.[1] as string[]).filter(c => c !== 'missing').length }],
    }));
    await expect(alreadySatisfied({ query }, 'ALTER TABLE t ADD COLUMN IF NOT EXISTS a text')).resolves.toBe(true);
    await expect(alreadySatisfied({ query }, 'ALTER TABLE t ADD COLUMN IF NOT EXISTS a text, ADD COLUMN IF NOT EXISTS missing text')).resolves.toBe(false);
    await expect(alreadySatisfied({ query }, 'ALTER TABLE t DROP COLUMN IF EXISTS a')).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0]![0])).not.toMatch(/\bLOCK\b|\bALTER\b/i);
  });
});

describe('already-current trigger pairs', () => {
  const drop = 'DROP TRIGGER IF EXISTS next_day_first_message ON messages;';
  const create = 'CREATE TRIGGER next_day_first_message AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION note_checkin_first_message();';
  const installed = 'CREATE TRIGGER next_day_first_message AFTER INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION note_checkin_first_message()';

  it('pairs only a drop and create of the same trigger on the same table', () => {
    expect(triggerPair(drop, create)).toEqual(['next_day_first_message', 'messages']);
    expect(triggerPair(drop, create.replace('ON messages', 'ON rooms'))).toBeNull();
    expect(triggerPair(drop, 'CREATE TRIGGER other AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION f()')).toBeNull();
    expect(triggerPair('DROP TRIGGER next_day_first_message ON messages', create)).toBeNull();
    expect(normalizeTriggerDefinition(installed)).toBe(normalizeTriggerDefinition(create));
  });

  it('skips only when the installed definition is identical', async () => {
    const query = vi.fn(async () => ({ rows: [{ definition: installed }] }));
    await expect(triggerAlreadyCurrent({ query }, drop, create)).resolves.toBe(true);
    await expect(triggerAlreadyCurrent({ query }, drop, create.replace('AFTER INSERT', 'AFTER INSERT OR UPDATE'))).resolves.toBe(false);
    const absent = vi.fn(async () => ({ rows: [] }));
    await expect(triggerAlreadyCurrent({ query: absent }, drop, create)).resolves.toBe(false);
    await expect(triggerAlreadyCurrent({ query }, 'UPDATE t SET a=1', create)).resolves.toBe(false);
  });
});
