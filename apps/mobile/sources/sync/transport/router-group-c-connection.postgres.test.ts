import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { WebSocket, WebSocketServer } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import type { RouterSnapshotInput } from '@beeline/api-contract/router-protocol';
import { ReadLanes } from '../../../../../packages/net/src/private/read-lanes.js';
import { PostgresDatabase, type SqlDatabase } from '../../../../server/src/database.js';
import { DURABLE_LIVE_SCHEMA } from '../../../../server/src/durable-live.js';
import { ROUTER_PROJECTION_SCHEMA } from '../../../../server/src/router-projection-schema.js';
import { LiveHub } from '../../../../server/src/live.js';
import { PhoneService } from '../../../../server/src/phone-service.js';
import { routerSocketProtocol } from '../../../../server/src/router-socket.js';
import { buildRouterSnapshot } from '../../../../server/src/router-projections.js';

const app = vi.hoisted(() => ({ listeners: new Set<(state: string) => void>(), currentState: 'active' }));
vi.mock('react-native', () => ({ AppState: {
  get currentState() { return app.currentState; },
  addEventListener: (_event: string, listener: (state: string) => void) => {
    app.listeners.add(listener); return { remove: () => app.listeners.delete(listener) };
  },
}, NativeModules: {}, Platform: { OS: 'android' } }));
import { LiveConnection } from './live-connection';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Group C connection proof requires isolated loopback PostgreSQL');
const workspace = '11111111-1111-4111-8111-111111111111', room = '22222222-2222-4222-8222-222222222222';
const hidden = '33333333-3333-4333-8333-333333333333', viewer = 'synthetic-reader';
const input = { family: 'room-head' as const, workspaceId: workspace, roomId: room };
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

