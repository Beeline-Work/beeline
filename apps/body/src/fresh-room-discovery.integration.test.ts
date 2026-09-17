import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
            ...(process.env.BEELINE_TEST_REPO_KEY
              ? { repository: process.env.BEELINE_TEST_REPO_KEY, targetBranch: 'main' }
              : {}),
          }),
        },
      );
      const body = await response.json();
      const cornerId = body.cornerId ?? ('http-' + response.status + ':' + JSON.stringify(body));
      // Production fidelity: the parent turn keeps running after open_corner.
      await new Promise((r) => setTimeout(r, 3000));
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

describe('fresh Room discovery through the live membership wake', () => {
  let database: PgliteDatabase;
  let origin: string;
  let server: ReturnType<typeof createBeelineServer>;
  let accessToken: string;
  let core: ThinDaemonCore;
  let abort: AbortController;
  let supervisorRoot: string;
  let live: LiveHub;
  let listener: PostgresLiveListener;
  let auth: TokenAuth;

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
    database = new PgliteDatabase();
    await migrate(database);
    await new (await import('@beeline/auth/store')).AuthStore(
      database as unknown as TransactionalDatabase,
    ).migrate();
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
    auth = new TokenAuth(database, async (proof) => ({
      subject: proof === 'proof' ? 'owner' : proof,
      login: proof === 'proof' ? 'owner' : proof,
      name: 'Owner',
    }));
    const phone = new PhoneService(database, 'http://placeholder');
    live = new LiveHub();
    const daemon = new DaemonService(database, live, async () => ({
      token: 'test-room-token',
      expiresAt: Date.now() + 60_000,
    }));
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
      },
      workspaceRoot: join(supervisorRoot, 'workspace'),
      relayBaseUrl: origin,
      relayHost: '127.0.0.1',
      relayScheme: 'http',
      relayWsUrl: origin.replace(/^http/, 'ws'),
      autoApprovePermissions: false,
      accessPolicy: 'everyone',
    } as never;
    const api = new DaemonApiClient(origin, daemonToken, AGENT);
    core = new ThinDaemonCore(runtime, configPath, config, {
      daemonApi: api,
      reconcileHeartbeatMs: RECONCILE_HEARTBEAT_MS,
    });
    abort = new AbortController();
    void core.run({ pollMs: 100, signal: abort.signal });
  });

  afterEach(async () => {
    abort?.abort();
    await listener?.stop();
    await new Promise((r) => setTimeout(r, 150));
    if (server) await new Promise<void>((resolve2) => server.close(() => resolve2()));
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
  const operation = (name: string, payload: unknown) =>
    request(`/v1/phone/operations/${name}`, 'POST', payload);
  const readRoom = async (roomId: string) =>
    (await (await request(`/v1/phone/rooms/${roomId}`)).json()) as {
      messages: Array<{ authorId?: string; text?: string }>;
    };

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
    // startRoom runs before the corner-start pass in reconcile(); without
    // per-Room isolation this deterministic failure aborts every reconcile
    // before any corner starts — the agent keeps serving its running Rooms and
    // looks healthy, while the freshly opened corner never acts.
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
    // The broken Room itself never becomes active.
    expect(core.activeRoomIds()).not.toContain(brokenRoom);
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
    process.env.BEELINE_TEST_REPO_KEY = 'owner/widgets';
    try {
      await vi.waitFor(() => expect(core.activeRoomIds()).toContain(ROOM), { timeout: 10_000 });
      await operation('sendRoomMessage', {
        roomId: ROOM,
        messageId: 'e'.repeat(64),
        text: '@bee OPEN CORNER now',
      });
      const room = await vi.waitFor(
        async () => {
          const room = await readRoom(ROOM);
          expect(
            room.messages.some((m) => (m.text ?? '').includes('CORNER OPENED ')),
          ).toBe(true);
          return room;
        },
        { timeout: 30_000, interval: 500 },
      );
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
    } finally {
      delete process.env.BEELINE_TEST_REPO_KEY;
    }
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
    }
  });
});
