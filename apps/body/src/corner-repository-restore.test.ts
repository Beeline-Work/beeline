import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { AcpClient } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import type { MonolithCornerTurnLoop } from './monolith-corner-turn.js';
import { cornerHasRepositoryWork } from './prompt-assembly.js';
import { agentToolsFor } from './read-only-mcp.js';
import { RoomRuntimeCoordinator } from './room-runtime.js';
import { identityFromKey, stageMonolithAgentRuntime } from './runtime.js';

/**
 * A corner is a code corner exactly when its parent Room has a repository.
 * The restore state carries no lane, and a human-opened corner arrives with an
 * empty objective and no brief: it must still cut a worktree on a feature
 * branch, run the code-corner surface, and be told to write the brief first.
 */

const git = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const HUMAN = 'a'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const CORNER = '33333333-3333-4333-8333-333333333333';

async function bareRemote(root: string): Promise<string> {
  const seed = join(root, 'seed');
  const remote = join(root, 'remote.git');
  await git('git', ['init', '-b', 'main', seed]);
  await writeFile(join(seed, 'widget.txt'), 'before\n');
  await git('git', ['-C', seed, 'add', '.']);
  await git('git', [
    '-C', seed, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    'commit', '-m', 'seed',
  ]);
  await git('git', ['clone', '--bare', seed, remote]);
  return remote;
}

