import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentCommand } from '../../server/src/agent-command.js';
import { migrate } from '../../server/src/database.js';
import { PgliteDatabase } from '../../server/src/test-support.js';
import { DaemonService } from '../../server/src/daemon-service.js';
import { LiveHub } from '../../server/src/live.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { MonolithCornerTurnLoop } from './monolith-corner-turn.js';
import { RoomRuntimeCoordinator } from './room-runtime.js';
import { identityFromKey, stageMonolithAgentRuntime } from './runtime.js';

const HUMAN = 'a'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const CORNER = '33333333-3333-4333-8333-333333333333';
const REQUEST = 'c'.repeat(64);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('corner-start standing faults against the real server', () => {
  it('inscribes the pending command and does not retry the same standing configuration', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-corner-start-fail-'));
    roots.push(root);
    const agentIdentity = identityFromKey('11'.repeat(32), 'Candy');
    const AGENT = agentIdentity.publicKey;
    const staged = await stageMonolithAgentRuntime({
      workspaceId: WORKSPACE,
      pairedBy: HUMAN,
      daemonExchangeToken: `bde_${'d'.repeat(43)}`,
      agentBinary: '/nonexistent',
      agentKind: 'codex',
      agentCommand: '/nonexistent',
      agentArgs: [],
      mcpBinary: 'unused',
      agentIdentity,
      bodyIdentity: identityFromKey('22'.repeat(32), 'Body'),
      supervisorRoot: root,
    });
    const database = new PgliteDatabase();
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Candy','candy')`,
      [HUMAN, AGENT],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, HUMAN]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General'),($3,$2,'Corner')`,
      [ROOM, WORKSPACE, CORNER],
    );
    await database.query(`UPDATE rooms SET parent_id=$1 WHERE id=$2`, [ROOM, CORNER]);
    await database.query(
      `INSERT INTO corner_facts(corner_id,owner_agent_id,objective,lifecycle) VALUES($1,$2,'','{"checks":"unknown"}')`,
      [CORNER, AGENT],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),
             ($1,$4,$2,'owner'),($1,$4,$3,'member'),
             ($1,$5,$2,'owner'),($1,$5,$3,'member')`,
      [WORKSPACE, HUMAN, AGENT, ROOM, CORNER],
    );
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@candy ship it')`,
      [REQUEST, CORNER, HUMAN],
    );
    const command = await createAgentCommand(database, {
      roomId: CORNER,
      agentId: AGENT,
      sourceMessageId: REQUEST,
      reason: 'corner_objective',
    });
    const daemon = new DaemonService(database, new LiveHub());
    const execute = vi.fn((name: string, input: Record<string, unknown>) =>
      daemon.execute(name as never, input as never, AGENT),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const coordinator = new RoomRuntimeCoordinator(
      staged.runtime,
      staged.configPath,
      { workspaceRoot: root } as never,
      {
        daemonApi: {
          execute,
          connection: () => ({
            baseUrl: 'https://server.example',
            daemonToken: 'daemon-token',
            agentId: AGENT,
          }),
        } as unknown as DaemonApiClient,
      },
    );
    const start = coordinator as unknown as {
      startCorner(corner: { cornerId: string; parentRoomId: string }): Promise<void>;
    };
    await start.startCorner({ cornerId: CORNER, parentRoomId: ROOM });
    await start.startCorner({ cornerId: CORNER, parentRoomId: ROOM });
    error.mockRestore();
    await coordinator.shutdown();

    const receipts = execute.mock.calls.filter(([name]) => name === 'postAgentTurnReceipt');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]![1]).toMatchObject({
      roomId: CORNER,
      requestId: REQUEST,
      status: 'failed',
      reasonKind: 'workspace-failure',
    });
    expect(receipts[0]![1]).not.toHaveProperty('generationId');
    expect(
      (
        await database.query<{ text: string; silence: string }>(
          `SELECT text,card->>'silenceKind' silence FROM messages
           WHERE room_id=$1 AND card_type='turn-failed' AND card->>'requestId'=$2`,
          [CORNER, REQUEST],
        )
      ).rows,
    ).toEqual([
      expect.objectContaining({
        silence: 'workspace-failure',
      }),
    ]);
    expect(
      (
        await database.query<{ state: string; hiccup_attempts: number }>(
          `SELECT state,hiccup_attempts FROM agent_commands WHERE id=$1`,
          [command!.id],
        )
      ).rows[0],
    ).toEqual({ state: 'complete', hiccup_attempts: 0 });
    await database.close();
  });
});

