// Local image smoke: exact Docker-built historical/current artifacts, production
// entrypoints and auth, no network namespace egress. Not a Fly rollout proof.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { planServerCanaryDeployment } from './unified-release.mjs';
import { proveImageCanaryAutoRevert } from './proofs/router-image-canary.mjs';
import path from 'node:path';

const execute = promisify(execFile);
const [historicalTag, candidateTag, socketPath] = process.argv.slice(2);
assert.ok(historicalTag && candidateTag && socketPath,
  'Usage: node scripts/prove-router-image-expansion.mjs <historical-image> <candidate-image> <owned-PG-socket>');
assert.ok(statSync(socketPath).isSocket(), 'The task-owned PostgreSQL Unix socket is required');
const adminUrl = new URL(process.env.BEELINE_COMMAND_TEST_POSTGRES_URL ?? '');
assert.ok(['127.0.0.1', 'localhost'].includes(adminUrl.hostname), 'Loopback test PostgreSQL required');
assert.equal(adminUrl.password, '', 'This proof uses only its disposable trust-authenticated cluster');
const docker = async (...args) => (await execute('docker', args, {
  timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
})).stdout.trim();
const inspectImage = async tag => {
  const [value] = JSON.parse(await docker('image', 'inspect', tag));
  return { id: value.Id, sourceSha: value.Config.Labels?.['app.usebeeline.release.sha'],
    version: value.Config.Labels?.['app.usebeeline.release.version'] };
};
const historical = await inspectImage(historicalTag), candidate = await inspectImage(candidateTag);
assert.equal(historical.sourceSha, 'f43bd3f86e4c7a30aa75378df82fcbda10027c72');
assert.match(candidate.sourceSha, /^[a-f0-9]{40}$/);
assert.notEqual(historical.id, candidate.id);
for (const image of [historical, candidate]) {
  const hash = text => createHash('sha256').update(text).digest('hex');
  const source = async file => (await execute('git', ['show', `${image.sourceSha}:${file}`], {
    maxBuffer: 16 * 1024 * 1024,
  })).stdout;
  image.dockerfileSha256 = hash(await source('apps/server/Dockerfile'));
  image.lockfileSha256 = hash(await source('package-lock.json'));
  const packaged = JSON.parse(await docker('run', '--rm', '--network', 'none', '--memory', '256m',
    image.id, 'node', '--input-type=module', '-e', `
      import {existsSync,readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
      console.log(JSON.stringify({node:process.version,lock:createHash('sha256').update(readFileSync('package-lock.json')).digest('hex'),
        fixtures:{auth:existsSync('apps/auth/dist/server-test-fixture.js'),body:existsSync('apps/body/dist/squire-broker-link.test-support.js')}}));`));
  assert.equal(packaged.lock, image.lockfileSha256, 'Packaged lock must match its exact source revision');
  image.node = packaged.node;
  image.packagedTestFixtures = packaged.fixtures;
}
assert.deepEqual(candidate.packagedTestFixtures, { auth: false, body: false },
  'The fresh candidate image must exclude the two proven test-only socket fixtures');
const identity = 'a'.repeat(64), message = 'c'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const token = 'synthetic-image-proof-access-token';
const suffix = randomUUID().replaceAll('-', '');
const databaseName = `router_image_${suffix}`;
const prefix = `beeline-network-ops-t7-${suffix.slice(0, 10)}`;
const port = adminUrl.port || '5432';
assert.ok(socketPath.endsWith(`/.s.PGSQL.${port}`));
const dbUrl = new URL(adminUrl); dbUrl.pathname = `/${databaseName}`;
const containerDbUrl = new URL(dbUrl); containerDbUrl.hostname = 'localhost';
containerDbUrl.searchParams.set('host', '/proofpg');
const common = ['--network', 'none', '--memory', '2g', '--memory-swap', '2g', '--cpus', '2',
  '--mount', `type=bind,src=${socketPath},dst=/proofpg/.s.PGSQL.${port},readonly`,
  '-e', `DATABASE_URL=${containerDbUrl}`, '-e', `MIGRATION_DATABASE_URL=${containerDbUrl}`,
  '-e', 'NODE_OPTIONS=--max-old-space-size=1536', '-e', 'BEELINE_NETWORK_ROUTER_V1=0',
  '-e', 'PUBLIC_ORIGIN=https://synthetic.invalid',
  '-e', `BEELINE_AUTH_TENANTS_JSON=${JSON.stringify([{ host: 'synthetic.invalid',
    community: 'synthetic-image-proof', roomCommunityIds: ['synthetic-image-proof'], origin: 'https://synthetic.invalid' }])}`,
  ...Object.entries({ ISSUER: 'https://synthetic.invalid', AUTHORIZATION_ENDPOINT: 'https://synthetic.invalid/authorize',
    TOKEN_ENDPOINT: 'https://synthetic.invalid/token', JWKS_URI: 'https://synthetic.invalid/keys',
    CLIENT_ID: 'synthetic', CLIENT_SECRET: 'synthetic' }).flatMap(([key, value]) => ['-e', `BEELINE_AUTH_OIDC_${key}=${value}`])];
