import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import type { QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AuthStore, type TransactionalDatabase } from '@beeline/auth/store';
import { TokenAuth } from './auth.js';
import { migrate, type QueryResult, type SqlDatabase } from './database.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { PgliteDatabase } from './test-support.js';

/**
 * What one ordinary human message costs the server as the Room grows, on the
 * two axes the fanout audit had not measured: readers attached to the writing
 * machine, and agents the message tags.
 *
 * Both are counted, not reasoned about — every statement the released code
 * runs passes through the counter below.
 */
const WORKSPACE = '50000000-0000-4000-8000-000000000001';
const ROOM = '50000000-0000-4000-8000-000000000002';
const READER_COUNT = 8;
const AGENT_COUNT = 4;

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

function agentHandle(index: number): string {
  return `sweepagent${index}`;
}

describe('live fanout cost sweep', () => {
  const store = new PgliteDatabase();
  let counted: CountingDatabase;
  let server: ReturnType<typeof createBeelineServer>;
  let origin: string;
  let writerToken: string;
  const readerTokens: string[] = [];
  const agentIds: string[] = [];
  const reported: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    await migrate(store);
    await new AuthStore(store as unknown as TransactionalDatabase).migrate();
    const auth = new TokenAuth(store, async (proof) => ({
      subject: proof,
      login: proof,
      name: proof,
    }));
    writerToken = (await auth.exchangeGitHubOidc('sweepwriter')).accessToken;
    for (let index = 0; index < READER_COUNT; index += 1) {
      readerTokens.push((await auth.exchangeGitHubOidc(`sweepreader${index}`)).accessToken);
    }
    const linked = await store.query<{ subject: string; identity_id: string }>(
      `SELECT subject,identity_id FROM identity_external_links WHERE provider='github'`,
    );
    const identityFor = (subject: string) =>
      linked.rows.find((row) => row.subject === subject)!.identity_id;
    const writer = identityFor('sweepwriter');
    const readers = Array.from({ length: READER_COUNT }, (_, index) =>
      identityFor(`sweepreader${index}`),
    );
    for (let index = 0; index < AGENT_COUNT; index += 1) {
      const agentId = randomBytes(32).toString('hex');
      agentIds.push(agentId);
      await store.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent',$2,$3)`,
        [agentId, `Sweep Agent ${index}`, agentHandle(index)],
      );
      await store.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agentId, writer]);
    }
    await store.query(`INSERT INTO workspaces(id,name) VALUES($1,'Fanout sweep')`, [WORKSPACE]);
    await store.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Sweep')`, [
      ROOM,
      WORKSPACE,
      writer,
    ]);
    const members = [writer, ...readers, ...agentIds];
    for (const member of members) {
      await store.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES($1,NULL,$2,$3),($1,$4,$2,$3)`,
        [WORKSPACE, member, member === writer ? 'owner' : 'member', ROOM],
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
  }, 300_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
    for (const entry of reported) console.log(JSON.stringify(entry));
  });

  async function send(text: string): Promise<string> {
    const messageId = randomBytes(32).toString('hex');
    const response = await fetch(`${origin}/v1/phone/operations/sendRoomMessage`, {
      method: 'POST',
      headers: { authorization: `Bearer ${writerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        roomId: ROOM,
        messageId,
        text,
        ...(text.includes('@') ? { mentions: agentIds.filter((_, i) => text.includes(agentHandle(i))) } : {}),
      }),
    });
    if (response.status !== 200) throw new Error(`send failed with ${response.status}`);
    return messageId;
  }

  async function attachReaders(count: number): Promise<WebSocket[]> {
    const sockets: WebSocket[] = [];
    for (let index = 0; index < count; index += 1) {
      const socket = new WebSocket(`${origin.replace('http', 'ws')}/v1/phone/live`, [
        `bearer.${readerTokens[index]}`,
      ]);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });
      const subscribed = new Promise<void>((resolve) => {
        socket.on('message', (raw) => {
          const event = JSON.parse(String(raw)) as { type?: string };
          if (event.type === 'subscribed') resolve();
        });
      });
      socket.send(JSON.stringify({ type: 'subscribe', roomIds: [ROOM] }));
      await subscribed;
      sockets.push(socket);
    }
    return sockets;
  }

  /** Every attached reader must hold the row before the statements are counted. */
  async function deliveredTo(sockets: readonly WebSocket[], messageId: string): Promise<void> {
    await Promise.all(
      sockets.map(
        (socket) =>
          new Promise<void>((resolve) => {
            const listener = (raw: WebSocket.RawData) => {
              const event = JSON.parse(String(raw)) as {
                type?: string;
                message?: { id?: string };
              };
              if (event.type !== 'message-delta' || event.message?.id !== messageId) return;
              socket.off('message', listener);
              resolve();
            };
            socket.on('message', listener);
          }),
      ),
    );
  }

  it('charges one extra Room read per attached reader for a human message', async () => {
    const measure = async (readerCount: number) => {
      const sockets = await attachReaders(readerCount);
      try {
        // Warm the path once so first-call planning is not attributed below.
        await deliveredTo(sockets, await send('warmup'));
        const before = counted.statements;
        const startedAt = performance.now();
        await deliveredTo(sockets, await send('fanout sample'));
        const elapsedMs = performance.now() - startedAt;
        return { statements: counted.statements - before, elapsedMs };
      } finally {
        for (const socket of sockets) socket.close();
      }
    };

    const one = await measure(1);
    const many = await measure(READER_COUNT);
    const perReader = (many.statements - one.statements) / (READER_COUNT - 1);
    reported.push({
      finding: 'human-write-delta-read-per-reader',
      oneReaderStatements: one.statements,
      [`${READER_COUNT}ReaderStatements`]: many.statements,
      perReaderStatements: perReader,
      oneReaderMs: Math.round(one.elapsedMs * 10) / 10,
      manyReaderMs: Math.round(many.elapsedMs * 10) / 10,
      note: 'a phone write publishes an id-only invalidation, so each socket resolves the row itself',
    });
    // A committed-row delta (the agent reply path) would make this zero. It is
    // not zero: the cost is linear in attached readers on the app pool.
    expect(perReader).toBeGreaterThanOrEqual(1);
    expect(many.statements).toBeGreaterThan(one.statements);
  }, 300_000);

  it('routes each tagged agent with its own statement pair inside the write', async () => {
    const measure = async (mentionCount: number) => {
      const handles = Array.from({ length: mentionCount }, (_, i) => `@${agentHandle(i)}`).join(' ');
      const text = mentionCount ? `${handles} please look` : 'no mentions here';
      await send(text);
      const before = counted.statements;
      const startedAt = performance.now();
      await send(text);
      return { statements: counted.statements - before, elapsedMs: performance.now() - startedAt };
    };

    const none = await measure(0);
    const tagged = await measure(AGENT_COUNT);
    const perMention = (tagged.statements - none.statements) / AGENT_COUNT;
    reported.push({
      finding: 'mention-routing-serial-per-agent',
      noMentionStatements: none.statements,
      [`${AGENT_COUNT}MentionStatements`]: tagged.statements,
      perMentionStatements: perMention,
      noMentionMs: Math.round(none.elapsedMs * 10) / 10,
      taggedMs: Math.round(tagged.elapsedMs * 10) / 10,
      note: 'routeHumanMention reads eligibility and creates the command one agent at a time, inside the send transaction',
    });
    expect(perMention).toBeGreaterThanOrEqual(2);
  }, 300_000);
});
