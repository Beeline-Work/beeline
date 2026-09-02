import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { AgentScheduleLoop } from '../../server/src/agent-schedules.js';
import { DaemonApiClient } from './daemon-api-client.js';
import { AcpClient } from './acp.js';
import { Body } from './body.js';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import { coordinateManagedUpdateHandoff, ManagedUpdateHandoff } from './managed-update.js';
import { completeDevicePairing } from './pair-command.js';
import { readRuntimeRecord, type AgentRuntimeRecord } from './runtime.js';
import { activeReleaseId, writeUpdateState } from './self-update.js';
import { SessionScheduler } from './session-scheduler.js';
import { ThinDaemonCore } from './thin-core.js';

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

  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name,github_subject) VALUES($1,'human','Owner','owner'),($2,'agent','Bee',NULL)`,
      [HUMAN, AGENT],
    );
    await database.query(
      `INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience)
       VALUES('github','owner',$1,'https://github.com','test-client')`,
      [HUMAN],
    );
    await database.query(
      `INSERT INTO agents(agent_id,owner_id,soul,selected_model,selected_effort,model_catalog)
       VALUES($1,$2,$3::jsonb,'gpt-5','high',$4::jsonb)`,
      [
        AGENT,
        HUMAN,
        JSON.stringify({ name: 'Terra', instructions: 'Vishnu, destroyer of worlds.' }),
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mountedAuth.close();
    await database.close();
    await rm(supervisorRoot, { recursive: true, force: true });
  }, 30_000);

  it('takes an app grant through finish, durable daemon auth, and a visible first heartbeat', async () => {
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

    const launched: string[] = [];
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
        selectedAgent: { kind: 'codex', command: 'codex-acp', args: [] },
        localConfig: { agentBinary: 'codex-acp', mcpBinary: 'buzz-dev-mcp', agentEnv: {} },
        validateSelection: async () => undefined,
        launch: async (configPath) => {
          launched.push(configPath);
          const launchedRuntime = await readRuntimeRecord(configPath);
          const transport = launchedRuntime.transport;
          if (!transport || !('daemonToken' in transport)) {
            throw new Error('launch received an unactivated runtime');
          }
          const client = new DaemonApiClient(
            transport.baseUrl,
            transport.daemonToken,
            launchedRuntime.agent.publicKey,
          );
          await client.execute('postAgentPresence', {
            agentId: launchedRuntime.agent.publicKey,
            roomId: ROOM,
            status: 'online',
          });
          return 4242;
        },
      },
    );
    expect(launched).toEqual([result.configPath]);
    expect(result.runtime.transport).toMatchObject({ kind: 'monolith', baseUrl: origin });
    expect(result.runtime.transport).toHaveProperty('daemonToken');
    expect(result.runtime.transport).not.toHaveProperty('exchangeToken');

    const room = await phone.readRoom(ROOM, HUMAN);
    expect(
      room?.members.find((member) => member.identity.pubkey === result.runtime.agent.publicKey),
    ).toMatchObject({ presence: { status: 'online', roomId: ROOM } });
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
    const sourceSha = 'd03cff8f'.padEnd(40, '0');
    const config = {
      agentBinary: '/nonexistent/codex-acp',
      agentCommand: '/nonexistent/codex-acp',
      mcpBinary: '/nonexistent',
      readonlyMcpCommand: '/nonexistent-readonly-mcp',
      agentEnv: {},
      workspaceRoot: join(supervisorRoot, 'repo-less-room'),
      relayBaseUrl: origin,
      relayHost: '127.0.0.1',
      relayScheme: 'http',
      relayWsUrl: origin.replace(/^http/, 'ws'),
      autoApprovePermissions: true,
      accessPolicy: 'everyone',
      agentHomeRoot: join(supervisorRoot, 'agent-home'),
      daemonReleaseVersion: 'v0.0.22',
      daemonSourceSha: sourceSha,
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
      relayBaseUrl: origin,
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      createdAt: new Date().toISOString(),
      accessPolicy: 'everyone',
      transport: { kind: 'monolith', baseUrl: origin, daemonToken: token.daemonToken },
    };
    const acp = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    vi.spyOn(acp, 'start').mockResolvedValue(undefined);
    const sessionNew = vi.spyOn(acp, 'sessionNew').mockResolvedValue({
      sessionId: 'repo-less-session',
      raw: {},
    });
    let finishHarnessTurn!: () => void;
    const harnessTurn = new Promise<void>((resolveTurn) => {
      finishHarnessTurn = resolveTurn;
    });
    const sessionPrompt = vi
      .spyOn(acp, 'sessionPrompt')
      .mockImplementation(async (_sessionId, _prompt, _timeout, onText) => {
        await harnessTurn;
        onText?.('', '');
        onText?.(
          "Terra, respond to the user's latest message.",
          "Terra, respond to the user's latest message.",
        );
        onText?.(
          'I am Terra, Vishnu, destroyer of worlds; I see the image you entrusted to me.',
          'I am Terra, Vishnu, destroyer of worlds; I see the image you entrusted to me.',
        );
        return {
          stopReason: 'end_turn',
          updates: [],
          agentText:
            'I am Terra, Vishnu, destroyer of worlds; I see the image you entrusted to me.',
          toolCalls: [],
        };
      });
    const daemonOperations = vi.spyOn(client, 'execute');
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
    await phone.execute(
      'sendRoomMessage',
      {
        roomId: ROOM,
        messageId: 'f'.repeat(64),
        text: 'Who are you?',
        mentions: [],
      },
      HUMAN,
    );
    const loop = turnLoop.run();
    try {
      await vi.waitFor(() => expect(polled).toHaveBeenCalled(), { timeout: 2_000 });
      const visibleOnline = await phone.readRoom(ROOM, HUMAN);
      expect(
        visibleOnline?.members.find((member) => member.identity.pubkey === AGENT),
      ).toMatchObject({ presence: { status: 'online', roomId: ROOM } });
      await expect(
        fetch(`${origin}/v1/releases/daemon-readiness`).then((response) => response.json()),
      ).resolves.toEqual({
        daemons: [
          expect.objectContaining({
            agentPubkey: AGENT,
            state: 'ready',
            version: 'v0.0.22',
            sha: sourceSha,
            observedAt: expect.any(Number),
          }),
        ],
      });

      const sent = await phone.execute(
        'sendRoomMessage',
        {
          roomId: ROOM,
          messageId: 'e'.repeat(64),
          text: '@bee respond',
          mentions: [AGENT],
          attachments: [
            {
              url: `${origin}/v1/media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
              name: 'world.png',
              mimeType: 'image/png',
              size: 9,
            },
          ],
        },
        HUMAN,
      );
      await vi.waitFor(() => expect(sessionPrompt).toHaveBeenCalled(), { timeout: 3_000 });
      const systemPrompt = sessionNew.mock.calls[0]![0].systemPrompt ?? '';
      expect(systemPrompt).toContain(
        'Your human-authored identity and soul in this Workspace is Terra.',
      );
      expect(systemPrompt).toContain('Soul instructions: Vishnu, destroyer of worlds.');
      expect(systemPrompt).toContain('using-beeline skill (SKILL.md)');
      const wirePrompt = sessionPrompt.mock.calls[0]![1];
      expect(wirePrompt).toContain('This is who you are in this Workspace.');
      expect(wirePrompt).toContain('using-beeline skill (SKILL.md)');
      expect(wirePrompt).toContain('Who are you?');
      expect(wirePrompt).toContain('most recent unanswered human message');
      expect(wirePrompt).toContain('image: world.png (image/png, 9 bytes)');
      expect(wirePrompt).toContain('/v1/media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      expect(turnLoop.isBusy()).toBe(true);
      await turnLoop.prepareForForcedUpdateRestart();
      expect(turnLoop.isBusy()).toBe(true);
      await expect(
        readFile(
          join(supervisorRoot, 'agent-home', 'codex', 'skills', 'using-beeline', 'SKILL.md'),
          'utf8',
        ),
      ).resolves.toContain('name: using-beeline');
      finishHarnessTurn();
      await vi.waitFor(
        async () => {
          const room = await phone.readRoom(ROOM, HUMAN);
          expect(room?.messages).toContainEqual(
            expect.objectContaining({
              author: expect.objectContaining({ pubkey: AGENT }),
              requestId: sent.messageId,
              text: 'I am Terra, Vishnu, destroyer of worlds; I see the image you entrusted to me.',
            }),
          );
        },
        { timeout: 3_000 },
      );
      await vi.waitFor(async () => {
        expect(turnLoop.isBusy()).toBe(false);
        expect(
          (
            await database.query<{ status: string }>(
              `SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
              [ROOM, sent.messageId, AGENT],
            )
          ).rows[0]?.status,
        ).toBe('complete');
      });
      const draftWrites = daemonOperations.mock.calls
        .filter(([operation]) => operation === 'postAgentDraft')
        .map(([, input]) => input);
      expect(draftWrites).toEqual([
        expect.objectContaining({
          turnId: sent.messageId,
          text: 'I am Terra, Vishnu, destroyer of worlds; I see the image you entrusted to me.',
        }),
      ]);
      expect(daemonOperations).toHaveBeenCalledWith(
        'retractAgentLiveOutput',
        expect.objectContaining({ turnId: sent.messageId, kind: 'draft' }),
      );
    } finally {
      finishHarnessTurn();
      abort.abort();
      await loop;
      await scheduler.dispose();
    }

    const visibleOffline = await phone.readRoom(ROOM, HUMAN);
    expect(
      visibleOffline?.members.find((member) => member.identity.pubkey === AGENT),
    ).toMatchObject({ presence: { status: 'offline', roomId: ROOM } });
  }, 15_000);

  it.skipIf(process.env.BEELINE_REAL_THIN_PROOF !== '1')(
    'proves soul, image, skill, and clean update drain through a real thin daemon and harness',
    async () => {
      const agentCommand = process.env.BEELINE_REAL_AGENT_COMMAND;
      const readonlyMcpCommand = process.env.BEELINE_REAL_READONLY_MCP_COMMAND;
      if (!agentCommand || !readonlyMcpCommand) {
        throw new Error('real thin proof requires absolute agent and read-only MCP command paths');
      }
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
      const configPath = join(supervisorRoot, 'runtime.json');
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
        relayBaseUrl: origin,
        agentKind: 'codex',
        agentCommand,
        agentArgs: [],
        agentBinary: agentCommand,
        mcpBinary: readonlyMcpCommand,
        createdAt: new Date().toISOString(),
        accessPolicy: 'everyone',
        transport: { kind: 'monolith', baseUrl: origin, daemonToken: token.daemonToken },
      };
      await writeFile(configPath, `${JSON.stringify(runtime)}\n`, { mode: 0o600 });
      const config = {
        agentKind: 'codex',
        agentCommand,
        agentArgs: [],
        agentBinary: agentCommand,
        mcpBinary: readonlyMcpCommand,
        readonlyMcpCommand,
        agentEnv: {
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
          ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
        },
        workspaceRoot: join(supervisorRoot, 'workspace'),
        relayBaseUrl: origin,
        relayHost: '127.0.0.1',
        relayScheme: 'http',
        relayWsUrl: origin.replace(/^http/, 'ws'),
        autoApprovePermissions: false,
        accessPolicy: 'everyone',
      } as const;
      const core = new ThinDaemonCore(runtime, configPath, config as never, {
        daemonApi: client,
      });
      const abort = new AbortController();
      await phone.execute(
        'sendRoomMessage',
        {
          roomId: ROOM,
          messageId: 'a'.repeat(64),
          text: 'What is your soul? Please identify yourself and acknowledge world.png.',
          mentions: [],
        },
        HUMAN,
      );
      const daemon = core.run({ pollMs: 50, signal: abort.signal });
      try {
        await vi.waitFor(() => expect(core.activeRoomIds()).toContain(ROOM), { timeout: 5_000 });
        const uploaded = await phone.uploadMedia(
          HUMAN,
          new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]),
          'image/png',
          'world.png',
          1_024,
        );
        const phoneAccessToken = (await auth.exchangeGitHubOidc('proof')).accessToken;
        const threadedResponse = await fetch(`${origin}/v1/phone/operations/sendRoomReply`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${phoneAccessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            roomId: ROOM,
            messageId: 'b'.repeat(64),
            parentMessageId: 'a'.repeat(64),
            text: '@bee respond',
            mentions: [AGENT],
            attachments: [uploaded],
          }),
        });
        expect(threadedResponse.status).toBe(200);
        const sent = (await threadedResponse.json()) as { messageId: string };
        await vi.waitFor(
          async () => {
            expect(
              (
                await database.query<{ status: string }>(
                  `SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
                  [ROOM, sent.messageId, AGENT],
                )
              ).rows[0]?.status,
            ).toBe('working');
          },
          { timeout: 10_000 },
        );

        const updateRoot = join(supervisorRoot, 'update-proof');
        const layout = {
          binDir: join(updateRoot, 'bin'),
          libDir: join(updateRoot, 'lib', 'beeline'),
          releasesRoot: join(updateRoot, 'lib', 'beeline-releases'),
        };
        for (const release of ['old', 'new']) {
          const bundle = join(layout.releasesRoot, release, 'lib', 'beeline');
          await mkdir(bundle, { recursive: true });
          await writeFile(join(bundle, 'beeline-cli.mjs'), '#!/usr/bin/env node\n');
          await writeFile(join(bundle, 'bundle.json'), JSON.stringify({ version: release }));
        }
        await mkdir(join(updateRoot, 'lib'), { recursive: true });
        await symlink('beeline-releases/old', layout.libDir);
        const update = await ManagedUpdateHandoff.create(layout, supervisorRoot);
        await writeUpdateState(layout, { stagedReleaseId: 'new' });
        let restarted = false;
        expect(
          await coordinateManagedUpdateHandoff(
            update,
            () => core.quiesceForUpdateIfIdle(),
            async () => {
              restarted = true;
            },
          ),
        ).toBe('waiting-for-idle');
        expect(restarted).toBe(false);
        expect(await activeReleaseId(layout)).toBe('old');

        let reply = '';
        await vi.waitFor(
          async () => {
            const room = await phone.readRoom(ROOM, HUMAN);
            reply =
              room?.messages.find((message) => message.requestId === sent.messageId)?.text ?? '';
            expect(reply).toMatch(/Terra|Vishnu|destroyer/i);
            expect(reply).toMatch(/world\.png|image/i);
          },
          { timeout: 180_000, interval: 500 },
        );
        expect(
          (
            await database.query<{ status: string }>(
              `SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
              [ROOM, sent.messageId, AGENT],
            )
          ).rows[0]?.status,
        ).toBe('complete');
        const durableAgentRows = (
          await database.query<{ text: string }>(
            `SELECT text FROM messages WHERE room_id=$1 AND author_id=$2 AND request_id=$3 AND presentation='message' ORDER BY created_at,id`,
            [ROOM, AGENT, sent.messageId],
          )
        ).rows;
        expect(durableAgentRows).toHaveLength(1);
        expect(durableAgentRows[0]!.text.trim()).not.toBe('');
        expect(durableAgentRows[0]!.text).not.toMatch(/respond to the user's latest message/i);
        const visibleAgentRows =
          (await phone.readRoom(ROOM, HUMAN))?.messages.filter(
            (message) =>
              message.author.pubkey === AGENT &&
              message.requestId === sent.messageId &&
              message.presentation === 'message',
          ) ?? [];
        expect(visibleAgentRows).toHaveLength(1);
        expect(
          (
            await database.query<{ count: string }>(
              `SELECT count(*)::text count FROM live_outputs WHERE room_id=$1 AND agent_id=$2 AND turn_id=$3 AND kind='draft'`,
              [ROOM, AGENT, sent.messageId],
            )
          ).rows[0]?.count,
        ).toBe('0');
        await vi.waitFor(() => expect(core.quiesceForUpdateIfIdle()).toBe(true), {
          timeout: 5_000,
        });
        expect(
          await coordinateManagedUpdateHandoff(
            update,
            () => core.quiesceForUpdateIfIdle(),
            async () => {
              restarted = true;
            },
          ),
        ).toBe('restarting');
        expect(restarted).toBe(true);
        expect(await activeReleaseId(layout)).toBe('new');
        expect(
          (
            await database.query<{ count: string }>(
              `SELECT count(*)::text count FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND status='failed'`,
              [ROOM, sent.messageId],
            )
          ).rows[0]?.count,
        ).toBe('0');
        console.log(
          `[real-thin-proof] request=${sent.messageId} reply=${JSON.stringify(reply)} durable_messages=1 live_drafts=0 update=old->new receipt=complete`,
        );
      } finally {
        abort.abort();
        await daemon;
      }
    },
    240_000,
  );

  it.skipIf(process.env.BEELINE_REAL_SCHEDULE_PROOF !== '1')(
    'posts a one-minute phone schedule and receives a real thin-daemon harness reply',
    async () => {
      const agentCommand = process.env.BEELINE_REAL_SCHEDULE_AGENT_COMMAND;
      const apiKey = process.env.OPENAI_API_KEY;
      if (!agentCommand || !apiKey) {
        throw new Error(
          'real schedule proof requires an absolute Agent command and OPENAI_API_KEY',
        );
      }
      await database.query(
        `UPDATE agents SET selected_model=NULL,selected_effort=NULL WHERE agent_id=$1`,
        [AGENT],
      );
      const exchange = await auth.createDaemonExchange(AGENT);
      const daemonGrant = await fetch(`${origin}/v1/auth/daemon/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exchangeToken: exchange.exchangeToken }),
      });
      const daemonToken = (await daemonGrant.json()) as { daemonToken: string };
      const api = new DaemonApiClient(origin, daemonToken.daemonToken, AGENT);
      const phoneToken = await auth.exchangeGitHubOidc('schedule-proof');
      const configPath = join(supervisorRoot, 'schedule-runtime.json');
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
        relayBaseUrl: origin,
        agentKind: 'reference',
        agentCommand,
        agentArgs: [],
        agentBinary: agentCommand,
        mcpBinary: process.execPath,
        createdAt: new Date().toISOString(),
        accessPolicy: 'everyone',
        transport: { kind: 'monolith', baseUrl: origin, daemonToken: daemonToken.daemonToken },
      };
      await writeFile(configPath, `${JSON.stringify(runtime)}\n`, { mode: 0o600 });
      const config = {
        agentKind: 'reference',
        agentCommand,
        agentArgs: [],
        agentBinary: agentCommand,
        mcpBinary: process.execPath,
        readonlyMcpCommand: process.execPath,
        readonlyMcpArgs: [new URL('../dist/read-only-mcp.js', import.meta.url).pathname],
        agentEnv: {
          PATH: process.env.PATH ?? '',
          HOME: join(supervisorRoot, 'harness-home'),
          TMPDIR: join(supervisorRoot, 'harness-tmp'),
          RUST_LOG: 'warn',
          BUZZ_AGENT_PROVIDER: 'openai',
          OPENAI_COMPAT_API_KEY: apiKey,
          OPENAI_COMPAT_BASE_URL: 'https://api.openai.com/v1',
          OPENAI_COMPAT_MODEL: process.env.BEELINE_REAL_SCHEDULE_MODEL ?? 'gpt-5.4-mini',
          OPENAI_COMPAT_API: 'responses',
        },
        workspaceRoot: join(supervisorRoot, 'schedule-workspace'),
        relayBaseUrl: origin,
        relayHost: '127.0.0.1',
        relayScheme: 'http',
        relayWsUrl: origin.replace(/^http/, 'ws'),
        autoApprovePermissions: false,
        accessPolicy: 'everyone',
      } as const;
      const core = new ThinDaemonCore(runtime, configPath, config as never, { daemonApi: api });
      const abort = new AbortController();
      const daemon = core.run({ pollMs: 100, signal: abort.signal });
      const scheduleLoop = new AgentScheduleLoop(database);
      let tick = Promise.resolve();
      let tickError: unknown;
      const timer = setInterval(() => {
        tick = tick
          .then(() => scheduleLoop.runOnce())
          .then(() => undefined)
          .catch((error) => {
            tickError = error;
          });
      }, 100);
      try {
        await vi.waitFor(() => expect(core.activeRoomIds()).toContain(ROOM), { timeout: 5_000 });
        const startsAt = Math.floor(Date.now() / 1_000) + 60;
        const response = await fetch(`${origin}/v1/phone/operations/createRoomSchedule`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${phoneToken.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            workspaceId: WORKSPACE,
            roomId: ROOM,
            agentId: AGENT,
            cadence: { kind: 'interval', everyMinutes: 60, startsAt },
            message: 'Reply with exactly: SCHEDULE PROOF COMPLETE',
          }),
        });
        expect(response.status).toBe(200);
        const schedule = (await response.json()) as { id: string; nextRunAt: number };
        expect(schedule.nextRunAt).toBe(startsAt);

        let requestId = '';
        let reply = '';
        await vi.waitFor(
          async () => {
            if (tickError) throw tickError;
            const scheduled = (
              await database.query<{ id: string; author_id: string; mention_ids: string[] }>(
                `SELECT id,author_id,mention_ids FROM messages
                 WHERE text='Reply with exactly: SCHEDULE PROOF COMPLETE'`,
              )
            ).rows[0];
            expect(scheduled).toMatchObject({ author_id: HUMAN, mention_ids: [AGENT] });
            requestId = scheduled!.id;
            reply =
              (
                await database.query<{ text: string }>(
                  `SELECT text FROM messages WHERE author_id=$1 AND request_id=$2
                   ORDER BY created_at DESC LIMIT 1`,
                  [AGENT, requestId],
                )
              ).rows[0]?.text ?? '';
            expect(reply).toMatch(/SCHEDULE PROOF COMPLETE/i);
          },
          { timeout: 240_000, interval: 500 },
        );
        expect(
          (
            await database.query<{ count: string }>(
              `SELECT count(*)::text count FROM agent_schedule_occurrences WHERE schedule_id=$1`,
              [schedule.id],
            )
          ).rows[0]?.count,
        ).toBe('1');
        console.log(
          `[real-schedule-proof] schedule=${schedule.id} request=${requestId} ` +
            `author=${HUMAN} mention=${AGENT} reply=${JSON.stringify(reply)}`,
        );
      } finally {
        clearInterval(timer);
        await tick;
        abort.abort();
        await daemon;
      }
    },
    300_000,
  );

  it('exchanges a token and round-trips inbox, receipts, authority, settings, presence, and corners', async () => {
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
      expect.objectContaining({
        soul: { name: 'Terra', instructions: 'Vishnu, destroyer of worlds.' },
      }),
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
            soul: expect.objectContaining({ instructions: 'Vishnu, destroyer of worlds.' }),
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
      // Inbox intake deliberately suppresses the daemon's own messages. The
      // conversation operation is the round-trip surface for its writes.
      client.execute('getRoomConversation', { roomId: ROOM, after: activation.cursor }),
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

    const corner = await client.execute('createCorner', {
      roomId: ROOM,
      requestId: 'c'.repeat(64),
      name: 'Cutover corner',
      task: 'Verify the monolith cut',
    });
    await client.execute('postCornerLifecycle', {
      cornerId: corner.cornerId,
      status: 'working',
      objective: 'Verify the monolith cut',
    });
    await client.execute('postCornerRemoteState', {
      cornerId: corner.cornerId,
      branch: 'fm/verify-monolith-cut',
      state: 'in-review',
      checks: 'passing',
      pullRequest: {
        number: 812,
        url: 'https://github.com/lunchboxfortwo/beeline/pull/812',
        title: 'Verify the monolith cut',
        targetBranch: 'main',
        headSha: '1'.repeat(40),
        mergeability: 'clean',
      },
    });
    expect(
      (
        await database.query<{ lifecycle: Record<string, unknown> }>(
          `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
          [corner.cornerId],
        )
      ).rows[0]?.lifecycle,
    ).toEqual(
      expect.objectContaining({
        lifecycle: 'in-review',
        checks: 'passing',
        pr: expect.objectContaining({ number: 812, targetBranch: 'main' }),
      }),
    );

    await client.execute('postRoomMessage', {
      roomId: ROOM,
      text: 'Merged pull request #812 into main.',
      presentation: 'card',
      tags: { cornerId: corner.cornerId, outcome: 'landed' },
    });
    await client.execute('postCornerRemoteState', {
      cornerId: corner.cornerId,
      branch: 'fm/verify-monolith-cut',
      state: 'gone',
      checks: 'passing',
    });
    await client.execute('archiveCorner', { cornerId: corner.cornerId });
    expect(
      (
        await database.query<{ archived: boolean }>(
          `SELECT archived_at IS NOT NULL archived FROM rooms WHERE id=$1`,
          [corner.cornerId],
        )
      ).rows[0]?.archived,
    ).toBe(true);
    expect(
      (
        await database.query<{ text: string }>(
          `SELECT text FROM messages WHERE room_id=$1 AND presentation='card' ORDER BY created_at DESC LIMIT 1`,
          [ROOM],
        )
      ).rows[0]?.text,
    ).toBe('Merged pull request #812 into main.');
    await expect(client.execute('listRoomCorners', { roomId: ROOM })).resolves.toEqual(
      expect.objectContaining({
        corners: [expect.objectContaining({ cornerId: corner.cornerId, parentRoomId: ROOM })],
      }),
    );
    expect(
      (
        await database.query(
          `SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL`,
          [corner.cornerId, HUMAN],
        )
      ).rowCount,
    ).toBe(1);
    await expect(client.execute('getDaemonBootstrap', { agentId: AGENT })).resolves.toEqual(
      expect.objectContaining({
        rooms: [expect.objectContaining({ roomId: ROOM })],
      }),
    );
  });
});
