/** R1 stand-in: built phone clients against a built server with blackholed HTTP. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import WebSocket from 'ws';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { TokenAuth } from '../apps/server/dist/auth.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { createBeelineServer } from '../apps/server/dist/server.js';

const root = process.cwd(), output = path.join(root, '.beeline-proof/phone-socket-r1');
const baseline = process.argv[process.argv.indexOf('--baseline-ref') + 1];
if (!process.argv.includes('--baseline-ref') || !baseline) throw Error('Supply --baseline-ref with the pre-migration commit');
const human = 'a'.repeat(64), workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222', seed = 'b'.repeat(64), message = 'c'.repeat(64);
const database = new PgliteDatabase(), live = new LiveHub();
const auth = new TokenAuth(database, async subject => ({ subject, login: subject, name: subject }));
const phone = new PhoneService(database, 'http://proof', undefined, undefined, live);
const server = createBeelineServer({ database, auth, phone, live, daemon: new DaemonService(database, live), mediaMaximumBytes: 1 });
const clients = [], evidence = { reproduction: 'R1', baseline, limitation: 'Android emulator failed: /dev/kvm permission denied. This is a Node-hosted phone transport/service proof, not a native paint or radio test.' };
let httpRequests = 0, socketRequests = 0, socketsOpened = 0;
class ProofWebSocket extends WebSocket {
  constructor(...args) { super(...args); socketsOpened++; clients.push(this); }
  send(data, ...args) { if (JSON.parse(String(data)).t === 'req') socketRequests++; return super.send(data, ...args); }
}
globalThis.WebSocket = ProofWebSocket;
// Model the silently dead web connection at the actual HTTP service boundary.
const handlers = server.listeners('request'); server.removeAllListeners('request');
server.on('request', (request, response) => {
  if (request.url.startsWith('/v1/phone/')) { httpRequests++; return; }
  for (const handler of handlers) handler.call(server, request, response);
});
async function bundle(label, origin, token, before = false) {
  const stubs = {
    'react': 'export const useSyncExternalStore=(_subscribe,read)=>read();',
    'react-native': `export const AppState={currentState:'active',addEventListener:()=>({remove(){}})};`,
    '@react-native-community/netinfo': `export default {addEventListener:()=>()=>{}};`,
    '@/auth/monolith-session': `export const MONOLITH_REQUEST_TIMEOUT_MS=15000;
      export class MonolithRequestTimeoutError extends Error {constructor(){super('The server did not answer in time.');this.name='MonolithRequestTimeoutError';}}
      export class MonolithSessionChangedError extends Error {}
      export const monolithResponseTiming=()=>null;
      export const monolithSession={authorization:async()=>${JSON.stringify(token)},noteStalled(){},
        fetch:(url,init)=>fetch(url,{...init,headers:{...init?.headers,authorization:'Bearer '+${JSON.stringify(token)}}})};`,
    '@/buzz/runtime-config': `export const getBuzzRuntimeConfig=()=>({monolithUrl:${JSON.stringify(origin)}});`,
    '@/buzz/room-open-trace': 'export const markRoomOpen=()=>{}; export const recordRoomReadNetworkTiming=()=>{};',
    '@/buzz/room-corner-store': `export const acceptCornerStatusFrame=()=>true;
      export const noteCornerLaneReleased=()=>{},noteCornerLaneSubscribed=()=>{},noteCornerSocketDropped=()=>{},noteRoomCornersChanged=()=>{};`,
    '@/sync/client-reset': 'export const subscribeClientReset=()=>()=>{};',
    '@/buzz/room-message-records': 'export const stampRoomMessageRows=()=>{};',
    '@/auth/signin-funnel': 'export const funnelSuccessfulOperation=()=>{};',
  };
  const outfile = path.join(output, `${label}.mjs`);
  await build({ stdin: { contents: `export {RoomViewClient} from './apps/mobile/sources/sync/transport/room-view-client';
      export {monolithPhoneOperation} from './apps/mobile/sources/sync/transport/monolith-operation';
      export {sharedLiveConnection,resetSharedLiveConnection} from './apps/mobile/sources/sync/transport/live-connection';
      export * from './apps/mobile/sources/buzz/room-draw-barrier';`, resolveDir: root },
    outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', plugins: [{ name: 'phone-host-seams', setup(context) {
      context.onResolve({ filter: /^(?:@\/|react-native$|react$|@react-native-community\/netinfo$)/ }, args => {
        if (stubs[args.path]) return { path: args.path, namespace: 'proof' };
        if (args.path.startsWith('@/')) return { path: path.join(root, 'apps/mobile/sources', `${args.path.slice(2)}.ts`) };
      });
      context.onLoad({ filter: /.*/, namespace: 'proof' }, args => ({ contents: stubs[args.path], loader: 'js' }));
      if (before) context.onLoad({ filter: /(?:room-view-client|monolith-operation)\.ts$/ }, args => ({
        contents: execFileSync('git', ['show', `${baseline}:${path.relative(root, args.path)}`], { encoding: 'utf8' }), loader: 'ts',
      }));
    } }] });
  return import(pathToFileURL(outfile));
}
try {
  await mkdir(output, { recursive: true }); await migrate(database);
  await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','R1 viewer')`, [human]);
  await database.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
    VALUES('github','r1-proof',$1,'https://github.com','beeline','r1-proof')`, [human]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'R1 proof')`, [workspace]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'R1 Room',$3)`, [room, workspace, human]);
  await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner')`, [workspace, room, human]);
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Existing Room text')`, [seed, room, human]);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`, token = (await auth.exchangeGitHubOidc('r1-proof')).accessToken;
  const options = { baseUrl: origin, identity: { publicKey: human, secretKey: new Uint8Array(32) } };
  const old = await bundle('before', origin, token, true);
  const started = Date.now();
  const failure = await new old.RoomViewClient(options).room(room).then(() => null, e => e);
  assert.equal(failure?.code, 'timeout'); assert.equal(httpRequests, 1);
  evidence.before = { result: 'Room opening fails at the existing deadline while HTTP is silent', error: failure.code, elapsedMs: Date.now() - started, httpRequests, socketRequests };
  old.resetSharedLiveConnection();
  const current = await bundle('after', origin, token), client = new current.RoomViewClient(options);
  current.beginRoomDraw(room);
  let optionalFinished = false;
  const optional = client.chats(workspace).then(value => { optionalFinished = true; return value; });
  const view = await client.room(room);
  assert.ok(view.messages.some(value => value.text === 'Existing Room text')); assert.equal(optionalFinished, false);
  current.observeVisibleRoomRows(room, [seed]); current.finishRoomDraw(seed, room);
  await optional;
  assert.ok((await client.workspaces()).workspaces.some(value => value.id === workspace));
  await client.history(room); await client.markRead(room, seed);
  const send = { roomId: room, messageId: message, text: 'Message sent while HTTP stays silent' };
  await current.monolithPhoneOperation('sendRoomMessage', send);
  await current.monolithPhoneOperation('sendRoomMessage', send);
  const refreshed = await client.room(room);
  assert.equal(refreshed.messages.filter(value => value.id === message).length, 1);
  assert.equal(refreshed.messages.find(value => value.id === message).text, send.text);
  assert.equal(httpRequests, 1); assert.equal(socketsOpened, 1);
  evidence.after = { result: 'Room open, Room refresh, history, lists, read mark and deduplicated send pass while HTTP stays silent; optional list waits for Room draw', httpRequests: 0, socketRequests, socketsOpened, messageCount: 1 };
  current.resetSharedLiveConnection();
  await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  for (const client of clients) client.terminate();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await database.close();
}
