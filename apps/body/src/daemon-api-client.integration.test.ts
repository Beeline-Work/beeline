import { execFile } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
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
import { GitHubOperations } from '../../server/src/github-operations.js';
import { DaemonApiClient } from './daemon-api-client.js';
import { AcpClient } from './acp.js';
import {
  agentReplyMentionIds,
  inboxItemTriggersTurn,
  isScheduledPrompt,
  MonolithRoomTurnLoop,
  roomPrincipalMayAddressAgent,
} from './monolith-room-turn.js';
import {
  SCHEDULE_RAN_VERB,
  SCHEDULE_SCHEDULER_ID,
  SCHEDULE_SCHEDULER_NAME,
} from '@beeline/api-contract/scheduled-prompts';
import { completeDevicePairing } from './device-pairing.js';
import { coordinateManagedUpdateHandoff, ManagedUpdateHandoff } from './managed-update.js';
import {
  launchRuntimeDaemon,
  readRuntimeRecord,
  stopRuntimeDaemon,
  writeRuntimeRecord,
  type AgentRuntimeRecord,
} from './runtime.js';
import { activeReleaseId, writeUpdateState } from './self-update.js';
import { SessionScheduler } from './session-scheduler.js';
import { ThinDaemonCore } from './thin-core.js';

const execFileAsync = promisify(execFile);

