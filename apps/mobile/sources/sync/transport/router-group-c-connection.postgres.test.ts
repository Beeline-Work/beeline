import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Client, Pool } from 'pg';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import type { RouterFamily, RouterSnapshot, RouterSnapshotInput } from '@beeline/api-contract/router-protocol';
import { ReadLanes } from '../../../../../packages/net/src/private/read-lanes.js';
import { PostgresDatabase, type SqlDatabase } from '../../../../server/src/database.js';
import { DURABLE_LIVE_SCHEMA } from '../../../../server/src/durable-live.js';
import { ROUTER_PROJECTION_SCHEMA } from '../../../../server/src/router-projection-schema.js';
import { LiveHub } from '../../../../server/src/live.js';
import { PhoneService } from '../../../../server/src/phone-service.js';
import { routerSocketProtocol } from '../../../../server/src/router-socket.js';
import { buildRouterSnapshot } from '../../../../server/src/router-projections.js';

const app = vi.hoisted(() => ({ listeners: new Set<(state: string) => void>(), currentState: 'active', origin: '',
  network: undefined as undefined | ((state: { type: string; isConnected: boolean; isInternetReachable: boolean; details: { ipAddress: string } }) => void),
  negotiated: async (_next: { generation: number; families: readonly RouterFamily[]; execute: (input: RouterSnapshotInput) => Promise<RouterSnapshot> }) => {},
  disconnected: () => {},
}));
const netInfo = vi.hoisted(() => ({ configure: vi.fn(), addEventListener: vi.fn((listener: NonNullable<typeof app.network>) => {
  app.network = listener; return () => { app.network = undefined; };
}) }));
vi.mock('@react-native-community/netinfo', () => ({ default: netInfo }));
vi.mock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: app.origin }) }));
vi.mock('@/buzz/router-owner', () => ({
  routerOwnerCapabilities: async () => ({ families: ['room-head'], authorityFencesV1: true }),
  routerOwnerNegotiated: (next: Parameters<typeof app.negotiated>[0]) => app.negotiated(next),
  routerOwnerDisconnected: () => app.disconnected(), routerOwnerReceive: () => {},
}));
vi.mock('react-native', () => ({ AppState: {
  get currentState() { return app.currentState; },
  addEventListener: (_event: string, listener: (state: string) => void) => {
    app.listeners.add(listener); return { remove: () => app.listeners.delete(listener) };
  },
}, NativeModules: { RNCNetInfo: {} }, Platform: { OS: 'android' } }));
import { LiveConnection, sharedLiveConnection, resetSharedLiveConnection } from './live-connection';
import { monolithSession } from '@/auth/monolith-session';

const authStorage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => authStorage.get(key) ?? null,
  setItem: async (key: string, value: string) => { authStorage.set(key, value); },
  removeItem: async (key: string) => { authStorage.delete(key); },
} }));
vi.mock('expo-linking', () => ({ createURL: (path: string) => `beeline://${path}` }));
vi.mock('@/auth/desktop-auth-redirect', () => ({ desktopAuthRedirectUri: (_name: string, fallback: string) => fallback }));
const googlePicker = vi.hoisted(() => ({ enabled: false, signIn: vi.fn() }));
vi.mock('@/auth/google-account-picker', () => ({ get googleAccountPicker() { return googlePicker.enabled ? googlePicker : null; } }));
import { runGoogleSignIn, resumeGoogleSignIn } from '@/auth/google-auth-session';
import { runResilientGitHubSignInSession, resumeInitialGitHubSignIn } from '@/auth/github-auth-session';
import { AuthStore, type BindTicket } from '../../../../auth/src/store.js';
import { waitForAuthTicket } from '../../../../auth/src/completion-wait.js';
import { COMMAND_COMPLETION_CHANNEL, notifyCommandCompletion, subscribeCommandCompletion } from '../../../../server/src/command-completion.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Group C connection proof requires isolated loopback PostgreSQL');
const workspace = '11111111-1111-4111-8111-111111111111', room = '22222222-2222-4222-8222-222222222222';
const hidden = '33333333-3333-4333-8333-333333333333', viewer = 'synthetic-reader';
const input = { family: 'room-head' as const, workspaceId: workspace, roomId: room };
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

