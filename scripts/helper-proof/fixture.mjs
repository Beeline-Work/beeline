import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeypair } from '../../packages/nostr/dist/index.js';
import { AuthStore } from '../../apps/auth/dist/store.js';
import { migrate } from '../../apps/server/src/database.ts';
import { PgliteDatabase } from '../../apps/server/src/test-support.ts';
import { TokenAuth } from '../../apps/server/src/auth.ts';
import { PhoneService } from '../../apps/server/src/phone-service.ts';
import { DaemonService } from '../../apps/server/src/daemon-service.ts';
import { LiveHub } from '../../apps/server/src/live.ts';
import { ReleaseNotifier } from '../../apps/server/src/release-notify.ts';
import { createBeelineServer } from '../../apps/server/src/server.ts';
import { HelperVersionGate } from '../../apps/server/src/helper-version-gate.ts';

const exec = promisify(execFile);
const home = process.env.HOME;
if (home !== '/home/proof' || !process.env.BEELINE_NATIVE_PROOF)
  throw new Error('fixture requires the isolated proof container');
const web = '/workspace/relay-stack/web';
const original = await readFile(`${web}/dl/beeline-linux-x64.tar.gz`);
let archive = original,
  digest = createHash('sha256').update(archive).digest('hex');
let version = 'v0.2.0',
  commit = '1'.repeat(40),
  fault = '';
let hold = false,
  slowDownload = false;
