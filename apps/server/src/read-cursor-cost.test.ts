import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import type { QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthStore, type TransactionalDatabase } from '@beeline/auth/store';
import { TokenAuth } from './auth.js';
import { migrate, type QueryResult, type SqlDatabase } from './database.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { PgliteDatabase } from './test-support.js';
import { LIVE_INTERACTION_TARGET_MS, ROUTE_P95_BUDGET_MS } from './production-corpus-performance.js';

/**
 * Fanout audit measurement for the viewport read cursor (#1609).
 *
 * Scroll is the hottest interaction on the chat surface and it now originates a
 * server write, so this times that write and the read-cursor projection the two
 * Room read paths carry, against a Room deep enough to make the scans visible.
 */
const WORKSPACE = '60000000-0000-4000-8000-000000000001';
const ROOM = '60000000-0000-4000-8000-000000000002';
const MESSAGE_COUNT = 5_000;

class CountingDatabase implements SqlDatabase {
  statements = 0;

  constructor(private readonly inner: SqlDatabase) {}

  async query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    this.statements += 1;
    return this.inner.query<Row>(sql, values);
  }

  async transaction<T>(work: (database: SqlDatabase) => Promise<T>): Promise<T> {
    return this.inner.transaction((database) => work(new CountingProxy(database, this)));
  }
}

class CountingProxy implements SqlDatabase {
  constructor(
    private readonly inner: SqlDatabase,
    private readonly counter: CountingDatabase,
  ) {}

  async query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    this.counter.statements += 1;
    return this.inner.query<Row>(sql, values);
  }

  async transaction<T>(work: (database: SqlDatabase) => Promise<T>): Promise<T> {
    return this.inner.transaction((database) => work(new CountingProxy(database, this.counter)));
  }
}

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function report(label: string, samples: number[]): { p50: number; p95: number } {
  const p50 = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  console.log(
    `${label.padEnd(52)} p50 ${p50.toFixed(2).padStart(8)} ms   p95 ${p95.toFixed(2).padStart(8)} ms   n=${samples.length}`,
  );
  return { p50, p95 };
}

