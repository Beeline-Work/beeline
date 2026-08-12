import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite, type PGliteInterface, type Transaction } from '@electric-sql/pglite';
import type { QueryResultRow } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthStore,
  type SqlExecutor,
  type SqlResult,
  type TransactionalDatabase,
} from './store.js';

class DurablePgliteDatabase implements TransactionalDatabase {
  readonly client: PGliteInterface;

  constructor(path: string) {
    this.client = new PGlite(`file://${path}`);
  }

  async query<Row extends QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<SqlResult<Row>> {
    const result = await this.client.query<Row>(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }

  async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    return this.client.transaction(async (transaction: Transaction) =>
      work({
        query: async <Row extends QueryResultRow>(sql: string, values: unknown[] = []) => {
          const result = await transaction.query<Row>(sql, values);
          return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
        },
      }),
    );
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

describe('durable transactional identity-link store', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  it('survives a database close/reopen and namespaces the same subject by audience', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'beeline-auth-store-'));
    directories.push(directory);
    const firstDatabase = new DurablePgliteDatabase(directory);
    await firstDatabase.client.waitReady;
    const firstStore = new AuthStore(firstDatabase);
    await firstStore.migrate();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60_000);
    const common = {
      challenge: 'challenge',
      community: 'community',
      issuer: 'https://issuer.example',
      subject: 'stable-subject',
      createdAt: now,
      expiresAt,
      attemptCount: 0,
      consumedAt: null,
      boundPubkey: null,
    };
    await firstStore.createTicket('1'.repeat(64), { ...common, audience: 'client-one' });
    await firstStore.createTicket('2'.repeat(64), { ...common, audience: 'client-two' });
    expect(
      (await firstStore.consumeTicketAndLink('1'.repeat(64), 'a'.repeat(64), now)).status,
    ).toBe('linked');
    expect(
      (await firstStore.consumeTicketAndLink('2'.repeat(64), 'b'.repeat(64), now)).status,
    ).toBe('linked');
    await firstStore.close();

    const reopenedDatabase = new DurablePgliteDatabase(directory);
    await reopenedDatabase.client.waitReady;
    const reopenedStore = new AuthStore(reopenedDatabase);
    await reopenedStore.migrate();
    expect(await reopenedStore.linksForPubkey('community', 'a'.repeat(64))).toEqual([
      expect.objectContaining({
        issuer: 'https://issuer.example',
        audience: 'client-one',
        subject: 'stable-subject',
      }),
    ]);
    expect(await reopenedStore.linksForPubkey('community', 'b'.repeat(64))).toEqual([
      expect.objectContaining({ audience: 'client-two' }),
    ]);
    await reopenedStore.close();
  }, 30_000);
});
