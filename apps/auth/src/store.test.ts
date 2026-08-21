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

  it('reads the server-stamped Room tenant across the two-community production shape', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'beeline-auth-room-store-'));
    directories.push(directory);
    const database = new DurablePgliteDatabase(directory);
    await database.client.waitReady;
    await database.query(`CREATE TABLE channels (
      id UUID PRIMARY KEY,
      community_id UUID NOT NULL,
      deleted_at TIMESTAMPTZ
    )`);
    await database.query(
      `INSERT INTO channels (id, community_id) VALUES
       ($1::uuid, $2::uuid),
       ($3::uuid, $4::uuid)`,
      [
        'd2cddea6-3224-43e8-bd45-0da26d95d378',
        '3a47eeff-fdff-4a1e-9eb9-b48cb4ed90ed',
        '484556f2-7e81-4ad6-a851-0e57bdba6a67',
        'e8299f28-f095-472f-941a-80d1195b9a24',
      ],
    );
    const store = new AuthStore(database);

    await expect(
      store.relayCommunityIdForRoom('d2cddea6-3224-43e8-bd45-0da26d95d378'),
    ).resolves.toBe('3a47eeff-fdff-4a1e-9eb9-b48cb4ed90ed');
    await expect(
      store.relayCommunityIdForRoom('484556f2-7e81-4ad6-a851-0e57bdba6a67'),
    ).resolves.toBe('e8299f28-f095-472f-941a-80d1195b9a24');
    await expect(store.relayCommunityIdForRoom('not-a-room-id')).resolves.toBeNull();
    await database.close();
  }, 30_000);
});
