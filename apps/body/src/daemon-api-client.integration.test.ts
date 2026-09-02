import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPublicKey } from '@beeline/nostr';
import { migrate } from '../../server/src/database.js';
import { PgliteDatabase } from '../../server/src/test-support.js';
import { TokenAuth } from '../../server/src/auth.js';
import { PhoneService } from '../../server/src/phone-service.js';
import { DaemonService } from '../../server/src/daemon-service.js';
import { LiveHub } from '../../server/src/live.js';
import { createBeelineServer } from '../../server/src/server.js';
import { createMonolithAuth, type MonolithAuthMount } from '../../server/src/monolith-auth.js';
import { DaemonApiClient } from './daemon-api-client.js';
import { AcpClient } from './acp.js';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import { completeDevicePairing } from './device-pairing.js';
import {
  launchRuntimeDaemon,
  readRuntimeRecord,
  stopRuntimeDaemon,
  writeRuntimeRecord,
  type AgentRuntimeRecord,
} from './runtime.js';
import { SessionScheduler } from './session-scheduler.js';

const HUMAN = createHash('sha256').update('github:daemon-client-owner').digest('hex');
const AGENT_SECRET = new Uint8Array(32).fill(11);
const AGENT = getPublicKey(AGENT_SECRET);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';

describe('daemon API client against the local monolith', () => {
  let database: PgliteDatabase;
  let auth: TokenAuth;
  let phone: PhoneService;
  let mountedAuth: MonolithAuthMount;
  let server: ReturnType<typeof createBeelineServer>;
  let origin: string;
  let supervisorRoot: string;
  let launchedDaemonConfig: string | undefined;

  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name,github_subject) VALUES($1,'human','Owner','owner'),($2,'agent','Bee',NULL)`,
      [HUMAN, AGENT],
    );
    await database.query(
      `INSERT INTO agents(agent_id,owner_id,soul,selected_model,selected_effort,model_catalog)
       VALUES($1,$2,$3::jsonb,'gpt-5','high',$4::jsonb)`,
      [
        AGENT,
        HUMAN,
        JSON.stringify({ name: 'Bee', instructions: 'Help carefully.' }),
        JSON.stringify([{ id: 'gpt-5', category: 'model', options: [] }]),
      ],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`,
      [WORKSPACE, HUMAN, AGENT, ROOM],
    );
    auth = new TokenAuth(database, async () => ({
      subject: 'owner',
      login: 'owner',
      name: 'Owner',
    }));
    phone = new PhoneService(database, 'http://placeholder');
    mountedAuth = await createMonolithAuth(database, 'https://server.usebeeline.app', undefined, {
      createDaemonExchange: (agentId, transaction) =>
        auth.createDaemonExchange(agentId, transaction),
      env: {
        NODE_ENV: 'test',
        BUZZY_AUTH_TENANTS_JSON: JSON.stringify([
          {
            host: 'server.usebeeline.app',
            community: 'stable-identity-namespace',
            roomCommunityIds: ['relay-community-id'],
            origin: 'https://server.usebeeline.app',
          },
        ]),
        BUZZY_AUTH_OIDC_ISSUER: 'https://accounts.example',
        BUZZY_AUTH_OIDC_AUTHORIZATION_ENDPOINT: 'https://accounts.example/authorize',
        BUZZY_AUTH_OIDC_TOKEN_ENDPOINT: 'https://accounts.example/token',
        BUZZY_AUTH_OIDC_JWKS_URI: 'https://accounts.example/jwks',
        BUZZY_AUTH_OIDC_CLIENT_ID: 'test-client',
      },
    });
    const live = new LiveHub();
    server = createBeelineServer({
      database,
      auth,
      phone,
      daemon: new DaemonService(database, live),
      live,
      mediaMaximumBytes: 1024,
      authHandler: mountedAuth.handle,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    supervisorRoot = await mkdtemp(join(tmpdir(), 'beeline-connect-monolith-'));
  });

  afterEach(async () => {
    if (launchedDaemonConfig) {
      await stopRuntimeDaemon(launchedDaemonConfig).catch(() => undefined);
      launchedDaemonConfig = undefined;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mountedAuth.close();
    await database.close();
    await rm(supervisorRoot, { recursive: true, force: true });
  }, 30_000);

  it('takes an app grant through finish, durable daemon auth, and a visible first heartbeat', async () => {
    const fakeAgent = join(supervisorRoot, 'deterministic-acp.mjs');
    await writeFile(
      fakeAgent,
      `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      sessionId: 'live-thin-session',
      configOptions: [{ id: 'model', category: 'model', currentValue: 'gpt-5.4', options: [{ value: 'gpt-5.4', name: 'GPT-5.4' }] }],
    } });
  } else if (message.method === 'session/set_config_option') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
  } else if (message.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'live-thin-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Thin daemon live proof.' } } } });
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  }
});
`,
      { mode: 0o700 },
    );
    await chmod(fakeAgent, 0o700);
    const code = 'BUZZ-1234ABCD-5678EF90';
    await database.query(
      `INSERT INTO agent_pairing_codes(code_hash,workspace_id,created_by,expires_at)
       VALUES($1,$2,$3,$4)`,
      [
        createHash('sha256').update(code).digest('hex'),
        WORKSPACE,
        HUMAN,
        new Date(Date.now() + 60_000),
      ],
    );
    const payload = JSON.stringify({
      pairing_code: code,
      harness: 'codex',
      model: 'gpt-5.4',
      soul: 'Brisk and kind.',
      agent_name: 'Scout',
    });
    const connected = await new Promise<{ status: number; body: Record<string, string> }>(
      (resolveResponse, rejectResponse) => {
        const outgoing = request(`${origin}/auth/agent/connect`, {
          method: 'POST',
          headers: {
            host: 'server.usebeeline.app',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
        });
        outgoing.once('error', rejectResponse);
        outgoing.once('response', (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          incoming.on('end', () =>
            resolveResponse({
              status: incoming.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string>,
            }),
          );
        });
        outgoing.end(payload);
      },
    );
    expect(connected.status).toBe(200);
    const grant = connected.body;
    expect(grant.daemon_exchange_token).toMatch(/^bde_/);
    expect(grant).not.toHaveProperty('pairing_code');

    const result = await completeDevicePairing(
      {
        agentSecretKey: grant.agent_secret_key!,
        bodySecretKey: grant.body_secret_key!,
        agentName: grant.agent_name!,
        harness: 'codex',
        model: grant.model!,
        soul: grant.soul!,
        workspaceId: grant.workspace_id!,
        workspaceName: grant.workspace_name!,
        pairedBy: grant.paired_by!,
        monolithBaseUrl: origin,
        daemonExchangeToken: grant.daemon_exchange_token!,
      },
      {
        supervisorRoot,
        selectedAgent: { kind: 'codex', command: fakeAgent, args: [] },
        localConfig: { agentBinary: fakeAgent, mcpBinary: 'buzz-dev-mcp', agentEnv: {} },
        validateSelection: async () => undefined,
        launch: async (configPath) => {
          launchedDaemonConfig = configPath;
          const liveRuntime = await readRuntimeRecord(configPath);
          liveRuntime.sandbox = 'off';
          await writeRuntimeRecord(liveRuntime);
          return launchRuntimeDaemon(configPath, {
            entrypoint: resolve('dist/cli.js'),
            env: {
              ...process.env,
              BEELINE_SYSTEMD_USER: '0',
              BUZZ_DEV_MCP_BIN: '/home/lunchbox/.local/bin/buzz-dev-mcp',
              XDG_STATE_HOME: supervisorRoot,
            },
          });
        },
      },
    );
    expect(result.runtime.transport).toMatchObject({ kind: 'monolith', baseUrl: origin });
    expect(result.runtime.transport).toHaveProperty('daemonToken');
    expect(result.runtime.transport).not.toHaveProperty('exchangeToken');

    await vi.waitFor(async () => {
      const room = await phone.readRoom(ROOM, HUMAN);
      expect(
        room?.members.find((member) => member.identity.pubkey === result.runtime.agent.publicKey),
      ).toMatchObject({ presence: { status: 'online', roomId: ROOM } });
    }, { timeout: 10_000 });
    // The server cursor is second-granular; cross the pairing join-note second
    // before creating the human request so this exercises a fresh inbox row.
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_100));

    const sent = await phone.execute(
      'sendRoomMessage',
      {
        roomId: ROOM,
        messageId: 'd'.repeat(64),
        text: '@scout prove the thin daemon path',
        mentions: [result.runtime.agent.publicKey],
      },
      HUMAN,
    );
    await vi.waitFor(async () => {
      const room = await phone.readRoom(ROOM, HUMAN);
      expect(room?.messages).toContainEqual(
        expect.objectContaining({
          author: expect.objectContaining({ pubkey: result.runtime.agent.publicKey }),
          requestId: sent.messageId,
          text: 'Thin daemon live proof.',
        }),
      );
    }, { timeout: 10_000 });
  }, 30_000);

  it('answers a mention in a repo-less Room and keeps monolith presence current', async () => {
    await database.query(
      `UPDATE agents SET selected_model=NULL,selected_effort=NULL WHERE agent_id=$1`,
      [AGENT],
    );
    const exchange = await auth.createDaemonExchange(AGENT);
    const exchanged = await fetch(`${origin}/v1/auth/daemon/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ exchangeToken: exchange.exchangeToken }),
    });
    const token = (await exchanged.json()) as { daemonToken: string };
    const client = new DaemonApiClient(origin, token.daemonToken, AGENT);
    const polled = vi.fn();
    const config = {
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      readonlyMcpCommand: '/nonexistent-readonly-mcp',
      agentEnv: {},
      workspaceRoot: join(supervisorRoot, 'repo-less-room'),
      autoApprovePermissions: true,
      accessPolicy: 'everyone',
    } as const;
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
        publicKey: getPublicKey(new Uint8Array(32).fill(22)),
        secretKeyHex: Buffer.from(new Uint8Array(32).fill(22)).toString('hex'),
      },
      rooms: [],
      supervisorRoot,
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      createdAt: new Date().toISOString(),
      accessPolicy: 'everyone',
      transport: { kind: 'monolith', baseUrl: origin, daemonToken: token.daemonToken },
    };
    const acp = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    vi.spyOn(acp, 'start').mockResolvedValue(undefined);
    vi.spyOn(acp, 'sessionNew').mockResolvedValue({
      sessionId: 'repo-less-session',
      raw: {},
    });
    vi.spyOn(acp, 'sessionPrompt').mockResolvedValue({
      stopReason: 'end_turn',
      updates: [],
      agentText: 'I am Bee, and I am ready to help.',
      toolCalls: [],
    });
    const scheduler = new SessionScheduler({ maxLiveSessions: 2 });
    const abort = new AbortController();
    const turnLoop = new MonolithRoomTurnLoop({
      roomId: ROOM,
      workspaceId: WORKSPACE,
      cwd: config.workspaceRoot,
      runtime,
      config: config as never,
      api: client,
      scheduler,
      health: { poll: polled, failure: vi.fn(), presence: vi.fn() },
      signal: abort.signal,
      pollMs: 10,
      createAcpClient: () => acp,
    });
    const loop = turnLoop.run();
    try {
      await vi.waitFor(() => expect(polled).toHaveBeenCalled(), { timeout: 2_000 });
      const visibleOnline = await phone.readRoom(ROOM, HUMAN);
      expect(
        visibleOnline?.members.find((member) => member.identity.pubkey === AGENT),
      ).toMatchObject({ presence: { status: 'online', roomId: ROOM } });

      const sent = await phone.execute(
        'sendRoomMessage',
        {
          roomId: ROOM,
          messageId: 'e'.repeat(64),
          text: '@bee introduce yourself',
          mentions: [AGENT],
        },
        HUMAN,
      );
      await vi.waitFor(
        async () => {
          const room = await phone.readRoom(ROOM, HUMAN);
          expect(room?.messages).toContainEqual(
            expect.objectContaining({
              author: expect.objectContaining({ pubkey: AGENT }),
              requestId: sent.messageId,
              text: 'I am Bee, and I am ready to help.',
            }),
          );
        },
        { timeout: 3_000 },
      );
    } finally {
      abort.abort();
      await loop;
      await scheduler.dispose();
    }

    const visibleOffline = await phone.readRoom(ROOM, HUMAN);
    expect(
      visibleOffline?.members.find((member) => member.identity.pubkey === AGENT),
    ).toMatchObject({ presence: { status: 'offline', roomId: ROOM } });
  }, 15_000);

  it('exchanges a token and round-trips the thin daemon operations', async () => {
    const exchange = await auth.createDaemonExchange(AGENT);
    const exchanged = await fetch(`${origin}/v1/auth/daemon/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ exchangeToken: exchange.exchangeToken }),
    });
    expect(exchanged.status).toBe(200);
    const token = (await exchanged.json()) as { daemonToken: string; agentId: string };
    const client = new DaemonApiClient(origin, token.daemonToken, AGENT);

    await expect(
      client.execute('getRoomAuthority', { roomId: ROOM, principalId: HUMAN }),
    ).resolves.toEqual(
      expect.objectContaining({ workspaceId: WORKSPACE, role: 'owner', member: true }),
    );
    await expect(
      client.execute('getAgentConfiguration', { agentId: AGENT, roomId: ROOM }),
    ).resolves.toEqual(
      expect.objectContaining({ soul: { name: 'Bee', instructions: 'Help carefully.' } }),
    );
    await expect(
      client.execute('getWorkspaceRoster', { agentId: AGENT, workspaceId: WORKSPACE }),
    ).resolves.toEqual(
      expect.objectContaining({
        members: expect.arrayContaining([
          expect.objectContaining({ identityId: HUMAN, kind: 'human', name: 'Owner' }),
          expect.objectContaining({
            identityId: AGENT,
            kind: 'agent',
            name: 'Bee',
            soul: expect.objectContaining({ instructions: 'Help carefully.' }),
          }),
        ]),
      }),
    );

    const message = await client.execute('postRoomMessage', {
      roomId: ROOM,
      requestId: 'a'.repeat(64),
      text: 'daemon reply',
    });
    const activation = await client.execute('getRoomInbox', {
      roomId: ROOM,
      startAtLatest: true,
    });
    expect(activation).toEqual({ items: [], cursor: expect.any(String) });
    const afterActivation = await client.execute('postRoomMessage', {
      roomId: ROOM,
      requestId: 'd'.repeat(64),
      text: 'after activation',
    });
    await expect(
      client.execute('getRoomInbox', { roomId: ROOM, after: activation.cursor }),
    ).resolves.toEqual(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            id: afterActivation.id,
            authorId: AGENT,
            body: 'after activation',
          }),
        ],
      }),
    );
    expect(message.id).not.toBe(afterActivation.id);

    await client.execute('postAgentTurnReceipt', {
      agentId: AGENT,
      roomId: ROOM,
      requestId: 'a'.repeat(64),
      status: 'complete',
      generationId: 'generation-1',
    });
    expect(
      (
        await database.query<{ status: string }>(
          `SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
          [ROOM, 'a'.repeat(64), AGENT],
        )
      ).rows[0]?.status,
    ).toBe('complete');

    await client.execute('postAgentPresence', {
      agentId: AGENT,
      roomId: ROOM,
      status: 'online',
    });
    await expect(
      client.execute('getAgentPresence', { agentId: AGENT, roomId: ROOM }),
    ).resolves.toEqual(expect.objectContaining({ status: 'online' }));

    await expect(client.execute('getDaemonBootstrap', { agentId: AGENT })).resolves.toEqual(
      expect.objectContaining({
        rooms: [expect.objectContaining({ roomId: ROOM })],
      }),
    );
  });
});
