// Historical-source server smoke, not a historical image or dependency rebuild.
// Prepare source with git archive f43bd3f86... apps/server package.json, and link
// this checkout's node_modules. Run with node --import tsx and a loopback test PG.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import WebSocket from 'ws';
import * as candidateDatabase from '../apps/server/src/database.ts';
import { PhoneService } from '../apps/server/src/phone-service.ts';
import { LiveHub } from '../apps/server/src/live.ts';
import { DurableLiveReplay } from '../apps/server/src/durable-live.ts';
import { createBeelineServer } from '../apps/server/src/server.ts';
import { proveMobileHistoricalRecovery } from './proofs/router-mobile-historical.mjs';

const historicalRoot = process.argv[2];
assert.ok(historicalRoot, 'Historical source root is required');
const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
assert.ok(url && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname), 'Isolated loopback PostgreSQL required');
assert.equal(process.env.BEELINE_NETWORK_ROUTER_V1, '0', 'Expansion proof requires explicit router off');
const historicalRevision = 'f43bd3f86e4c7a30aa75378df82fcbda10027c72';
// Verify the complete archived server source before loading it. Dependencies
// intentionally come from this checkout and are separately labelled below.
const sourceTree = execFileSync('git', ['ls-tree', '-r', '-z', historicalRevision, 'apps/server'], { encoding: 'utf8' });
let historicalFiles = 0;
for (const entry of sourceTree.split('\0').filter(Boolean)) {
  const [metadata, file] = entry.split('\t');
  const [, kind, expected] = metadata.split(' ');
  assert.equal(kind, 'blob');
  const content = readFileSync(path.resolve(historicalRoot, file));
  const actual = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
  assert.equal(actual, expected, `Historical source mismatch: ${file}`);
  historicalFiles++;
}
const load = name => import(pathToFileURL(path.resolve(historicalRoot, `apps/server/src/${name}.ts`)).href);
const [historicalDatabase, historicalPhone, historicalLive, historicalServer, historicalReplay] = await Promise.all([
  load('database'), load('phone-service'), load('live'), load('server'), load('durable-live'),
]);
assert.equal(historicalDatabase.REQUIRED_SCHEMA_VERSION, 46);
const schema = `router_expansion_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: url, max: 1 });
await admin.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
await admin.query(`CREATE SCHEMA ${schema}`);
const database = new candidateDatabase.PostgresDatabase('', 3, {
  pool: new Pool({ connectionString: url, options: `-c search_path=${schema},public`, max: 3 }), mode: 'migration',
});
const viewer = 'a'.repeat(64), message = 'c'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111', room = '22222222-2222-4222-8222-222222222222';
const handles = [];
async function serve(old, selected = false) {
  const Hub = old ? historicalLive.LiveHub : LiveHub;
  const Phone = old ? historicalPhone.PhoneService : PhoneService;
  const factory = old ? historicalServer.createBeelineServer : createBeelineServer;
  const Replay = old ? historicalReplay.DurableLiveReplay : DurableLiveReplay;
  const live = new Hub(), phone = new Phone(database, 'https://synthetic.invalid', undefined, undefined, live);
  const server = factory({ database, live, phone, replay: new Replay(database, live),
    auth: { authenticatePhone: async token => token === 'synthetic' ? viewer : null }, daemon: {}, mediaMaximumBytes: 1,
    ...(selected ? { routerProjections: { families: ['needs-you-count'], commandDedupV1: true, listenerReady: () => true } } : {}),
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `ws://127.0.0.1:${server.address().port}`;
  const socket = new WebSocket(`${origin}/v1/phone/live`, ['bearer.synthetic']);
  await once(socket, 'open');
  let sequence = 0;
  const pending = new Map();
  socket.on('message', raw => {
    const frame = JSON.parse(String(raw));
    if (frame.t !== 'res') return;
    const resolve = pending.get(frame.id); pending.delete(frame.id); resolve?.(frame);
  });
  const handle = {
    origin,
    request: async (op, args) => {
      const id = String(++sequence);
      let deadline;
      const response = new Promise((resolve, reject) => {
        pending.set(id, resolve);
        deadline = setTimeout(() => { pending.delete(id); reject(new Error(`Historical-source ${op} response deadline`)); }, 20_000);
      });
      socket.send(JSON.stringify({ t: 'req', id, op, args }));
      try { const frame = await response; assert.equal(frame.ok, true, JSON.stringify(frame.error)); return frame.result; }
      finally { clearTimeout(deadline); }
    },
    close: async () => {
      const closed = once(socket, 'close'); socket.terminate(); await closed;
      await new Promise(resolve => server.close(resolve));
      handles.splice(handles.indexOf(handle), 1);
    },
  };
  handles.push(handle); return handle;
}
const columns = async () => (await database.query(`SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=$1 ORDER BY table_name,column_name`, [schema])).rows;
try {
  await historicalDatabase.migrate(database);
  await historicalDatabase.markSchemaCurrent(database);
  await historicalDatabase.assertSchemaCurrent(database);
  await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Synthetic reader')`, [viewer]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic expansion')`, [workspace]);
  await database.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`, [room, workspace, viewer]);
  await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner')`, [workspace, room, viewer]);
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Synthetic migration message')`, [message, room, viewer]);
  const old = await serve(true);
  const before = await old.request('readRoom', { roomId: room });
  const baseline = await columns();
  await candidateDatabase.migrate(database);
  await candidateDatabase.markSchemaCurrent(database);
  await historicalDatabase.assertSchemaCurrent(database);
  await candidateDatabase.assertSchemaCurrent(database);
  const expanded = await columns(), byColumn = new Map(expanded.map(row => [`${row.table_name}.${row.column_name}`, row]));
  for (const row of baseline) assert.deepEqual(byColumn.get(`${row.table_name}.${row.column_name}`), row, `Changed historical column ${row.table_name}.${row.column_name}`);
  assert.deepEqual(await old.request('readRoom', { roomId: room }), before, 'Running old handler changed after expansion');
  const reaction = { roomId: room, messageId: message, emoji: '👍' };
  await old.request('reactToMessage', reaction);
  assert.deepEqual((await database.query('SELECT reactions FROM messages WHERE id=$1', [message])).rows[0].reactions, { '👍': [viewer] });
  await old.close();
  await historicalDatabase.assertSchemaCurrent(database);
  const restarted = await serve(true), current = await serve(false);
  assert.deepEqual(await restarted.request('readRoom', { roomId: room }), await current.request('readRoom', { roomId: room }), 'Old/new legacy Room wire differs');
  await current.request('reactToMessage', reaction);
  assert.deepEqual((await database.query('SELECT reactions FROM messages WHERE id=$1', [message])).rows[0].reactions, {});
  // Both deliberate reaction writes increment the message's durable version.
  // Compare migration against this current state, not the pre-write revision0.
  const beforeRepeat = await restarted.request('readRoom', { roomId: room });
  assert.equal(beforeRepeat.messages.find(row => row.id === message).version, 2);
  await candidateDatabase.migrate(database);
  await candidateDatabase.markSchemaCurrent(database);
  await historicalDatabase.assertSchemaCurrent(database);
  assert.deepEqual(await restarted.request('readRoom', { roomId: room }), beforeRepeat, 'Repeated expansion changed historical Room wire');
  const selected = await serve(false, true);
  const mobileRecovery = await proveMobileHistoricalRecovery({ selectedOrigin: selected.origin,
    historicalOrigin: restarted.origin, database, viewer, workspace, room, message });
  const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  console.log(JSON.stringify({ status: 'PASS', historicalRevision, historicalFiles,
    productionBaseHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    scope: 'Historical source with current installed dependencies, synthetic auth, real loopback sockets/PostgreSQL; no image/startup background/native/deployed floor claim',
    installedDependencyLockSha256: hash('package-lock.json'), node: process.version,
    historicalEntries: Object.fromEntries(['database', 'phone-service', 'live', 'server'].map(name => [name, hash(path.resolve(historicalRoot, `apps/server/src/${name}.ts`))])),
    legacyColumnsPreserved: baseline.length, additiveColumns: expanded.length - baseline.length,
    oldBootAfterExpansion: true, oldSocketReadAfterExpansion: true, oldWriteAfterExpansion: true,
    oldHandlerRestart: true, currentLegacyWireEqual: true, currentWrite: true, repeatedExpansion: true,
    mobileRecovery,
  }));
} finally {
  for (const handle of [...handles]) await handle.close();
  await database.close();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
}