const HUMAN = createHash('sha256').update('github:daemon-client-owner').digest('hex');
const AGENT_SECRET = new Uint8Array(32).fill(11);
const AGENT = getPublicKey(AGENT_SECRET);
const PEER_AGENT_SECRET = new Uint8Array(32).fill(12);
const PEER_AGENT = getPublicKey(PEER_AGENT_SECRET);
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

  it('routes model-written peer names through validated agent mention ids', () => {
    const peer = 'peer-agent';
    const roster = {
      members: [
        { identityId: AGENT, kind: 'agent' as const, name: 'Bee', role: 'member' as const },
        {
          identityId: peer,
          kind: 'agent' as const,
          name: 'Codex',
          handle: 'codex-helper',
          role: 'member' as const,
          soul: {
            name: 'Clockwork',
            instructions: '',
            avatarSeed: peer,
            authoredBy: HUMAN,
            updatedAt: 1,
          },
        },
        {
          identityId: HUMAN,
          kind: 'human' as const,
          name: 'Owner',
          handle: 'lunchboxfortwo',
          role: 'owner' as const,
        },
      ],
    };

    expect(agentReplyMentionIds('@codex what time is it?', roster, AGENT)).toEqual([peer]);
    expect(agentReplyMentionIds('Please ask @Clockwork.', roster, AGENT)).toEqual([peer]);
    expect(agentReplyMentionIds('Mail codex@example.com', roster, AGENT)).toEqual([]);
    expect(agentReplyMentionIds('@Owner please review', roster, AGENT)).toEqual([HUMAN]);
    expect(agentReplyMentionIds('@a_lunchboxfortwo please review', roster, AGENT)).toEqual([HUMAN]);
    expect(agentReplyMentionIds('Unknown @Stranger stays plain text', roster, AGENT)).toEqual([]);
    expect(
      roomPrincipalMayAddressAgent(
        { workspaceId: WORKSPACE, member: true, principalKind: 'agent' },
        false,
      ),
    ).toBe(true);
    expect(
      roomPrincipalMayAddressAgent(
        { workspaceId: WORKSPACE, member: true, principalKind: 'human' },
        false,
      ),
    ).toBe(false);
  });

  it.skipIf(process.env.BEELINE_REAL_ROOM_CAPABILITY_PROOF !== '1')(
    'proves two real codex Room agents can address a peer and open a corner',
    async () => {
      const agentCommand = process.env.BEELINE_REAL_AGENT_COMMAND;
      const readonlyMcpCommand = process.env.BEELINE_REAL_READONLY_MCP_COMMAND;
      if (!agentCommand || !readonlyMcpCommand) {
        throw new Error('real Room capability proof requires agent and read-only MCP commands');
      }
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Codex')`, [
        PEER_AGENT,
      ]);
      await database.query(
        `INSERT INTO agents(agent_id,owner_id,soul,selected_model,selected_effort,model_catalog)
         VALUES($1,$2,$3::jsonb,NULL,NULL,'[]'::jsonb)`,
        [
          PEER_AGENT,
          HUMAN,
          JSON.stringify({ name: 'Codex', instructions: 'Answer directly and briefly.' }),
        ],
      );
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
        [WORKSPACE, PEER_AGENT, ROOM],
      );
      await database.query(
        `UPDATE agents SET selected_model=NULL,selected_effort=NULL,
           soul=$2::jsonb WHERE agent_id=$1`,
        [
          AGENT,
          JSON.stringify({
            name: 'Terra',
            instructions:
              'Follow requests literally. To ask Codex something, address @codex with the question. For repository work, call open_corner.',
          }),
        ],
      );
      await database.query(
        `UPDATE rooms SET repository_key='local/beeline',repository_name='local/beeline',
           repository_remote=$2,repository_resolution='repository',repository_target_branch='main'
         WHERE id=$1`,
        [ROOM, `file://${process.cwd()}`],
      );

      const makeCore = async (agentId: string, secret: Uint8Array, name: string, root: string) => {
        await mkdir(root, { recursive: true });
        const exchange = await auth.createDaemonExchange(agentId);
        const exchanged = await fetch(`${origin}/v1/auth/daemon/exchange`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ exchangeToken: exchange.exchangeToken }),
        });
        const token = (await exchanged.json()) as { daemonToken: string };
        const runtime: AgentRuntimeRecord = {
          version: 2,
          communityId: WORKSPACE,
          pairedBy: HUMAN,
          agent: {
            name,
            publicKey: agentId,
            secretKeyHex: Buffer.from(secret).toString('hex'),
          },
          body: {
            name: `${name} Body`,
            publicKey: getPublicKey(new Uint8Array(32).fill(name === 'Terra' ? 21 : 22)),
            secretKeyHex: Buffer.from(new Uint8Array(32).fill(name === 'Terra' ? 21 : 22)).toString(
              'hex',
            ),
          },
          rooms: [
            {
              channelId: ROOM,
              root: join(root, 'room'),
              repo: { root: process.cwd(), targetBranch: 'main' },
            },
          ],
          supervisorRoot: root,
          agentKind: 'codex',
          agentCommand,
          agentArgs: [],
          agentBinary: agentCommand,
          mcpBinary: readonlyMcpCommand,
          accessPolicy: 'everyone',
          transport: { kind: 'monolith', baseUrl: origin, daemonToken: token.daemonToken },
        };
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
          operatorHome: process.env.HOME,
          workspaceRoot: process.cwd(),
          autoApprovePermissions: false,
          accessPolicy: 'everyone',
        } as const;
        const configPath = join(root, 'runtime.json');
        await writeFile(configPath, `${JSON.stringify(runtime)}\n`, { mode: 0o600 });
        const client = new DaemonApiClient(origin, token.daemonToken, agentId);
        return {
          core: new ThinDaemonCore(runtime, configPath, config as never, {
            daemonApi: client,
            reconcileHeartbeatMs: 60_000,
          }),
          client,
        };
      };

      const terra = await makeCore(AGENT, AGENT_SECRET, 'Terra', join(supervisorRoot, 'terra'));
      const codex = await makeCore(
        PEER_AGENT,
        PEER_AGENT_SECRET,
        'Codex',
        join(supervisorRoot, 'codex'),
      );
      const terraAbort = new AbortController();
      const codexAbort = new AbortController();
      const terraRun = terra.core.run({ pollMs: 50, signal: terraAbort.signal });
      const codexRun = codex.core.run({ pollMs: 50, signal: codexAbort.signal });
      try {
        await vi.waitFor(
          () => {
            expect(terra.core.activeRoomIds()).toContain(ROOM);
            expect(codex.core.activeRoomIds()).toContain(ROOM);
          },
          { timeout: 10_000, interval: 100 },
        );
        // activeRoomIds is populated before the Room leaf finishes its
        // start-at-latest inbox read. Let both leaves install their cursors so
        // the first proof message cannot be mistaken for startup history.
        await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
        await phone.execute(
          'sendRoomMessage',
          {
            roomId: ROOM,
            messageId: createHash('sha256').update('real-agent-addressing-proof').digest('hex'),
            mentions: [AGENT],
            text: '@terra ask codex what time it is',
          },
          HUMAN,
        );
        await vi.waitFor(
          async () => {
            const conversation = await terra.client.execute('getRoomConversation', {
              roomId: ROOM,
              limit: 200,
            });
            const terraMessage = conversation.items.find(
              (item) => item.authorId === AGENT && /@codex\b/i.test(item.body),
            );
            expect(terraMessage?.mentionIds).toContain(PEER_AGENT);
            expect(
              conversation.items.some(
                (item) =>
                  item.authorId === PEER_AGENT &&
                  item.requestId === terraMessage!.id &&
                  item.type === 'message' &&
                  item.body.trim().length > 0,
              ),
            ).toBe(true);
          },
          { timeout: 240_000, interval: 500 },
        );

        await phone.execute(
          'sendRoomMessage',
          {
            roomId: ROOM,
            messageId: createHash('sha256').update('real-open-corner-proof').digest('hex'),
            mentions: [AGENT],
            text: '@terra open a corner to add a README line',
          },
          HUMAN,
        );
        let cornerId = '';
        await vi.waitFor(
          async () => {
            const corners = await terra.client.execute('listRoomCorners', { roomId: ROOM });
            cornerId = corners.corners[0]?.cornerId ?? '';
            expect(cornerId).toBeTruthy();
          },
          { timeout: 240_000, interval: 500 },
        );
        const conversation = await terra.client.execute('getRoomConversation', {
          roomId: ROOM,
          limit: 200,
        });
        const terraMessage = conversation.items.find(
          (item) => item.authorId === AGENT && /@codex\b/i.test(item.body),
        );
        const codexMessage = conversation.items.find(
          (item) =>
            item.authorId === PEER_AGENT &&
            item.requestId === terraMessage?.id &&
            item.type === 'message' &&
            item.body.trim().length > 0,
        );
        console.log(
          [
            '[real-room-capability-proof]',
            `Terra: ${terraMessage?.body}`,
            `Terra mention ids: ${terraMessage?.mentionIds.join(',')}`,
            `Codex: ${codexMessage?.body}`,
            `Corner: ${cornerId}`,
          ].join('\n'),
        );
      } finally {
        terraAbort.abort();
        codexAbort.abort();
        await Promise.all([terraRun, codexRun]);
      }
    },
    540_000,
  );

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
    const githubOperations = new GitHubOperations(
      database,
      {} as never,
      { deleteBranch: async () => undefined } as never,
      'local-proof-secret',
    );
    server = createBeelineServer({
      database,
      auth,
      phone,
      daemon: new DaemonService(database, live, async () => ({
        token: process.env.BEELINE_REAL_GITHUB_TOKEN ?? 'github-room-token',
        expiresAt: Date.now() + 60 * 60_000,
      })),
      live,
      mediaMaximumBytes: 1024,
      authHandler: mountedAuth.handle,
      github: {
        webhookSecret: 'local-proof-secret',
        onWebhook: (event, payload) => githubOperations.processWebhook(event, payload),
      },
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
      // This flow finishes the join itself via /auth/agent/connect/finish
      // below, once its rename decision settles.
      defer_join: true,
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

    // The wizard's rename window has closed (kept, in this test): join the
    // Rooms the claim seeded and write the "joined" announcement.
    const finishPayload = JSON.stringify({
      pairing_code: code,
      workspace_joined: (grant as unknown as { workspace_joined: boolean }).workspace_joined,
    });
    const finished = await new Promise<{ status: number }>((resolveResponse, rejectResponse) => {
      const outgoing = request(`${origin}/auth/agent/connect/finish`, {
        method: 'POST',
        headers: {
          host: 'server.usebeeline.app',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(finishPayload),
        },
      });
      outgoing.once('error', rejectResponse);
      outgoing.once('response', (incoming) => {
        incoming.resume();
        incoming.once('end', () => resolveResponse({ status: incoming.statusCode ?? 0 }));
      });
      outgoing.end(finishPayload);
    });
    expect(finished.status).toBe(200);

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

    await vi.waitFor(
      async () => {
        const room = await phone.readRoom(ROOM, HUMAN);
        expect(
          room?.members.find((member) => member.identity.pubkey === result.runtime.agent.publicKey),
        ).toMatchObject({ presence: { status: 'online', roomId: ROOM } });
      },
      { timeout: 10_000 },
    );
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
    await vi.waitFor(
      async () => {
        const room = await phone.readRoom(ROOM, HUMAN);
        expect(room?.messages).toContainEqual(
          expect.objectContaining({
            author: expect.objectContaining({ pubkey: result.runtime.agent.publicKey }),
            requestId: sent.messageId,
            text: 'Thin daemon live proof.',
          }),
        );
      },
      { timeout: 10_000 },
    );
  }, 30_000);

  it('answers persisted implicit targets in a repo-less Room and keeps monolith presence current', async () => {
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
    let promptCount = 0;
    const sessionPrompt = vi
      .spyOn(acp, 'sessionPrompt')
      .mockImplementation(async (_sessionId, _prompt, _timeout, onText) => {
        promptCount += 1;
        if (promptCount === 1) await harnessTurn;
        const agentText =
          promptCount === 1
            ? 'This cancelled answer must not be published.'
            : 'Course changed: I will focus only on the latest human steer.';
        if (promptCount > 1) {
          onText?.('', '');
          onText?.(
            "Terra, respond to the user's latest message.",
            "Terra, respond to the user's latest message.",
          );
          onText?.(agentText, agentText);
        }
        return {
          stopReason: 'end_turn',
          updates: [],
          agentText,
          toolCalls: [],
        };
      });
    const sessionSteer = vi.spyOn(acp, 'sessionSteer').mockImplementation(async () => {
      if (sessionSteer.mock.calls.length === 1) {
        return { runId: 'run-original', messageId: 'steer-1' };
      }
      throw new Error('harness cannot accept another live steer');
    });
    const sessionCancel = vi.spyOn(acp, 'sessionCancel').mockImplementation(() => {
      finishHarnessTurn();
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
        summary: { total: 1, ready: 1, neverSeen: 0 },
      });

      const sent = await phone.execute(
        'sendRoomMessage',
        {
          roomId: ROOM,
          // IDs break same-millisecond transcript timestamps deterministically. Keep the
          // original request before its two live steers while exercising main's implicit
          // agent target resolution (no client-supplied mention).
          messageId: '1'.repeat(64),
          text: 'Introduce yourself',
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
      expect(systemPrompt).toContain('including another agent');
      expect(systemPrompt).toContain('beeline-agent open_corner');
      expect(sessionNew.mock.calls[0]![0].mcpServers?.map((server) => server.name)).toEqual([
        'beeline-readonly-mcp',
        'beeline-agent',
      ]);
      expect(
        sessionNew.mock.calls[0]![0].mcpServers?.flatMap((server) => server.env ?? []).map(
          (entry) => entry.name,
        ),
      ).not.toEqual(expect.arrayContaining(['GH_TOKEN', 'GITHUB_TOKEN']));
      const wirePrompt = sessionPrompt.mock.calls[0]![1];
      expect(wirePrompt).toContain('This is who you are in this Workspace.');
      expect(wirePrompt).toContain('using-beeline skill (SKILL.md)');
      expect(wirePrompt).toContain('including another agent');
      expect(wirePrompt).toContain('beeline-agent open_corner');
      expect(wirePrompt).toContain('Who are you?');
      expect(wirePrompt).toContain('most recent unanswered human message');
      expect(wirePrompt).toContain('image: world.png (image/png, 9 bytes)');
      expect(wirePrompt).toContain('/v1/media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      expect(wirePrompt).toMatch(
        /Maintain your assigned identity and soul in every response, including when tools or permissions block the requested action\.$/,
      );
      expect(turnLoop.isBusy()).toBe(true);
      await turnLoop.prepareForForcedUpdateRestart();
      expect(turnLoop.isBusy()).toBe(true);
      const steer = await phone.execute(
        'sendRoomMessage',
        {
          roomId: ROOM,
          messageId: '2'.repeat(64),
          text: 'Change course and focus only on this steer.',
          mentions: [],
        },
        HUMAN,
      );
      await vi.waitFor(() => expect(sessionSteer).toHaveBeenCalledTimes(1), { timeout: 3_000 });
      expect(sessionSteer.mock.calls[0]?.[1]).toContain(
        'Change course and focus only on this steer.',
      );
      const fallbackSteer = await phone.execute(
        'sendRoomMessage',
        {
          roomId: ROOM,
          messageId: '3'.repeat(64),
          text: 'Ignore the introduction and report only the steering result.',
          mentions: [],
        },
        HUMAN,
      );
      await vi.waitFor(() => expect(sessionSteer).toHaveBeenCalledTimes(2), { timeout: 3_000 });
      await vi.waitFor(() => expect(sessionPrompt).toHaveBeenCalledTimes(2), { timeout: 3_000 });
      expect(sessionCancel).toHaveBeenCalledTimes(1);
      const resumePrompt = sessionPrompt.mock.calls[1]?.[1] ?? '';
      expect(resumePrompt).toContain('Change course and focus only on this steer.');
      expect(resumePrompt).toContain(
        'Ignore the introduction and report only the steering result.',
      );
      expect(resumePrompt.indexOf('Change course')).toBeLessThan(
        resumePrompt.indexOf('Ignore the introduction'),
      );
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
              text: 'Course changed: I will focus only on the latest human steer.',
            }),
          );
        },
        { timeout: 3_000 },
      );
      const visible = await phone.readRoom(ROOM, HUMAN);
      expect(
        visible?.messages
          .filter(
            (message) =>
              message.id === sent.messageId ||
              message.id === steer.messageId ||
              message.id === fallbackSteer.messageId,
          )
          .map((message) => ({ id: message.id, text: message.text })),
      ).toEqual([
        { id: sent.messageId, text: 'Introduce yourself' },
        { id: steer.messageId, text: 'Change course and focus only on this steer.' },
        {
          id: fallbackSteer.messageId,
          text: 'Ignore the introduction and report only the steering result.',
        },
      ]);
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
      const followup = await phone.execute(
        'sendRoomMessage',
        {
          roomId: ROOM,
          messageId: '8'.repeat(64),
          text: 'Who are you?',
        },
        HUMAN,
      );
      // Each of the remaining messages is awaited to its OWN prompt before the
      // next one is sent. `sessionPrompt`'s count only ever climbs, so a target
      // the loop can run past is a target `vi.waitFor` can miss between polls
      // and then never see again: waiting here for 2 (the count already
      // reached before this message was sent) returned instantly, left the
      // followup's prompt in flight, and handed the next wait a count that
      // could jump 2 → 3 → 4 inside one poll interval — 'expected 3, got 4',
      // for good. One message outstanding at a time makes every target a
      // resting point.
      await vi.waitFor(() => expect(sessionPrompt).toHaveBeenCalledTimes(3), { timeout: 3_000 });
      await vi.waitFor(async () => {
        const room = await phone.readRoom(ROOM, HUMAN);
        expect(room?.messages).toContainEqual(
          expect.objectContaining({
            author: expect.objectContaining({ pubkey: AGENT }),
            requestId: followup.messageId,
          }),
        );
      });

      const agentParent = (await phone.readRoom(ROOM, HUMAN))?.messages.find(
        (message) => message.requestId === followup.messageId,
      );
      expect(agentParent).toBeDefined();
      const threaded = await phone.execute(
        'sendRoomReply',
        {
          roomId: ROOM,
          messageId: '9'.repeat(64),
          parentMessageId: agentParent!.id,
          text: 'Answer in this thread too.',
        },
        HUMAN,
      );
      await vi.waitFor(() => expect(sessionPrompt).toHaveBeenCalledTimes(4), { timeout: 3_000 });
      await vi.waitFor(async () => {
        const room = await phone.readRoom(ROOM, HUMAN);
        expect(room?.messages).toContainEqual(
          expect.objectContaining({
            author: expect.objectContaining({ pubkey: AGENT }),
            requestId: threaded.messageId,
          }),
        );
      });
      await vi.waitFor(() =>
        expect(daemonOperations).toHaveBeenCalledWith(
          'postAgentDraft',
          expect.objectContaining({ turnId: threaded.messageId }),
        ),
      );
      const draftWrites = daemonOperations.mock.calls
        .filter(([operation]) => operation === 'postAgentDraft')
        .map(([, input]) => input);
      expect(draftWrites).toEqual([
        expect.objectContaining({
          turnId: sent.messageId,
          text: 'Course changed: I will focus only on the latest human steer.',
        }),
        expect.objectContaining({
          turnId: followup.messageId,
          text: 'Course changed: I will focus only on the latest human steer.',
        }),
        expect.objectContaining({
          turnId: threaded.messageId,
          text: 'Course changed: I will focus only on the latest human steer.',
        }),
      ]);
      for (const requestId of [sent.messageId, followup.messageId, threaded.messageId]) {
        await vi.waitFor(() =>
          expect(daemonOperations).toHaveBeenCalledWith(
            'retractAgentLiveOutput',
            expect.objectContaining({ turnId: requestId, kind: 'draft' }),
          ),
        );
      }
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
    'proves live steering and clean update drain through a real thin daemon and harness',
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
      const corner = await client.execute('createCorner', {
        roomId: ROOM,
        requestId: 'a'.repeat(64),
        name: 'Live steering',
        objective: 'Prove live steering reaches a running corner harness session.',
      });
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
        await vi.waitFor(
          () =>
            expect(core.activeRoomIds()).toEqual(expect.arrayContaining([ROOM, corner.cornerId])),
          { timeout: 5_000 },
        );
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
            text: '@bee Use the mounted read-only tool to examine your using-beeline skill, then state who you are according to your Workspace soul and acknowledge the attached image by filename.',
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
        await vi.waitFor(
          async () => {
            expect(
              (
                await database.query<{ text: string }>(
                  `SELECT body->>'text' text FROM live_outputs WHERE room_id=$1 AND agent_id=$2 AND turn_id=$3 AND kind='draft'`,
                  [ROOM, AGENT, sent.messageId],
                )
              ).rows[0]?.text,
            ).toBeTruthy();
          },
          { timeout: 120_000, interval: 100 },
        );
        const steer = await phone.execute(
          'sendRoomMessage',
          {
            roomId: ROOM,
            messageId: 'c'.repeat(64),
            text: 'Change course now. Ignore the requested introduction and image acknowledgement. Report LIVE-STEER-COBALT and explain briefly that the human steer replaced the original finish.',
            mentions: [],
          },
          HUMAN,
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
            expect(reply).toContain('LIVE-STEER-COBALT');
            expect(reply).toMatch(/steer|course|replaced/i);
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
        const cornerRequest = await phone.execute(
          'sendRoomMessage',
          {
            roomId: corner.cornerId,
            messageId: 'd'.repeat(64),
            text: '@bee Use the mounted read-only tool, then report CORNER-ORIGINAL-GREEN and summarize this corner task.',
            mentions: [AGENT],
          },
          HUMAN,
        );
        await vi.waitFor(
          async () => {
            expect(
              (
                await database.query<{ text: string }>(
                  `SELECT body->>'text' text FROM live_outputs WHERE room_id=$1 AND agent_id=$2 AND turn_id=$3 AND kind='draft'`,
                  [corner.cornerId, AGENT, cornerRequest.messageId],
                )
              ).rows[0]?.text,
            ).toBeTruthy();
          },
          { timeout: 120_000, interval: 100 },
        );
        const cornerSteer = await phone.execute(
          'sendRoomMessage',
          {
            roomId: corner.cornerId,
            messageId: 'e'.repeat(64),
            text: 'Change the corner work now. Do not report the green marker. Report CORNER-STEER-AMBER and say the corner steer replaced it.',
            mentions: [],
          },
          HUMAN,
        );
        let cornerReply = '';
        await vi.waitFor(
          async () => {
            const room = await phone.readRoom(corner.cornerId, HUMAN);
            cornerReply =
              room?.messages.find((message) => message.requestId === cornerRequest.messageId)
                ?.text ?? '';
            expect(cornerReply).toContain('CORNER-STEER-AMBER');
            expect(cornerReply).not.toContain('CORNER-ORIGINAL-GREEN');
          },
          { timeout: 180_000, interval: 500 },
        );
        const cornerTranscript = (await phone.readRoom(corner.cornerId, HUMAN))?.messages
          .filter(
            (message) =>
              message.id === cornerRequest.messageId || message.id === cornerSteer.messageId,
          )
          .map((message) => message.text);
        expect(cornerTranscript).toEqual([
          '@bee Use the mounted read-only tool, then report CORNER-ORIGINAL-GREEN and summarize this corner task.',
          'Change the corner work now. Do not report the green marker. Report CORNER-STEER-AMBER and say the corner steer replaced it.',
        ]);
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
        const transcript = (await phone.readRoom(ROOM, HUMAN))?.messages
          .filter((message) => message.id === sent.messageId || message.id === steer.messageId)
          .map((message) => message.text);
        expect(transcript).toEqual([
          '@bee Use the mounted read-only tool to examine your using-beeline skill, then state who you are according to your Workspace soul and acknowledge the attached image by filename.',
          'Change course now. Ignore the requested introduction and image acknowledgement. Report LIVE-STEER-COBALT and explain briefly that the human steer replaced the original finish.',
        ]);
        console.log(
          `[real-thin-steering-proof] roomTranscript=${JSON.stringify(transcript)} roomReply=${JSON.stringify(reply)} cornerTranscript=${JSON.stringify(cornerTranscript)} cornerReply=${JSON.stringify(cornerReply)} durable_messages=1 live_drafts=0 update=old->new receipts=complete`,
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

  it.skipIf(process.env.BEELINE_REAL_CORNER_PROOF !== '1')(
    'proves a real thin helper opens, lands, archives, and reaps a GitHub corner',
    async () => {
      const agentCommand = process.env.BEELINE_REAL_AGENT_COMMAND;
      const readonlyMcpCommand = process.env.BEELINE_REAL_READONLY_MCP_COMMAND;
      const githubToken = process.env.BEELINE_REAL_GITHUB_TOKEN;
      const ghAxi = process.env.BEELINE_REAL_GH_AXI_COMMAND;
      if (!agentCommand || !readonlyMcpCommand || !githubToken || !ghAxi) {
        throw new Error(
          'real corner proof requires agent, read-only MCP, GitHub token, and gh-axi command paths',
        );
      }
      const repository = 'lunchboxfortwo/beeline-agent-land-proof-20260811-2159';
      const installationId = 77;
      await database.query(
        `INSERT INTO github_installations(installation_id,owner_id,account_login,account_type,status)
         VALUES($1,$2,'lunchboxfortwo','User','active')`,
        [installationId, HUMAN],
      );
      await database.query(
        `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch,active)
         VALUES(101,$1,$2,'main',true)`,
        [installationId, repository],
      );
      await database.query(
        `UPDATE rooms SET repository_key=$2,repository_name=$2,
           repository_remote=$3,repository_resolution='repository',repository_target_branch='main',
           github_installation_id=$4,github_events_enabled=true WHERE id=$1`,
        [ROOM, repository, `https://github.com/${repository}.git`, installationId],
      );
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
        reconcileHeartbeatMs: 100,
      });
      const abort = new AbortController();
      const daemon = core.run({ pollMs: 50, signal: abort.signal });
      const webhook = async (event: string, delivery: string, payload: unknown) => {
        const bytes = Buffer.from(JSON.stringify(payload));
        const signature = `sha256=${createHmac('sha256', 'local-proof-secret')
          .update(bytes)
          .digest('hex')}`;
        const response = await fetch(`${origin}/v1/github/webhook`, {
          method: 'POST',
          headers: {
            'x-hub-signature-256': signature,
            'x-github-delivery': delivery,
            'x-github-event': event,
            'content-type': 'application/json',
          },
          body: bytes,
        });
        expect(response.status).toBe(202);
      };
      try {
        await vi.waitFor(() => expect(core.activeRoomIds()).toContain(ROOM), { timeout: 5_000 });
        const proofStamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
        const requestId = createHash('sha256').update(`corner-proof:${proofStamp}`).digest('hex');
        await phone.execute(
          'sendRoomMessage',
          {
            roomId: ROOM,
            messageId: requestId,
            mentions: [AGENT],
            text:
              `@bee Use open_corner exactly once for this objective: in ${repository}, ` +
              `create proof-${proofStamp}.txt containing "thin corner live proof ${proofStamp}". ` +
              `Add .github/workflows/corner-proof.yml with a pull_request workflow and one Ubuntu job ` +
              `that checks out the repository and verifies the proof file exists. Commit, push, open a ` +
              `pull request to main titled "Thin corner live proof ${proofStamp}", and print its full URL. ` +
              `End that PR-opening turn immediately after printing the URL. On the later checks event, ` +
              `obey the corner checks gate and merge rules. Do not modify any other repository.`,
          },
          HUMAN,
        );
        let cornerId = '';
        await vi.waitFor(
          async () => {
            const corners = await client.execute('listRoomCorners', { roomId: ROOM });
            cornerId = corners.corners[0]?.cornerId ?? '';
            expect(cornerId).toBeTruthy();
          },
          { timeout: 180_000, interval: 500 },
        );
        const worktree = join(supervisorRoot, 'beeline', 'corners', cornerId);
        let branch = '';
        await vi.waitFor(
          async () => {
            const restore = await client.execute('getCornerRestoreState', { cornerId });
            branch = restore.featureBranch ?? '';
            expect(branch).toBeTruthy();
            await expect(access(worktree)).resolves.toBeUndefined();
          },
          { timeout: 60_000, interval: 250 },
        );

        let transcript = '';
        let pullRequestUrl = '';
        await vi.waitFor(
          async () => {
            const conversation = await client.execute('getRoomConversation', {
              roomId: cornerId,
              limit: 200,
            });
            transcript = conversation.items
              .map((item) => `${item.authorId === AGENT ? 'agent' : 'human'}: ${item.body}`)
              .join('\n');
            pullRequestUrl =
              transcript.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0] ?? '';
            expect(pullRequestUrl).toMatch(/\/pull\/\d+$/);
            // The daemon never posts a system line of its own.
            expect(conversation.items.some((item) => item.type === 'system')).toBe(false);
            const activities = await database.query<{ activity: Array<{ kind?: string }> }>(
              `SELECT activity FROM messages WHERE room_id=$1 AND presentation='activity'`,
              [cornerId],
            );
            expect(
              activities.rows.some((row) =>
                row.activity.some((activity) => activity.kind === 'tool'),
              ),
            ).toBe(true);
          },
          { timeout: 300_000, interval: 1_000 },
        );
        const pullRequestNumber = pullRequestUrl.split('/').at(-1)!;
        let checks = '';
        await vi.waitFor(
          async () => {
            try {
              checks = (
                await execFileAsync(ghAxi, ['pr', 'checks', pullRequestNumber], {
                  cwd: worktree,
                  maxBuffer: 1024 * 1024,
                })
              ).stdout;
            } catch (error) {
              checks = String((error as { stdout?: string }).stdout ?? error);
            }
            expect(checks).toMatch(/summary: "[1-9]\d* passed, 0 failed/);
          },
          { timeout: 300_000, interval: 2_000 },
        );
        await webhook('status', `checks-${proofStamp}`, {
          state: 'success',
          target_url: pullRequestUrl,
          branches: [{ name: branch }],
          repository: { full_name: repository },
          installation: { id: installationId },
        });
        let merged = '';
        await vi.waitFor(
          async () => {
            merged = (
              await execFileAsync(ghAxi, ['pr', 'view', pullRequestNumber], {
                cwd: worktree,
                maxBuffer: 1024 * 1024,
              })
            ).stdout;
            expect(merged).toMatch(/state: merged|merged: "[^"]+"/);
            expect(merged).not.toContain('merged: no');
          },
          { timeout: 300_000, interval: 2_000 },
        );
        await webhook('pull_request', `merged-${proofStamp}`, {
          action: 'closed',
          pull_request: {
            number: Number(pullRequestNumber),
            title: `Thin corner live proof ${proofStamp}`,
            html_url: pullRequestUrl,
            merged: true,
            commits: 1,
            changed_files: 2,
            head: { ref: branch },
          },
          repository: { full_name: repository },
          installation: { id: installationId },
        });
        await vi.waitFor(
          async () => {
            const corners = await client.execute('listRoomCorners', { roomId: ROOM });
            expect(corners.corners.find((corner) => corner.cornerId === cornerId)?.archived).toBe(
              true,
            );
            expect(core.activeRoomIds()).not.toContain(cornerId);
            await expect(access(worktree)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(
              (
                await database.query<{ lifecycle: string }>(
                  `SELECT lifecycle->>'lifecycle' lifecycle FROM corner_facts WHERE corner_id=$1`,
                  [cornerId],
                )
              ).rows[0]?.lifecycle,
            ).toBe('done');
          },
          { timeout: 30_000, interval: 250 },
        );
        const finalConversation = await client.execute('getRoomConversation', {
          roomId: cornerId,
          limit: 200,
        });
        transcript = finalConversation.items
          .map((item) => `${item.authorId === AGENT ? 'agent' : 'human'}: ${item.body}`)
          .join('\n');
        console.log(
          `[real-corner-proof]\nPR: ${pullRequestUrl}\nChecks: ${checks.trim()}\n` +
            `Merged: ${merged.trim()}\nArchived: yes\nWorktree reaped: yes\nTranscript:\n${transcript}`,
        );
      } finally {
        abort.abort();
        await daemon;
      }
    },
    720_000,
  );

  it('wakes the agent from a scheduler-authored scheduled prompt, never from plain system lines', async () => {
    // Gating unit checks: own rows and mentionless system lines never trigger.
    const line = (over: Partial<Parameters<typeof isScheduledPrompt>[0]>) => ({
      id: 'x',
      authorId: SCHEDULE_SCHEDULER_ID,
      createdAt: 0,
      type: 'system' as const,
      body: 'Beeline Scheduler ran a schedule for Bee · ping',
      systemEvent: {
        subject: { kind: 'system' as const, id: SCHEDULE_SCHEDULER_ID, name: 'Beeline Scheduler' },
        verb: SCHEDULE_RAN_VERB,
        object: { text: 'Bee', id: AGENT },
        consequence: 'ping',
      },
      mentionIds: [AGENT],
      attachments: [],
      ...over,
    });
    expect(inboxItemTriggersTurn(line({}), AGENT)).toBe(true);
    expect(inboxItemTriggersTurn(line({ authorId: AGENT }), AGENT)).toBe(false);
    expect(inboxItemTriggersTurn(line({ mentionIds: [] }), AGENT)).toBe(false);
    expect(
      inboxItemTriggersTurn(line({ body: 'Scout joined', systemEvent: undefined }), AGENT),
    ).toBe(false);
    expect(inboxItemTriggersTurn(line({ type: 'message', authorId: HUMAN }), AGENT)).toBe(true);

    const exchange = await auth.createDaemonExchange(AGENT);
    const exchanged = await fetch(`${origin}/v1/auth/daemon/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ exchangeToken: exchange.exchangeToken }),
    });
    const token = (await exchanged.json()) as { daemonToken: string };
    const client = new DaemonApiClient(origin, token.daemonToken, AGENT);
    // Drop the fixture's model selection; the mocked harness advertises no axis.
    await database.query(
      `UPDATE agents SET selected_model=NULL,selected_effort=NULL WHERE agent_id=$1`,
      [AGENT],
    );

    // Seed the scheduler identity the way AgentScheduleLoop does for agent-created
    // schedules; the transcript rows are inserted after the loop starts polling
    // (its inbox cursor opens at the latest row).
    await database.query(
      `INSERT INTO identities(id,kind,name,hidden_from_roster) VALUES($1,'human',$2,true)`,
      [SCHEDULE_SCHEDULER_ID, SCHEDULE_SCHEDULER_NAME],
    );

    const acp = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    vi.spyOn(acp, 'start').mockResolvedValue(undefined);
    const polled = vi.fn();
    const sessionNew = vi.spyOn(acp, 'sessionNew').mockResolvedValue({
      sessionId: 'scheduled-session',
      raw: {},
    });
    const sessionPrompt = vi.spyOn(acp, 'sessionPrompt').mockResolvedValue({
      stopReason: 'end_turn',
      updates: [],
      agentText: 'hello',
      toolCalls: [],
    });
    const config = {
      agentBinary: '/nonexistent/codex-acp',
      agentCommand: '/nonexistent/codex-acp',
      mcpBinary: '/nonexistent',
      readonlyMcpCommand: '/nonexistent-readonly-mcp',
      agentEnv: {},
      workspaceRoot: join(supervisorRoot, 'scheduled-room'),
      autoApprovePermissions: true,
      accessPolicy: 'everyone',
      agentHomeRoot: join(supervisorRoot, 'agent-home'),
      daemonReleaseVersion: 'v0.0.22',
      daemonSourceSha: 'd03cff8f'.padEnd(40, '0'),
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
    const abort = new AbortController();
    const turnLoop = new MonolithRoomTurnLoop({
      roomId: ROOM,
      workspaceId: WORKSPACE,
      cwd: config.workspaceRoot,
      runtime,
      config: config as never,
      api: client,
      scheduler: new SessionScheduler({ maxLiveSessions: 2 }),
      health: { poll: polled, failure: vi.fn(), presence: vi.fn() },
      signal: abort.signal,
      pollMs: 10,
      createAcpClient: () => acp,
    });
    const loop = turnLoop.run();
    try {
      // The turn loop opens its inbox cursor at the latest row, so fire the
      // scheduled prompt while it is polling (as the real schedule loop would).
      // Deterministic wake: `health.poll()` fires only AFTER the loop's first
      // inbox fetch has established its `startAtLatest` cursor, so rows inserted
      // once `polled` has been called are guaranteed to be picked up by a
      // subsequent poll (unlike presence, which posts before the snapshot).
      await vi.waitFor(() => expect(polled).toHaveBeenCalled(), { timeout: 5_000 });
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES($1,$2,$3,$4,'system')`,
        ['e'.repeat(64), ROOM, SCHEDULE_SCHEDULER_ID, 'Beeline Scheduler checked the roster'],
      );
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,mention_ids,system_event)
         VALUES($1,$2,$3,$4,'system',$5::jsonb,$6::jsonb) RETURNING id`,
        [
          'd'.repeat(64),
          ROOM,
          SCHEDULE_SCHEDULER_ID,
          'Beeline Scheduler ran a schedule for Bee · Post exactly: hello',
          JSON.stringify([AGENT]),
          JSON.stringify({
            subject: { kind: 'system', id: SCHEDULE_SCHEDULER_ID, name: 'Beeline Scheduler' },
            verb: SCHEDULE_RAN_VERB,
            object: { text: 'Bee', id: AGENT },
            consequence: 'Post exactly: hello',
          }),
        ],
      );
      await vi.waitFor(() => expect(sessionPrompt).toHaveBeenCalled(), { timeout: 5_000 });
      const wirePrompt = sessionPrompt.mock.calls[0]![1];
      expect(wirePrompt).toContain('Post exactly: hello');
      expect(wirePrompt).not.toContain('ran a schedule for');
      expect(wirePrompt).toContain(`from ${SCHEDULE_SCHEDULER_NAME}`);
      // The plain system line stayed out of the turn.
      expect(wirePrompt).not.toContain('checked the roster');
      await vi.waitFor(
        async () => {
          const room = await phone.readRoom(ROOM, HUMAN);
          expect(room?.messages).toContainEqual(
            expect.objectContaining({
              author: expect.objectContaining({ pubkey: AGENT }),
              requestId: 'd'.repeat(64),
              text: 'hello',
            }),
          );
        },
        { timeout: 10_000 },
      );
    } finally {
      abort.abort();
      await loop;
    }
  }, 30_000);

  it('obeys the server access policy live, and lets the Room see the refusal', async () => {
    // Greeter's production shape, exactly: the runtime record this helper was
    // paired with says `creator`, and the SERVER is the authority for who may
    // address the agent. A change there has to reach this already-running loop.
    const OUTSIDER = getPublicKey(new Uint8Array(32).fill(13));
    // Handles, because a system line names a person by @handle and never by the
    // display name beside it.
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Bananaman','bananaman614305')`,
      [OUTSIDER],
    );
    await database.query(`UPDATE identities SET handle='lunchboxfortwo' WHERE id=$1`, [HUMAN]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, OUTSIDER, ROOM],
    );
    await database.query(
      `UPDATE agents SET selected_model=NULL,selected_effort=NULL,
         access_policy='{"type":"creator"}'::jsonb WHERE agent_id=$1`,
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

    const acp = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    vi.spyOn(acp, 'start').mockResolvedValue(undefined);
    vi.spyOn(acp, 'sessionNew').mockResolvedValue({ sessionId: 'access-session', raw: {} });
    const sessionPrompt = vi.spyOn(acp, 'sessionPrompt').mockResolvedValue({
      stopReason: 'end_turn',
      updates: [],
      agentText: 'at your service',
      toolCalls: [],
    });
    const polled = vi.fn();
    const config = {
      agentBinary: '/nonexistent/codex-acp',
      agentCommand: '/nonexistent/codex-acp',
      mcpBinary: '/nonexistent',
      readonlyMcpCommand: '/nonexistent-readonly-mcp',
      agentEnv: {},
      workspaceRoot: join(supervisorRoot, 'access-room'),
      autoApprovePermissions: true,
      // Deliberately the record's own reading, and deliberately NOT what the
      // server says. Nothing below restarts or re-pairs this helper.
      accessPolicy: 'creator',
      accessOwnerPubkey: HUMAN,
      agentHomeRoot: join(supervisorRoot, 'access-agent-home'),
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
      accessPolicy: 'creator',
      transport: { kind: 'monolith', baseUrl: origin, daemonToken: token.daemonToken },
    };
    const abort = new AbortController();
    const turnLoop = new MonolithRoomTurnLoop({
      roomId: ROOM,
      workspaceId: WORKSPACE,
      cwd: config.workspaceRoot,
      runtime,
      config: config as never,
      api: client,
      scheduler: new SessionScheduler({ maxLiveSessions: 2 }),
      health: { poll: polled, failure: vi.fn(), presence: vi.fn() },
      signal: abort.signal,
      pollMs: 10,
      createAcpClient: () => acp,
    });
    const systemLines = async () =>
      (
        await database.query<{ text: string }>(
          `SELECT text FROM messages WHERE room_id=$1 AND presentation='system' ORDER BY created_at,id`,
          [ROOM],
        )
      ).rows.map((row) => row.text);
    const turns = async () =>
      (await database.query(`SELECT 1 FROM agent_turns WHERE room_id=$1`, [ROOM])).rows.length;

    const loop = turnLoop.run();
    try {
      await vi.waitFor(() => expect(polled).toHaveBeenCalled(), { timeout: 5_000 });

      // Refused: the Room says so once, and no turn is ever created.
      await phone.execute(
        'sendRoomMessage',
        { roomId: ROOM, messageId: '1'.repeat(64), text: '@bee yo', mentions: [AGENT] },
        OUTSIDER,
      );
      await vi.waitFor(
        async () =>
          expect(await systemLines()).toEqual([
            'Bee did not answer @bananaman614305 · only @lunchboxfortwo may address Bee. ' +
              'Ask the user for permission to access the agent in the members page',
          ]),
        { timeout: 5_000 },
      );
      // The refusal above is written by the SEND, so seeing it proves nothing
      // about the loop yet. `health.poll()` fires once per completed intake
      // cycle: two of them since the send means a cycle has read this message,
      // decided, and moved its cursor past it.
      const settled = polled.mock.calls.length + 2;
      await vi.waitFor(() => expect(polled.mock.calls.length).toBeGreaterThanOrEqual(settled), {
        timeout: 5_000,
      });
      expect(sessionPrompt).not.toHaveBeenCalled();
      expect(await turns()).toBe(0);

      // The owner flips the toggle in the members page. Nothing restarts.
      await phone.execute(
        'updateAgentAccessPolicy',
        { workspaceId: WORKSPACE, agentId: AGENT, policy: 'everyone' },
        HUMAN,
      );
      await phone.execute(
        'sendRoomMessage',
        { roomId: ROOM, messageId: '2'.repeat(64), text: '@bee yo again', mentions: [AGENT] },
        OUTSIDER,
      );
      await vi.waitFor(() => expect(sessionPrompt).toHaveBeenCalled(), { timeout: 5_000 });
      expect(sessionPrompt.mock.calls[0]![1]).toContain('yo again');
      await vi.waitFor(async () => expect(await turns()).toBeGreaterThan(0), { timeout: 5_000 });
      // The same helper, the same record, one more system line: the change.
      // The refusal is stamped up to 1s past its cause (system-line.ts's
      // ordering floor), so which of these two lines the clock reached first
      // is timing, not fact — assert the pair, never their order.
      const lines = await systemLines();
      expect(lines).toHaveLength(2);
      expect(lines).toEqual(
        expect.arrayContaining([
          expect.stringContaining('did not answer @bananaman614305'),
          '@lunchboxfortwo changed who may address Bee · anyone may ask now',
        ]),
      );
    } finally {
      abort.abort();
      await loop;
    }
  }, 30_000);

  it('gives agents canonical handles instead of stale membership profiles', async () => {
    await database.query(`UPDATE identities SET handle='lunchboxfortwo' WHERE id=$1`, [HUMAN]);
    await database.query(
      `UPDATE memberships
       SET identity_profile=$3::jsonb
       WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`,
      [WORKSPACE, HUMAN, JSON.stringify({ name: 'a_lunchboxfortwo', handle: 'a_lunchboxfortwo' })],
    );
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
      client.execute('getWorkspaceRoster', { agentId: AGENT, workspaceId: WORKSPACE }),
    ).resolves.toEqual(
      expect.objectContaining({
        members: expect.arrayContaining([
          expect.objectContaining({
            identityId: HUMAN,
            kind: 'human',
            name: 'Owner',
            handle: 'lunchboxfortwo',
          }),
        ]),
      }),
    );
  });

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
        // The yolo switch reaches the runtime as a plain flag; slice 1 carries
        // it only, the grant loop reads it. New agents default to yolo on.
        yoloMode: true,
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

    await expect(client.execute('getDaemonBootstrap', { agentId: AGENT })).resolves.toEqual(
      expect.objectContaining({
        rooms: [expect.objectContaining({ roomId: ROOM })],
      }),
    );
  });
});
