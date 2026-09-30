import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const HUMAN = createHash('sha256').update('github:owner').digest('hex');
const AGENT_SECRET = new Uint8Array(32).fill(11);
const AGENT = getPublicKey(AGENT_SECRET);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';

/**
 * Regression: a freshly created Room's bound agent must discover, subscribe,
 * and answer the first tagged message through the live membership wake — the
 * daemon here runs a TEN MINUTE reconciliation heartbeat, so heartbeat-driven
 * discovery can never explain a pass.
 */
const RECONCILE_HEARTBEAT_MS = 10 * 60_000;

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function writeFakeHarness(directory: string): Promise<string> {
  const binary = resolve(directory, 'fake-acp-agent.mjs');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');

lines.on('line', async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'session-1' } });
  } else if (message.method === 'session/prompt') {
    const text = (message.params.prompt ?? [])
      .map((block) => (typeof block === 'string' ? block : block?.text ?? ''))
      .join('\\n');
    if (!text.includes('OPEN CORNER') && process.env.BEELINE_TEST_GATE_FILE) {
      // A freshly-opened corner's own turn starts on commit, before the
      // parent Room turn (still in this same session/prompt handler below)
      // finishes posting CORNER OPENED - the two would otherwise run
      // concurrently in this single-process harness. Only gate when a
      // repository key was set for this run (only the repository-corner
      // test does), since every other corner-opening test's own turn has
      // nothing to wait for and must not block on a file nobody writes.
      // The test writes the gate file only after it has observed CORNER
      // OPENED durably persisted, so wait for it here instead of racing
      // that reply.
      const { existsSync, readFileSync } = await import('node:fs');
      let repositoryKeyWasSet = false;
      try {
        repositoryKeyWasSet = Boolean(readFileSync(process.env.BEELINE_TEST_REPO_KEY_FILE, 'utf8').trim());
      } catch {}
      if (repositoryKeyWasSet) {
        const deadline = Date.now() + 20000;
        while (!existsSync(process.env.BEELINE_TEST_GATE_FILE) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 20));
        }
      }
    }
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ECHO REPLY' } },
      },
    });
    if (text.includes('OPEN CORNER')) {
      // Play the open_corner tool: read the turn context the loop persists for
      // the mounted MCP surface, then call the daemon operation it calls.
      const { readdir, readFile } = await import('node:fs/promises');
      const { join: pjoin } = await import('node:path');
      const dir = process.env.BEELINE_TEST_CONTEXT_DIR;
      const contexts = dir ? (await readdir(dir)).filter(
        (f) => f.startsWith('beeline-command-') && f.endsWith('.json'),
      ) : [];
      let ctx;
      for (const f of contexts) {
        try {
          const parsed = JSON.parse(await readFile(pjoin(dir, f), 'utf8'));
          if (
            parsed.roomId &&
            parsed.requestId &&
            parsed.generationId &&
            parsed.roomId === process.env.BEELINE_DAEMON_ROOM_ID
          )
            ctx = parsed;
        } catch {}
      }
      if (!ctx) console.error('[fake-harness] no turn context in', dir);
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
            name: 'Thing',
            objective: 'Build the thing',
            brief: {
              intentVerbatim: [
                { sourceMessageId: ctx.requestId, snapshot: '@bee OPEN CORNER now' },
              ],
              buildSpec: 'Build the requested thing in the corner.',
              criteria: [{ id: 'AC-1', text: 'The corner opens and runs.' }],
              references: [],
              approvalBasis: {
                kind: 'initiating-command',
                sourceMessageId: ctx.requestId,
                snapshot: '@bee OPEN CORNER now',
              },
            },
            ...(await (async () => {
              // This Room's own harness session is spawned once, well
              // before a test can set an env var for it to inherit (AcpClient
              // does not inherit process.env by default), so the repository
              // key is read fresh from a file at prompt-handling time
              // instead - written by the test right before it sends the
              // OPEN CORNER message.
              const { readFile: readRepoKeyFile } = await import('node:fs/promises');
              try {
                const key = (await readRepoKeyFile(process.env.BEELINE_TEST_REPO_KEY_FILE, 'utf8')).trim();
                return key ? { repository: key, targetBranch: 'main' } : {};
              } catch {
                return {};
              }
            })()),
          }),
        },
      );
      const body = await response.json();
      const cornerId = body.cornerId ?? ('http-' + response.status + ':' + JSON.stringify(body));
      // Production fidelity: the parent turn keeps running after open_corner.
      // Short on purpose - this is arbitrary fixture overhead, not something
      // under test, and it eats directly into the room-turn's own reply
      // budget under CI contention.
      await new Promise((r) => setTimeout(r, 250));
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'CORNER OPENED ' + cornerId },
          },
        },
      });
      } catch (error) {
        console.error('[fake-harness] open corner failed', error);
      }
    }
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  } else if (message.method === 'shutdown') {
    process.exit(0);
  }
});
`,
  );
  await chmod(binary, 0o755);
  return binary;
}

async function createMigratedDatabase(): Promise<PgliteDatabase> {
  const database = new PgliteDatabase();
  await migrate(database);
  await new (await import('@beeline/auth/store')).AuthStore(
    database as unknown as TransactionalDatabase,
  ).migrate();
  return database;
}

async function seedFixtureRows(database: PgliteDatabase): Promise<void> {
  await database.query(
    `INSERT INTO identities(id,kind,name,handle,github_subject) VALUES($1,'human','Owner','owner','owner'),($2,'agent','Bee','bee',NULL)`,
    [HUMAN, AGENT],
  );
  await database.query(
    `INSERT INTO agents(agent_id,owner_id,soul,selected_model,selected_effort,model_catalog)
     VALUES($1,$2,$3::jsonb,NULL,NULL,'[]'::jsonb)`,
    [AGENT, HUMAN, JSON.stringify({ name: 'Bee', instructions: 'Answer briefly.' })],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [
    ROOM,
    WORKSPACE,
  ]);
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`,
    [WORKSPACE, HUMAN, AGENT, ROOM],
  );
}

