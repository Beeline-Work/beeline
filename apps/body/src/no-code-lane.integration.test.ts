import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { migrate } from '../../server/src/database.js';
import { PgliteDatabase } from '../../server/src/test-support.js';
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
 * The no-code lane, end to end, against the real server over HTTP.
 *
 * A person asks for a write-up in a Room that IS bound to a repository. The
 * agent opens the corner on the no-code lane, and what comes back has to be
 * the work itself — no branch is cut, no pull request is opened, and the
 * corner reports by tagging the person who asked. Every other corner in a
 * repository Room ends at a merge card, so this is the whole difference.
 */

const execFileAsync = promisify(execFile);

const HUMAN = createHash('sha256').update('github:owner').digest('hex');
const AGENT_SECRET = new Uint8Array(32).fill(11);
const AGENT = getPublicKey(AGENT_SECRET);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

/**
 * An ACP harness that plays the two turns this story needs: the parent Room's
 * agent opening a no-code corner, and the corner's own agent delivering. It
 * records every system prompt it is handed so the test can read what the
 * corner was actually told.
 */
async function writeFakeHarness(directory: string, promptLog: string): Promise<string> {
  const binary = resolve(directory, 'fake-acp-agent.mjs');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFile } from 'node:fs/promises';

const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const PROMPT_LOG = ${JSON.stringify(promptLog)};
let systemPrompt = '';

const chunk = (text) =>
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'session-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  });

lines.on('line', async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
    return;
  }
  if (message.method === 'session/new') {
    systemPrompt = String(message.params?.systemPrompt ?? '');
    await appendFile(PROMPT_LOG, JSON.stringify({ systemPrompt }) + '\\n');
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'session-1' } });
    return;
  }
  if (message.method === 'session/prompt') {
    // The corner's own turn. Its prompt is the only place the lane is stated,
    // so the harness answers the way that prompt tells it to.
    if (systemPrompt.includes('no-code corner with no repository checkout')) {
      const handle = (systemPrompt.match(/replying with @([a-z0-9-]+)/i) ?? [])[1] ?? 'nobody';
      chunk('Posted the competitor write-up. @' + handle + ' it is in this corner.');
      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
      return;
    }
    const text = (message.params.prompt ?? [])
      .map((block) => (typeof block === 'string' ? block : block?.text ?? ''))
      .join('\\n');
    if (text.includes('write it up')) {
      // Play open_corner on the no-code lane, through the same daemon
      // operation the MCP tool calls.
      const { readdir, readFile } = await import('node:fs/promises');
      const { join: pjoin } = await import('node:path');
      const dir = process.env.BEELINE_TEST_CONTEXT_DIR;
      const files = dir
        ? (await readdir(dir)).filter((f) => f.startsWith('beeline-command-') && f.endsWith('.json'))
        : [];
      let ctx;
      for (const f of files) {
        try {
          const parsed = JSON.parse(await readFile(pjoin(dir, f), 'utf8'));
          if (parsed.roomId === process.env.BEELINE_DAEMON_ROOM_ID && parsed.requestId) ctx = parsed;
        } catch {}
      }
      try {
        const response = await fetch(
          new URL('/v1/daemon/operations/createCorner', process.env.BEELINE_DAEMON_BASE_URL + '/'),
          {
            method: 'POST',
            headers: {
              authorization: 'Bearer ' + process.env.BEELINE_DAEMON_TOKEN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              ...ctx,
              name: 'Market scan',
              objective: 'Survey the five nearest competitors and write it up',
              lane: 'no_code',
              repository: process.env.BEELINE_TEST_REPO_KEY,
              targetBranch: 'main',
            }),
          },
        );
        const body = await response.json();
        chunk('CORNER OPENED ' + (body.cornerId ?? 'http-' + response.status));
      } catch (error) {
        chunk('CORNER FAILED ' + String(error));
      }
      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
      return;
    }
    chunk('ECHO REPLY');
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
  }
  async drop(): Promise<void> {
    await this.end();
    this.emit('end');
  }
}