let loseExchangeReply = false;
let publicationAvailable = true;
const held = new Set();
const downloadListeners = new Set();
const harnessListeners = new Set();
const calls = new Map();
export const stateRoot = `${home}/.local/state`;
export const workspaceId = '11111111-1111-4111-8111-111111111111';
export const roomId = '22222222-2222-4222-8222-222222222222';
export const owner = 'a'.repeat(64);
export const database = new PgliteDatabase();
await migrate(database);
await new AuthStore(database).migrate();
export const auth = new TokenAuth(database, async () => {
  throw new Error('fixture has no external sign-in');
});
export const live = new LiveHub();
export const phone = new PhoneService(database, 'http://fixture', undefined, undefined, live);
const daemon = new DaemonService(database, live);
export const releases = new ReleaseNotifier(database, { secret: 'fixture-release', live });
export const helperVersionGate = new HelperVersionGate();
const backendOptions = {
  database,
  auth,
  phone,
  daemon,
  live,
  helperVersionGate,
  mediaMaximumBytes: 1024,
  releaseNotify: releases,
  legacyMigrationOrigin: '',
  liveHeartbeatMs: 1000,
};
const backend = createBeelineServer(backendOptions);
await database.query(
  `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner')`,
  [owner],
);
await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Native fixture')`, [workspaceId]);
await database.query(
  `INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`,
  [workspaceId, owner],
);
export const agents = [];
const server = createServer(async (request, response) => {
  try {
    calls.set(request.url, (calls.get(request.url) ?? 0) + 1);
    if (request.url === '/dl/manifest.json' && !publicationAvailable)
      return response.writeHead(503).end('publication unavailable');
    if (request.url === '/dl/manifest.json')
      return response.end(
        JSON.stringify({
          sourceCommit: commit,
          version,
          bundles: { 'linux-x64': { file: 'beeline-linux-x64.tar.gz', sha256: digest } },
        }),
      );
    if (request.url === '/dl/beeline-linux-x64.tar.gz') {
      for (const done of downloadListeners) done();
      downloadListeners.clear();
      if (slowDownload) {
        response.write(archive.subarray(0, 1024));
        return;
      }
      return response.end(archive);
    }
    if (
      request.url === '/dl/beeline-bootstrap.mjs' ||
      request.url === '/dl/beeline-bootstrap.mjs.sha256'
    )
      return response.end(await readFile(`${web}${request.url}`));
    if (request.url === '/install') return response.end(await readFile(`${web}/install.sh`));
    if (request.url === '/harness/answer') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      for (const done of harnessListeners) done(input);
      harnessListeners.clear();
      if (hold && input.agentId === agents[0] && input.text.includes('native-held')) {
        // Undici's default five-minute headers/body timeout must not make the
        // held command become idle just before the real five-minute handoff.
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write(' ');
        const heartbeat = setInterval(() => response.write(' '), 30_000);
        await new Promise((done) => {
          const finish = () => {
            held.delete(finish);
            clearInterval(heartbeat);
            done();
          };
          held.add(finish);
          response.once('close', finish);
        });
      }
      return response.end(JSON.stringify({ text: 'Native fixture reply.' }));
    }
    if (request.url?.startsWith('/v1/')) {
      if (request.url === '/v1/auth/daemon/exchange') {
        const end = response.end.bind(response);
        response.end = (...args) => {
          if (loseExchangeReply && JSON.parse(String(args[0] || '{}')).agentId === agents[1]) {
            loseExchangeReply = false;
            response.socket.destroy();
            return response;
          }
          return end(...args);
        };
      }
      if (/\/(?:postRoomMessage|postAgentTurnReceipt)$/.test(request.url))
        response.once('finish', () => {
          live.publish({ type: 'invalidate', roomId, reason: 'fixture-committed-write' });
        });
      return backend.emit('request', request, response);
    }
    response.writeHead(404).end('fixture route not found');
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});
server.on('upgrade', (request, socket, head) => backend.emit('upgrade', request, socket, head));
await new Promise((done) => server.listen(0, '127.0.0.1', done));
export const origin = `http://127.0.0.1:${server.address().port}`;
backendOptions.legacyMigrationOrigin = origin;
await mkdir(`${home}/.trusty-squire/mcp-broker-install/node_modules/@trusty-squire/mcp`, {
  recursive: true,
});
await writeFile(
  `${home}/.trusty-squire/mcp-broker-install/node_modules/@trusty-squire/mcp/package.json`,
  JSON.stringify({ version: '1.1.32' }),
);
const harness = `${home}/fixture-acp.mjs`;
await writeFile(
  harness,
  `#!/usr/local/bin/node
import { createInterface } from 'node:readline';
const sessions = new Map();
const send = (value) => console.log(JSON.stringify(value));
createInterface({ input: process.stdin }).on('line', async (line) => {
  const request = JSON.parse(line); if (!request.id) return;
  let result = {};
  if (request.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: { image: true } }, authMethods: [], agentInfo: { name: 'native-fixture', version: '1' } };
  if (request.method === 'session/new') result = { sessionId: crypto.randomUUID(), models: { currentModelId: 'fixture', availableModels: [{ modelId: 'fixture', name: 'Fixture' }] }, modes: { currentModeId: 'readonly', availableModes: [{ id: 'readonly', name: 'Read only' }, { id: 'code', name: 'Code' }] } };
  if (request.method === 'session/prompt') {
    const controller = new AbortController(); sessions.set(request.params.sessionId, controller);
    const text = JSON.stringify(request.params.prompt);
    try {
      const response = await fetch(${JSON.stringify(origin + '/harness/answer')}, { method: 'POST', body: JSON.stringify({ text, agentId: process.argv[2] }), signal: controller.signal });
      const answer = await response.json();
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: request.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer.text } } } });
      result = { stopReason: 'end_turn' };
    } catch { result = { stopReason: 'cancelled' }; }
    sessions.delete(request.params.sessionId);
  }
  if (request.method === 'session/cancel') sessions.get(request.params.sessionId)?.abort();
  send({ jsonrpc: '2.0', id: request.id, result });
});
`,
  { mode: 0o755 },
);
for (let index = 0; index < 2; index++) {
  const key = generateKeypair(),
    body = generateKeypair();
  const stored = (value, name) => ({
    name,
    publicKey: value.publicKey,
    secretKeyHex: Buffer.from(value.secretKey).toString('hex'),
  });
  await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent',$2,$3)`, [
    key.publicKey,
    `Fixture ${index}`,
    `bee${index}`,
  ]);
  await database.query(
    `INSERT INTO agents(agent_id,owner_id,selected_model) VALUES($1,$2,'fixture')`,
    [key.publicKey, owner],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`,
    [workspaceId, key.publicKey],
  );
  const exchange = index ? undefined : await auth.createDaemonExchange(key.publicKey);
  const runtime = {
    version: 2,
    communityId: workspaceId,
    pairedBy: owner,
    agent: stored(key, `Fixture ${index}`),
    body: stored(body, 'Body'),
    rooms: [],
    supervisorRoot: stateRoot,
    ...(exchange
      ? { transport: { kind: 'monolith', baseUrl: origin, exchangeToken: exchange.exchangeToken } }
      : {}),
    agentKind: 'reference',
    agentBinary: harness,
    agentCommand: harness,
    agentArgs: [key.publicKey],
    mcpBinary: '/bin/true',
    sandbox: 'off',
    accessPolicy: 'creator',
  };
  const directory = `${stateRoot}/beeline/agents/${key.publicKey}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(`${directory}/runtime.json`, JSON.stringify(runtime), { mode: 0o600 });
  agents.push(key.publicKey);
}
export async function makeRelease(nextVersion, nextCommit, nextFault = '') {
  const directory = await mkdtemp(`${home}/artifact-`);
  try {
    const input = `${directory}/original.tar.gz`;
    await writeFile(input, original);
    await mkdir(`${directory}/release`);
    await exec('tar', ['-xzf', input, '-C', `${directory}/release`]);
    const metadataPath = `${directory}/release/lib/beeline/bundle.json`;
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    await writeFile(
      metadataPath,
      JSON.stringify({
        ...metadata,
        version: nextVersion,
        commit: nextCommit,
        ...(nextFault === 'engine' ? { node: '>=99.0.0' } : {}),
      }),
    );
    if (nextFault === 'import')
      await writeFile(
        `${directory}/release/lib/beeline/beeline-cli.mjs`,
        "throw new Error('fixture import failure');\n",
      );
    const output = `${directory}/bundle.tar.gz`;
    await exec('tar', ['-czf', output, '-C', `${directory}/release`, 'bin', 'lib']);
    archive = await readFile(output);
    version = nextVersion;
    commit = nextCommit;
    fault = nextFault;
    digest =
      nextFault === 'checksum'
        ? '0'.repeat(64)
        : createHash('sha256').update(archive).digest('hex');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export function holdWork(value) {
  hold = value;
  if (!hold) {
    for (const done of held) done();
    held.clear();
  }
}
export function loseLegacyExchangeReply() {
  loseExchangeReply = true;
}
export function setPublicationAvailable(value) {
  publicationAvailable = value;
}
export async function addUnrecognizedAgent() {
  const identity = generateKeypair();
  const runtime = JSON.parse(
    await readFile(`${stateRoot}/beeline/agents/${agents[0]}/runtime.json`, 'utf8'),
  );
  runtime.agent = {
    name: 'Unrecognized',
    publicKey: identity.publicKey,
    secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
  };
  delete runtime.transport;
  const directory = `${stateRoot}/beeline/agents/${identity.publicKey}`;
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/runtime.json`, JSON.stringify(runtime), { mode: 0o600 });
  return identity.publicKey;
}
export function holdDownload(value) {
  slowDownload = value;
}
export function nextDownload() {
  return new Promise((done) => downloadListeners.add(done));
}
export function nextHarness() {
  return new Promise((done) => harnessListeners.add(done));
}
export async function addRoom() {
  await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Native work')`, [
    roomId,
    workspaceId,
  ]);
  for (const id of [owner, ...agents])
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,$4)`,
      [workspaceId, roomId, id, id === owner ? 'owner' : 'member'],
    );
  for (const id of agents)
    live.publish({
      type: 'invalidate',
      roomId,
      workspaceId,
      targetAgentId: id,
      reason: 'postgres:memberships',
    });
}
export async function message(text, index = 0) {
  const id = createHash('sha256').update(text).update(String(Date.now())).digest('hex');
  const result = await phone.execute(
    'sendRoomMessage',
    { roomId, messageId: id, text: `@bee${index} ${text}`, wakes: [] },
    owner,
  );
  live.publish({ type: 'invalidate', roomId, reason: 'fixture-commit' });
  live.publish({
    type: 'invalidate',
    roomId,
    reason: 'postgres:agent_commands',
    targetAgentId: agents[index],
  });
  return result.messageId;
}
export async function waitReply(requestId, timeoutMs = 30_000) {
  let wake,
    changed = false;
  const off = live.subscribeAll(() => {
    changed = true;
    wake?.();
  });
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      changed = false;
      const rows = await database.query(
        `SELECT text FROM messages WHERE request_id=$1 AND author_id=ANY($2::text[]) AND presentation='message'`,
        [requestId, agents],
      );
      if (rows.rows.length) return rows.rows;
      if (changed) continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('native reply deadline exceeded');
      await new Promise((done, reject) => {
        const timer = setTimeout(
          () => reject(new Error('native reply deadline exceeded')),
          remaining,
        );
        wake = () => {
          clearTimeout(timer);
          done();
        };
        if (changed) wake();
      });
      wake = undefined;
    }
  } finally {
    off();
  }
}
export async function closeFixture() {
  holdWork(false);
  server.closeAllConnections();
  await new Promise((done) => server.close(() => done()));
  backend.close();
  await database.close();
}
export function evidence() {
  return {
    origin,
    stateRoot,
    agents,
    version,
    commit,
    fault,
    digest,
    calls: Object.fromEntries(calls),
  };
}
console.log(JSON.stringify({ origin, stateRoot, agents }));
