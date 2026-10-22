import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { postgresPoolConfig } from './database.js';

const modes = ['app', 'enrichment', 'diagnostics', 'long-running', 'migration'] as const;
const url = process.env.BEELINE_JIT_TEST_POSTGRES_URL;
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) {
  throw new Error('JIT proofs require isolated loopback PostgreSQL');
}

describe('server pool JIT policy', () => {
  it.each(modes)('disables JIT in %s startup options', (mode) => {
    expect(postgresPoolConfig('postgres://localhost/test', 2, mode).options).toContain('-c jit=off');
  });

  it.skipIf(!url).each(modes)('R-JIT-POOL: new and reused %s connections report JIT off', async (mode) => {
    const pool = new Pool(postgresPoolConfig(url!, 2, mode));
    try {
      // Hold both clients so the second checkout must create another connection.
      const first = await pool.connect();
      try {
        const second = await pool.connect();
        try {
          expect((await first.query('SHOW jit')).rows).toEqual([{ jit: 'off' }]);
          expect((await second.query('SHOW jit')).rows).toEqual([{ jit: 'off' }]);
        } finally {
          second.release();
        }
      } finally {
        first.release();
      }
      expect((await pool.query('SHOW jit')).rows).toEqual([{ jit: 'off' }]);
    } finally {
      await pool.end();
    }
  });
});
