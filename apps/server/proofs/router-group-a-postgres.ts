import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Client, Pool, type QueryResultRow } from 'pg';
import WebSocket from 'ws';
import type { RouterFamily, RouterSnapshot, RouterSnapshotInput } from '@beeline/api-contract/router-protocol';
import type { RouterCommandIdentity } from '@beeline/api-contract/router-command';
import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import { RouterBatchAssembly } from '../../../packages/net/src/private/batch-assembly.js';
import { ReadLanes } from '../../../packages/net/src/private/read-lanes.js';
import { migrate, PostgresDatabase, type QueryResult, type SqlDatabase } from '../src/database.js';
import { LiveHub } from '../src/live.js';
import { PhoneService } from '../src/phone-service.js';
import { createBeelineServer } from '../src/server.js';
import type { TokenAuth } from '../src/auth.js';
import type { DaemonService } from '../src/daemon-service.js';
import { phoneReadLimits } from '../src/phone-read-limit.js';
import { COMMAND_COMPLETION_CHANNEL, notifyCommandCompletion } from '../src/command-completion.js';

export const reader = 'a'.repeat(64), peer = 'b'.repeat(64);
export const workspace = (n = 1) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
export const room = (n = 1) => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
export const origin = 'https://synthetic.invalid';

/** Observe the real query handles, including every nested transaction. */
export class ObservedDatabase implements SqlDatabase {
  readonly statements: Array<{ sql: string; args: unknown[]; rows?: readonly QueryResultRow[] }> = [];
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly database: SqlDatabase, private readonly root?: ObservedDatabase) {}
  async query<Row extends QueryResultRow = QueryResultRow>(sql: string, args: unknown[] = []): Promise<QueryResult<Row>> {
    const root = this.root ?? this, statement: ObservedDatabase['statements'][number] = { sql, args };
    root.active++; root.statements.push(statement);
    try { const result = await this.database.query<Row>(sql, args); statement.rows = result.rows; return result; }
    finally { root.complete(); }
  }
  async transaction<T>(work: (database: SqlDatabase) => Promise<T>): Promise<T> {
    const root = this.root ?? this; root.active++;
    try { return await this.database.transaction(tx => work(new ObservedDatabase(tx, root))); }
    finally { root.complete(); }
  }
  private complete() { if (!--this.active) for (const wake of this.waiters.splice(0)) wake(); }
  idle(): Promise<void> { return this.active ? new Promise(resolve => this.waiters.push(resolve)) : Promise.resolve(); }
  reset() { this.statements.length = 0; }
}

/** Full production migrations in a private schema on loopback PostgreSQL.
 * No substituted DTO builders, source triggers, clocks or authority readers. */
