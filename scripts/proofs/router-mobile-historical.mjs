import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

// Same explicit host seams as router-mobile-transport.integration.test.ts.
// The production transport and both server handlers execute unchanged.
export async function proveMobileHistoricalRecovery({ selectedOrigin, historicalOrigin, database, viewer, workspace, room, message }) {
  await mkdir('.beeline-proof', { recursive: true });
  const directory = await mkdtemp(path.resolve('.beeline-proof/historical-mobile-'));
  const sockets = [], sent = [], received = [];
  const originals = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch };
  let connection, drop = false, dropped = 0, fetches = 0;
  const command = { v: 1, id: 'historical-mobile-recovery' };
  try {
    const stubs = {
      react: 'export const useSyncExternalStore=()=>{throw Error("UI hook outside scope");};',
      'react-native': `export const AppState={currentState:'active',addEventListener:()=>({remove(){}})};export const NativeModules={};export const Platform={OS:'web'};`,
      '@/auth/monolith-session': `export class MonolithRequestTimeoutError extends Error {} export class MonolithSessionChangedError extends Error {} export const monolithSession={authorization:()=>{throw Error('Unexpected shared auth');}};`,
      '@/buzz/runtime-config': 'export const getBuzzRuntimeConfig=()=>{throw Error("Unexpected shared runtime");};',
      '@/buzz/room-draw-barrier': 'export const waitForRoomDraw=async()=>{};',
      '@/buzz/room-open-trace': 'export const markRoomOpen=()=>{};',
      '@/buzz/room-corner-store': `export const acceptCornerStatusFrame=()=>true;
        export const noteCornerLaneReleased=()=>{},noteCornerLaneSubscribed=()=>{},noteCornerSocketDropped=()=>{},noteRoomCornersChanged=()=>{};`,
      '@/sync/client-reset': 'export const subscribeClientReset=()=>()=>{};',
      '@/buzz/router-owner': 'throw Error("Production navigation bridge is outside this transport proof");',
    };
    const outfile = path.join(directory, 'transport.mjs');
    await build({ stdin: { contents: "export {LiveConnection} from './apps/mobile/sources/sync/transport/live-connection';", resolveDir: process.cwd() },
      outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external',
      plugins: [{ name: 'historical-mobile-host-seams', setup(api) {
        api.onResolve({ filter: /^(?:@\/|react-native$|react$)/ }, args => {
          assert.ok(Object.hasOwn(stubs, args.path), `Unexpected host seam ${args.path}`);
          return { path: args.path, namespace: 'host-seam' };
        });
        api.onLoad({ filter: /.*/, namespace: 'host-seam' }, args => ({ contents: stubs[args.path], loader: 'js' }));
      } }],
    });
    const { LiveConnection } = await import(pathToFileURL(outfile).href);
    const origins = new Set([selectedOrigin, historicalOrigin]);
    class LoopbackSocket extends WebSocket {
      constructor(url, protocols) {
        assert.ok(origins.has(new URL(url).origin), 'Socket must stay in the loopback fixture');
        super(url, protocols); sockets.push(this);
      }
      send(data, ...args) { sent.push(JSON.parse(String(data))); return super.send(data, ...args); }
      emit(event, ...args) {
        if (event === 'message') {
          const frame = JSON.parse(String(args[0]));
          received.push(frame.type ?? frame.kind ?? frame.t);
          if (received.length > 12) received.shift();
        }
        if (event === 'message' && drop) {
          const frame = JSON.parse(String(args[0]));
          if (frame.t === 'res' && frame.ok && frame.result?.commandId === command.id) {
            drop = false; dropped++; this.close(); return true;
          }
        }
        return super.emit(event, ...args);
      }
    }
    globalThis.WebSocket = LoopbackSocket;
    globalThis.fetch = () => { fetches++; throw new Error('Unexpected HTTP fallback'); };
    let origin = selectedOrigin, snapshot;
    connection = new LiveConnection({ authorization: async () => 'synthetic', liveUrl: () => `${origin}/v1/phone/live`,
      subscribeIdentityChange: () => () => {},
      router: { requestedCapabilities: async () => ({ families: ['needs-you-count'], authorityFencesV1: true }),
        negotiated: async next => { if (next.families.includes('needs-you-count')) snapshot = next.execute; },
        disconnected() {}, receive() {},
      },
    });
    const until = (phase, matches) => new Promise((resolve, reject) => {
      let release = () => {};
      const timer = setTimeout(() => { release(); reject(new Error(`Historical mobile ${phase} deadline: ${JSON.stringify({ state: connection.commandState(), received })}`)); }, 10_000);
      const check = () => { if (matches(connection.commandState())) { clearTimeout(timer); release(); resolve(); } };
      release = connection.subscribeCommandCapabilities(check); check();
    });
    const ready = until('initial', state => state.ready && state.commandDedupV1);
    await connection.register([], () => {}); await ready;
    assert.equal(typeof snapshot, 'function');
    const initialSnapshot = snapshot, input = { family: 'needs-you-count', workspaceId: workspace };
    assert.equal((await initialSnapshot(input)).value.count, 0);
    const generation = connection.commandState().generation;
    origin = historicalOrigin; drop = true;
    const parked = until('historical replacement', state => state.ready && !state.commandDedupV1 && state.generation > generation);
    const args = { roomId: room, messageId: message, emoji: '👍' };
    await assert.rejects(connection.requestCommand('reactToMessage', args, command)); await parked;
    assert.equal(dropped, 1); assert.equal(sockets.length, 2);
    await assert.rejects(initialSnapshot(input));
    await assert.rejects(connection.requestCommand('reactToMessage', args, command), { code: 'command_unavailable' });
    assert.equal(sent.filter(frame => frame.t === 'req').length, 2, 'No selected command/read may reach the historical server');
    origin = selectedOrigin;
    const recovered = until('explicit recovery', state => state.ready && state.commandDedupV1);
    connection.reconnectNow(); await recovered;
    const receipt = await connection.requestCommand('reactToMessage', args, command);
    assert.equal(receipt.state, 'committed'); assert.equal(receipt.commandId, command.id);
    const commands = sent.filter(frame => frame.t === 'req' && frame.command);
    assert.equal(commands.length, 2); assert.deepEqual(commands[0].command, commands[1].command);
    assert.equal(sent.filter(frame => frame.op === 'readRouterSnapshot').length, 1);
    assert.deepEqual((await database.query('SELECT reactions FROM messages WHERE id=$1', [message])).rows, [{ reactions: { '👍': [viewer] } }]);
    assert.deepEqual((await database.query('SELECT state FROM router_commands')).rows, [{ state: 'committed' }]);
    assert.equal(sockets.length, 3); assert.equal(fetches, 0);
    return { committedEffects: 1, durableRows: 1, snapshotReads: 1, incidentReplacements: 1,
      historicalSelectedRequests: 0, recoveryReusesIdentity: true, httpFallbacks: 0,
      scope: 'Actual mobile transport with supplied owner and platform/auth/UI seams; actual historical-source socket handler, current dependencies; no native/image claim' };
  } finally {
    connection?.dispose(); for (const socket of sockets) socket.terminate();
    globalThis.WebSocket = originals.WebSocket; globalThis.fetch = originals.fetch;
    await rm(directory, { recursive: true, force: true });
  }
}
