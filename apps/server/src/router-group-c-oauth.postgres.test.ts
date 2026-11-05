import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type ClientRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { TokenAuth } from './auth.js';
import { PostgresDatabase, type SqlDatabase } from './database.js';
import { COMMAND_COMPLETION_CHANNEL, notifyCommandCompletion } from './command-completion.js';
import { ROOMS_MCP_SCHEMA } from './rooms-mcp-schema.js';
import { RoomsMcpOAuth } from './rooms-mcp-oauth.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Group C OAuth proof requires isolated loopback PostgreSQL');
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe.skipIf(!url)('Group C P7/P12 real PostgreSQL OAuth HTTP handoff', () => {
  it('F21: ten pending minutes inspect once; foreign completion cannot wake the waiter and a lost HTTP result replays the same committed code', async () => {
    const schema = `group_c_oauth_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const config = { connectionString: url, options: `-c search_path=${schema},public`, max: 2 };
    const db = new PostgresDatabase('', 2, { pool: new Pool(config) }), listener = new Client(config);
    const notices: string[] = [], requests: ClientRequest[] = [];
    let reads = 0, inspection = deferred(), foreignDelivered = deferred();
    listener.on('notification', event => {
      if (event.channel === COMMAND_COMPLETION_CHANNEL && event.payload) {
        notices.push(event.payload); notifyCommandCompletion(event.payload); foreignDelivered.resolve();
      }
    });
    const observed: SqlDatabase = { transaction: work => db.transaction(work), query: async (sql, args) => {
      const result = await db.query(sql, args);
      if (sql.startsWith('SELECT code,error FROM rooms_mcp_handoffs')) { reads++; inspection.resolve(); }
      return result;
    } };
    const oauth = new RoomsMcpOAuth(observed, 'http://synthetic.invalid', {} as TokenAuth, undefined, () => true);
    const server = createServer((request, response) => {
      void oauth.handle(request, response, new URL(request.url!, 'http://synthetic.invalid')).catch(() => response.destroy());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (state: string, waitMs = 600_000) => {
      const headers = deferred();
      const done = new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
        const request = httpRequest(origin + '/mcp/oauth/handoff', { method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
          headers.resolve(); let text = '';
          response.on('data', chunk => { text += chunk; }); response.on('error', reject);
          response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(text) }));
        });
        requests.push(request); request.on('error', reject); request.end(JSON.stringify({ state, completionV1: true, waitMs }));
      });
      return { headers: headers.promise, done };
    };
    let pending: ReturnType<typeof post> | undefined;
    try {
      await db.query('CREATE TABLE identities(id text PRIMARY KEY); CREATE TABLE messages(id text PRIMARY KEY,author_id text,room_id uuid,reply_to_message_id text,presentation text); CREATE TABLE rooms(id uuid PRIMARY KEY)');
      await db.query(ROOMS_MCP_SCHEMA); await listener.connect(); await listener.query(`LISTEN ${COMMAND_COMPLETION_CHANNEL}`);
      const state = randomUUID().replaceAll('-', '') + 'synthetic';
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      pending = post(state); await pending.headers; await inspection.promise;
      await vi.advanceTimersByTimeAsync(599_999); expect(reads).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending.done).toEqual({ status: 200, body: { error: 'authorization_pending' } }); expect(reads).toBe(1);
      inspection = deferred(); pending = post(state); await pending.headers; await inspection.promise;
      expect(reads).toBe(2);
      foreignDelivered = deferred();
      await fetch(origin + '/mcp/oauth/handoff?state=' + 'z'.repeat(43) + '&code=foreign-code'); await foreignDelivered.promise;
      expect(reads).toBe(2);
      await fetch(origin + '/mcp/oauth/handoff?state=' + state + '&code=synthetic-code');
      expect(await pending.done).toEqual({ status: 200, body: { code: 'synthetic-code' } }); expect(reads).toBe(3);
      // Treat that first body as lost. Replay retrieves the same receipt;
      // no provider token exchange or regenerated authorization is performed.
      expect(await post(state).done).toEqual({ status: 200, body: { code: 'synthetic-code' } }); expect(reads).toBe(4);
      expect(JSON.stringify(notices)).not.toContain(state); expect(JSON.stringify(notices)).not.toContain('synthetic-code');
      await vi.advanceTimersByTimeAsync(86_400_000); expect(reads).toBe(4);
    } finally {
      for (const request of requests) request.destroy(); await pending?.done.catch(() => undefined); vi.useRealTimers();
      await new Promise<void>(resolve => server.close(() => resolve())); await listener.end(); await db.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    }
  });
});
