import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { migrate } from '../../server/src/database.js';
import { MemoryObjectStorage, PgliteDatabase } from '../../server/src/test-support.js';
import { ObjectService } from '../../server/src/object-service.js';
import { ARTIFACT_MAXIMUM_BYTES } from '../../../packages/api-contract/src/artifacts.js';
import { TokenAuth } from '../../server/src/auth.js';
import { PhoneService } from '../../server/src/phone-service.js';
import { DaemonService } from '../../server/src/daemon-service.js';
import { LiveHub } from '../../server/src/live.js';
import { createBeelineServer } from '../../server/src/server.js';
import { PostgresLiveListener, type LivePgClient } from '../../server/src/postgres-live.js';
import type { TransactionalDatabase } from '@beeline/auth/store';
import { getPublicKey } from '@beeline/nostr';
import { DaemonApiClient } from './daemon-api-client.js';
import { ThinDaemonCore } from './thin-core.js';
import type { AgentRuntimeRecord } from './runtime.js';

/**
 * A person-opened corner in a repository Room, end to end, against the real
 * server over HTTP.
 *
 * The person opens a corner from the phone and tags the agent. The corner is
 * a code corner from the start: the tag is consumed by ONE code session on the
 * corner's feature-branch worktree, and its reply is visible in the corner.
 * There is no no-code turn, no lane upgrade, and no session restart.
 */

const execFileAsync = promisify(execFile);

const HUMAN = createHash('sha256').update('github:owner').digest('hex');
const AGENT_SECRET = new Uint8Array(32).fill(11);
const AGENT = getPublicKey(AGENT_SECRET);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';

/**
 * Vitest's default hook timeout is 10s, and setup here is real work: a bare
 * git remote built with four git children, a pglite migrate, an object store,
 * an HTTP server and a daemon core. That fits locally and does not fit on a
 * loaded CI runner, so every hook in this file states its own budget rather
 * than widening the shared config for the whole suite.
 */
const HOOK_TIMEOUT_MS = 60_000;

const roots: string[] = [];
afterEach(
  async () =>
    Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
  HOOK_TIMEOUT_MS,
);

/**
 * An ACP harness that answers every corner prompt with one plain reply. It
 * logs each `session/new` (its cwd and system prompt) and each
 * `session/prompt`, so the test can count sessions and turns.
 */
async function writeFakeHarness(directory: string, sessionLog: string): Promise<string> {
  const binary = resolve(directory, 'fake-acp-agent.mjs');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFile } from 'node:fs/promises';

const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const SESSION_LOG = ${JSON.stringify(sessionLog)};
let sessions = 0;

lines.on('line', async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
    return;
  }
  if (message.method === 'session/new') {
    sessions += 1;
    await appendFile(SESSION_LOG, JSON.stringify({
      event: 'session/new',
      cwd: String(message.params?.cwd ?? ''),
      systemPrompt: String(message.params?.systemPrompt ?? ''),
    }) + '\\n');
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'session-' + sessions } });
    return;
  }
  if (message.method === 'session/prompt') {
    await appendFile(SESSION_LOG, JSON.stringify({ event: 'session/prompt' }) + '\\n');
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: message.params?.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'On it: reading the widget code now.' },
        },
      },
    });
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (message.method === 'shutdown') process.exit(0);
});
`,
  );
  await chmod(binary, 0o755);
  return binary;
}

class PgliteListenClient extends EventEmitter implements LivePgClient {
  private release?: () => Promise<void>;
  constructor(private readonly database: PgliteDatabase) {
    super();
  }
  async connect(): Promise<void> {}
  async query(sql: string): Promise<void> {
    if (sql !== `LISTEN beeline_live_v1`) throw new Error(`unexpected query: ${sql}`);
    this.release = await this.database.client.listen('beeline_live_v1', (payload: string) => {
      this.emit('notification', { channel: 'beeline_live_v1', payload });
    });
  }
  async end(): Promise<void> {
    const release = this.release;
    this.release = undefined;
    await release?.();
    this.emit('end');
  }
  async drop(): Promise<void> {
    await this.end();
  }
}

let database: PgliteDatabase;
let objectStorage: MemoryObjectStorage;
let origin: string;
let server: ReturnType<typeof createBeelineServer>;
const serverSockets = new Set<Socket>();
let accessToken: string;
let core: ThinDaemonCore;
let abort: AbortController;
let listener: PostgresLiveListener;
let sessionLog: string;

/** A real bare repository to stand in for the Room's GitHub remote. */
async function createBareRemote(directory: string): Promise<string> {
  const remote = join(directory, 'widgets.git');
  const seed = join(directory, 'seed');
  await mkdir(seed, { recursive: true });
  await execFileAsync('git', ['init', '--initial-branch=main', seed]);
  await writeFile(join(seed, 'README.md'), '# widgets\n');
  for (const args of [
    ['config', 'user.email', 'seed@example.com'],
    ['config', 'user.name', 'Seed'],
    ['add', '.'],
    ['commit', '-m', 'seed'],
  ])
    await execFileAsync('git', ['-C', seed, ...args]);
  await execFileAsync('git', ['clone', '--bare', seed, remote]);
  return `file://${remote}`;
}

