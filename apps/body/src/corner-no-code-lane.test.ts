import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { createAgentCommand } from '../../server/src/agent-command.js';
import { migrate } from '../../server/src/database.js';
import { PgliteDatabase } from '../../server/src/test-support.js';
import { DaemonService } from '../../server/src/daemon-service.js';
import { LiveHub } from '../../server/src/live.js';
import { AcpClient } from './acp.js';
import { commandFixtureApi } from './command-fixture.test-support.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { CORNER_AUTHOR_CONTRACT, MonolithCornerTurnLoop } from './monolith-corner-turn.js';
import { agentToolsFor } from './read-only-mcp.js';
import { RoomRuntimeCoordinator } from './room-runtime.js';
import { identityFromKey, stageMonolithAgentRuntime, type AgentRuntimeRecord } from './runtime.js';
import { SessionScheduler } from './session-scheduler.js';

/**
 * The no-code lane, from the helper's side.
 *
 * Two halves have to hold. The runtime must not cut a worktree or mint a
 * GitHub token for a no-code corner even though its parent Room is bound to a
 * repository — that binding used to be the only thing the decision read. And
 * the corner's session has to be told the truth about how this corner ends:
 * artifacts and a reply tagging the requester, because there is no pull
 * request URL and no merge card to stand in for "done".
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const HUMAN = 'a'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const CORNER = '33333333-3333-4333-8333-333333333333';
const REQUEST = 'c'.repeat(64);
const git = promisify(execFile);

function stored(hex: string, name: string) {
  const identity = identityFromKey(hex, name);
  return {
    name,
    publicKey: identity.publicKey,
    secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
  };
}

/** A repository Room whose single corner sits on `lane`, served by the real server. */
async function stageRepositoryRoomCorner(
  lane: 'code' | 'no_code',
  remote = 'https://github.com/owner/widgets.git',
) {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-no-code-lane-'));
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
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Ada','ada'),($2,'agent','Candy','candy')`,
    [HUMAN, AGENT],
  );
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, HUMAN]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,name,repository_key,repository_remote,repository_resolution,repository_target_branch)
     VALUES($1,$2,'Widgets','owner/widgets',$3,'repository','main')`,
    [ROOM, WORKSPACE, remote],
  );
  await database.query(
    `INSERT INTO rooms(id,workspace_id,name,parent_id) VALUES($1,$2,'Corner',$3)`,
    [CORNER, WORKSPACE, ROOM],
  );
  await database.query(
    `INSERT INTO corner_facts(corner_id,owner_agent_id,commissioned_by,objective,lane,lifecycle)
     VALUES($1,$2,$3,'Survey the five nearest competitors and write it up',$4,'{"checks":"unknown"}')`,
    [CORNER, AGENT, HUMAN, lane],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
     VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),
           ($1,$4,$2,'owner'),($1,$4,$3,'member'),
           ($1,$5,$2,'owner'),($1,$5,$3,'member')`,
    [WORKSPACE, HUMAN, AGENT, ROOM, CORNER],
  );
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@candy please do this')`,
    [REQUEST, CORNER, HUMAN],
  );
  await createAgentCommand(database, {
    roomId: CORNER,
    agentId: AGENT,
    sourceMessageId: REQUEST,
    reason: 'corner_objective',
  });
  const token = vi.fn(async () => ({ token: 'corner-token', expiresAt: Date.now() + 60_000 }));
  const daemon = new DaemonService(database, new LiveHub(), token);
  const execute = vi.fn((name: string, input: Record<string, unknown>) =>
    daemon.execute(name as never, input as never, AGENT),
  );
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
    startCorner(corner: {
      cornerId: string;
      parentRoomId: string;
      openedBy?: string;
    }): Promise<void>;
  };
  return {
    execute,
    coordinator,
    async run() {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      await start.startCorner({ cornerId: CORNER, parentRoomId: ROOM, openedBy: AGENT });
      const lines = log.mock.calls.map((call) => String(call[0]));
      error.mockRestore();
      log.mockRestore();
      await coordinator.shutdown();
      return { lines, scratchPath: join(dirname(staged.configPath), 'rooms', CORNER, 'scratch') };
    },
    database,
    token,
    startCorner: () => start.startCorner({ cornerId: CORNER, parentRoomId: ROOM, openedBy: AGENT }),
    roomBase: dirname(staged.configPath),
    supervisorRoot: staged.runtime.supervisorRoot,
  };
}

it('serves a no-code corner of a repository Room from scratch, with no branch and no token', async () => {
  const staged = await stageRepositoryRoomCorner('no_code');

  const { lines, scratchPath } = await staged.run();

  expect(existsSync(scratchPath)).toBe(true);
  expect(lines.some((line) => line.includes(`serving no-code corner ${CORNER}`))).toBe(true);
  // The token is minted only to clone and push. Asking for one here would mean
  // a worktree was about to be cut for a corner that must not produce a commit.
  expect(staged.execute).not.toHaveBeenCalledWith('getRoomGitHubToken', expect.anything());
  // No feature branch is announced either: there is no remote state to report.
  expect(staged.execute).not.toHaveBeenCalledWith('postCornerRemoteState', expect.anything());
});

