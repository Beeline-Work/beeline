import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import WebSocket, { WebSocketServer } from 'ws';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { RouterCommandReceipt } from '@beeline/api-contract/router-command';
import type { RouterFamily, RouterSnapshot, RouterSnapshotInput } from '@beeline/api-contract/router-protocol';
import type { TokenAuth } from './auth.js';
import type { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { migratedDatabase } from './test-support.js';

// Node-hosted production mobile transport, not an installed-native or paint
// proof. Only platform/UI/auth host seams are supplied; socket policy and both
// server dispatchers execute their actual implementation against a local DB.
interface Connection {
  register(filters: readonly unknown[], listener: () => void): Promise<() => void>;
  commandState(): { generation: number; ready: boolean; commandDedupV1: boolean };
  subscribeCommandCapabilities(listener: () => void): () => void;
  requestCommand(operation: string, args: unknown, identity: { v: 1; id: string }): Promise<RouterCommandReceipt>;
  reconnectNow(): void;
  dispose(): void;
}
let ConnectionClass: new (deps: object) => Connection;
let bundleDirectory: string;
beforeAll(async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const proof = path.join(root, '.beeline-proof');
  await mkdir(proof, { recursive: true });
  bundleDirectory = await mkdtemp(path.join(proof, 'router-mobile-transport-'));
  const stubs: Record<string, string> = {
    react: 'export const useSyncExternalStore=()=>{throw Error("UI hook outside scope");};',
    'react-native': `export const AppState={currentState:'active',addEventListener:()=>({remove(){}})};
      export const NativeModules={}; export const Platform={OS:'web'};`,
    '@/auth/monolith-session': `export class MonolithRequestTimeoutError extends Error {}
      export class MonolithSessionChangedError extends Error {}
      export const monolithSession={authorization:()=>{throw Error('Unexpected shared auth');}};`,
    '@/buzz/runtime-config': 'export const getBuzzRuntimeConfig=()=>{throw Error("Unexpected shared runtime");};',
    '@/buzz/room-draw-barrier': 'export const waitForRoomDraw=async()=>{};',
    '@/buzz/room-open-trace': 'export const markRoomOpen=()=>{};',
    '@/buzz/room-corner-store': `export const acceptCornerStatusFrame=()=>true;
      export const noteCornerLaneReleased=()=>{},noteCornerLaneSubscribed=()=>{},noteCornerSocketDropped=()=>{},noteRoomCornersChanged=()=>{};`,
    '@/sync/client-reset': 'export const subscribeClientReset=()=>()=>{};',
    '@/buzz/router-owner': 'throw Error("Production navigation bridge is outside this transport proof");',
  };
  const outfile = path.join(bundleDirectory, 'mobile.mjs');
  const result = await build({
    stdin: { contents: "export {LiveConnection} from './apps/mobile/sources/sync/transport/live-connection';", resolveDir: root },
    outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', metafile: true,
    plugins: [{ name: 'explicit-mobile-host-seams', setup(context) {
      context.onResolve({ filter: /^(?:@\/|react-native$|react$)/ }, args => {
        if (!Object.hasOwn(stubs, args.path)) throw new Error(`Unexpected mobile host dependency: ${args.path}`);
        return { path: args.path, namespace: 'host-seam' };
      });
      context.onLoad({ filter: /.*/, namespace: 'host-seam' }, args => ({ contents: stubs[args.path]!, loader: 'js' }));
    } }],
  });
  expect(Object.keys(result.metafile!.inputs).some(file => file.endsWith('/sync/transport/live-connection.ts'))).toBe(true);
  ConnectionClass = (await import(/* @vite-ignore */ pathToFileURL(outfile).href)).LiveConnection;
});
afterAll(async () => { if (bundleDirectory) await rm(bundleDirectory, { recursive: true, force: true }); });