// The socket framing bridge and credential are synthetic. The WebSockets,
// sharedLiveConnection and its production NetInfo callback adapter, lane state
// machine, PostgreSQL snapshot and final enqueue fence are real. The native
// NetInfo source is synthetic; installed OS/SDK captures remain separate.
describe.skipIf(!url)('Group C P4 real socket/PostgreSQL lane recovery', () => {
  it('F10/F18: native death reopens and re-reads demanded keys; failed handshakes park without polling', async () => {
    resetSharedLiveConnection(); app.currentState = 'active'; app.listeners.clear(); netInfo.configure.mockClear();
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
    let queries = 0, sockets = 0, attempts = 0, pings = 0, pong = true, refuse = false;
    const wrap = (database: SqlDatabase): SqlDatabase => ({
      transaction: work => database.transaction(tx => work(wrap(tx))),
      query: async (sql, args) => { queries++; return database.query(sql, args); },
    });
    const observed = wrap(db), live = new LiveHub(), phone = new PhoneService(observed, 'https://synthetic.test');
    const reads: RouterSnapshotInput[] = [], errors: unknown[] = [];
    const protocols: ReturnType<typeof routerSocketProtocol>[] = [];
    const lanes = new ReadLanes({ origin: 'https://synthetic.test', principal: viewer, sessionEpoch: 1 }, () => true);
    let connection: LiveConnection | undefined, path = 1;
    const sample = () => app.network!({ type: 'wifi', isConnected: true, isInternetReachable: true, details: { ipAddress: `192.0.2.${path}` } });
    const network = () => { path++; sample(); };
    let challenged = deferred(), negotiated = deferred(), installed = deferred(), rejected = deferred();
    lanes.subscribe(input, () => { if (lanes.peek(input).state === 'LIVE') installed.resolve(); });
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient: (_info, finish) => {
      attempts++;
      // Refuse the upgrade itself. Closing after an accepted upgrade is a
      // native death of an opened socket and correctly admits a reconnect.
      if (refuse) { finish(false, 401); rejected.resolve(); }
      else finish(true);
    } }); await once(wss, 'listening');
    wss.on('connection', socket => {
      sockets++;
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
      app.origin = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`;
      vi.spyOn(monolithSession, 'authorization').mockResolvedValue('synthetic-credential');
      const invalidateAuthorization = vi.spyOn(monolithSession, 'invalidateAuthorization');
      app.negotiated = async next => { lanes.connected(next.generation, next.families, next.execute, { roomHeadContinuityV1: true }); negotiated.resolve(); };
      app.disconnected = () => lanes.disconnected();
      connection = sharedLiveConnection();
      await connection.register([], () => {}); await negotiated.promise;
      await vi.waitFor(() => expect(app.network).toBeDefined());
      expect(netInfo.configure.mock.calls[0]![0].reachabilityShouldRun()).toBe(false);
      sample(); // The initial native sample is a baseline, never a recovery edge.
      await expect(connection.request('readRoomTools', { roomId: room, anchor: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'owner_required' });
      await expect(connection.request('readMediaMetadata', { objectId: room })).rejects.toMatchObject({ code: 'owner_required' });
      await expect(connection.request('readMediaLink', { objectId: room })).rejects.toMatchObject({ code: 'owner_required' });
      await expect(connection.request('readMediaPlayback', { objectId: room })).rejects.toMatchObject({ code: 'owner_required' });
      const a = {}, b = {}, oldHidden = {}, hiddenInput = { ...input, roomId: hidden };
      lanes.demand(input, a, { isCurrent: () => true }); lanes.demand(input, b, { isCurrent: () => true }); await installed.promise;
      const hiddenInstalled = deferred(); const stopHidden = lanes.subscribe(hiddenInput, () => { if (lanes.peek(hiddenInput).state === 'LIVE') hiddenInstalled.resolve(); });
      const releaseHidden = lanes.demand(hiddenInput, oldHidden, { isCurrent: () => true }); await hiddenInstalled.promise;
      releaseHidden(); stopHidden();
      expect(reads.map(read => read.roomId)).toEqual([room, hidden]);
      const cut = lanes.peek(input).cut;
      queries = 0;
      transition('background'); transition('active');
      for (let n = 0; n < 100; n++) { transition('active'); sample(); }
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
      // A real native close after that recovery must create a fresh socket,
      // re-read the still-demanded Room once, and leave the released Room alone.
      pong = true; negotiated = deferred(); installed = deferred();
      const latest = [...wss.clients].at(-1)!; latest.terminate();
      await negotiated.promise; await installed.promise;
      expect({ sockets, attempts, ready: connection.commandState().ready }).toEqual({ sockets: 3, attempts: 3, ready: true });
      expect(lanes.peek(input).state).toBe('LIVE');
      expect(lanes.peek(input).cut).toEqual(cut);
      expect(reads.filter(read => read.roomId === room)).toHaveLength(3);
      expect(reads.filter(read => read.roomId === hidden)).toHaveLength(1);
      // Its next native close also gets one attempt, but an upgrade which
      // never opens cannot refill recovery or leave a silently LIVE lane.
      refuse = true; [...wss.clients].at(-1)!.terminate(); await rejected.promise;
      await vi.waitFor(() => expect(invalidateAuthorization).toHaveBeenCalledTimes(1));
      expect(lanes.peek(input).state).toBe('PARKED');
      expect(connection.commandState().ready).toBe(false);
      const count = queries;
      await vi.advanceTimersByTimeAsync(86_400_000);
      expect({ queries, sockets, attempts }).toEqual({ queries: count, sockets: 3, attempts: 4 });
      // A distinct path edge admits one bounded handshake recovery. Neither
      // refusal nor elapsed time manufactures another attempt or snapshot.
      network();
      await vi.waitFor(() => expect(invalidateAuthorization).toHaveBeenCalledTimes(3));
      await vi.advanceTimersByTimeAsync(86_400_000);
      expect({ queries, sockets, attempts }).toEqual({ queries: count, sockets: 3, attempts: 6 });
      expect(reads).toHaveLength(4); expect(errors).toEqual([]);
    } finally {
      resetSharedLiveConnection(); connection?.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
      for (const protocol of protocols) protocol.close(); for (const socket of wss.clients) socket.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve())); await db.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); app.listeners.clear();
    }
  }, 20_000);
});


// Actual preauth clients/HTTP, independent PostgreSQL pools, durable ticket
// capture and LISTEN wake. Browser/OS callback delivery and the HTTP response
// serializer are explicit synthetic seams; no installed-native claim is made.
describe.skipIf(!url)('Group D P9 correlated native callback adapter composition', () => {
  it('F11: cancellation during native lost-response recovery burns the committed ticket without returning it', async () => {
    authStorage.clear(); googlePicker.enabled = true; googlePicker.signIn.mockResolvedValue('synthetic-native-id-token');
    const schema = `group_d_native_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const config = { connectionString: url, options: `-c search_path=${schema},public`, max: 2 };
    const readerDb = new PostgresDatabase('', 2, { pool: new Pool(config) });
    const writerDb = new PostgresDatabase('', 2, { pool: new Pool(config) });
    const reader = new AuthStore(readerDb), writer = new AuthStore(writerDb);
    const state = 's'.repeat(43), browserToken = 'r'.repeat(43);
    const token = createHash('sha256').update(`beeline-google-native:${browserToken}`).digest('base64url');
    const hash = createHash('sha256').update(token).digest('hex');
    const inspected = deferred(), release = deferred(), controller = new AbortController();
    const pending: Promise<unknown>[] = [], errors: unknown[] = [];
    let requests = 0, reads = 0, cancellations = 0;
    // Native picker/HTTP serialization are synthetic. Ticket commit, independent
    // recovery read, client cancellation fence and durable ticket burn are real.
    const server = createServer((request, response) => {
      let body = ''; request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        const work = (async () => {
          requests++;
          const args = JSON.parse(body);
          if (request.url === '/auth/oidc/native/start') {
            expect(args.recoveryChallenge).toBe(hash);
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ state, nonce: 'n'.repeat(43), serverClientId: 'synthetic.apps.googleusercontent.com' }));
            return;
          }
          expect(args.recoveryToken).toBe(token);
          if (request.url === '/auth/oidc/native/complete') {
            expect(args.idToken).toBe('synthetic-native-id-token');
            await writer.createTicket(hash, { challenge: 'c'.repeat(43), community: 'synthetic.test', issuer: 'https://accounts.google.com',
              audience: 'fixture', subject: 'synthetic-person', createdAt: new Date(), expiresAt: new Date(Date.now() + 120_000),
              attemptCount: 0, consumedAt: null, boundPubkey: null });
            response.destroy(); // The commit succeeded; only its HTTP response is lost.
            return;
          }
          if (request.url === '/auth/oidc/completion') {
            reads++; const ticket = await reader.findTicket(hash);
            expect(ticket).toMatchObject({ consumedAt: null, subject: 'synthetic-person' });
            inspected.resolve(); await release.promise;
            response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}');
            return;
          }
          expect(request.url).toBe('/auth/oidc/completion/cancel');
          cancellations++; await writer.cancelRecoveryTicket(hash, new Date());
          response.writeHead(204); response.end();
        })(); pending.push(work); void work.catch(error => { errors.push(error); inspected.resolve(); response.destroy(error); });
      });
    });
    try {
      await writer.migrate();
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      app.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const browser = vi.fn();
      const result = runGoogleSignIn({ state, recoveryToken: browserToken, signal: controller.signal,
        openAuthSession: browser, subscribeToUrls: () => ({ remove() {} }) });
      const outcome = result.then(value => ({ value }), error => ({ error }));
      await inspected.promise;
      expect({ requests, reads, cancellations }).toEqual({ requests: 3, reads: 1, cancellations: 0 });
      controller.abort(); release.resolve();
      expect(await outcome).toMatchObject({ error: { code: 'browser_canceled' } });
      expect({ requests, reads, cancellations }).toEqual({ requests: 4, reads: 1, cancellations: 1 });
      expect((await reader.findTicket(hash))?.consumedAt).toBeInstanceOf(Date);
      expect(browser).not.toHaveBeenCalled(); expect(authStorage.size).toBe(0); expect(errors).toEqual([]);
    } finally {
      controller.abort(); release.resolve(); googlePicker.enabled = false;
      await Promise.allSettled(pending); await new Promise<void>(resolve => server.close(() => resolve()));
      await readerDb.close(); await writerDb.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    }
  }, 20_000);

  it.each(['github', 'google'] as const)('F11: %s warm/cold callbacks share one held HTTP request and committed ticket', async provider => {
    authStorage.clear();
    const schema = `group_d_auth_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const config = { connectionString: url, options: `-c search_path=${schema},public`, max: 2 };
    const readerDb = new PostgresDatabase('', 2, { pool: new Pool(config) });
    const writerDb = new PostgresDatabase('', 2, { pool: new Pool(config) });
    const listener = new Client(config), reader = new AuthStore(readerDb), writer = new AuthStore(writerDb);
    const inspected = deferred(); let requests = 0, reads = 0;
    const state = 's'.repeat(43), token = 'r'.repeat(43);
    const hash = createHash('sha256').update(token).digest('hex');
    const pending: Promise<unknown>[] = [], controllers = new Set<AbortController>();
    const server = createServer((request, response) => {
      let body = ''; request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        const controller = new AbortController(); controllers.add(controller);
        response.once('close', () => { controller.abort(); controllers.delete(controller); });
        const work = (async () => {
          requests++;
          const args = JSON.parse(body) as { recoveryToken: string; waitMs?: number };
          expect(args.recoveryToken).toBe(token);
          const ticket = await waitForAuthTicket(wake => subscribeCommandCompletion({ principal: 'auth', operation: 'ticket', commandId: hash }, wake),
            async () => { reads++; const found = await reader.findTicket(hash); inspected.resolve(); return found; }, args.waitMs ?? 0, controller.signal);
          response.writeHead(ticket ? 200 : 202, { 'content-type': 'application/json' });
          response.end(JSON.stringify(ticket ? {
            protocol: 1, kind: 24250, marker: 'beeline-oidc-bind-v1', ticket: token,
            challenge: ticket.challenge, provider: ticket.issuer, audience: ticket.audience,
            subject: ticket.subject, community: ticket.community,
            issued_at: Math.floor(ticket.createdAt.getTime() / 1000), expires_at: Math.floor(ticket.expiresAt.getTime() / 1000),
          } : {}));
        })(); pending.push(work); void work.catch(error => response.destroy(error));
      });
    });
    try {
      await writer.migrate(); await listener.connect();
      listener.on('notification', event => { if (event.channel === COMMAND_COMPLETION_CHANNEL && event.payload) notifyCommandCompletion(event.payload); });
      await listener.query(`LISTEN ${COMMAND_COMPLETION_CHANNEL}`);
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      app.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const browser = { state, recoveryToken: token, platform: 'android', openAuthSession: async () => ({ type: 'opened' }), subscribeToUrls: () => ({ remove() {} }) };
      const warm = provider === 'github' ? runResilientGitHubSignInSession(browser) : runGoogleSignIn(browser);
      const warmResult = warm.then(value => ({ value }), error => ({ error }));
      await inspected.promise;
      const cold = provider === 'github'
        ? resumeInitialGitHubSignIn(async () => `beeline://beeline/github-callback?state=${state}&completed=1`)
        : resumeGoogleSignIn(`beeline://beeline/google-callback?state=${state}&completed=1`);
      const coldResult = cold.then(value => ({ value }), error => ({ error }));
      await vi.advanceTimersByTimeAsync(119_999);
      expect({ requests, reads }).toEqual({ requests: 1, reads: 1 });
      const ticket: BindTicket = { challenge: 'c'.repeat(43), community: 'synthetic.test', issuer: provider === 'github' ? 'https://github.com' : 'https://accounts.google.com',
        audience: 'fixture', subject: 'synthetic-person', createdAt: new Date(), expiresAt: new Date(Date.now() + 120_000), attemptCount: 0, consumedAt: null, boundPubkey: null };
      await writer.createTicket(hash, ticket);
      const first = await warmResult, second = await coldResult;
      expect(first).toEqual(second);
      if (provider === 'github') expect(first).toMatchObject({ value: { ticket: token, provider: 'https://github.com' } });
      else expect(first).toEqual({ value: token });
      expect({ requests, reads }).toEqual({ requests: 1, reads: 2 });
      await vi.advanceTimersByTimeAsync(600_000);
      expect({ requests, reads }).toEqual({ requests: 1, reads: 2 });
    } finally {
      for (const controller of controllers) controller.abort();
      vi.useRealTimers(); await Promise.allSettled(pending);
      await new Promise<void>(resolve => server.close(() => resolve())); await listener.end();
      await readerDb.close(); await writerDb.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    }
  }, 20_000);
});
