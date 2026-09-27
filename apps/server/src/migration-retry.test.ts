import { describe, expect, it } from 'vitest';
import { isDeadlock, retryMigrationStep, retryOnDeadlock, splitMigrationStatements } from './migration-retry.js';

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