let database: PgliteDatabase;
let origin: string;
let server: ReturnType<typeof createBeelineServer>;
let accessToken: string;
let core: ThinDaemonCore;
let abort: AbortController;
let listener: PostgresLiveListener;
let promptLog: string;

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
  const supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-no-code-e2e-'));
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
  // The Room IS bound to a repository. That binding is what used to force
  // every corner it opened onto the commit-and-merge path.
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
  const phone = new PhoneService(database, 'http://placeholder');
  const live = new LiveHub();
  const daemon = new DaemonService(database, live, async () => ({
    token: 'test-room-token',
    expiresAt: Date.now() + 60_000,
  }));
  server = createBeelineServer({ database, auth, phone, daemon, live });
  listener = new PostgresLiveListener(database, live, () => new PgliteListenClient(database), 50);
  void listener.run();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  accessToken = (await auth.exchangeGitHubOidc('proof')).accessToken;

  const harnessHome = join(supervisorRoot, 'harness-home');
  await mkdir(harnessHome, { recursive: true });
  promptLog = join(supervisorRoot, 'prompts.jsonl');
  await writeFile(promptLog, '');
  const agentCommand = await writeFakeHarness(supervisorRoot, promptLog);
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
    readonlyMcpCommand: process.execPath,
    readonlyMcpArgs: [],
    agentEnv: {
      PATH: process.env.PATH ?? '',
      HOME: harnessHome,
      BEELINE_DAEMON_BASE_URL: origin,
      BEELINE_DAEMON_TOKEN: daemonToken,
      BEELINE_DAEMON_ROOM_ID: ROOM,
      BEELINE_TEST_REPO_KEY: 'owner/widgets',
      BEELINE_TEST_CONTEXT_DIR: resolve(supervisorRoot, 'rooms', ROOM, 'agent-home'),
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
});

afterEach(async () => {
  abort?.abort();
  await listener?.stop();
  await new Promise((r) => setTimeout(r, 150));
  if (server) await new Promise<void>((done) => server.close(() => done()));
  if (database) await database.close();
});

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
  'delivers a no-code corner of a repository Room by tagging the requester, with no branch and no pull request',
  { timeout: 120_000 },
  async () => {
    await vi.waitFor(() => expect(core.activeRoomIds()).toContain(ROOM), { timeout: 15_000 });

    await request('/v1/phone/operations/sendRoomMessage', 'POST', {
      roomId: ROOM,
      messageId: 'e'.repeat(64),
      text: '@bee survey the five nearest competitors and write it up',
    });

    // The corner the agent opened, as the person sees it in the Room list.
    const corner = await vi.waitFor(
      async () => {
        const { rows } = await database.query<{ corner_id: string; lane: string }>(
          `SELECT corner_id,lane FROM corner_facts`,
        );
        expect(rows[0]).toBeTruthy();
        return rows[0]!;
      },
      { timeout: 30_000 },
    );
    expect(corner.lane).toBe('no_code');

    // The corner runs and answers. That reply is this lane's completion
    // signal, so it has to name the person who asked — and the server has to
    // resolve that tag to the requester's identity, or it reaches nobody.
    const reply = await vi.waitFor(
      async () => {
        const room = (await (await request(`/v1/phone/rooms/${corner.corner_id}`)).json()) as {
          messages: Array<{
            text?: string;
            author?: { pubkey?: string };
            mentionPubkeys?: string[];
          }>;
        };
        const found = room.messages.find(
          (message) =>
            message.author?.pubkey === AGENT && (message.mentionPubkeys ?? []).includes(HUMAN),
        );
        expect(found).toBeTruthy();
        return found!;
      },
      { timeout: 60_000 },
    );

    const prompts = (await readFile(promptLog, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { systemPrompt: string });
    const cornerPrompt = prompts.find((entry) =>
      entry.systemPrompt.includes('no-code corner with no repository checkout'),
    )!;

    process.stdout.write(
      [
        '',
        '--- what the person who asked sees ---',
        `corner lane recorded:   ${corner.lane}`,
        `corner reply in Room:   ${reply.text}`,
        `tag routed to:          ${reply.mentionPubkeys?.includes(HUMAN) ? 'the requester (Owner)' : 'nobody'}`,
        `feature branch cut:     ${
          (await database.query(`SELECT feature_branch FROM corner_facts WHERE feature_branch IS NOT NULL`))
            .rows.length
        } (0 means none)`,
        `pull request opened:    ${
          (await database.query(`SELECT 1 FROM corner_merge_approvals`)).rows.length
        } (0 means none)`,
        '--- what the corner was told ---',
        cornerPrompt.systemPrompt
          .split('\n')
          .filter((line) => /no-code|post_artifact|Do not initialize/.test(line))
          .map((line) => `  ${line.trim()}`)
          .join('\n'),
        '',
      ].join('\n'),
    );

    // No branch was cut and no merge was ever on the table.
    expect(
      (await database.query(`SELECT feature_branch FROM corner_facts WHERE feature_branch IS NOT NULL`))
        .rows,
    ).toHaveLength(0);
    expect((await database.query(`SELECT 1 FROM corner_merge_approvals`)).rows).toHaveLength(0);
    expect(cornerPrompt.systemPrompt).toContain('post_artifact everything the objective asked for');
    expect(cornerPrompt.systemPrompt).not.toContain('Open the pull request with gh');
    expect(cornerPrompt.systemPrompt).not.toContain('gh pr merge');
  },
);