function capabilities(connection: Connection, matches: (state: ReturnType<Connection['commandState']>) => boolean) {
  return new Promise<void>((resolve, reject) => {
    const finish = () => { clearTimeout(deadline); release(); };
    const check = () => { if (matches(connection.commandState())) { finish(); resolve(); } };
    const release = connection.subscribeCommandCapabilities(check);
    const deadline = setTimeout(() => { finish(); reject(new Error(`Capability transition deadline: ${JSON.stringify(connection.commandState())}`)); }, 5_000);
    check();
  });
}

it.each(['policy-off', 'legacy-sync'] as const)(
  'P10: actual mobile transport parks a lost command on %s and preserves identity on a later native recovery', async replacementWire => {
  const viewer = 'a'.repeat(64), workspace = '11111111-1111-4111-8111-111111111111';
  const room = '22222222-2222-4222-8222-222222222222', message = 'c'.repeat(64);
  const db = await migratedDatabase(), servers: Server[] = [], sockets: WebSocket[] = [];
  const legacyServers: WebSocketServer[] = [];
  const sent: Record<string, any>[] = [];
  let connection: Connection | undefined, dropReceipt = false, dropped = 0;
  let snapshot: ((input: RouterSnapshotInput) => Promise<RouterSnapshot>) | undefined;
  const allowed = new Set<string>();
  const command = { v: 1 as const, id: 'mobile-recovery-reaction' };
  const http = vi.fn(() => { throw new Error('Unexpected HTTP fallback'); });
  try {
    await db.query("INSERT INTO identities(id,kind,name) VALUES($1,'human','Reader')", [viewer]);
    await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Transport proof')", [workspace]);
    await db.query("INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')", [room, workspace, viewer]);
    await db.query("INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner')", [workspace, room, viewer]);
    await db.query("INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Synthetic message')", [message, room, viewer]);
    const origins: string[] = [];
    for (const selected of [true, false]) {
      const live = new LiveHub(), phone = new PhoneService(db, 'http://proof.invalid', undefined, undefined, live);
      let server: Server;
      if (!selected && replacementWire === 'legacy-sync') {
        // Exact pre-router sync acknowledgement from main f43bd3f86,
        // server.ts:1095-1140. This is a wire fixture, not the historical image:
        // it ignores negotiation and has no application operation handler.
        server = createServer((_request, response) => { response.writeHead(404); response.end(); });
        const legacy = new WebSocketServer({ server, path: '/v1/phone/live' });
        legacyServers.push(legacy);
        legacy.on('connection', client => client.on('message', raw => {
          if (JSON.parse(raw.toString()).type === 'sync') client.send('{"type":"sync-ok"}');
        }));
      } else server = createBeelineServer({ database: db, live, phone,
        auth: { authenticatePhone: async () => viewer } as unknown as TokenAuth,
        daemon: {} as DaemonService, mediaMaximumBytes: 1,
        ...(selected ? { routerProjections: { families: ['needs-you-count' as const], commandDedupV1: true, listenerReady: () => true } } : {}),
      });
      servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const origin = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
      origins.push(origin); allowed.add(origin);
    }
    class LoopbackSocket extends WebSocket {
      constructor(address: string, protocols?: string | string[]) {
        if (!allowed.has(new URL(address).origin)) throw new Error('Non-fixture socket denied');
        super(address, protocols); sockets.push(this);
      }
      override send(data: WebSocket.Data, ...rest: any[]) {
        sent.push(JSON.parse(String(data)));
        return super.send(data, ...rest);
      }
      override emit(event: string | symbol, ...args: any[]): boolean {
        if (event === 'message' && dropReceipt) {
          const frame = JSON.parse(String(args[0]));
          if (frame.t === 'res' && frame.ok === true && frame.result?.commandId === command.id) {
            // Drop the committed receipt at the actual transport boundary. The
            // next connection goes to the other server; no synthetic error is
            // injected into requestCommand or the dispatcher.
            dropReceipt = false; dropped++; this.close(); return true;
          }
        }
        return super.emit(event, ...args);
      }
    }
    vi.stubGlobal('WebSocket', LoopbackSocket); vi.stubGlobal('fetch', http);
    let origin = origins[0]!;
    connection = new ConnectionClass({
      authorization: async () => 'fixture-token', liveUrl: () => `${origin}/v1/phone/live`,
      subscribeIdentityChange: () => () => {},
      router: { requestedCapabilities: async () => ({ families: ['needs-you-count'], authorityFencesV1: true }),
        negotiated: async (next: { families: readonly RouterFamily[]; execute: (input: RouterSnapshotInput) => Promise<RouterSnapshot> }) => {
          if (next.families.includes('needs-you-count')) snapshot = next.execute;
        }, disconnected: () => {}, receive: () => {} },
    });
    const ready = capabilities(connection, state => state.ready && state.commandDedupV1);
    await connection.register([], () => {}); await ready;
    expect(snapshot).toBeTypeOf('function');
    const originalSnapshot = snapshot!;
    const snapshotInput = { family: 'needs-you-count' as const, workspaceId: workspace };
    expect(await originalSnapshot(snapshotInput)).toMatchObject({ value: { count: 0 } });
    const initialGeneration = connection.commandState().generation;
    const args = { roomId: room, messageId: message, emoji: '👍' };
    origin = origins[1]!; dropReceipt = true;
    const parked = capabilities(connection, state => state.ready && !state.commandDedupV1 && state.generation > initialGeneration);
    await expect(connection.requestCommand('reactToMessage', args, command)).rejects.toMatchObject({ name: 'PhoneSocketDisconnectedError' });
    await parked;
    expect(dropped).toBe(1); expect(sockets).toHaveLength(2);
    expect(sent.filter(frame => frame.t === 'req')).toHaveLength(2);
    // A retained owner callback cannot send an old selected read through the
    // new, incapable physical socket.
    await expect(originalSnapshot(snapshotInput)).rejects.toThrow();
    await expect(connection.requestCommand('reactToMessage', args, command)).rejects.toMatchObject({ code: 'command_unavailable' });
    expect(sent.filter(frame => frame.t === 'req')).toHaveLength(2);
    expect((await db.query('SELECT reactions FROM messages WHERE id=$1', [message])).rows)
      .toEqual([{ reactions: { '👍': [viewer] } }]);

    origin = origins[0]!;
    const recovered = capabilities(connection, state => state.ready && state.commandDedupV1);
    // Retry observes a healthy connection; it cannot replace an incapable
    // socket. A later native close is the transport's recovery evidence.
    connection.reconnectNow();
    expect(sockets).toHaveLength(2);
    expect(connection.commandState()).toMatchObject({ generation: initialGeneration + 1, ready: true, commandDedupV1: false });
    sockets.at(-1)!.close();
    await recovered;
    expect(await connection.requestCommand('reactToMessage', args, command)).toMatchObject({ state: 'committed', commandId: command.id });
    const requests = sent.filter(frame => frame.t === 'req' && frame.command);
    expect(requests).toHaveLength(2); expect(requests[1]!.command).toEqual(requests[0]!.command);
    expect(sent.filter(frame => frame.op === 'readRouterSnapshot')).toHaveLength(1);
    expect((await db.query('SELECT reactions FROM messages WHERE id=$1', [message])).rows)
      .toEqual([{ reactions: { '👍': [viewer] } }]);
    expect((await db.query('SELECT state FROM router_commands')).rows).toEqual([{ state: 'committed' }]);
    expect(sockets).toHaveLength(3); expect(http).not.toHaveBeenCalled();
  } finally {
    connection?.dispose();
    for (const socket of sockets) socket.terminate();
    for (const legacy of legacyServers) await new Promise<void>(resolve => legacy.close(() => resolve()));
    for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close(); vi.unstubAllGlobals();
  }
}, 30_000);
