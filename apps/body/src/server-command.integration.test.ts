import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PgliteDatabase } from '../../server/src/test-support.js';
import { migrate } from '../../server/src/database.js';
import { PhoneService } from '../../server/src/phone-service.js';
import { DaemonService } from '../../server/src/daemon-service.js';
import { LiveHub } from '../../server/src/live.js';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import { MonolithCornerTurnLoop } from './monolith-corner-turn.js';
import { AcpClient } from './acp.js';
import { SessionScheduler } from './session-scheduler.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
const identity = identityFromKey('11'.repeat(32), 'Hoots');
const A = identity.publicKey,
  H = 'a'.repeat(64),
  B = 'c'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111',
  R = '22222222-2222-4222-8222-222222222222',
  C = '33333333-3333-4333-8333-333333333333';
let db: PgliteDatabase, phone: PhoneService, daemon: DaemonService, root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'command-body-'));
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Human','human'),($2,'agent','Hoots','hoots'),($3,'agent','Goosy','goosy')`,
    [H, A, B],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [A, B, H]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Test')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Room'),($2,$3,'Corner')`, [
    R,
    C,
    W,
  ]);
  await db.query(`UPDATE rooms SET parent_id=$1 WHERE id=$2`, [R, C]);
  await db.query(
    `INSERT INTO corner_facts(corner_id,owner_agent_id,objective,lifecycle) VALUES($1,$2,'Only server commands','{"checks":"unknown"}')`,
    [C, B],
  );
  for (const who of [H, A, B])
    for (const room of [null, R, C])
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,
        [W, room, who],
      );
  phone = new PhoneService(db, 'http://test');
  daemon = new DaemonService(db, new LiveHub());
}, 30_000);
afterAll(async () => {
  await db?.close();
  await rm(root, { recursive: true, force: true });
});
describe.each([
  ['Room', R],
  ['corner', C],
])('%s helper with real server commands', (surface, roomId) => {
  it('runs only the commanded agent, stores turn-bound output, and never asks for intake authority', async () => {
    const runtime = {
      agent: { name: 'Hoots', publicKey: A, secretKeyHex: '11'.repeat(32) },
      rooms: [],
      supervisorRoot: root,
      transport: { kind: 'monolith', baseUrl: 'http://test', daemonToken: 'token' },
      agentBinary: '/fake',
      agentKind: 'codex',
      agentCommand: '/fake',
      agentArgs: [],
      mcpBinary: '/fake',
    } as unknown as AgentRuntimeRecord;
    const config = {
      agentBinary: '/fake',
      agentKind: 'codex',
      agentCommand: '/fake',
      agentArgs: [],
      mcpBinary: '/fake',
      readonlyMcpCommand: '/fake-mcp',
      agentEnv: {},
      agentHomeRoot: join(root, surface),
      workspaceRoot: root,
      autoApprovePermissions: true,
      accessPolicy: 'everyone',
    } as BodyConfig;
    const execute = vi.fn(async (name: string, input: never) =>
      daemon.execute(name as never, input, A),
    );
    const api = {
      execute,
      connection: () => ({ baseUrl: 'http://test', daemonToken: 'token', agentId: A }),
    } as unknown as DaemonApiClient;
    const acp = new AcpClient({ agentBinary: '/fake', agentEnv: {} });
    vi.spyOn(acp, 'start').mockResolvedValue();
    vi.spyOn(acp, 'stop').mockResolvedValue();
    vi.spyOn(acp, 'isAlive', 'get').mockReturnValue(true);
    vi.spyOn(acp, 'canPromptWithImages').mockReturnValue(false);
    vi.spyOn(acp, 'sessionNew').mockResolvedValue({ sessionId: 'session', raw: {} });
    const prompt = vi
      .spyOn(acp, 'sessionPrompt')
      .mockResolvedValue({
        stopReason: 'end_turn',
        updates: [],
        agentText: 'Tag @goosy and Goosy answers',
        toolCalls: [],
      });
    const scheduler = new SessionScheduler({ maxLiveSessions: 2 }),
      controller = new AbortController();
    await phone.execute('sendRoomMessage', { roomId, text: '@hoots explain tags' }, H);
    const common = {
      api,
      runtime,
      config,
      scheduler,
      signal: controller.signal,
      pollMs: 10,
      workspaceId: W,
      createAcpClient: () => acp,
    };
    const loop =
      surface === 'Room'
        ? new MonolithRoomTurnLoop({
            ...common,
            roomId,
            cwd: root,
            health: { poll: vi.fn(), failure: vi.fn(), presence: vi.fn() },
          })
        : new MonolithCornerTurnLoop({
            ...common,
            cornerId: roomId,
            parentRoomId: R,
            worktreePath: root,
            objective: 'No uncommanded objective',
            openedBy: B,
            onPoll: vi.fn(),
            onFailure: vi.fn(),
            onCloseRequested: async () => {},
          });
    const running = loop.run();
    try {
      await vi.waitFor(
        async () =>
          expect(
            (
              await db.query(
                `SELECT 1 FROM messages WHERE room_id=$1 AND author_id=$2 AND text='Tag @goosy and Goosy answers'`,
                [roomId, A],
              )
            ).rowCount,
          ).toBe(1),
        { timeout: 15_000 },
      );
      expect(prompt).toHaveBeenCalledTimes(1);
      expect((await daemon.execute('getAgentCommands', { roomId }, B)).commands).toEqual([]);
      expect(
        execute.mock.calls.some(([name]) =>
          ['getRoomAuthority', 'getRoomInbox', 'getCornerCloseRequests'].includes(name),
        ),
      ).toBe(false);
    } finally {
      controller.abort();
      await running;
      await scheduler.dispose();
    }
  });
});