beforeEach(async () => {
  const supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-human-corner-e2e-'));
  roots.push(supervisorRoot);
  const remote = await createBareRemote(join(supervisorRoot, 'remote'));
  database = new PgliteDatabase();
  await migrate(database);
  await new (await import('@beeline/auth/store')).AuthStore(
    database as unknown as TransactionalDatabase,
  ).migrate();
  await database.query(
    `INSERT INTO identities(id,kind,name,handle,github_subject)
     VALUES($1,'human','Owner','owner','owner'),($2,'agent','Bee','bee',NULL)`,
    [HUMAN, AGENT],
  );
  await database.query(
    `INSERT INTO agents(agent_id,owner_id,soul,selected_model,selected_effort,model_catalog)
     VALUES($1,$2,$3::jsonb,NULL,NULL,'[]'::jsonb)`,
    [AGENT, HUMAN, JSON.stringify({ name: 'Bee', instructions: 'Answer briefly.' })],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
  // The Room is bound to a repository, so every corner it holds is a code
  // corner, including one a person opens from the phone.
  await database.query(
    `INSERT INTO rooms(id,workspace_id,name,repository_key,repository_remote,repository_resolution,repository_target_branch)
     VALUES($1,$2,'Widgets','owner/widgets',$3,'repository','main')`,
    [ROOM, WORKSPACE, remote],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
     VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`,
    [WORKSPACE, HUMAN, AGENT, ROOM],
  );
  const auth = new TokenAuth(database, async (proof) => ({
    subject: proof === 'proof' ? 'owner' : proof,
    login: proof === 'proof' ? 'owner' : proof,
    name: 'Owner',
  }));
  const live = new LiveHub();
  objectStorage = new MemoryObjectStorage();
  await objectStorage.listen();
  const objectService = new ObjectService(
    database,
    objectStorage.asStorage(),
    'http://placeholder',
    ARTIFACT_MAXIMUM_BYTES,
  );
  const phone = new PhoneService(
    database,
    'http://placeholder',
    undefined,
    undefined,
    live,
    false,
    database,
    objectService,
  );
  const daemon = new DaemonService(database, live, async () => ({
    token: 'test-room-token',
    expiresAt: Date.now() + 60_000,
  }));
  server = createBeelineServer({ database, auth, phone, daemon, live, objectService });
  server.on('connection', (socket) => {
    serverSockets.add(socket);
    socket.on('close', () => serverSockets.delete(socket));
  });
  listener = new PostgresLiveListener(database, live, () => new PgliteListenClient(database), 50);
  void listener.run();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The attachment url the corner's reply carries has to be one the requester
  // can actually fetch, so both services must name this server.
  (phone as unknown as { publicOrigin: string }).publicOrigin = origin;
  (objectService as unknown as { publicOrigin: string }).publicOrigin = origin;
  accessToken = (await auth.exchangeGitHubOidc('proof')).accessToken;

  const harnessHome = join(supervisorRoot, 'harness-home');
  await mkdir(harnessHome, { recursive: true });
  sessionLog = join(supervisorRoot, 'sessions.jsonl');
  await writeFile(sessionLog, '');
  const agentCommand = await writeFakeHarness(supervisorRoot, sessionLog);
  const exchange = await auth.createDaemonExchange(AGENT);
  const daemonToken = (await auth.exchangeDaemonToken(exchange.exchangeToken))!.daemonToken;
  const runtime: AgentRuntimeRecord = {
    version: 2,
    communityId: WORKSPACE,
    pairedBy: HUMAN,
    agent: {
      name: 'Bee',
      publicKey: AGENT,
      secretKeyHex: Buffer.from(AGENT_SECRET).toString('hex'),
    },
    body: { name: 'Body', publicKey: 'cc'.repeat(32), secretKeyHex: 'bb'.repeat(32) },
    rooms: [],
    supervisorRoot,
    relayBaseUrl: origin,
    agentKind: 'custom',
    agentCommand,
    agentArgs: [],
    agentBinary: agentCommand,
    mcpBinary: process.execPath,
    createdAt: new Date().toISOString(),
    accessPolicy: 'everyone',
    transport: { kind: 'monolith', baseUrl: origin, daemonToken },
  };
  const config = {
    agentKind: 'custom',
    agentCommand,
    agentArgs: [],
    agentBinary: agentCommand,
    mcpBinary: process.execPath,
    // The real agent-surface MCP server, as a live corner session mounts it.
    readonlyMcpCommand: process.execPath,
    // Absolute loader path: the MCP server is spawned with the corner's
    // worktree as its cwd, where a bare `tsx` specifier cannot resolve.
    readonlyMcpArgs: [
      '--import',
      fileURLToPath(new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url)),
      fileURLToPath(new URL('./read-only-mcp.ts', import.meta.url)),
    ],
    agentHomeRoot: join(supervisorRoot, 'agent-home-overlay'),
    agentEnv: {
      PATH: process.env.PATH ?? '',
      HOME: harnessHome,
      BEELINE_DAEMON_BASE_URL: origin,
      BEELINE_DAEMON_TOKEN: daemonToken,
      BEELINE_DAEMON_ROOM_ID: ROOM,
    },
    workspaceRoot: join(supervisorRoot, 'workspace'),
    relayBaseUrl: origin,
    relayHost: '127.0.0.1',
    relayScheme: 'http',
    relayWsUrl: origin.replace(/^http/, 'ws'),
    autoApprovePermissions: false,
    accessPolicy: 'everyone',
  } as never;
  core = new ThinDaemonCore(runtime, join(supervisorRoot, 'runtime.json'), config, {
    daemonApi: new DaemonApiClient(origin, daemonToken, AGENT),
    reconcileHeartbeatMs: 10 * 60_000,
  });
  abort = new AbortController();
  void core.run({ pollMs: 100, signal: abort.signal });
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  abort?.abort();
  await listener?.stop();
  await new Promise((r) => setTimeout(r, 150));
  if (server) {
    const closed = new Promise<void>((done) => server.close(() => done()));
    server.closeAllConnections();
    // Upgraded WebSocket connections are excluded from closeAllConnections.
    for (const socket of serverSockets) socket.destroy();
    await closed;
  }
  if (objectStorage) await objectStorage.close();
  if (database) await database.close();
}, HOOK_TIMEOUT_MS);

const request = async (path: string, method = 'GET', payload?: unknown) =>
  fetch(`${origin}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });

it(
  'answers a tag in a person-opened corner from one code session, with no upgrade and no restart',
  { timeout: 120_000 },
  async () => {
    await vi.waitFor(() => expect(core.activeRoomIds()).toContain(ROOM), { timeout: 15_000 });

    // The person opens a corner from the phone, the way lucid-atlas-corner was opened.
    const opened = await request('/v1/phone/operations/createHumanCorner', 'POST', {
      roomId: ROOM,
      title: 'lucid-atlas-corner',
      titleGenerated: true,
    });
    expect(opened.status).toBe(200);
    const cornerId = ((await opened.json()) as { id: string }).id;
    const featureBranch = `feature/corner-${cornerId.replaceAll('-', '').slice(0, 12)}`;

    // The tag.
    const tagged = await request('/v1/phone/operations/sendRoomMessage', 'POST', {
      roomId: cornerId,
      messageId: 'f'.repeat(64),
      text: '@bee why am I getting no responses in this corner',
    });
    expect(tagged.status).toBe(200);

    // The reply, as the person reads the corner.
    const reply = await vi.waitFor(
      async () => {
        const room = (await (await request(`/v1/phone/rooms/${cornerId}`)).json()) as {
          messages: Array<{ text?: string; author?: { pubkey?: string } }>;
        };
        const found = room.messages.find(
          (message) => message.author?.pubkey === AGENT && message.text?.includes('On it'),
        );
        expect(found).toBeTruthy();
        return found!;
      },
      { timeout: 60_000 },
    );

    const log = (await readFile(sessionLog, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; cwd?: string; systemPrompt?: string });
    const cornerSessions = log.filter(
      (entry) => entry.event === 'session/new' && entry.systemPrompt?.includes(featureBranch),
    );
    const commands = (
      await database.query<{ reason: string | null; state: string }>(
        `SELECT reason,state FROM agent_commands WHERE room_id=$1 AND agent_id=$2`,
        [cornerId, AGENT],
      )
    ).rows;
    const fact = (
      await database.query<{ workflow_state: string; owner_agent_id: string | null }>(
        `SELECT workflow_state,owner_agent_id FROM corner_facts WHERE corner_id=$1`,
        [cornerId],
      )
    ).rows[0]!;
    const branch = (
      await execFileAsync('git', ['-C', cornerSessions[0]?.cwd ?? '.', 'branch', '--show-current'])
    ).stdout.trim();

    process.stdout.write(
      [
        '',
        '--- what the person who tagged sees ---',
        `reply in the corner:      ${reply.text}`,
        `corner run state:         ${fact.workflow_state}`,
        `corner owner:             ${fact.owner_agent_id === AGENT ? 'the tagged agent' : fact.owner_agent_id}`,
        `corner sessions started:  ${cornerSessions.length}`,
        `session worktree branch:  ${branch}`,
        `agent commands consumed:  ${commands.map((command) => `${command.reason}:${command.state}`).join(', ')}`,
        '',
      ].join('\n'),
    );

    expect(fact.workflow_state).toBe('implement');
    expect(fact.owner_agent_id).toBe(AGENT);
    // One code session on the corner's own feature branch: no scratch session
    // came first and none replaced it.
    expect(cornerSessions).toHaveLength(1);
    expect(branch).toBe(featureBranch);
    expect(cornerSessions[0]!.systemPrompt).not.toContain('upgrade_corner_to_code');
    // The tag was consumed once, by that session, with no re-delivery.
    expect(commands).toHaveLength(1);
    expect(commands[0]!.state).toBe('complete');
    expect(commands.some((command) => command.reason === 'corner_lane_upgrade')).toBe(false);
  },
);