it('still takes the repository path for a code-lane corner of the same Room', async () => {
  const staged = await stageRepositoryRoomCorner('code');

  await staged.run();

  expect(staged.execute).toHaveBeenCalledWith('getRoomGitHubToken', { roomId: ROOM });
});

it('retires a running no-code session and restarts the same corner with a real branch and token', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'beeline-lane-upgrade-remote-'));
  roots.push(fixture);
  const seed = join(fixture, 'seed');
  const remote = join(fixture, 'remote.git');
  await git('git', ['init', '-b', 'main', seed]);
  await writeFile(join(seed, 'widget.txt'), 'before\n');
  await git('git', ['-C', seed, 'add', '.']);
  await git('git', [
    '-C',
    seed,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'seed',
  ]);
  await git('git', ['clone', '--bare', seed, remote]);
  const staged = await stageRepositoryRoomCorner('no_code', `file://${remote}`);
  await staged.database.query(`DELETE FROM agent_commands WHERE room_id=$1`, [CORNER]);

  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await staged.startCorner();
    const scratch = join(staged.roomBase, 'rooms', CORNER, 'scratch');
    expect(existsSync(scratch)).toBe(true);
    expect(staged.token).not.toHaveBeenCalled();

    const featureBranch = `feature/corner-${CORNER.replaceAll('-', '').slice(0, 12)}`;
    await staged.database.query(`UPDATE corner_facts SET lane='code' WHERE corner_id=$1`, [CORNER]);
    await staged.coordinator.applyCornerRestart(CORNER);
    expect(staged.coordinator.activeRoomIds()).not.toContain(CORNER);
    expect(existsSync(scratch)).toBe(false);

    await staged.startCorner();
    const worktree = join(staged.supervisorRoot, 'beeline', 'corners', CORNER);
    expect(staged.coordinator.activeRoomIds()).toContain(CORNER);
    expect(staged.token).toHaveBeenCalledWith(ROOM);
    expect(existsSync(join(worktree, 'widget.txt'))).toBe(true);
    expect((await git('git', ['-C', worktree, 'branch', '--show-current'])).stdout.trim()).toBe(
      featureBranch,
    );
    expect(staged.execute).toHaveBeenCalledWith(
      'postCornerRemoteState',
      expect.objectContaining({ cornerId: CORNER, branch: featureBranch, state: 'working' }),
    );
  } finally {
    error.mockRestore();
    log.mockRestore();
    await staged.coordinator.shutdown();
    await staged.database.close();
  }
});

