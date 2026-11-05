import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

// Each entry must work in a fresh ESM graph. A warm Vitest import hides cycles
// that previously read Needs-you words or the authority lock before initialization.
it.each(['needs-you', 'membership-authority-schema', 'postgres-live', 'command-completion'])(
  'cold %s import can construct the live and authority schemas', entry => {
    const url = (name: string) => new URL(`./${name}.ts`, import.meta.url).href;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      await import(${JSON.stringify(url(entry))});
      const live = await import(${JSON.stringify(url('postgres-live'))});
      const authority = await import(${JSON.stringify(url('membership-authority-schema'))});
      const lock = await import(${JSON.stringify(url('router-authority-lock'))});
      if (!(await live.postgresLiveSchema()).includes('CREATE OR REPLACE FUNCTION beeline_notify_live')) throw Error('missing live schema');
      if (!authority.MEMBERSHIP_AUTHORITY_SCHEMA.includes(lock.ROUTER_AUTHORITY_LOCK)) throw Error('missing authority lock');
    `], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' } });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  }, 25_000,
);
