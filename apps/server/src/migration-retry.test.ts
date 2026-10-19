import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDeadlock, lockedTables, logLockHolders, retryMigrationStep, retryOnDeadlock, splitMigrationStatements } from './migration-retry.js';

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
});