it('tells a no-code corner to deliver artifacts and tag the requester, never to open a pull request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-no-code-prompt-'));
  roots.push(root);
  const workspace = join(root, 'rooms', 'corner-id', 'scratch');
  const scratchRoot = join(workspace, 'agent-home');
  await mkdir(scratchRoot, { recursive: true });
  const agent = stored('11'.repeat(32), 'Bee');
  const runtime = {
    agentId: '11'.repeat(32),
    agent,
    rooms: [],
    supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'daemon-token' },
    agentBinary: '/fake-agent',
    agentKind: 'codex',
    agentCommand: '/fake-agent',
    agentArgs: [],
    mcpBinary: '/fake-dev-mcp',
  } as unknown as AgentRuntimeRecord;
  const config: BodyConfig = {
    agentBinary: '/fake-agent',
    agentKind: 'codex',
    agentCommand: '/fake-agent',
    agentArgs: [],
    mcpBinary: '/fake-dev-mcp',
    readonlyMcpCommand: '/fake-beeline-mcp',
    agentEnv: {},
    agentHomeRoot: scratchRoot,
    workspaceRoot: workspace,
    autoApprovePermissions: true,
  };
  const execute = vi.fn(async (name: string) => {
    if (name === 'getAgentConfiguration') return { commands: [] };
    if (name === 'getWorkspaceRoster') {
      return {
        members: [{ identityId: agent.publicKey, kind: 'agent', name: 'Bee', role: 'member' }],
      };
    }
    if (name === 'getRoomConversation') return { items: [], cursor: 'latest' };
    if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
    if (name === 'getCornerCloseRequests')
      return { items: [], cursor: 'latest', closeRequested: true };
    return { id: 'write-id', createdAt: 1 };
  });
  const api = {
    execute,
    connection: () => ({
      baseUrl: 'https://server.example',
      daemonToken: 'daemon-token',
      agentId: agent.publicKey,
    }),
  } as unknown as DaemonApiClient;
  const acp = new AcpClient({ agentBinary: '/fake-agent', agentEnv: {} });
  vi.spyOn(acp, 'start').mockResolvedValue(undefined);
  let sessionInput: Parameters<AcpClient['sessionNew']>[0] | undefined;
  vi.spyOn(acp, 'sessionNew').mockImplementation(async (input) => {
    sessionInput = input;
    return { sessionId: 'corner-session', raw: {} };
  });
  vi.spyOn(acp, 'sessionPrompt').mockResolvedValue({
    stopReason: 'end_turn',
    updates: [],
    agentText: 'Posted the write-up.',
    toolCalls: [],
  });
  const scheduler = new SessionScheduler({ maxLiveSessions: 2 });
  await new MonolithCornerTurnLoop({
    cornerId: 'corner-id',
    parentRoomId: 'room-id',
    workspaceId: 'workspace',
    objective: 'Survey the five nearest competitors and write it up',
    worktreePath: workspace,
    requesterHandle: 'ada',
    runtime,
    config,
    api: commandFixtureApi(
      api,
      'corner-id',
      agent.publicKey,
      'Survey the five nearest competitors and write it up',
    ),
    scheduler,
    pollMs: 1,
    onPoll: vi.fn(),
    onFailure: vi.fn(),
    onCloseRequested: vi.fn(async () => undefined),
    createAcpClient: () => acp,
  }).run();
  await scheduler.dispose();

  const prompt = String(sessionInput?.systemPrompt);
  expect(prompt).toContain('no-code corner with no repository checkout');
  expect(prompt).toContain('post_artifact everything the assigned intent and criteria require');
  expect(prompt).toContain('The corner stays open until a human explicitly closes it');
  expect(prompt).not.toContain('close_corner');
  const agentServer = sessionInput?.mcpServers.find((server) => server.name === 'beeline-agent');
  const agentEnvironment = new Map(agentServer?.env.map(({ name, value }) => [name, value]));
  expect(agentEnvironment.has('BEELINE_CORNER_AGENT_CLOSE')).toBe(false);
  expect(
    agentToolsFor(
      agentEnvironment.get('BEELINE_MCP_SURFACE') === 'agent',
      agentEnvironment.get('BEELINE_AGENT_DM') === '1',
      Boolean(agentEnvironment.get('BEELINE_DAEMON_CORNER_ID')),
      agentEnvironment.get('BEELINE_CORNER_REVIEWER') === '1',
      Boolean(agentEnvironment.get('BEELINE_GRANT_RUNNER_URL')),
      agentEnvironment.get('BEELINE_CORNER_AGENT_CLOSE') === '1',
    ).map((tool) => tool.name),
  ).not.toContain('close_corner');
  // The requester still has to receive the delivery report.
  expect(prompt).toContain('@ada');
  expect(prompt).toContain('Do not initialize a repository, create a branch, commit, push');
  expect(prompt).not.toContain('Open the pull request with gh');
  expect(prompt).not.toContain('gh pr merge');
  expect(prompt).not.toContain(CORNER_AUTHOR_CONTRACT);
});

it('retires a no-code session on the timed restore read when the server already moved it to code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-lane-poll-'));
  roots.push(root);
  const workspace = join(root, 'rooms', 'corner-id', 'scratch');
  await mkdir(workspace, { recursive: true });
  const agent = stored('11'.repeat(32), 'Bee');
  const runtime = {
    agentId: '11'.repeat(32),
    agent,
    rooms: [],
    supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'daemon-token' },
    agentBinary: '/fake-agent',
    agentKind: 'codex',
    agentCommand: '/fake-agent',
    agentArgs: [],
    mcpBinary: '/fake-dev-mcp',
  } as unknown as AgentRuntimeRecord;
  const config: BodyConfig = {
    agentBinary: '/fake-agent',
    agentKind: 'codex',
    agentCommand: '/fake-agent',
    agentArgs: [],
    mcpBinary: '/fake-dev-mcp',
    readonlyMcpCommand: '/fake-beeline-mcp',
    agentEnv: {},
    workspaceRoot: workspace,
    autoApprovePermissions: true,
  };
  const execute = vi.fn(async (name: string) => {
    if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [] };
    if (name === 'getCornerRestoreState')
      return {
        cornerId: 'corner-id',
        objective: 'Write it up',
        lane: 'code',
        closeRequested: false,
      };
    return { id: 'write-id', createdAt: 1 };
  });
  const api = {
    execute,
    connection: () => ({
      baseUrl: 'https://server.example',
      daemonToken: 'daemon-token',
      agentId: agent.publicKey,
    }),
  } as unknown as DaemonApiClient;
  const scheduler = new SessionScheduler({ maxLiveSessions: 2 });
  const onLaneChanged = vi.fn();
  const onCloseRequested = vi.fn(async () => undefined);

  await new MonolithCornerTurnLoop({
    cornerId: 'corner-id',
    parentRoomId: 'room-id',
    workspaceId: 'workspace',
    objective: 'Write it up',
    worktreePath: workspace,
    lane: 'no_code',
    runtime,
    config,
    api,
    scheduler,
    pollMs: 1,
    onPoll: vi.fn(),
    onFailure: vi.fn(),
    onCloseRequested,
    onLaneChanged,
  }).run();
  await scheduler.dispose();

  expect(onLaneChanged).toHaveBeenCalledTimes(1);
  expect(onCloseRequested).not.toHaveBeenCalled();
  expect(execute).toHaveBeenCalledWith('getCornerRestoreState', { cornerId: 'corner-id' });
});
