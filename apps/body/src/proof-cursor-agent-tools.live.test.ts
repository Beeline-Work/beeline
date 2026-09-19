/**
 * The acceptance path for the cursor ACP bridge delivering session MCP.
 *
 * A real cursor-agent, in a real Room on a real monolith server, is told to
 * open a corner. It must reach `beeline-agent open_corner` through the
 * isolated `mcp.json` the bridge writes — the field `session/new` used to
 * drop. A hermetic test that only asserts a file was written cannot catch
 * cursor-agent silently skipping that file.
 *
 * Reuses one dedicated test Workspace id. Never mints a production Workspace.
 *
 * Run it deliberately — it spends real tokens:
 *
 *   BEELINE_REAL_CURSOR_TOOL_PROOF=1 \
 *   npm run test:live -w @beeline/body -- src/proof-cursor-agent-tools.live.test.ts
 */
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
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
import { prepareRoomAgentHome } from './agent-home.js';
import { DaemonApiClient } from './daemon-api-client.js';
import { cursorAcpBridgeLaunch } from './cursor-acp-bridge.js';
import { ThinDaemonCore } from './thin-core.js';
import type { AgentRuntimeRecord } from './runtime.js';

const HUMAN = createHash('sha256').update('github:cursor-tool-proof-owner').digest('hex');
const AGENT_SECRET = new Uint8Array(32).fill(41);
const AGENT = getPublicKey(AGENT_SECRET);
const WORKSPACE = '33333333-3333-4333-8333-333333333333';
const ROOM = '44444444-4444-4444-8444-444444444444';

const enabled = process.env.BEELINE_REAL_CURSOR_TOOL_PROOF === '1';