export async function groupAFixture(url: string) {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
    throw new Error('Group A proofs require isolated loopback PostgreSQL');
  const schema = `router_group_a_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { connectionString: url, options: `-c search_path=${schema},public`, max: 3 };
  const a = new PostgresDatabase('', 3, { pool: new Pool(options), mode: 'migration' });
  const b = new PostgresDatabase('', 3, { pool: new Pool(options), mode: 'migration' });
  const servers: Array<{ close: () => Promise<void> }> = [];
  async function server(database: SqlDatabase, families: readonly RouterFamily[], usageCellV1 = false, viewer = reader) {
    const observed = new ObservedDatabase(database), live = new LiveHub();
    const phone = new PhoneService(observed, origin), listener = new Client(options);
    const builds: RouterSnapshotInput[] = [];
    const originalBuild = phone.buildRouterValue.bind(phone);
    phone.buildRouterValue = async (...args) => { builds.push(args[1]); return originalBuild(...args); };
    const frames: Record<string, any>[] = [];
    const lanes = new ReadLanes({ origin, principal: viewer, sessionEpoch: 1 }, () => true);
    let applied = Promise.resolve();
    const waiters: Array<{ predicate: () => boolean; resolve: () => void }> = [];
    const wake = () => {
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]!.predicate()) waiters.splice(i, 1)[0]!.resolve();
    };
    const wait = (predicate: () => boolean) => predicate() ? Promise.resolve()
      : new Promise<void>(resolve => waiters.push({ predicate, resolve }));
    const assembly = new RouterBatchAssembly(
      facts => createHash('sha256').update(JSON.stringify(facts)).digest('hex'),
      batch => { applied = lanes.accept(batch).then(wake); },
      reason => { throw new Error(`Unexpected batch fault: ${reason}`); },
    );
    const http = createBeelineServer({ database: observed, live, phone,
      auth: { authenticatePhone: async (token: string) => token === 'synthetic-reader-token' ? viewer : null } as TokenAuth,
      daemon: {} as DaemonService, mediaMaximumBytes: 1, phoneReadLimits: phoneReadLimits(),
      routerProjections: { families, listenerReady: () => true, commandDedupV1: true, needsYouRoomsV1:true },
    });
    // Independent committed LISTEN for each server execution context. This is
    // a test bridge, not a second production listener or phone connection.
    listener.on('notification', notification => {
      if (notification.channel === COMMAND_COMPLETION_CHANNEL && notification.payload) {
        notifyCommandCompletion(notification.payload); return;
      }
      if (notification.channel !== 'beeline_live_v1' || !notification.payload) return;
      const event = JSON.parse(notification.payload);
      if (Array.isArray(event.journalStreams)) live.journalChanged(event.journalStreams);
    });
    await listener.connect(); await listener.query('LISTEN beeline_live_v1');
    await listener.query(`LISTEN ${COMMAND_COMPLETION_CHANNEL}`);
    await listener.query('LISTEN beeline_group_a_barrier');
    http.listen(0, '127.0.0.1'); await once(http, 'listening');
    const socket = new WebSocket(`ws://127.0.0.1:${(http.address() as AddressInfo).port}/v1/phone/live`, ['bearer.synthetic-reader-token']);
    const responses = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    const requests: Array<{ op: string; args: object }> = [];
    socket.on('message', raw => {
      const frame = JSON.parse(String(raw)); frames.push(frame);
      if (frame.kind === 'push-part' || frame.kind === 'push-commit') assembly.accept(frame);
      if(frame.kind==='authority-fence'){
        const epoch=frame.authority.scopes.find((scope:{authorityScope:string})=>scope.authorityScope===frame.authorityScope)?.epoch;
        if(!epoch)throw new Error('Missing proof authority epoch');
        applied=(frame.mode==='advance'?lanes.advance(frame.authorityScope,epoch):lanes.revoke(frame.authorityScope,epoch)).then(wake);
      }
      if (frame.t === 'res') {
        const pending = responses.get(frame.id); responses.delete(frame.id);
        if (frame.ok) pending?.resolve(frame.result);
        else pending?.reject(new Error(JSON.stringify(frame.error)));
      }
      wake();
    });
    socket.on('close', () => { for (const pending of responses.values()) pending.reject(new Error('Proof socket closed')); responses.clear(); });
    await once(socket, 'open');
    let sequence = 0;
    const request = <K extends keyof PhoneOperationMap>(op: K, args: PhoneOperationMap[K]['input'], command?: RouterCommandIdentity) => {
      requests.push({ op, args }); const id = `group-a-${++sequence}`;
      const reply = new Promise<PhoneOperationMap[K]['output']>((resolve, reject) => responses.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ t: 'req', id, op, args, ...(command ? { command } : {}) })); return reply;
    };
    const protocol = {
      snapshot: (input: RouterSnapshotInput): Promise<RouterSnapshot> => request('readRouterSnapshot', input),
      supports: (family: string) => frames.filter(frame => frame.type === 'router-capabilities').at(-1)?.families.includes(family) === true,
      handle: async (message: object) => {
        const position = frames.length;
        socket.send(JSON.stringify(message));
        await wait(() => frames.slice(position).some(frame => frame.type === 'router-capabilities'));
      },
    };
    await protocol.handle({ type: 'router-negotiate', protocol: 1, families, authorityFencesV1: true, usageCellV1, needsYouRoomsV1:true });
    let reads = 0;
    lanes.connected(1, families, async input => { reads++; return protocol.snapshot(input); });
    const releases: Array<() => void> = [];
    const demand = async (input: RouterSnapshotInput) => {
      const installed = wait(() => lanes.peek(input).state === 'LIVE');
      const unsubscribe = lanes.subscribe(input, wake);
      const release = lanes.demand(input, {}, { isCurrent: () => true });
      releases.push(release, unsubscribe); await installed;
      return release;
    };
    const barrier = async () => {
      const token = randomUUID();
      const delivered = new Promise<void>(resolve => {
        const onNotification = (notification: { channel: string; payload?: string }) => {
          if (notification.channel !== 'beeline_group_a_barrier' || notification.payload !== token) return;
          listener.off('notification', onNotification); resolve();
        };
        listener.on('notification', onNotification);
      });
      await database.query(`SELECT pg_notify('beeline_group_a_barrier',$1)`, [token]); await delivered;
      // Flush local asynchronous construction/fence continuations, then use a
      // transport-only barrier to consume already-enqueued frames. No phone
      // data request, polling query or synthetic journal cause is involved.
      for (let n = 0; n < 4; n++) { await observed.idle(); await new Promise<void>(resolve => setImmediate(resolve)); }
      const pong = once(socket, 'pong'); socket.ping(token); await pong;
      await applied;
    };
    const result = { observed, live, phone, frames, lanes, protocol, wait, demand, builds, requests, request, barrier,
      applied: () => applied, reads: () => reads,
      close: async () => {
        for (const release of releases) release();
        const closed = once(socket, 'close'); socket.terminate(); await closed;
        await new Promise<void>(resolve => http.close(() => resolve())); await listener.end();
      },
    };
    servers.push(result); return result;
  }
  const closeServers = async () => { await Promise.all(servers.splice(0).map(server => server.close())); };
  const close = async () => {
    await closeServers();
    await Promise.all([a.close(), b.close()]);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  };
  try {
    await migrate(a, { deferData: true });
    await a.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Reader','reader'),($2,'human','Peer','peer')`, [reader, peer]);
    await a.query(`INSERT INTO workspaces(id,name) SELECT id,'Workspace '||n FROM unnest($1::uuid[]) WITH ORDINALITY value(id,n)`,
      [Array.from({ length: 10 }, (_, n) => workspace(n + 1))]);
    await a.query(`INSERT INTO rooms(id,workspace_id,name) SELECT id,workspace,'Room '||n
      FROM unnest($1::uuid[],$2::uuid[]) WITH ORDINALITY value(id,workspace,n)`,
      [Array.from({ length: 16 }, (_, n) => room(n + 1)), Array.from({ length: 16 }, (_, n) => workspace(n < 10 ? n + 1 : 1))]);
    await a.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      SELECT id,NULL,person,'owner' FROM workspaces CROSS JOIN unnest($1::text[]) person`, [[reader, peer]]);
    await a.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      SELECT workspace_id,id,person,'owner' FROM rooms CROSS JOIN unnest($1::text[]) person`, [[reader, peer]]);
    return { a, b, server, close, closeServers };
  } catch (error) { await close(); throw error; }
}