it('cuts a worktree and runs the code-corner surface for a human corner of a repository Room', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-corner-repository-'));
  roots.push(root);
  const remote = await bareRemote(root);
  const agentIdentity = identityFromKey('11'.repeat(32), 'Candy');
  const AGENT = agentIdentity.publicKey;
  const staged = await stageMonolithAgentRuntime({
    workspaceId: WORKSPACE,
    pairedBy: HUMAN,
    daemonExchangeToken: `bde_${'d'.repeat(43)}`,
    agentBinary: '/fake-agent',
    agentKind: 'goose',
    agentCommand: '/fake-agent',
    agentArgs: [],
    mcpBinary: '/fake-dev-mcp',
    agentIdentity,
    bodyIdentity: identityFromKey('22'.repeat(32), 'Body'),
    supervisorRoot: root,
  });
  // The restore state has no lane: the parent Room's repository alone decides.
  const restore = {
    cornerId: CORNER,
    parentRoomId: ROOM,
    objective: '',
    title: 'quiet-harbor-corner',
    titleGenerated: true,
    kind: 'human',
    closeRequested: false,
  };
  const execute = vi.fn(async (name: string, _input?: unknown) => {
    switch (name) {
      case 'getCornerRestoreState':
        return restore;
      case 'getRoomRepositoryState':
        return {
          resolution: 'repository',
          key: 'owner/widgets',
          remote: `file://${remote}`,
          targetBranch: 'main',
        };
      case 'getRoomGitHubToken':
        return { token: 'corner-token', expiresAt: Date.now() + 60 * 60_000 };
      case 'getAgentConfiguration':
        return { commands: [], yoloMode: true };
      case 'getWorkspaceRoster':
        return {
          members: [
            { identityId: AGENT, kind: 'agent', name: 'Candy', handle: 'candy', role: 'member' },
          ],
        };
      case 'getAgentCommands':
        return { commandProtocol: 1, commands: [] };
      case 'getRoomInbox':
        return { items: [], cursor: 'latest' };
      case 'listCornerBriefRevisions':
        return { revisions: [] };
      default:
        return { id: 'write-id', createdAt: 1 };
    }
  });
  const coordinator = new RoomRuntimeCoordinator(
    staged.runtime,
    staged.configPath,
    {
      workspaceRoot: root,
      agentBinary: '/fake-agent',
      agentKind: 'goose',
      agentCommand: '/fake-agent',
      agentArgs: [],
      mcpBinary: '/fake-dev-mcp',
      readonlyMcpCommand: '/fake-beeline-mcp',
      agentEnv: {},
      autoApprovePermissions: true,
      codegraphCommand: '/usr/bin/false',
    } as BodyConfig,
    {
      daemonApi: {
        execute,
        connection: () => ({
          baseUrl: 'https://server.example',
          daemonToken: 'daemon-token',
          agentId: AGENT,
          helperVersion: 'test',
        }),
      } as unknown as DaemonApiClient,
    },
  );
  const internals = coordinator as unknown as {
    startCorner(corner: { cornerId: string; parentRoomId: string; openedBy?: string }): Promise<void>;
    running: Map<string, { body: MonolithCornerTurnLoop }>;
  };
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await internals.startCorner({ cornerId: CORNER, parentRoomId: ROOM, openedBy: HUMAN });
    expect(error.mock.calls.map((call) => String(call[0]))).not.toContainEqual(
      expect.stringContaining('failed to start corner'),
    );
    expect(coordinator.activeRoomIds()).toContain(CORNER);

    const featureBranch = `feature/corner-${CORNER.replaceAll('-', '').slice(0, 12)}`;
    const worktree = join(staged.runtime.supervisorRoot, 'beeline', 'corners', CORNER);
    expect(execute).toHaveBeenCalledWith('getRoomGitHubToken', { roomId: ROOM });
    expect(existsSync(join(worktree, 'widget.txt'))).toBe(true);
    expect((await git('git', ['-C', worktree, 'branch', '--show-current'])).stdout.trim()).toBe(
      featureBranch,
    );
    expect(execute).toHaveBeenCalledWith(
      'postCornerRemoteState',
      expect.objectContaining({ cornerId: CORNER, branch: featureBranch, state: 'working' }),
    );

    // The session it runs is a code corner's, with no upgrade tool anywhere.
    const loop = internals.running.get(CORNER)!.body;
    const acp = new AcpClient({ agentBinary: '/fake-agent', agentEnv: {} });
    vi.spyOn(acp, 'start').mockResolvedValue(undefined);
    vi.spyOn(acp, 'stop').mockResolvedValue(undefined);
    const sessionNew = vi
      .spyOn(acp, 'sessionNew')
      .mockResolvedValue({ sessionId: 'code-session', raw: {} });
    (loop as unknown as { options: { createAcpClient: () => AcpClient } }).options.createAcpClient =
      () => acp;
    await (loop as unknown as { activate(): Promise<string> }).activate();
    expect((loop as unknown as { sessionSurface: string }).sessionSurface).toBe('code-corner');
    const input = sessionNew.mock.calls[0]![0];
    expect(input.cwd).toBe(worktree);
    expect(input.systemPrompt).toContain(`isolated git worktree on ${featureBranch}`);
    // No brief yet: nothing is assigned, so the brief comes before any code.
    expect(cornerHasRepositoryWork(undefined)).toBe(false);
    expect(input.systemPrompt).toContain('write it with revise_corner_brief first');
    expect(input.systemPrompt).not.toContain('repo-less corner');
    const agentServer = (input.mcpServers ?? []).find((server) => server.name === 'beeline-agent');
    const environment = new Map((agentServer?.env ?? []).map(({ name, value }) => [name, value]));
    expect(environment.get('BEELINE_CORNER_REPOSITORY')).toBe('1');
    expect([...environment.keys()].some((name) => /LANE|UPGRADE/.test(name))).toBe(false);
    const tools = agentToolsFor(
      environment.get('BEELINE_MCP_SURFACE') === 'agent',
      environment.get('BEELINE_AGENT_DM') === '1',
      Boolean(environment.get('BEELINE_DAEMON_CORNER_ID')),
      environment.get('BEELINE_CORNER_REPOSITORY') === '1',
      Boolean(environment.get('BEELINE_GRANT_RUNNER_URL')),
      environment.get('BEELINE_CORNER_AGENT_CLOSE') === '1',
    ).map((tool) => tool.name);
    expect(tools).toContain('approve_merge');
    expect(tools).toContain('merge_corner');
    expect(tools).toContain('rename_corner');
    expect(tools).toContain('revise_corner_brief');
    expect(tools).not.toContain('upgrade_corner_to_code');
  } finally {
    await coordinator.shutdown();
  }
}, 60_000);