describe('a real cursor Room agent opens a corner through beeline-agent', () => {
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
      `INSERT INTO identities(id,kind,name,handle,github_subject)
       VALUES($1,'human','Owner','owner','cursor-tool-proof-owner'),($2,'agent','Nerd','nerd',NULL)`,
      [HUMAN, AGENT],
    );
    await database.query(
      `INSERT INTO agents(agent_id,owner_id,soul,selected_model,model_catalog)
       VALUES($1,$2,$3::jsonb,$4,'[]'::jsonb)`,
      [
        AGENT,
        HUMAN,
        JSON.stringify({
          name: 'Nerd',
          instructions: 'Do exactly what you are asked, with your tools, and say what you did.',
        }),
        process.env.BEELINE_REAL_CURSOR_MODEL ?? 'composer-2.5',
      ],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Cursor proof')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'beeline')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`,
      [WORKSPACE, HUMAN, AGENT, ROOM],
    );
    auth = new TokenAuth(database, async () => ({
      subject: 'cursor-tool-proof-owner',
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
            community: 'cursor-tool-proof',
            roomCommunityIds: ['cursor-tool-proof'],
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
    root = await mkdtemp(join(tmpdir(), 'beeline-cursor-tool-proof-'));
  });

  afterEach(async () => {
    if (!enabled) return;
    await new Promise<void>((closed) => server.close(() => closed()));
    await mountedAuth.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  it.skipIf(!enabled)(
    'reaches open_corner from a cursor turn and the Room carries the corner',
    { timeout: 600_000 },
    async () => {
      // cursor-agent spawns this from the Room cwd, so the command must be
      // cwd-safe: `node --import tsx ./read-only-mcp.ts` cannot resolve tsx
      // from an empty worktree. Production uses the built binary the same way.
      const mcpCommand = process.execPath;
      const mcpArgs = [resolve(import.meta.dirname, '../dist/read-only-mcp.js')];
      if (!existsSync(mcpArgs[0] as string)) {
        throw new Error(`built beeline-readonly-mcp missing at ${mcpArgs[0]}`);
      }
      const roomRoot = join(root, 'room');
      await mkdir(roomRoot, { recursive: true });
      const agentHomeRoot = join(roomRoot, 'agent-home');
      const homeOverlay = await prepareRoomAgentHome({
        root: agentHomeRoot,
        operatorHome: homedir(),
        agentKind: 'cursor',
        sharedSkills: [],
      });
      const isolatedAuthDir = join(homeOverlay.HOME, '.config', 'cursor');
      await mkdir(isolatedAuthDir, { recursive: true, mode: 0o700 });
      const operatorAuth = join(homedir(), '.config', 'cursor', 'auth.json');
      if (!existsSync(operatorAuth)) {
        throw new Error('cursor-agent login is required at ~/.config/cursor/auth.json');
      }
      const isolatedAuth = join(isolatedAuthDir, 'auth.json');
      await copyFile(operatorAuth, isolatedAuth);
      await chmod(isolatedAuth, 0o600);
      if (!existsSync(isolatedAuth)) throw new Error('failed to seed isolated cursor auth');

      const exchange = await auth.createDaemonExchange(AGENT);
      const exchanged = await fetch(`${origin}/v1/auth/daemon/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exchangeToken: exchange.exchangeToken }),
      });
      const { daemonToken } = (await exchanged.json()) as { daemonToken: string };
      const launch = cursorAcpBridgeLaunch();
      const runtime: AgentRuntimeRecord = {
        version: 2,
        communityId: WORKSPACE,
        pairedBy: HUMAN,
        agent: {
          name: 'Nerd',
          publicKey: AGENT,
          secretKeyHex: Buffer.from(AGENT_SECRET).toString('hex'),
        },
        body: {
          name: 'Nerd Body',
          publicKey: getPublicKey(new Uint8Array(32).fill(42)),
          secretKeyHex: Buffer.from(new Uint8Array(32).fill(42)).toString('hex'),
        },
        rooms: [{ channelId: ROOM, root: roomRoot }],
        supervisorRoot: root,
        agentKind: 'cursor',
        agentCommand: launch.command,
        agentArgs: launch.args,
        agentBinary: 'cursor-agent',
        mcpBinary: mcpCommand,
        accessPolicy: 'everyone',
        transport: { kind: 'monolith', baseUrl: origin, daemonToken },
      };
      const config = {
        agentKind: 'cursor' as const,
        agentCommand: launch.command,
        agentArgs: launch.args,
        agentBinary: 'cursor-agent',
        mcpBinary: mcpCommand,
        readonlyMcpCommand: mcpCommand,
        readonlyMcpArgs: mcpArgs,
        agentHomeRoot,
        sharedSkills: [],
        agentEnv: {
          ...homeOverlay,
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
          ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
          ...(process.env.USER ? { USER: process.env.USER } : {}),
        },
        operatorHome: process.env.HOME,
        workspaceRoot: roomRoot,
        autoApprovePermissions: false,
        accessPolicy: 'everyone' as const,
      };
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
            messageId: createHash('sha256').update('cursor-open-corner-proof').digest('hex'),
            wakes: [AGENT],
            text: '@nerd Open a corner named Proof Corner whose objective is prove cursor can call open_corner. Use the beeline-agent open_corner tool. Do not describe the tool; call it.',
          },
          HUMAN,
        );
        const queued = await database.query<{ n: string }>(
          `SELECT count(*)::text n FROM agent_commands WHERE room_id=$1 AND agent_id=$2`,
          [ROOM, AGENT],
        );
        expect(Number(queued.rows[0]?.n ?? 0)).toBeGreaterThan(0);

        const deadline = Date.now() + 420_000;
        for (;;) {
          const failed = await database.query<{ reason: string | null }>(
            `SELECT failure_reason reason FROM agent_turns
             WHERE room_id=$1 AND agent_id=$2 AND status='failed'
             ORDER BY created_at DESC LIMIT 1`,
            [ROOM, AGENT],
          );
          if (failed.rows[0]) {
            throw new Error(`cursor Room turn failed: ${failed.rows[0].reason ?? 'unknown'}`);
          }
          const corners = await database.query<{ id: string; name: string }>(
            `SELECT rooms.id, rooms.name FROM rooms
             JOIN corner_facts ON corner_facts.corner_id = rooms.id
             WHERE rooms.parent_id=$1`,
            [ROOM],
          );
          if (corners.rows.length > 0) {
            expect(corners.rows[0]?.name.toLowerCase()).toMatch(/proof/);
            break;
          }
          const settled = await database.query<{ status: string; text: string | null }>(
            `SELECT agent_turns.status, messages.text
             FROM agent_turns
             LEFT JOIN messages ON messages.room_id=agent_turns.room_id
               AND messages.author_id=agent_turns.agent_id
               AND messages.presentation='message'
             WHERE agent_turns.room_id=$1 AND agent_turns.agent_id=$2
             ORDER BY agent_turns.created_at DESC, messages.created_at DESC
             LIMIT 1`,
            [ROOM, AGENT],
          );
          if (settled.rows[0]?.status === 'complete') {
            const homeMcp = join(agentHomeRoot, 'user', '.cursor', 'mcp.json');
            const cursorMcp = join(agentHomeRoot, 'cursor', 'mcp.json');
            const homeBody = await readFile(homeMcp, 'utf8').catch(() => 'missing');
            const cursorBody = await readFile(cursorMcp, 'utf8').catch(() => 'missing');
            throw new Error(
              [
                `cursor turn completed without open_corner: ${settled.rows[0].text ?? '(no reply)'}`,
                `HOME mcp.json: ${homeBody}`,
                `CURSOR_HOME mcp.json: ${cursorBody}`,
              ].join('\n'),
            );
          }
          if (Date.now() > deadline) {
            throw new Error('timed out waiting for cursor open_corner');
          }
          await new Promise((settle) => setTimeout(settle, 1_000));
        }
      } finally {
        abort.abort();
        await run.catch(() => undefined);
      }
    },
  );
});
