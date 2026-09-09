import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  B = identityFromKey('22'.repeat(32), 'Goosy').publicKey;
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
  for (const agent of [A, B])
    await db.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}') ON CONFLICT(room_id,agent_id,turn_id,kind) DO UPDATE SET body=EXCLUDED.body,updated_at=now()`,
      [R, agent],
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
])('%s complete command conversation', (surface, roomId) => {
  it('replays Hoots/Goosy with two helpers, deliberate delegation, fresh human reply and idle untagged traffic', async () => {
    const scheduler = new SessionScheduler({ maxLiveSessions: 4 });
    const controller = new AbortController();
    const helpers = [A, B].map((agentId) => {
      const name = agentId === A ? 'Hoots' : 'Goosy';
      const runtime = {
        agent: { name, publicKey: agentId, secretKeyHex: (agentId === A ? '11' : '22').repeat(32) },
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
        agentHomeRoot: join(root, surface, agentId),
        workspaceRoot: root,
        autoApprovePermissions: true,
        accessPolicy: 'everyone',
      } as BodyConfig;
      const execute = vi.fn(async (name: string, input: never) =>
        daemon.execute(name as never, input, agentId),
      );
      const api = {
        execute,
        connection: () => ({ baseUrl: 'http://test', daemonToken: 'token', agentId }),
      } as unknown as DaemonApiClient;
      const acp = new AcpClient({ agentBinary: '/fake', agentEnv: {} });
      vi.spyOn(acp, 'start').mockResolvedValue();
      vi.spyOn(acp, 'stop').mockResolvedValue();
      vi.spyOn(acp, 'isAlive', 'get').mockReturnValue(true);
      vi.spyOn(acp, 'canPromptWithImages').mockReturnValue(false);
      const session = vi.spyOn(acp, 'sessionNew').mockResolvedValue({ sessionId: name, raw: {} });
      let turns = 0;
      const prompt = vi.spyOn(acp, 'sessionPrompt').mockImplementation(async () => {
        turns++;
        if (agentId === A && turns === 1) {
          // The deterministic model explicitly invokes delegation, using the same
          // live turn context the MCP process receives. Prose is separate.
          const path = session.mock.calls[0]![0].mcpServers!.flatMap(
            (server) => server.env ?? [],
          ).find((entry) => entry.name === 'BEELINE_TURN_CONTEXT_FILE')!.value;
          const context = JSON.parse(await readFile(path, 'utf8'));
          await api.execute('stageAgentDelegation', { ...context, targetAgentId: B });
        }
        return {
          stopReason: 'end_turn',
          updates: [],
          toolCalls: [],
          agentText:
            agentId === A
              ? turns === 1
                ? '@goosy please help'
                : 'Tag @goosy and Goosy answers'
              : turns === 1
                ? 'Goosy answered'
                : 'Goosy answered again',
        };
      });
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
              objective: 'Never start from this local objective',
              openedBy: B,
              onPoll: vi.fn(),
              onFailure: vi.fn(),
              onCloseRequested: async () => {},
            });
      return { prompt, execute, running: loop.run() };
    });
    const answers = () =>
      db.query<{ id: string; text: string; author_id: string }>(
        `SELECT id,text,author_id FROM messages WHERE room_id=$1 AND author_id IN ($2,$3) AND presentation='message' ORDER BY created_at,id`,
        [roomId, A, B],
      );
    const waitAnswers = async (n: number) =>
      vi.waitFor(async () => expect((await answers()).rowCount).toBe(n), { timeout: 10000 });
    try {
      await phone.execute('sendRoomMessage', { roomId, text: '@hoots ask Goosy' }, H);
      await waitAnswers(2);
      expect(helpers.map((h) => h.prompt.mock.calls.length)).toEqual([1, 1]);
      await phone.execute('sendRoomMessage', { roomId, text: '@hoots explain tags' }, H);
      await waitAnswers(3);
      expect(helpers.map((h) => h.prompt.mock.calls.length)).toEqual([2, 1]);
      const goosy = (await answers()).rows.find((row) => row.author_id === B)!;
      await phone.execute(
        'sendRoomReply',
        { roomId, parentMessageId: goosy.id, text: 'Please continue' },
        H,
      );
      await waitAnswers(4);
      expect(helpers.map((h) => h.prompt.mock.calls.length)).toEqual([2, 2]);
      const untagged = await phone.execute(
        'sendRoomMessage',
        { roomId, text: 'Thanks everyone' },
        H,
      );
      expect(
        (
          await db.query(`SELECT 1 FROM agent_commands WHERE source_message_id=$1`, [
            untagged.messageId,
          ])
        ).rowCount,
      ).toBe(0);
      for (const agentId of [A, B])
        expect((await daemon.execute('getAgentCommands', { roomId }, agentId)).commands).toEqual(
          [],
        );
      for (const helper of helpers)
        expect(
          helper.execute.mock.calls.some(([name]) =>
            ['getRoomAuthority', 'getRoomInbox', 'getCornerCloseRequests'].includes(name),
          ),
        ).toBe(false);
      const depths = await db.query<{ agent_depth: number }>(
        `SELECT agent_depth FROM agent_commands WHERE room_id=$1 ORDER BY created_at,id`,
        [roomId],
      );
      expect(depths.rows.map((c) => c.agent_depth)).toEqual([0, 1, 0, 0]);
    } finally {
      controller.abort();
      await Promise.all(helpers.map((h) => h.running));
      await scheduler.dispose();
    }
  });
});
