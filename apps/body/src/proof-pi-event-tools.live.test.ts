/**
 * The acceptance path, with nothing faked between the model and the database.
 *
 * A real pi harness on a real OpenRouter custom model, in a real Room on a real
 * monolith server, is told "subscribe to joins". It must reach
 * `beeline-agent subscribe_events` — the tool this slice adds — and the Room
 * membership it owns must come back carrying `joined` with no one touching a
 * database row. Then a newcomer joins and the join line must mention it, which
 * is what starts the greeting turn.
 *
 * This is the proof the report from the field demanded: the welcome agent said
 * "the beeline-agent tools are not mounted here… I can see they exist but I
 * cannot reach them", and every hermetic test in this repository agreed with
 * the code rather than with the agent. Only a real pi session can tell them
 * apart.
 *
 * Run it deliberately — it spends real tokens on a real provider:
 *
 *   BEELINE_REAL_PI_EVENT_PROOF=1 \
 *   BEELINE_REAL_PI_AGENT_COMMAND=$(command -v pi-acp) \
 *   npm run test:live -w @beeline/body -- src/proof-pi-event-tools.live.test.ts
 *
 * `BEELINE_REAL_PI_MODEL` overrides the model; the operator's own
 * `~/.pi/agent/models.json` (custom providers and their keys) is what
 * `prepareRoomAgentHome` copies into the session, exactly as in production.
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
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
import { joinRooms } from '../../server/src/membership-join.js';
import { DaemonApiClient } from './daemon-api-client.js';
import { ThinDaemonCore } from './thin-core.js';
import type { AgentRuntimeRecord } from './runtime.js';

const HUMAN = createHash('sha256').update('github:pi-event-proof-owner').digest('hex');
const NEWCOMER = createHash('sha256').update('github:pi-event-proof-newcomer').digest('hex');
const AGENT_SECRET = new Uint8Array(32).fill(31);
const AGENT = getPublicKey(AGENT_SECRET);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';

const enabled = process.env.BEELINE_REAL_PI_EVENT_PROOF === '1';

describe('a real pi Room agent subscribes itself to arrivals', () => {
  let database: PgliteDatabase;
  let auth: TokenAuth;
  let phone: PhoneService;
  let mountedAuth: MonolithAuthMount;
  let server: ReturnType<typeof createBeelineServer>;
  let origin: string;
  let root: string;

  beforeEach(async () => {
    if (!enabled) return;
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name,github_subject)
       VALUES($1,'human','Owner','pi-event-proof-owner'),($2,'agent','Greeter',NULL),
             ($3,'human','Newcomer','pi-event-proof-newcomer')`,
      [HUMAN, AGENT, NEWCOMER],
    );
    await database.query(
      `INSERT INTO agents(agent_id,owner_id,soul,selected_model,model_catalog)
       VALUES($1,$2,$3::jsonb,$4,'[]'::jsonb)`,
      [
        AGENT,
        HUMAN,
        JSON.stringify({
          name: 'Greeter',
          instructions: 'Do exactly what you are asked, with your tools, and say what you did.',
        }),
        process.env.BEELINE_REAL_PI_MODEL ?? 'openrouter-ox/z-ai/glm-5.3-flash',
      ],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'welcome')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member'),
             ($1,NULL,$5,'member')`,
      [WORKSPACE, HUMAN, AGENT, ROOM, NEWCOMER],
    );
    auth = new TokenAuth(database, async () => ({
      subject: 'pi-event-proof-owner',
      login: 'owner',
      name: 'Owner',
    }));
    phone = new PhoneService(database, 'http://placeholder');
    mountedAuth = await createMonolithAuth(database, 'https://server.test', undefined, {
      createDaemonExchange: (agentId, transaction) =>
        auth.createDaemonExchange(agentId, transaction),
      env: {
        NODE_ENV: 'test',
        BUZZY_AUTH_TENANTS_JSON: JSON.stringify([
          {
            host: 'server.test',
            community: 'pi-event-proof',
            roomCommunityIds: ['pi-event-proof'],
            origin: 'https://server.test',
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
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    root = await mkdtemp(join(tmpdir(), 'beeline-pi-event-proof-'));
  });

  afterEach(async () => {
    if (!enabled) return;
    await new Promise<void>((closed) => server.close(() => closed()));
    await mountedAuth.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  it.skipIf(!enabled)(
    'reaches its own subscribe tool from a pi turn, and is mentioned by the next join',
    { timeout: 600_000 },
    async () => {
      const agentCommand = process.env.BEELINE_REAL_PI_AGENT_COMMAND;
      if (!agentCommand) throw new Error('BEELINE_REAL_PI_AGENT_COMMAND is required');
      // The MCP server the session mounts is this working tree's own, run the
      // way the release runs it: one command, no arguments.
      const mcpCommand = join(root, 'beeline-readonly-mcp');
      await writeFile(
        mcpCommand,
        `#!/bin/sh\nexec ${process.execPath} --import tsx ${resolve(import.meta.dirname, 'read-only-mcp.ts')} "$@"\n`,
        'utf8',
      );
      await chmod(mcpCommand, 0o755);
      const roomRoot = join(root, 'room');
      await mkdir(roomRoot, { recursive: true });

      const exchange = await auth.createDaemonExchange(AGENT);
      const exchanged = await fetch(`${origin}/v1/auth/daemon/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exchangeToken: exchange.exchangeToken }),
      });
      const { daemonToken } = (await exchanged.json()) as { daemonToken: string };
      const runtime: AgentRuntimeRecord = {
        version: 2,
        communityId: WORKSPACE,
        pairedBy: HUMAN,
        agent: {
          name: 'Greeter',
          publicKey: AGENT,
          secretKeyHex: Buffer.from(AGENT_SECRET).toString('hex'),
        },
        body: {
          name: 'Greeter Body',
          publicKey: getPublicKey(new Uint8Array(32).fill(32)),
          secretKeyHex: Buffer.from(new Uint8Array(32).fill(32)).toString('hex'),
        },
        rooms: [{ channelId: ROOM, root: roomRoot }],
        supervisorRoot: root,
        agentKind: 'pi',
        agentCommand,
        agentArgs: [],
        agentBinary: agentCommand,
        mcpBinary: mcpCommand,
        accessPolicy: 'everyone',
        transport: { kind: 'monolith', baseUrl: origin, daemonToken },
      };
      const config = {
        agentKind: 'pi',
        agentCommand,
        agentArgs: [],
        agentBinary: agentCommand,
        mcpBinary: mcpCommand,
        readonlyMcpCommand: mcpCommand,
        agentHomeRoot: join(root, 'agent-home'),
        sharedSkills: [],
        agentEnv: {
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
          ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
        },
        operatorHome: process.env.HOME,
        workspaceRoot: roomRoot,
        autoApprovePermissions: false,
        accessPolicy: 'everyone',
      } as const;
      const configPath = join(root, 'runtime.json');
      await writeFile(configPath, `${JSON.stringify(runtime)}\n`, { mode: 0o600 });
      const client = new DaemonApiClient(origin, daemonToken, AGENT);
      const core = new ThinDaemonCore(runtime, configPath, config as never, {
        daemonApi: client,
        reconcileHeartbeatMs: 60_000,
      });
      const abort = new AbortController();
      const run = core.run({ pollMs: 100, signal: abort.signal });
      try {
        await vi.waitFor(() => expect(core.activeRoomIds()).toContain(ROOM), {
          timeout: 30_000,
          interval: 200,
        });
        await new Promise((settle) => setTimeout(settle, 1_000));
        await phone.execute(
          'sendRoomMessage',
          {
            roomId: ROOM,
            messageId: createHash('sha256').update('pi-event-subscribe-proof').digest('hex'),
            mentions: [AGENT],
            text: '@Greeter subscribe to joins in this Room, so every arrival wakes you. Use your tools, then tell me what you subscribed to.',
          },
          HUMAN,
        );

        // The whole point: the agent's OWN Room membership carries the kind,
        // written by the agent, through the tool, from inside a pi turn.
        await vi.waitFor(
          async () => {
            const rows = await database.query<{ event_subscriptions: string[] }>(
              `SELECT event_subscriptions FROM memberships WHERE room_id=$1 AND identity_id=$2`,
              [ROOM, AGENT],
            );
            expect(rows.rows[0]?.event_subscriptions).toContain('joined');
          },
          { timeout: 420_000, interval: 1_000 },
        );

        // And the subscription does what it is for: the next arrival mentions it.
        await database.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [
          NEWCOMER,
        ]);
        await joinRooms(database, {
          workspaceId: WORKSPACE,
          identityId: NEWCOMER,
          rooms: { type: 'rooms', roomIds: [ROOM] },
        });
        const joins = await database.query<{ mention_ids: string[] }>(
          `SELECT mention_ids FROM messages WHERE room_id=$1 AND author_id=$2
           AND system_event->>'kind'='joined'`,
          [ROOM, NEWCOMER],
        );
        expect(joins.rows.some((row) => row.mention_ids.includes(AGENT))).toBe(true);
      } finally {
        abort.abort();
        await run.catch(() => undefined);
      }
    },
  );
});
