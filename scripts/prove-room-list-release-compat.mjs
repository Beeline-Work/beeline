// Historical-source compatibility proof, not an installed-native or production-image proof.
// Run from the repository root: NODE_OPTIONS=--max-old-space-size=4096 node --import tsx scripts/prove-room-list-release-compat.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import WebSocket from 'ws';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
const root = process.cwd();
await mkdir(resolve(root, '.beeline-proof'), { recursive: true });
const base = await mkdtemp(resolve(root, '.beeline-proof/room-list-release-'));
const sources = {
  v142: '98c2a49a4f3df909e8fd3fc32ae39129f6f8367b',
  main: '483ea07d07d2c747b026f3c9e7c4b95cd85a5d94',
};
for (const [version, ref] of Object.entries(sources)) {
  const destination = resolve(base, version);
  await mkdir(destination);
  const archive = resolve(base, version + '.tar');
  execFileSync(
    'git',
    [
      'archive',
      '--format=tar',
      '-o',
      archive,
      ref,
      'apps/server/src',
      'apps/server/assets',
      'apps/mobile/sources',
      'packages',
      'tsconfig.base.json',
    ],
    { cwd: root },
  );
  execFileSync('tar', ['-xf', archive, '-C', destination]);
}
console.log('Historical-source evidence directory: ' + base);
// Server source and migrations are pinned; installed server dependencies are current.
// Clients bundle their own pinned @beeline source. Auth and native host services below
// are synthetic; the production shared socket, owner, stores and validators execute.
const originalSocket = globalThis.WebSocket,
  originalFetch = globalThis.fetch;
const viewer = 'a'.repeat(64),
  workspace = '11111111-1111-4111-8111-111111111111',
  roomIds = Array.from(
    { length: 12 },
    (_, i) => '22222222-2222-4222-8222-' + String(i + 1).padStart(12, '0'),
  );
