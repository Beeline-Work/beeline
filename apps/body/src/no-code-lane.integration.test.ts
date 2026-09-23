import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
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
 * An ACP harness that plays the two turns this story needs: the parent Room's
 * agent opening a no-code corner, and the corner's own agent delivering. It
 * records every system prompt it is handed so the test can read what the
 * corner was actually told.
 *
 * The delivering turn does NOT narrate an artifact. It spawns the real
 * `beeline-agent` MCP server off the `session/new` wire — the same command,
 * args and env a live ACP agent is handed — and calls `post_artifact` over
 * stdio. Otherwise this test would pass on a lane that had lost the ability
 * to deliver anything at all, which is the one thing the lane exists to do.
 */
async function writeFakeHarness(
  directory: string,
  promptLog: string,
  artifactLog: string,
): Promise<string> {
  const binary = resolve(directory, 'fake-acp-agent.mjs');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const PROMPT_LOG = ${JSON.stringify(promptLog)};
const ARTIFACT_LOG = ${JSON.stringify(artifactLog)};
const WRITE_UP = [
  '# Five nearest competitors',
  '',
  '| product | wedge |',
  '| --- | --- |',
  '| Acme | price |',
  '| Widgetry | distribution |',
].join('\\n');
let systemPrompt = '';
let mcpServers = [];

/** One stdio MCP session against a server off the session/new wire. */
async function callMcpTools(server, calls) {
  const env = { ...process.env };
  for (const entry of server.env ?? []) env[entry.name] = entry.value;
  const child = spawn(server.command, server.args ?? [], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Kept so a server that dies on startup reports why, instead of surfacing
  // as an unexplained initialize timeout.
  let stderr = '';
  child.stderr.on('data', (piece) => { stderr += String(piece); });
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const settle = pending.get(message.id);
    if (settle) { pending.delete(message.id); settle(message); }
  });
  let nextId = 1;
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(
        () => reject(new Error(method + ' timed out; server stderr: ' + (stderr.trim() || '(silent)'))),
        30000,
      );
      pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');
    });
  try {
    await rpc('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'fake-acp-agent', version: '1.0.0' },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\\n');
    const results = [];
    for (const call of calls) {
      results.push(await rpc('tools/call', { name: call.name, arguments: call.arguments }));
    }
    return results;
  } finally {
    child.kill();
  }
}

/** Write the report, then post it. Exactly the two steps the prompt names. */
async function deliverArtifact() {
  const server = (mcpServers ?? []).find((entry) => entry.name === 'beeline-agent');
  if (!server) return { ok: false, detail: 'no beeline-agent MCP server on the session wire' };
  const [written, posted] = await callMcpTools(server, [
    { name: 'write_scratch_file', arguments: { path: 'competitors.md', content: WRITE_UP } },
    { name: 'post_artifact', arguments: { path: 'competitors.md', title: 'Competitor scan', mime: 'text/markdown' } },
  ]);
  const textOf = (answer) =>
    (answer?.result?.content ?? []).map((part) => part?.text ?? '').join(' ') ||
    JSON.stringify(answer?.error ?? answer?.result ?? null);
  const failed = written?.result?.isError || posted?.result?.isError || posted?.error || written?.error;
  return {
    ok: !failed,
    wrote: textOf(written),
    posted: textOf(posted),
  };
}

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
    mcpServers = message.params?.mcpServers ?? [];
    await appendFile(PROMPT_LOG, JSON.stringify({ systemPrompt }) + '\\n');
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'session-1' } });
    return;
  }
  if (message.method === 'session/prompt') {
    // The corner's own turn. Its prompt is the only place the lane is stated,
    // so the harness answers the way that prompt tells it to.
    if (systemPrompt.includes('no-code corner with no repository checkout')) {
      const handle = (systemPrompt.match(/replying with @([a-z0-9-]+)/i) ?? [])[1] ?? 'nobody';
      let delivery;
      try {
        delivery = await deliverArtifact();
      } catch (error) {
        delivery = { ok: false, detail: String(error) };
      }
      await appendFile(ARTIFACT_LOG, JSON.stringify(delivery) + '\\n');
      // The reply is plain prose, as a real one would be. The artifact rides
      // it because post_artifact queued it onto this turn, not because the
      // text says so.
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
let accessToken: string;
let core: ThinDaemonCore;
let abort: AbortController;
let listener: PostgresLiveListener;
let promptLog: string;
let artifactLog: string;

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
  const live = new LiveHub();
  // Real object storage: post_artifact streams the bytes through the server,
  // so without it the delivery this test exists to prove cannot happen.
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
  promptLog = join(supervisorRoot, 'prompts.jsonl');
  artifactLog = join(supervisorRoot, 'artifacts.jsonl');
  await writeFile(promptLog, '');
  await writeFile(artifactLog, '');
  const agentCommand = await writeFakeHarness(supervisorRoot, promptLog, artifactLog);
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
    // The real agent-surface MCP server, so post_artifact is the production
    // code path and not a stub the test wrote to agree with itself.
    readonlyMcpCommand: process.execPath,
    // Absolute loader path: the MCP server is spawned with the corner's
    // scratch directory as its cwd, where a bare `tsx` specifier cannot
    // resolve.
    readonlyMcpArgs: [
      '--import',
      fileURLToPath(new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url)),
      fileURLToPath(new URL('./read-only-mcp.ts', import.meta.url)),
    ],
    // post_artifact's second legal root, and where write_scratch_file writes.
    agentHomeRoot: join(supervisorRoot, 'agent-home-overlay'),
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
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  abort?.abort();
  await listener?.stop();
  await new Promise((r) => setTimeout(r, 150));
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
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
            attachments?: Array<{ url: string; name: string; mimeType: string; size: number }>;
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

    // What post_artifact actually reported, checked BEFORE the attachment: a
    // tool refusal should fail as itself, not as a mystery empty array.
    const delivery = (await readFile(artifactLog, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { ok: boolean; wrote?: string; posted?: string; detail?: string });
    expect(delivery[0]?.ok, `post_artifact failed: ${JSON.stringify(delivery[0])}`).toBe(true);

    // The tag and the artifact have to arrive on the SAME message: that one
    // message is the whole delivery on this lane.
    expect(reply.attachments ?? []).toHaveLength(1);

    // The requester can open it, and the bytes are the write-up.
    const attachment = reply.attachments![0]!;
    const downloaded = await fetch(attachment.url, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(downloaded.status).toBe(200);
    const contents = Buffer.from(await downloaded.arrayBuffer()).toString('utf8');

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
        `artifact on that reply: ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes)`,
        `artifact opens as:      ${JSON.stringify(contents.split('\n')[0])} ...`,
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

    // The delivery itself: a real artifact, posted through the real tool.
    expect(attachment).toMatchObject({ name: 'Competitor scan', mimeType: 'text/markdown' });
    expect(contents).toContain('# Five nearest competitors');
    expect(contents).toContain('| Widgetry | distribution |');
    expect(attachment.size).toBe(Buffer.byteLength(contents, 'utf8'));

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