// Restoring a full app+auth migration into a fresh WASM Postgres instance -
// whether by re-running the migrations or by restoring a dumped snapshot -
// costs 400ms+ per instantiation in isolation, and that cost does not scale
// linearly: 24 concurrent instantiations (approximating this suite's own
// hook running alongside the rest of the parallel CI worker pool) measured
// up to ~9s at the tail, well past a 10s hook budget, because spinning up a
// WASM VM is CPU-bound and every concurrent instantiation competes for the
// same host CPU. Migrate ONE instance during collection and reset it with a
// plain TRUNCATE + reseed before every test instead: that is ordinary SQL
// against an already-warm instance, holds up far better under the same
// contention (measured ~2s wall for 24 concurrent resets vs ~9s for 24
// concurrent restores), and needs no per-test WASM instantiation at all.
const SHARED_DATABASE = await createMigratedDatabase();
const RESET_TABLES = (
  await SHARED_DATABASE.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  )
).rows.map((row) => `"${row.tablename}"`);

async function resetDatabase(database: PgliteDatabase): Promise<void> {
  await database.query(`TRUNCATE ${RESET_TABLES.join(',')} RESTART IDENTITY CASCADE`);
  await seedFixtureRows(database);
}

describe('fresh Room discovery through the live membership wake', () => {
  let database: PgliteDatabase;
  let origin: string;
  let server: ReturnType<typeof createBeelineServer>;
  let accessToken: string;
  let core: ThinDaemonCore;
  let daemonApi: DaemonApiClient;
  let abort: AbortController;
  let coreRun: Promise<'aborted' | 'agent-removed'>;
  let supervisorRoot: string;
  let live: LiveHub;
  let listener: PostgresLiveListener;
  let auth: TokenAuth;
  let deniedRoomId: string | undefined;

  class PgliteListenClient extends EventEmitter implements LivePgClient {
    private release?: () => Promise<void>;
    constructor(private readonly database2: PgliteDatabase) {
      super();
    }
    async connect(): Promise<void> {}
    async query(sql: string): Promise<void> {
      if (sql !== `LISTEN beeline_live_v1`) throw new Error(`unexpected query: ${sql}`);
      this.release = await this.database2.client.listen('beeline_live_v1', (payload: string) => {
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

  beforeEach(async () => {
    deniedRoomId = undefined;
    database = SHARED_DATABASE;
    await resetDatabase(database);
    auth = new TokenAuth(database, async (proof) => ({
      subject: proof === 'proof' ? 'owner' : proof,
      login: proof === 'proof' ? 'owner' : proof,
      name: 'Owner',
    }));
    const phone = new PhoneService(database, 'http://placeholder');
    live = new LiveHub();
    const daemon = new DaemonService(database, live, async (roomId) => {
      if (roomId === deniedRoomId) throw new Error('GitHub repository installation not found');
      return { token: 'test-room-token', expiresAt: Date.now() + 60_000 };
    });
    server = createBeelineServer({ database, auth, phone, daemon, live });
    listener = new PostgresLiveListener(database, live, () => new PgliteListenClient(database), 50);
    void listener.run();
    await new Promise<void>((resolve2) => server.listen(0, '127.0.0.1', resolve2));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    accessToken = (await auth.exchangeGitHubOidc('proof')).accessToken;

    supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-e2e-'));
    roots.push(supervisorRoot);
    const harnessHome = join(supervisorRoot, 'harness-home');
    await mkdir(harnessHome, { recursive: true });
    const agentCommand = await writeFakeHarness(supervisorRoot);
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
      body: {
        name: 'Body',
        publicKey: 'cc'.repeat(32),
        secretKeyHex: 'bb'.repeat(32),
      },
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
    const configPath = join(supervisorRoot, 'runtime.json');
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
        BEELINE_TEST_CONTEXT_DIR: resolve(supervisorRoot, 'rooms', ROOM, 'agent-home'),
        // Harmless when unused (no test writes to either path): the harness
        // only reads a repository key when this file exists and is
        // non-empty, and only gates a non-open-corner turn on the other
        // file's existence when a repository key was set. Both are static
        // per-test paths, not per-test env mutations, since the Room's own
        // harness session is spawned once in this hook and AcpClient does
        // not inherit process.env by default.
        BEELINE_TEST_REPO_KEY_FILE: resolve(supervisorRoot, 'test-repo-key'),
        BEELINE_TEST_GATE_FILE: resolve(supervisorRoot, 'open-corner-gate'),
      },
      workspaceRoot: join(supervisorRoot, 'workspace'),
      relayBaseUrl: origin,
      relayHost: '127.0.0.1',
      relayScheme: 'http',
      relayWsUrl: origin.replace(/^http/, 'ws'),
      autoApprovePermissions: false,
      accessPolicy: 'everyone',
    } as never;
    daemonApi = new DaemonApiClient(origin, daemonToken, AGENT);
    core = new ThinDaemonCore(runtime, configPath, config, {
      daemonApi,
      reconcileHeartbeatMs: RECONCILE_HEARTBEAT_MS,
    });
    abort = new AbortController();
    coreRun = core.run({ pollMs: 100, signal: abort.signal });
  });

  // A repository corner reaps its worktree and branch during shutdown. The
  // helper now gives a server read a bounded admission wait, so this fixture
  // cleanup needs room for that wait plus local worktree teardown under CI
  // contention; the turn and delivery assertions retain their own deadlines.
  afterEach(async () => {
    abort?.abort();
    await coreRun;
    await listener?.stop();
    await new Promise((r) => setTimeout(r, 150));
    if (server) await new Promise<void>((resolve2) => server.close(() => resolve2()));
  }, 90_000);

  // database is the one shared, already-migrated instance created during
  // collection (see the comment above SHARED_DATABASE); it is reset, not
  // recreated, between tests and only closed once the whole file is done.
  afterAll(async () => {
    await SHARED_DATABASE.close();
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
  const operation = (name: string, payload: unknown) =>
    request(`/v1/phone/operations/${name}`, 'POST', payload);
  const readRoom = async (roomId: string) =>
    (await (await request(`/v1/phone/rooms/${roomId}`)).json()) as {
      messages: Array<{ authorId?: string; text?: string }>;
    };

  const startRepositoryRoom = async (roomId: string, remote: string) => {
    await database.query(
      `INSERT INTO rooms(id,workspace_id,name,repository_key,repository_remote,repository_target_branch)
       VALUES($1,$2,'Repository',$3,$4,'main')`,
      [roomId, WORKSPACE, 'github:123', remote],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`,
      [WORKSPACE, roomId, HUMAN, AGENT],
    );
    const runtime = (
      core as unknown as { roomRuntime: { startRoom(roomId: string): Promise<void> } }
    ).roomRuntime;
    await runtime.startRoom(roomId);
    await vi.waitFor(() => expect(core.activeRoomIds()).toContain(roomId), { timeout: 10_000 });
  };

  it(
    'answers from an externally empty repository, states one remedy, and checks out the first commit',
    { timeout: 60_000 },
    async () => {
      const roomId = '44444444-4444-4444-8444-444444444444';
      const remote = resolve(supervisorRoot, 'empty-origin.git');
      const seed = resolve(supervisorRoot, 'empty-seed');
      const git = promisify(execFile);
      await git('git', ['init', '--bare', '-b', 'main', remote]);
      await startRepositoryRoom(roomId, `file://${remote}`);
      await operation('sendRoomMessage', {
        roomId,
        messageId: '8'.repeat(64),
        text: '@bee hello empty',
      });
      await vi.waitFor(
        async () => {
          const room = await readRoom(roomId);
          expect(room.messages.some((message) => message.text?.includes('ECHO REPLY'))).toBe(true);
        },
        { timeout: 30_000, interval: 500 },
      );
      const notice =
        "This repository has no commits yet - push a first commit and I'll pick it up.";
      await vi.waitFor(
        async () => {
          const room = await readRoom(roomId);
          expect(room.messages.filter((message) => message.text === notice)).toHaveLength(1);
        },
        { timeout: 10_000, interval: 300 },
      );
      await git('git', ['clone', remote, seed]);
      await writeFile(resolve(seed, 'README.md'), '# Repository\n');
      await git('git', ['-C', seed, 'add', 'README.md']);
      await git('git', [
        '-C',
        seed,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'first',
      ]);
      await git('git', ['-C', seed, 'push', 'origin', 'main']);
      await operation('sendRoomMessage', {
        roomId,
        messageId: '9'.repeat(64),
        text: '@bee hello committed',
      });
      await vi.waitFor(
        async () => {
          const room = await readRoom(roomId);
          expect(
            room.messages.filter((message) => message.text?.includes('ECHO REPLY')),
          ).toHaveLength(2);
        },
        { timeout: 30_000, interval: 500 },
      );
      const checkoutRoot = resolve(supervisorRoot, 'beeline', 'room-checkouts');
      const { readdir, readFile } = await import('node:fs/promises');
      const checkouts = await readdir(checkoutRoot);
      expect(checkouts.length).toBeGreaterThan(0);
      expect(await readFile(resolve(checkoutRoot, checkouts[0]!, 'README.md'), 'utf8')).toBe(
        '# Repository\n',
      );
      expect(
        (await readRoom(roomId)).messages.filter((message) => message.text === notice),
      ).toHaveLength(1);
    },
  );

  it(
    'answers with one App install or grant line when token lookup returns installation 404',
    { timeout: 60_000 },
    async () => {
      const roomId = '55555555-5555-4555-8555-555555555555';
      deniedRoomId = roomId;
      await startRepositoryRoom(roomId, 'https://github.com/Beeline-Work/ungranted.git');
      await operation('sendRoomMessage', {
        roomId,
        messageId: 'a'.repeat(64),
        text: '@bee hello denied',
      });
      await vi.waitFor(
        async () => {
          const room = await readRoom(roomId);
          expect(room.messages.some((message) => message.text?.includes('ECHO REPLY'))).toBe(true);
        },
        { timeout: 30_000, interval: 500 },
      );
      await operation('sendRoomMessage', { roomId, messageId: 'b'.repeat(64), text: '@bee again' });
      await vi.waitFor(
        async () => {
          const room = await readRoom(roomId);
          expect(
            room.messages.filter((message) => message.text?.includes('ECHO REPLY')),
          ).toHaveLength(2);
        },
        { timeout: 30_000, interval: 500 },
      );
      const room = await readRoom(roomId);
      expect(
        room.messages.filter(
          (message) =>
            message.text === 'Install or grant the Beeline GitHub App to access this repository.',
        ),
      ).toHaveLength(1);
      expect(
        room.messages.some((message) =>
          /installation not found|HTTP 404/i.test(message.text ?? ''),
        ),
      ).toBe(false);
    },
  );

  it('agent replies in a freshly created room without a reconciliation heartbeat', { timeout: 60_000 }, async () => {
    await vi.waitFor(() => expect(core.activeRoomIds()).toContain(ROOM), { timeout: 10_000 });
    const created = (await (
      await operation('createRoom', { workspaceId: WORKSPACE, name: 'milo' })
    ).json()) as { id: string };
    const fresh = created.id;
    // Discovery and subscription happen on the live membership wake, far
    // inside the ten-minute heartbeat this daemon is configured with.
    await vi.waitFor(() => expect(core.activeRoomIds()).toContain(fresh), { timeout: 15_000 });
    await operation('sendRoomMessage', {
      roomId: fresh,
      messageId: 'e'.repeat(64),
      text: '@bee hello fresh',
    });
    await vi.waitFor(
      async () => {
        const room = await readRoom(fresh);
        expect(room.messages.some((m) => (m.text ?? '').includes('ECHO REPLY'))).toBe(true);
      },
      { timeout: 30_000, interval: 500 },
    );
  });

  it('agent works a freshly opened corner without a reconciliation heartbeat', { timeout: 120_000 }, async () => {
    await vi.waitFor(() => expect(core.activeRoomIds()).toContain(ROOM), { timeout: 10_000 });
    await operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: 'f'.repeat(64),
      text: '@bee OPEN CORNER now',
    });
    // The Room turn itself must run at all.
    await vi.waitFor(
      async () => {
        const room = await readRoom(ROOM);
        expect(
          room.messages.some((m) => (m.text ?? '').includes('CORNER OPENED ')),
        ).toBe(true);
      },
      { timeout: 30_000, interval: 500 },
    );
    const room = await readRoom(ROOM);
    const cornerId = room.messages
      .find((m) => (m.text ?? '').includes('CORNER OPENED '))!
      .text!.match(/CORNER OPENED (\S+)/)![1];
    // The corner the agent itself just opened must be discovered and served
    // through the live wake — never by the ten-minute heartbeat.
    await vi.waitFor(() => expect(core.activeRoomIds()).toContain(cornerId), {
      timeout: 15_000,
    });
    // And the corner's opening objective must be claimed and answered.
    await vi.waitFor(
      async () => {
        const corner = await readRoom(cornerId);
        expect(corner.messages.some((m) => (m.text ?? '').includes('ECHO REPLY'))).toBe(true);
      },
      { timeout: 30_000, interval: 500 },
    );
  });

  it('a corner still acts when a sibling Room cannot materialize its checkout', { timeout: 120_000 }, async () => {
    // A second top-level Room whose repository checkout can NEVER materialize.
    // Its chat loop still starts, and the corner-start pass must continue.
    const brokenRoom = '33333333-3333-4333-8333-333333333333';
    await database.query(
      `INSERT INTO rooms(id,workspace_id,name,repository_key,repository_remote,repository_target_branch)
       VALUES($1,$2,'#broken',$3,$4,'main')`,
      [brokenRoom, WORKSPACE, 'owner/gone', 'file:///nonexistent/beeline-corner-open-broken.git'],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,$2,$3,'member') ON CONFLICT DO NOTHING`,
      [WORKSPACE, brokenRoom, AGENT],
    );
    await vi.waitFor(() => expect(core.activeRoomIds()).toContain(ROOM), { timeout: 10_000 });
    await operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: 'd'.repeat(64),
      text: '@bee OPEN CORNER now',
    });
    const room = await vi.waitFor(
      async () => {
        const room = await readRoom(ROOM);
        expect(room.messages.some((m) => (m.text ?? '').includes('CORNER OPENED '))).toBe(true);
        return room;
      },
      { timeout: 30_000, interval: 500 },
    );
    const cornerId = room.messages
      .find((m) => (m.text ?? '').includes('CORNER OPENED '))!
      .text!.match(/CORNER OPENED (\S+)/)![1];
    await vi.waitFor(() => expect(core.activeRoomIds()).toContain(cornerId), {
      timeout: 15_000,
    });
    await vi.waitFor(
      async () => {
        const corner = await readRoom(cornerId);
        expect(corner.messages.some((m) => (m.text ?? '').includes('ECHO REPLY'))).toBe(true);
      },
      { timeout: 30_000, interval: 500 },
    );
    // Repository inspection is optional, so the broken Room still serves chat.
    expect(core.activeRoomIds()).toContain(brokenRoom);
  });

  it('agent works a freshly opened repository corner without a reconciliation heartbeat', { timeout: 120_000 }, async () => {
    // A real local git origin keeps the worktree materialization honest.
    const execFileAsync = promisify(execFile);
    const origin = resolve(supervisorRoot, 'origin.git');
    const seed = resolve(supervisorRoot, 'seed');
    await execFileAsync('git', ['init', '--bare', '-b', 'main', origin]);
    await execFileAsync('git', ['clone', origin, seed]);
    await writeFile(resolve(seed, 'README.md'), '# widgets\n');
    await execFileAsync('git', ['-C', seed, 'add', 'README.md']);
    await execFileAsync('git', ['-C', seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init']);
    await execFileAsync('git', ['-C', seed, 'push', 'origin', 'main']);
    await database.query(
      `UPDATE rooms SET repository_key='owner/widgets',
         repository_remote=$2,
         repository_target_branch='main'
       WHERE id=$1`,
      [ROOM, 'file://' + origin],
    );
    // AcpClient does not inherit process.env by default, and this Room's
    // harness session is already spawned by the time this test body runs -
    // an env var set here would never reach it. Write the key to the file
    // the harness reads fresh at prompt-handling time instead (see
    // BEELINE_TEST_REPO_KEY_FILE above), so this test actually exercises a
    // repository corner rather than always falling back to a no-code one.
    await writeFile(resolve(supervisorRoot, 'test-repo-key'), 'owner/widgets');
    await vi.waitFor(() => expect(core.activeRoomIds()).toContain(ROOM), { timeout: 10_000 });
    await operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: 'e'.repeat(64),
      text: '@bee OPEN CORNER now',
    });
    // createCorner() discovers and starts the new corner's own turn as soon
    // as its row commits, well before this Room turn's own reply - the two
    // would otherwise run concurrently, sharing this test's single Node
    // event loop and single PGlite connection. Polling the full
    // authenticated readRoom (auth, PhoneService projection, joins) every
    // 500ms also adds its own load to that same connection; poll a direct,
    // uninstrumented query for just the text instead, and pay for the full
    // projection once, after the row is already known to exist. The
    // corner's own harness turn is separately gated (see BEELINE_TEST_GATE_
    // FILE / writeFakeHarness) on this exact wait succeeding, so the two
    // turns no longer overlap at all rather than merely racing a wider
    // budget.
    await vi.waitFor(
      async () => {
        const found = await database.query<{ id: string }>(
          `SELECT id FROM messages WHERE room_id=$1 AND text LIKE '%CORNER OPENED %' LIMIT 1`,
          [ROOM],
        );
        expect(found.rowCount).toBeGreaterThan(0);
      },
      { timeout: 30_000, interval: 200 },
    );
    await writeFile(resolve(supervisorRoot, 'open-corner-gate'), '1');
    const room = await readRoom(ROOM);
    const cornerId = room.messages
      .find((m) => (m.text ?? '').includes('CORNER OPENED '))!
      .text!.match(/CORNER OPENED (\S+)/)![1];
    expect(cornerId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await vi.waitFor(() => expect(core.activeRoomIds()).toContain(cornerId), {
      timeout: 15_000,
    });
    await vi.waitFor(
      async () => {
        const corner = await readRoom(cornerId);
        expect(corner.messages.some((m) => (m.text ?? '').includes('ECHO REPLY'))).toBe(true);
      },
      { timeout: 30_000, interval: 500 },
    );
  });

  it('pushes rooms-changed to a connected daemon socket on membership change', { timeout: 60_000 }, async () => {
    const exchange = await auth.createDaemonExchange(AGENT);
    const daemonToken = (await auth.exchangeDaemonToken(exchange.exchangeToken))!.daemonToken;
    const watcher = new DaemonApiClient(origin, daemonToken, AGENT);
    const changed = vi.fn();
    watcher.setRoomsChangedListener(changed);
    let subscribed = false;
    const unsubscribe = watcher.liveSubscribe(ROOM, undefined, undefined, (connected) => {
      if (connected) subscribed = true;
    });
    try {
      await vi.waitFor(() => expect(subscribed).toBe(true), { timeout: 10_000 });
      await operation('createRoom', { workspaceId: WORKSPACE, name: 'wake' });
      await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 10_000 });
    } finally {
      unsubscribe();
      watcher.closeLive();
    }
  });

  it('refreshes a running Room when its repository binding changes over the socket', async () => {
    const execute = vi.spyOn(daemonApi, 'execute');
    await vi.waitFor(() => expect(core.activeRoomIds()).toContain(ROOM));
    await vi.waitFor(() => expect(execute.mock.calls.filter(([name]) => name === 'getAgentCommands').length).toBeGreaterThan(0));
    execute.mockClear();
    await database.query(
      `UPDATE rooms SET repository_resolution='unverified',repository_updated_at=now() WHERE id=$1`,
      [ROOM],
    );
    await vi.waitFor(() => expect(execute.mock.calls.filter(([name]) => name === 'getAgentCommands').length).toBeGreaterThan(0),
      { timeout: 10_000 });
    expect(core.activeRoomIds()).toContain(ROOM);
  });

  it('refreshes a running Room when its GitHub installation changes over the socket', async () => {
    const execute = vi.spyOn(daemonApi, 'execute');
    await vi.waitFor(() => expect(core.activeRoomIds()).toContain(ROOM));
    // The initial command read starts before the socket subscription is ready.
    // Wait for both ends of the notification path before changing the install.
    await vi.waitFor(() => expect(listener.projectionHealth().connected).toBe(true));
    await vi.waitFor(() =>
      expect(core.surfaceHealthSnapshot().find((surface) => surface.id === ROOM)?.stage).toBe('intake-ready'),
    );
    expect(execute.mock.calls.filter(([name]) => name === 'getAgentCommands').length).toBeGreaterThan(0);
    const subscribe = daemonApi.liveSubscribe.bind(daemonApi);
    let replacementSubscribed = false;
    vi.spyOn(daemonApi, 'liveSubscribe').mockImplementation((roomId, cursor, onItems, onState, presence, onCommands) =>
      subscribe(roomId, cursor, onItems, (connected, capabilities) => {
        onState?.(connected, capabilities);
        if (roomId === ROOM && connected && capabilities?.pushIntake) replacementSubscribed = true;
      }, presence, onCommands),
    );
    execute.mockClear();
    await database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_login,account_type)
       VALUES(77,$1,'owner','User')`, [HUMAN],
    );
    await database.query(
      `UPDATE rooms SET github_installation_id=77,repository_updated_at=now() WHERE id=$1`, [ROOM],
    );
    await vi.waitFor(() => expect(execute.mock.calls.filter(([name]) => name === 'getAgentCommands').length).toBeGreaterThan(0),
      { timeout: 10_000 });
    // The command read precedes the replacement socket subscription. The next
    // update must target the new, acknowledged subscription.
    await vi.waitFor(() => expect(replacementSubscribed).toBe(true), { timeout: 10_000 });
    execute.mockClear();
    await database.query(
      `UPDATE github_installations SET status='suspended',updated_at=now() WHERE installation_id=77`,
    );
    await vi.waitFor(() => expect(execute.mock.calls.filter(([name]) => name === 'getAgentCommands').length).toBeGreaterThan(0),
      { timeout: 10_000 });
  });
});