const results = [];
for (const serverVersion of ['v142', 'main', 'enabled']) {
  process.env.BEELINE_NETWORK_ROUTER_V1 = serverVersion === 'enabled' ? '1' : '0';
  const source = serverVersion === 'enabled' ? root : resolve(base, serverVersion);
  const mod = async (name) =>
    import(pathToFileURL(resolve(source, 'apps/server/src', name + '.ts')).href);
  const [
    { migrate },
    { PhoneService },
    { LiveHub },
    { createBeelineServer },
    { DurableLiveReplay },
  ] = await Promise.all(['database', 'phone-service', 'live', 'server', 'durable-live'].map(mod));
  const db = new PgliteDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Synthetic reader','reader');`,
    [viewer],
  );
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic workspace')`, [workspace]);
  for (const [index, room] of roomIds.entries()) {
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,$4)`, [
      room,
      workspace,
      viewer,
      'Synthetic Room ' + index,
    ]);
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,
      [workspace, room, viewer],
    );
  }
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner')`,
    [workspace, viewer],
  );
  const live = new LiveHub();
  const phone = new PhoneService(db, 'https://synthetic.invalid');
  let runtime;
  if (serverVersion === 'enabled') {
    const { createNetworkRouterRuntime } = await mod('network-router-runtime');
    runtime = createNetworkRouterRuntime({
      database: db,
      jobsDatabase: db,
      live,
      instanceId: 'synthetic-server',
      publicOrigin: 'https://synthetic.invalid',
      listenerReady: () => true,
      wake() {},
      retireOwner() {},
    });
  }
  const server = createBeelineServer({
    database: db,
    live,
    phone,
    replay: new DurableLiveReplay(db, live),
    auth: { authenticatePhone: async () => viewer },
    daemon: {},
    mediaMaximumBytes: 1,
    ...(runtime ? { routerProjections: runtime.policy, mediaMetadataV1: true } : {}),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const clientVersion of ['v142', 'main', 'enabled']) {
      const mobile = resolve(
        clientVersion === 'enabled' ? root : resolve(base, clientVersion),
        'apps/mobile/sources',
      );
      const frames = [];
      let connection;
      const stubs = {
        'react-native-mmkv': `export class MMKV {data=new Map();getString(k){return this.data.get(k)}set(k,v){this.data.set(k,v)}delete(k){this.data.delete(k)}getAllKeys(){return [...this.data.keys()]}contains(k){return this.data.has(k)}clearAll(){this.data.clear()}addOnValueChangedListener(){return{remove(){}}}}`,
        'expo-crypto': `export const getRandomBytes=n=>new Uint8Array(n).fill(1);`,
        'react-native': `export const AppState={currentState:'active',addEventListener:()=>({remove(){}})};export const InteractionManager={runAfterInteractions:work=>{const timer=setImmediate(work);return{cancel:()=>clearImmediate(timer)}}};export const NativeModules={};export const Platform={OS:'android'};`,
        '@/auth/monolith-session': `export class MonolithRequestTimeoutError extends Error {} export class MonolithSessionChangedError extends Error {} export const MONOLITH_REQUEST_TIMEOUT_MS=2000;export const monolithSession={authorization:async()=> 'synthetic',invalidateAuthorization(){}};`,
        '@/auth/buzz-identity-storage': `export const loadBuzzIdentity=async()=>({publicKey:'${viewer}'});export const getEffectiveRelayUrl=async()=> '${origin}';`,
        '@/buzz/runtime-config': `export const getBuzzRuntimeConfig=()=>({monolithUrl:'${origin}'});`,
        '@/buzz/room-draw-barrier': 'export const waitForRoomDraw=async()=>{};',
        '@/buzz/room-open-trace': 'export const markRoomOpen=()=>{};',
        '@/buzz/room-corner-store':
          'export const acceptCornerStatusFrame=()=>true;export const noteCornerLaneReleased=()=>{},noteCornerLaneSubscribed=()=>{},noteCornerSocketDropped=()=>{},noteRoomCornersChanged=()=>{},applyChatListCorners=()=>{},cornerStoreClock=()=>0,getRoomCornerSummary=()=>null;',
        '@/buzz/room-message-records': 'export const stampRoomMessageRows=()=>{};',
      };
      const entry =
        `export {sharedLiveConnection,resetSharedLiveConnection} from '${mobile}/sync/transport/live-connection';export {RoomViewClient} from '${mobile}/sync/transport/room-view-client';export {acquireChatList} from '${mobile}/buzz/chat-list-store';` +
        (clientVersion === 'v142'
          ? ''
          : `export * as owner from '${mobile}/buzz/router-owner';export {acquireRoutedChatList} from '${mobile}/buzz/router-chat-list';`);
      const outfile = resolve(base, `client-${serverVersion}-${clientVersion}.mjs`);
      await build({
        stdin: { contents: entry, resolveDir: root },
        outfile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        packages: 'external',
        plugins: [
          {
            name: 'host',
            setup(api) {
              api.onResolve({ filter: /.*/ }, (args) => {
                if (args.path.startsWith('@beeline/')) {
                  const [name, ...subpath] = args.path.slice('@beeline/'.length).split('/');
                  const packageRoot = resolve(
                    clientVersion === 'enabled' ? root : resolve(base, clientVersion),
                    'packages',
                    name,
                  );
                  const pkg = JSON.parse(
                    readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
                  );
                  const entry = pkg.exports[subpath.length ? './' + subpath.join('/') : '.'];
                  const target =
                    typeof entry === 'string' ? entry : (entry.import ?? entry.default);
                  return {
                    path: resolve(
                      packageRoot,
                      target.replace('./dist/', './src/').replace(/\.js$/, '.ts'),
                    ),
                  };
                }
                if (args.path === 'react')
                  return {
                    path: resolve(root, 'apps/mobile/node_modules/react/index.js'),
                    external: true,
                  };
                const key = args.path;
                if (Object.hasOwn(stubs, key)) return { path: key, namespace: 'host' };
                if (args.path.startsWith('@/'))
                  return { path: resolve(mobile, args.path.slice(2) + '.ts') };
              });
              api.onLoad({ filter: /.*/, namespace: 'host' }, (args) => ({
                contents: stubs[args.path],
                loader: 'js',
                resolveDir: root,
              }));
            },
          },
        ],
      });
      const sockets = [];
      globalThis.fetch = () => {
        throw Error('Unexpected HTTP request; proof permits only the loopback socket');
      };
      globalThis.WebSocket = class extends WebSocket {
        constructor(url, protocols) {
          if (new URL(url).origin !== origin.replace('http', 'ws')) throw Error('nonlocal socket');
          super(url, protocols);
          sockets.push(this);
          this.on('message', (data) => {
            frames.push(['receive', JSON.parse(String(data))]);
          });
        }
        send(data, ...args) {
          frames.push(['send', JSON.parse(String(data))]);
          return super.send(data, ...args);
        }
      };
      const client = await import(pathToFileURL(outfile).href);
      connection = client.sharedLiveConnection();
      let release, handle;
      try {
        release = await connection.register([], () => {});
        const reader = new client.RoomViewClient({
          relayUrl: origin,
          identity: { publicKey: viewer },
        });
        const workspaces = await reader.workspaces();
        assert.equal(workspaces.workspaces.length, 1);
        let chats;
        if (client.owner)
          client.owner.routerOwnerNavigation({
            routes: [
              { key: 'channels', name: 'beeline/channels', params: { communityId: workspace } },
            ],
          });
        chats = await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                Error(
                  'real chat store deadline; mode=' + client.owner?.routerFamilyMode('room-list'),
                ),
              ),
            4000,
          );
          const finish = (value) => {
            clearTimeout(timer);
            resolve(value);
          };
          handle = client.acquireChatList(
            { relayUrl: origin, viewerPubkey: viewer, workspaceId: workspace },
            {
              visible: () => true,
              onError: (error) => {
                clearTimeout(timer);
                reject(error);
              },
            },
          );
          const check = () => {
            const value = handle.current();
            if (value) finish(value);
          };
          handle.subscribe(check);
          check();
        });
        assert.deepEqual(chats.chats.map((chat) => chat.room.id).sort(), [...roomIds].sort());
        if (serverVersion === 'enabled' && clientVersion === 'enabled') {
          assert.equal(client.owner.routerFamilyMode('room-list'), 'router');
          assert.ok(
            frames.some(
              ([direction, frame]) => direction === 'send' && frame.op === 'readRouterSnapshot',
            ),
          );
        }
        results.push({
          server: serverVersion,
          client: clientVersion,
          status: 'PASS',
          rooms: chats.chats.length,
          mode: client.owner?.routerFamilyMode('room-list') ?? 'legacy',
          frames,
        });
      } catch (error) {
        results.push({
          server: serverVersion,
          client: clientVersion,
          status: 'FAIL',
          error: String(error),
          mode: client.owner?.routerFamilyMode('room-list'),
          frames,
        });
      } finally {
        handle?.release();
        release?.();
        client.resetSharedLiveConnection();
        for (const socket of sockets) socket.terminate();
        globalThis.WebSocket = originalSocket;
        globalThis.fetch = originalFetch;
      }
      console.log(JSON.stringify({ ...results.at(-1), frames: undefined }));
    }
  } finally {
    await runtime?.close();
    await new Promise((resolve) => server.close(resolve));
    await db.close();
  }
}
await writeFile(
  resolve(base, 'matrix.json'),
  JSON.stringify(
    {
      sources,
      candidate: {
        head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        source: 'current working tree',
        trackedChanges: execFileSync('git', ['diff', 'HEAD', '--name-only'], { encoding: 'utf8' })
          .trim()
          .split('\n')
          .filter(Boolean),
      },
      results,
    },
    null,
    2,
  ),
);
assert.equal(results.length, 9);
assert.equal(
  results.filter((result) => result.status !== 'PASS').length,
  0,
  'All nine source compatibility cases must load the complete Room list',
);