describe('corner-start transient clone against the real server', () => {
  it('keeps the actual pending request redeliverable and answers it after the clone recovers', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-corner-start-clone-'));
    roots.push(root);
    const agentIdentity = identityFromKey('11'.repeat(32), 'Candy');
    const AGENT = agentIdentity.publicKey;
    const staged = await stageMonolithAgentRuntime({
      workspaceId: WORKSPACE,
      pairedBy: HUMAN,
      daemonExchangeToken: `bde_${'d'.repeat(43)}`,
      agentBinary: '/nonexistent',
      agentKind: 'codex',
      agentCommand: '/nonexistent',
      agentArgs: [],
      mcpBinary: 'unused',
      agentIdentity,
      bodyIdentity: identityFromKey('22'.repeat(32), 'Body'),
      supervisorRoot: root,
    });
    const database = new PgliteDatabase();
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Candy','candy')`,
      [HUMAN, AGENT],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, HUMAN]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General'),($3,$2,'Corner')`,
      [ROOM, WORKSPACE, CORNER],
    );
    await database.query(`UPDATE rooms SET parent_id=$1 WHERE id=$2`, [ROOM, CORNER]);
    await database.query(
      `UPDATE rooms SET repository_key='acme/widgets',repository_remote='https://github.example/acme/widgets.git',
         repository_target_branch='main',repository_resolution='repository' WHERE id=$1`,
      [ROOM],
    );
    await database.query(
      `INSERT INTO corner_facts(corner_id,owner_agent_id,objective,lifecycle)
       VALUES($1,$2,'Ship the importer dry-run flag','{"checks":"unknown"}')`,
      [CORNER, AGENT],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),
             ($1,$4,$2,'owner'),($1,$4,$3,'member'),
             ($1,$5,$2,'owner'),($1,$5,$3,'member')`,
      [WORKSPACE, HUMAN, AGENT, ROOM, CORNER],
    );
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@candy ship it')`,
      [REQUEST, CORNER, HUMAN],
    );
    const command = await createAgentCommand(database, {
      roomId: CORNER,
      agentId: AGENT,
      sourceMessageId: REQUEST,
      reason: 'corner_objective',
    });
    const daemon = new DaemonService(database, new LiveHub(), async () => ({
      token: 'gh-token',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    }));
    const execute = vi.fn((name: string, input: Record<string, unknown>) =>
      daemon.execute(name as never, input as never, AGENT),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const recoveredPath = resolve(root, 'recovered-worktree');
    const recoveredGit = resolve(root, 'recovered.git');
    await mkdir(recoveredPath, { recursive: true });
    await mkdir(recoveredGit, { recursive: true });
    const turnRun = vi
      .spyOn(MonolithCornerTurnLoop.prototype, 'run')
      .mockImplementation(async function (this: {
        options: { api: DaemonApiClient; cornerId: string };
      }) {
        const { commands } = await this.options.api.execute('getAgentCommands', {
          roomId: this.options.cornerId,
        });
        const pending = commands.find(
          (item) => item.action === 'input' || item.action === 'resume',
        );
        if (!pending) throw new Error('original request was not pending to answer');
        await this.options.api.execute('postAgentTurnReceipt', {
          roomId: this.options.cornerId,
          requestId: pending.turnRequestId,
          status: 'working',
          generationId: 'recover-gen',
        });
        await this.options.api.execute('postRoomMessage', {
          roomId: this.options.cornerId,
          requestId: pending.turnRequestId,
          generationId: 'recover-gen',
          text: 'clone recovered; answering the original ask',
        });
      });
    const coordinator = new RoomRuntimeCoordinator(
      staged.runtime,
      staged.configPath,
      { workspaceRoot: root } as never,
      {
        daemonApi: {
          execute,
          connection: () => ({
            baseUrl: 'https://server.example',
            daemonToken: 'daemon-token',
            agentId: AGENT,
          }),
        } as unknown as DaemonApiClient,
      },
    );
    const start = coordinator as unknown as {
      startCorner(corner: { cornerId: string; parentRoomId: string }): Promise<void>;
      materializeCornerWorktree(input: unknown): Promise<{ path: string; gitCommonDir: string }>;
    };
    const materialize = vi
      .spyOn(start, 'materializeCornerWorktree')
      .mockRejectedValueOnce(
        new Error(
          'Command failed: git clone https://github.example/acme/widgets.git\nfatal: unable to access repository',
        ),
      )
      .mockResolvedValueOnce({ path: recoveredPath, gitCommonDir: recoveredGit });

    await start.startCorner({ cornerId: CORNER, parentRoomId: ROOM });
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(turnRun).not.toHaveBeenCalled();
    expect(
      (
        await database.query<{ state: string; hiccup_attempts: number }>(
          `SELECT state,hiccup_attempts FROM agent_commands WHERE id=$1`,
          [command!.id],
        )
      ).rows[0],
    ).toEqual({ state: 'pending', hiccup_attempts: 0 });
    const failure = (
      await database.query<{ text: string }>(
        `SELECT text FROM messages WHERE room_id=$1 AND card_type='turn-failed' AND card->>'requestId'=$2`,
        [CORNER, REQUEST],
      )
    ).rows[0];
    expect(failure?.text).toBeTruthy();
    expect(failure!.text).not.toMatch(/restarting|resending/i);

    await start.startCorner({ cornerId: CORNER, parentRoomId: ROOM });
    expect(materialize).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => {
      expect(turnRun).toHaveBeenCalledTimes(1);
      expect(
        (
          await database.query<{ state: string }>(`SELECT state FROM agent_commands WHERE id=$1`, [
            command!.id,
          ])
        ).rows[0]?.state,
      ).toBe('complete');
    });
    error.mockRestore();
    turnRun.mockRestore();
    materialize.mockRestore();
    await coordinator.shutdown();

    expect(
      (
        await database.query<{ hiccup_attempts: number }>(
          `SELECT hiccup_attempts FROM agent_commands WHERE id=$1`,
          [command!.id],
        )
      ).rows[0],
    ).toEqual({ hiccup_attempts: 0 });
    expect(
      (
        await database.query<{ text: string }>(
          `SELECT text FROM messages WHERE room_id=$1 AND presentation='message' AND author_id=$2`,
          [CORNER, AGENT],
        )
      ).rows.map((row) => row.text),
    ).toContain('clone recovered; answering the original ask');
    await database.close();
  });
});