const containers = new Set();
const admin = new Pool({ connectionString: adminUrl.href, max: 1 });
let database;
const startup = [];
const shutdown = [];
function waitForListening(name) {
  return new Promise((resolve, reject) => {
    const reader = spawn('docker', ['logs', '--follow', name], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const finish = error => {
      if (settled) return; settled = true;
      clearTimeout(deadline); reader.kill('SIGTERM');
      error ? reject(error) : resolve();
    };
    const deadline = setTimeout(() => finish(new Error(`Image startup deadline: ${name}\n${output}`)), 45_000);
    const consume = chunk => {
      output = (output + chunk).slice(-128_000);
      if (output.includes('[server] listening on')) finish();
    };
    reader.stdout.on('data', consume); reader.stderr.on('data', consume);
    reader.once('error', finish);
    reader.once('exit', code => finish(new Error(`Image exited before listening (${code}): ${output}`)));
  });
}
async function start(name, image) {
  console.error(`[image-proof] boot ${name} from ${image.sourceSha}`);
  containers.add(name);
  await docker('run', '-d', '--name', name, ...common, image.id);
  const [configuration] = JSON.parse(await docker('inspect', name));
  assert.equal(configuration.HostConfig.NetworkMode, 'none');
  assert.equal(configuration.HostConfig.Memory, 2 * 1024 ** 3);
  assert.equal(configuration.Config.Env.find(value => value.startsWith('NODE_ENV=')), 'NODE_ENV=production');
  await waitForListening(name);
  const health = JSON.parse(await docker('exec', name, 'node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const responses={};
    for(const path of ['/healthz','/readyz','/version']){
      const response=await fetch('http://127.0.0.1:8080'+path,{signal:AbortSignal.timeout(10000)});
      assert.equal(response.status,200,path);responses[path]=await response.json();
    }
    console.log(JSON.stringify(responses));`));
  assert.equal(health['/version'].sourceSha, image.sourceSha);
  startup.push({ name, imageId: image.id, health });
}
async function stop(name) {
  console.error(`[image-proof] drain ${name}`);
  await docker('stop', '--time', '15', name);
  const [stopped] = JSON.parse(await docker('inspect', name));
  shutdown.push({ name, exitCode: stopped.State.ExitCode, oomKilled: stopped.State.OOMKilled });
  assert.equal(stopped.State.OOMKilled, false);
  assert.equal(stopped.State.ExitCode, 0, 'Image swap must drain its production entrypoint');
  await docker('rm', name); containers.delete(name);
}
async function migrate(image) {
  console.error(`[image-proof] release migration from ${image.sourceSha}`);
  const name = `${prefix}-migration`;
  containers.add(name);
  await docker('run', '--rm', '--name', name, ...common, image.id, 'node', 'apps/server/dist/index.js', '--migrate');
  containers.delete(name);
}
async function request(name, op, args) {
  const result = await docker('exec', name, 'node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';import WebSocket from 'ws';
    const [token,op,args]=JSON.parse(process.argv[1]);
    const socket=new WebSocket('ws://127.0.0.1:8080/v1/phone/live',['bearer.'+token]);
    const deadline=setTimeout(()=>{socket.terminate();throw Error('Image socket response deadline');},10000);
    socket.once('open',()=>socket.send(JSON.stringify({t:'req',id:'image-proof',op,args})));
    socket.on('message',raw=>{const frame=JSON.parse(String(raw));if(frame.t!=='res'||frame.id!=='image-proof')return;
      clearTimeout(deadline);assert.equal(frame.ok,true,JSON.stringify(frame.error));console.log(JSON.stringify({result:frame.result}));socket.close();});
    socket.once('error',error=>{clearTimeout(deadline);throw error;});`, JSON.stringify([token, op, args]));
  return JSON.parse(result).result;
}
async function state() {
  const base = (await database.query('SELECT version FROM beeline_schema_state WHERE singleton')).rows[0].version;
  const router = (await database.query('SELECT version FROM beeline_router_schema_state WHERE singleton')).rows[0].version;
  assert.equal(base, 46); assert.equal(router, 61);
  return { base, router };
}
try {
  await admin.query(`CREATE DATABASE ${databaseName}`);
  database = new Pool({ connectionString: dbUrl.href, max: 1 });
  await migrate(historical);
  await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Synthetic image reader')`, [identity]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic image proof')`, [workspace]);
  await database.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`, [room, workspace, identity]);
  await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner')`, [workspace, room, identity]);
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Synthetic image message')`, [message, room, identity]);
  await database.query(`INSERT INTO phone_access_tokens(token_hash,identity_id,family_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')`,
    [createHash('sha256').update(token).digest('hex'), identity, randomUUID()]);
  const a = `${prefix}-a`, b = `${prefix}-b`;
  await start(a, historical); await start(b, historical);
  const before = await request(a, 'readRoom', { roomId: room });
  await migrate(candidate);
  const afterExpansion = await state();
  assert.deepEqual(await request(a, 'readRoom', { roomId: room }), before);
  assert.deepEqual(await request(b, 'readRoom', { roomId: room }), before);
  const reaction = { roomId: room, messageId: message, emoji: '👍' };
  await request(b, 'reactToMessage', reaction);
  assert.deepEqual((await database.query('SELECT reactions FROM messages WHERE id=$1', [message])).rows[0].reactions, { '👍': [identity] });
  // Follow the production plan's image order locally. No Fly API or registry is
  // contacted. This first swap injects failure after startup; the unchanged
  // 90-second shell runs after repeated migration below.
  const oldRef = `registry.fly.io/beeline-server:${historical.version}@${historical.id}`;
  const nextRef = `registry.fly.io/beeline-server:${candidate.version}@${candidate.id}`;
  const plan = planServerCanaryDeployment([{ id: 'a', imageRef: oldRef }, { id: 'b', imageRef: oldRef }], nextRef);
  assert.equal(plan.steps[0], 'migrate');
  await stop(a); await start(a, candidate);
  assert.deepEqual(await request(a, 'readRoom', { roomId: room }), await request(b, 'readRoom', { roomId: room }));
  await request(a, 'reactToMessage', reaction);
  assert.deepEqual((await database.query('SELECT reactions FROM messages WHERE id=$1', [message])).rows[0].reactions, {});
  assert.deepEqual(plan.rollbackSteps, [`update:a:${oldRef}`, 'fail-release']);
  await stop(a); await start(a, historical);
  const afterRollback = await request(a, 'readRoom', { roomId: room });
  assert.deepEqual(afterRollback, await request(b, 'readRoom', { roomId: room }));
  assert.deepEqual(await state(), afterExpansion, 'Image rollback must not restore the schema');
  await migrate(candidate);
  assert.deepEqual(await request(a, 'readRoom', { roomId: room }), afterRollback);
  assert.equal((await database.query('SELECT count(*)::int count FROM router_commands')).rows[0].count, 0,
    'Pre-switch image rollback proof must have no router-selected command');
  const canaryAutoRevert = await proveImageCanaryAutoRevert({ plan, historical, candidate,
    machineNames: { a, b }, socketDirectory: path.dirname(socketPath), token, room, docker, start, stop });
  assert.deepEqual(await state(), afterExpansion);
  assert.deepEqual(await request(a, 'readRoom', { roomId: room }), afterRollback);
  await stop(a); await stop(b);
  console.log(JSON.stringify({ status: 'PASS', historical, candidate, startup, shutdown,
    fullEntrypoints: true, productionAuthSyntheticToken: true, runtimeNetwork: 'none; task-owned PG Unix socket only',
    oldImagesSurviveFullMigration: true, oldNewLegacyWireEqual: true, writesBeforeAndAfterSwitch: true,
    rollbackWithoutSchemaRestore: true, repeatedMigration: true, markers: afterExpansion,
    plan, canaryAutoRevert,
    scope: 'Local full-image policy-off expansion and actual canary-shell smoke; not a separate expansion release, deployed ledger-aware floor, Fly/provider/native or production proof' }, null, 2));
} finally {
  for (const name of containers) await docker('rm', '-f', name).catch(error => console.error(`Cleanup ${name}: ${error.message}`));
  await database?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await admin.end();
}