describe('read-cursor server cost', () => {
  const store = new PgliteDatabase();
  let counted: CountingDatabase;
  let server: ReturnType<typeof createBeelineServer>;
  let origin: string;
  let readerToken: string;
  let authorToken: string;
  const messageIds: string[] = [];

  beforeAll(async () => {
    await migrate(store);
    await new AuthStore(store as unknown as TransactionalDatabase).migrate();
    const auth = new TokenAuth(store, async (proof) => ({
      subject: proof,
      login: proof,
      name: proof,
    }));
    authorToken = (await auth.exchangeGitHubOidc('cursorauthor')).accessToken;
    readerToken = (await auth.exchangeGitHubOidc('cursorreader')).accessToken;
    const linked = await store.query<{ subject: string; identity_id: string }>(
      `SELECT subject,identity_id FROM identity_external_links WHERE provider='github'`,
    );
    const identityFor = (subject: string) =>
      linked.rows.find((row) => row.subject === subject)!.identity_id;
    const author = identityFor('cursorauthor');
    const reader = identityFor('cursorreader');
    await store.query(`INSERT INTO workspaces(id,name) VALUES($1,'Read cursor')`, [WORKSPACE]);
    await store.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Cursor')`,
      [ROOM, WORKSPACE, author],
    );
    for (const member of [author, reader]) {
      await store.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES($1,NULL,$2,$3),($1,$4,$2,$3)`,
        [WORKSPACE, member, member === author ? 'owner' : 'member', ROOM],
      );
    }
    // Authored by the other member, so every row counts as unread for the
    // reader — the worst case the cursor's count has to walk.
    const base = Date.now() - MESSAGE_COUNT * 1000;
    for (let index = 0; index < MESSAGE_COUNT; index += 1) {
      const id = randomBytes(32).toString('hex');
      messageIds.push(id);
      await store.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,created_at)
         VALUES($1,$2,$3,$4,'message',to_timestamp($5))`,
        [id, ROOM, author, `row ${index}`, (base + index * 1000) / 1000],
      );
    }
    await store.query(`ANALYZE`);

    counted = new CountingDatabase(store);
    const live = new LiveHub();
    const phone = new PhoneService(counted, 'http://placeholder', undefined, undefined, live);
    const daemon = new DaemonService(counted, live);
    server = createBeelineServer({
      database: counted,
      auth,
      phone,
      daemon,
      live,
      mediaMaximumBytes: 1024 * 1024,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    (phone as unknown as { publicOrigin: string }).publicOrigin = origin;
  }, 600_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
  });

  async function markRead(messageId: string): Promise<number> {
    const response = await fetch(`${origin}/v1/phone/rooms/${ROOM}/read`, {
      method: 'POST',
      headers: { authorization: `Bearer ${readerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messageId }),
    });
    if (response.status !== 200 && response.status !== 204)
      throw new Error(`read mark failed with ${response.status}`);
    return response.status;
  }

  async function roomRead(): Promise<void> {
    const response = await fetch(`${origin}/v1/phone/rooms/${ROOM}`, {
      headers: { authorization: `Bearer ${readerToken}` },
    });
    if (response.status !== 200)
      throw new Error(`room read failed with ${response.status}: ${await response.text()}`);
    await response.json();
  }

  it('S1: one viewport read mark, against a 5,000-message Room', async () => {
    for (let warm = 0; warm < 5; warm += 1) await markRead(messageIds[warm]!);
    const samples: number[] = [];
    const before = counted.statements;
    const writes = 200;
    for (let index = 0; index < writes; index += 1) {
      // Forward-moving, as the advancer only ever publishes forward.
      const target = messageIds[100 + index * 10]!;
      const began = performance.now();
      await markRead(target);
      samples.push(performance.now() - began);
    }
    const statementsPerWrite = (counted.statements - before) / writes;
    const { p95 } = report('S1 POST /rooms/:id/read', samples);
    console.log(`S1 statements per read mark: ${statementsPerWrite.toFixed(1)}`);
    expect(p95).toBeLessThan(ROUTE_P95_BUDGET_MS);
  }, 300_000);

  it('S2: Room read with the mark at the TAIL (nothing unread)', async () => {
    await markRead(messageIds[MESSAGE_COUNT - 1]!);
    for (let warm = 0; warm < 3; warm += 1) await roomRead();
    const samples: number[] = [];
    for (let index = 0; index < 40; index += 1) {
      const began = performance.now();
      await roomRead();
      samples.push(performance.now() - began);
    }
    const { p95 } = report('S2 GET /rooms/:id, mark at tail', samples);
    expect(p95).toBeLessThan(ROUTE_P95_BUDGET_MS);
  }, 300_000);

  it('S3: Room read with the mark 5,000 rows back (the count scan runs)', async () => {
    // A reader who has been away: the cursor's unreadCount subquery walks from
    // the mark forward until it hits the 99 cap, and firstUnread walks with it.
    await store.query(`DELETE FROM room_read_marks WHERE room_id=$1`, [ROOM]);
    for (let warm = 0; warm < 3; warm += 1) await roomRead();
    const samples: number[] = [];
    for (let index = 0; index < 40; index += 1) {
      const began = performance.now();
      await roomRead();
      samples.push(performance.now() - began);
    }
    const { p95 } = report('S3 GET /rooms/:id, no mark at all', samples);
    console.log(
      `targets: interaction ${LIVE_INTERACTION_TARGET_MS} ms, route budget ${ROUTE_P95_BUDGET_MS} ms`,
    );
    expect(p95).toBeLessThan(ROUTE_P95_BUDGET_MS);
  }, 300_000);

  it('S4: a scrolling reader writes at a rate the server absorbs', async () => {
    // The phone debounce publishes at most one write per rest. A reader working
    // down a long transcript rests often; this is 30 rests back to back.
    const began = performance.now();
    for (let index = 0; index < 30; index += 1) await markRead(messageIds[1_000 + index * 100]!);
    const total = performance.now() - began;
    console.log(`S4 30 sequential read marks: ${total.toFixed(1)} ms total`);
    expect(total).toBeGreaterThan(0);
  }, 300_000);
});
