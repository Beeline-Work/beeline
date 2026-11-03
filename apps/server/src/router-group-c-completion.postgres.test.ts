import { createHash, randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthStore, type BindTicket } from '../../auth/src/store.js';
import { waitForAuthTicket } from '../../auth/src/completion-wait.js';
import { PostgresDatabase, type SqlDatabase } from './database.js';
import { COMMAND_COMPLETION_CHANNEL, notifyCommandCompletion, subscribeCommandCompletion,
  type CommandCompletionKey } from './command-completion.js';
import { RouterCommandLedger, ROUTER_COMMAND_SCHEMA } from './router-command-ledger.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Group C proofs require isolated loopback PostgreSQL');
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const schema = `group_c_completion_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const config = { connectionString: url, options: `-c search_path=${schema},public`, max: 2 };
  const a = new PostgresDatabase('', 2, { pool: new Pool(config) });
  const b = new PostgresDatabase('', 2, { pool: new Pool(config) });
  const listener = new Client(config);
  const barriers = new Map<string, () => void>();
  listener.on('notification', event => {
    if (event.channel !== COMMAND_COMPLETION_CHANNEL || !event.payload) return;
    notifyCommandCompletion(event.payload);
    barriers.get(event.payload)?.();
  });
  await listener.connect();
  await listener.query(`LISTEN ${COMMAND_COMPLETION_CHANNEL}`);
  return { a, b,
    // A notification after a writer transaction proves all earlier notifications
    // on this connection have been handled; no sleep/poll discovers completion.
    flush: async () => {
      const payload = JSON.stringify({ barrier: randomUUID() }), done = deferred();
      barriers.set(payload, () => done.resolve());
      await b.query('SELECT pg_notify($1,$2)', [COMMAND_COMPLETION_CHANNEL, payload]);
      await done.promise;
      barriers.delete(payload);
    },
    close: async () => {
      await listener.end(); await Promise.all([a.close(), b.close()]);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    },
  };
}
afterEach(() => vi.useRealTimers());

describe.skipIf(!url)('Group C P7/P9/P12 real PostgreSQL correlated completion', () => {
  it.each(['https://github.com', 'https://accounts.google.com'])(
    'F11: %s pending ten minutes has no timed inspection; only its committed ticket wakes it', async issuer => {
      const f = await fixture();
      const abort = new AbortController();
      let waiting: Promise<BindTicket | null> | undefined;
      try {
        const reader = new AuthStore(f.a), writer = new AuthStore(f.b);
        await writer.migrate();
        const hash = createHash('sha256').update(randomUUID()).digest('hex');
        const other = createHash('sha256').update(randomUUID()).digest('hex');
        const started = deferred(), inspected = vi.fn(async () => {
          const value = await reader.findTicket(hash); started.resolve(); return value;
        });
        const ticket: BindTicket = { challenge: 'c'.repeat(43), community: 'synthetic.test', issuer,
          audience: 'fixture', subject: 'synthetic-person', createdAt: new Date(),
          expiresAt: new Date(Date.now() + 1_200_000), attemptCount: 0, consumedAt: null, boundPubkey: null };
        const key: CommandCompletionKey = { principal: 'auth', operation: 'ticket', commandId: hash };
        const released = vi.fn();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        waiting = waitForAuthTicket(wake => {
          const stop = subscribeCommandCompletion(key, wake);
          return () => { released(); stop(); };
        }, inspected, 1_200_000, abort.signal);
        await started.promise;
        await vi.advanceTimersByTimeAsync(600_000);
        expect(inspected).toHaveBeenCalledTimes(1);
        await writer.createTicket(other, ticket); await f.flush();
        expect(inspected).toHaveBeenCalledTimes(1);
        // The actual trigger's notification must disappear with its write.
        await expect(f.b.transaction(async tx => {
          await new AuthStore(tx).createTicket(hash, ticket);
          throw new Error('synthetic rollback');
        })).rejects.toThrow('synthetic rollback');
        await f.flush(); expect(inspected).toHaveBeenCalledTimes(1);
        await writer.createTicket(hash, ticket);
        expect(await waiting).toMatchObject({ issuer, subject: ticket.subject });
        expect(inspected).toHaveBeenCalledTimes(2); expect(released).toHaveBeenCalledTimes(1);
        await f.flush(); await vi.advanceTimersByTimeAsync(86_400_000);
        expect(inspected).toHaveBeenCalledTimes(2);
      } finally {
        abort.abort(); await waiting?.catch(() => undefined); vi.useRealTimers(); await f.close();
      }
    });

  it('F21: a pending payment waits ten minutes, ignores foreign identity and rollback, then consumes its committed result once', async () => {
    const f = await fixture(), abort = new AbortController();
    const started = deferred(), release = deferred();
    let effect: Promise<unknown> | undefined, waiting: ReturnType<RouterCommandLedger['wait']> | undefined;
    try {
      await f.a.query(ROUTER_COMMAND_SCHEMA);
      const key = { principal: 'payer', operation: 'payment', commandId: randomUUID() }, args = { amount: '1', asset: 'synthetic' };
      const first = new RouterCommandLedger(f.a);
      effect = first.external(key, args, async () => { started.resolve(); await release.promise; return { txId: 'synthetic-confirmed' }; });
      await started.promise;
      const initiallyRead = deferred(); let reads = 0;
      const observed: SqlDatabase = { transaction: work => f.b.transaction(work), query: async (sql, values) => {
        const result = await f.b.query(sql, values);
        if (sql.startsWith('SELECT digest,state,result,coverage,')) { reads++; initiallyRead.resolve(); }
        return result;
      } };
      const second = new RouterCommandLedger(observed);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      waiting = second.wait(key, args, 1_200_000, abort.signal);
      await initiallyRead.promise;
      await vi.advanceTimersByTimeAsync(600_000); expect(reads).toBe(1);
      for (const wrong of [{ ...key, principal: 'other' }, { ...key, operation: 'other' }, { ...key, commandId: 'other' }])
        await f.a.query('SELECT pg_notify($1,$2)', [COMMAND_COMPLETION_CHANNEL, JSON.stringify(wrong)]);
      await f.flush(); expect(reads).toBe(1);
      await expect(f.a.transaction(async tx => {
        await tx.query('SELECT pg_notify($1,$2)', [COMMAND_COMPLETION_CHANNEL, JSON.stringify(key)]);
        throw new Error('synthetic rollback');
      })).rejects.toThrow('synthetic rollback');
      await f.flush(); expect(reads).toBe(1);
      release.resolve(); await effect;
      expect(await waiting).toMatchObject({ state: 'committed', result: { txId: 'synthetic-confirmed' } });
      // The local completion wake and actual LISTEN wake may overlap; neither
      // can inspect again once the waiter has finished.
      await f.flush(); const settledReads = reads;
      await vi.advanceTimersByTimeAsync(86_400_000); expect(reads).toBe(settledReads);
      const replayEffect = vi.fn();
      expect(await second.external(key, args, replayEffect)).toMatchObject({ state: 'committed' });
      expect(replayEffect).not.toHaveBeenCalled();
    } finally {
      abort.abort(); release.resolve(); await effect?.catch(() => undefined);
      await waiting?.catch(() => undefined); vi.useRealTimers(); await f.close();
    }
  });

  it('F18/F21: a lost external response stays UNKNOWN across pools and an idle day without redispatch', async () => {
    const f = await fixture();
    try {
      await f.a.query(ROUTER_COMMAND_SCHEMA);
      const key = { principal: 'payer', operation: 'payment', commandId: randomUUID() }, args = { amount: '1' };
      await f.a.query('CREATE TABLE provider_effects(id text)');
      const lostReply = vi.fn(async () => {
        // The synthetic provider commits before its response is lost. No
        // uniqueness constraint masks a duplicate dispatch in this proof.
        await f.b.query('INSERT INTO provider_effects VALUES($1)', [key.commandId]);
        throw new Error('synthetic lost provider result');
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      await expect(new RouterCommandLedger(f.a).external(key, args, lostReply)).rejects.toThrow('synthetic lost provider result');
      await vi.advanceTimersByTimeAsync(86_400_000);
      expect(lostReply).toHaveBeenCalledTimes(1);
      const replay = vi.fn(async () => 'must not dispatch');
      for (let n = 0; n < 3; n++)
        expect(await new RouterCommandLedger(f.b).external(key, args, replay)).toMatchObject({ state: 'unknown' });
      expect(replay).not.toHaveBeenCalled();
      expect((await f.a.query('SELECT * FROM provider_effects')).rows).toEqual([{ id: key.commandId }]);
    } finally { vi.useRealTimers(); await f.close(); }
  });
});