// The socket framing bridge and credential are synthetic. The WebSockets,
// LiveConnection, lane state machine, PostgreSQL snapshot and final enqueue
// fence are real. Installed native/network-adapter cohorts remain separate.
describe.skipIf(!url)('Group C P4 real socket/PostgreSQL lane recovery', () => {
  it('F10/F18: healthy callbacks read zero; one half-open replacement recovers each demanded key once and flapping cannot refill it', async () => {
    app.currentState = 'active'; app.listeners.clear();
    const healthyPong = deferred();
    class ClientSocket extends WebSocket {
      constructor(address: string, protocols: string[]) {
        super(address, protocols);
        this.on('message', raw => { if (JSON.parse(String(raw)).type === 'pong') healthyPong.resolve(); });
      }
    }
    vi.stubGlobal('WebSocket', ClientSocket);
    const schema = `group_c_socket_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const db = new PostgresDatabase('', 2, { pool: new Pool({ connectionString: url, options: `-c search_path=${schema},public`, max: 2 }) });
    let queries = 0, sockets = 0, pings = 0, pong = true, refuse = false;
    const wrap = (database: SqlDatabase): SqlDatabase => ({
      transaction: work => database.transaction(tx => work(wrap(tx))),
      query: async (sql, args) => { queries++; return database.query(sql, args); },
    });
    const observed = wrap(db), live = new LiveHub(), phone = new PhoneService(observed, 'https://synthetic.test');
    const reads: RouterSnapshotInput[] = [], errors: unknown[] = [];
    const protocols: ReturnType<typeof routerSocketProtocol>[] = [];
    const lanes = new ReadLanes({ origin: 'https://synthetic.test', principal: viewer, sessionEpoch: 1 }, () => true);
    let network = () => {}, connection: LiveConnection | undefined;
    let challenged = deferred(), negotiated = deferred(), installed = deferred(), rejected = deferred();
    lanes.subscribe(input, () => { if (lanes.peek(input).state === 'LIVE') installed.resolve(); });
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(wss, 'listening');
    wss.on('connection', socket => {
      sockets++;
      if (refuse) { socket.close(); rejected.resolve(); return; }
      const protocol = routerSocketProtocol(observed, viewer, raw => socket.send(raw),
        { families: ['room-head'], listenerReady: () => true, roomHeadContinuityV1: true }, { live, phone, rooms: () => [] });
      protocols.push(protocol); let serial = Promise.resolve();
      socket.on('message', raw => {
        serial = serial.then(async () => {
          const frame = JSON.parse(String(raw));
          if (frame.type === 'ping') { pings++; if (pong) socket.send('{"type":"pong"}'); challenged.resolve(); return; }
          if (await protocol.handle(frame)) return;
          if (frame.type === 'sync') return;
          if (frame.t === 'req') {
            expect(frame.op).toBe('readRouterSnapshot');
            const value = await protocol.snapshot(frame.args);
            await protocol.fenceReply(frame.op, frame.args, value, () => { socket.send(JSON.stringify({ t: 'res', id: frame.id, ok: true, result: value })); return undefined; });
          }
        }).catch(error => { errors.push(error); socket.close(); });
      });
      socket.on('close', () => protocol.close());
    });
    const transition = (state: string) => { app.currentState = state; for (const listener of app.listeners) listener(state); };
    try {
      await db.query(`CREATE TABLE workspaces(id uuid PRIMARY KEY);
        CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,archived_at timestamptz,name text);
        CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);`);
      await db.query(DURABLE_LIVE_SCHEMA); await db.query(ROUTER_PROJECTION_SCHEMA);
      await db.query('INSERT INTO workspaces VALUES($1)', [workspace]);
      await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Visible'),($2,$3,'Hidden')`, [room, hidden, workspace]);
      await db.query(`INSERT INTO memberships VALUES($1,NULL,$4,'member',NULL),($1,$2,$4,'member',NULL),($1,$3,$4,'member',NULL)`, [workspace, room, hidden, viewer]);
      phone.buildRouterValue = async (tx, args) => {
        const value = (await tx.query<{ name: string }>('SELECT name FROM rooms WHERE id=$1', [args.roomId])).rows[0]!;
        return { room: { id: args.roomId!, name: value.name }, messages: [] };
      };
      phone.readRouterSnapshot = async (args, reader) => {
        reads.push(args); return buildRouterSnapshot(observed, args, reader, phone.buildRouterValue.bind(phone));
      };
      connection = new LiveConnection({ authorization: async () => 'synthetic-credential',
        liveUrl: () => `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
        subscribeIdentityChange: () => () => {}, subscribeNetworkChange: listener => { network = listener; return () => {}; },
        router: {
          requestedCapabilities: async () => ({ families: ['room-head'], authorityFencesV1: true }),
          negotiated: async next => { lanes.connected(next.generation, next.families, next.execute, { roomHeadContinuityV1: true }); negotiated.resolve(); },
          disconnected: () => lanes.disconnected(), receive: () => {},
        },
      });
      await connection.register([], () => {}); await negotiated.promise;
      const a = {}, b = {}, oldHidden = {}, hiddenInput = { ...input, roomId: hidden };
      lanes.demand(input, a, { isCurrent: () => true }); lanes.demand(input, b, { isCurrent: () => true }); await installed.promise;
      const hiddenInstalled = deferred(); const stopHidden = lanes.subscribe(hiddenInput, () => { if (lanes.peek(hiddenInput).state === 'LIVE') hiddenInstalled.resolve(); });
      const releaseHidden = lanes.demand(hiddenInput, oldHidden, { isCurrent: () => true }); await hiddenInstalled.promise;
      releaseHidden(); stopHidden();
      expect(reads.map(read => read.roomId)).toEqual([room, hidden]);
      const cut = lanes.peek(input).cut;
      queries = 0;
      transition('background'); transition('active');
      for (let n = 0; n < 100; n++) transition('active');
      await challenged.promise;
      // Wait for the actual pong to clear the single outstanding challenge.
      await healthyPong.promise;
      expect(connection.commandState().ready).toBe(true);
      expect({ queries, sockets, reads: reads.length, pings }).toEqual({ queries: 0, sockets: 1, reads: 2, pings: 1 });
      expect(lanes.peek(input).cut).toEqual(cut);
      // Fake only control clocks; all socket and PostgreSQL I/O remains real.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      pong = false; challenged = deferred(); negotiated = deferred(); installed = deferred();
      transition('background'); transition('active'); network(); await challenged.promise;
      await vi.advanceTimersByTimeAsync(5_000);
      await negotiated.promise; await installed.promise;
      expect(sockets).toBe(2);
      expect(reads.filter(read => read.roomId === room)).toHaveLength(2);
      expect(reads.filter(read => read.roomId === hidden)).toHaveLength(1);
      expect(lanes.peek(input).cut).toEqual(cut);
      const latest = [...wss.clients].at(-1)!; latest.terminate();
      await vi.waitFor(() => expect(lanes.peek(input).state).toBe('PARKED'));
      const count = queries;
      await vi.advanceTimersByTimeAsync(86_400_000);
      expect({ queries, sockets }).toEqual({ queries: count, sockets: 2 });
      // A distinct path edge admits one attempt. Refusal and elapsed time do
      // not manufacture a fourth attempt or a fresh snapshot generation.
      refuse = true; network(); await rejected.promise;
      await vi.advanceTimersByTimeAsync(86_400_000);
      expect(sockets).toBe(3); expect(reads).toHaveLength(3); expect(errors).toEqual([]);
    } finally {
      connection?.dispose(); vi.useRealTimers(); vi.unstubAllGlobals();
      for (const protocol of protocols) protocol.close(); for (const socket of wss.clients) socket.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve())); await db.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); app.listeners.clear();
    }
  }, 20_000);
});
