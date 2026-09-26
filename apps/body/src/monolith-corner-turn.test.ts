import { commandFixtureApi } from './command-fixture.test-support.js';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import {
  CORNER_AUTHOR_CONTRACT,
  CORNER_CLOSE_POLL_BASE_MS,
  CORNER_DELIVERY_NUDGE,
  CORNER_REVIEWER_SESSION_INSTRUCTION,
  CORNER_REVIEWER_UNSTABLE_HEAD_INSTRUCTION,
  CORNER_YOLO_MERGE_NUDGE,
  cornerClosePollMs,
  cornerHasUndeliveredRepositoryWork,
  cornerMergeInstruction,
  cornerReviewerInstruction,
  cornerSelfReviewerInstruction,
  cornerToolActivity,
  MonolithCornerTurnLoop,
} from './monolith-corner-turn.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { SOUL_HOUSE_RULE } from './response-directives.js';
import { agentToolsFor, postArtifact, writeScratchFile } from './read-only-mcp.js';
import { SessionScheduler } from './session-scheduler.js';
import {
  sharedCargoTargetDir,
  sharedNpmCacheDir,
  sharedPnpmStoreDir,
} from './warm-node-modules.js';

// Turn fixtures use scratch repositories. Branch synchronization has its own
// real-git suite; these tests exercise the conversation and merge instructions.
vi.mock('./corner-branch-sync.js', () => ({ syncCornerBranch: vi.fn(async () => 'unchanged') }));

const roots: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function stored(hex: string, name: string) {
  const identity = identityFromKey(hex, name);
  return {
    name,
    publicKey: identity.publicKey,
    secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
  };
}

const TEST_AGENT_PUBLIC_KEY = stored('11'.repeat(32), 'Bee').publicKey;

describe('corner merge instructions', () => {
  it('does not reuse a startup token after the Room denies a fresh credential', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('repository access denied'));
    const loop = Object.create(MonolithCornerTurnLoop.prototype) as {
      options: Record<string, unknown>;
      syncBranch(): Promise<void>;
    };
    loop.options = {
      repository: {
        featureBranch: 'feature/widget',
        targetBranch: 'main',
        githubToken: 'stale-token',
      },
      api: { execute },
      parentRoomId: 'exact-room',
      worktreePath: '/unused',
    };
    await expect(loop.syncBranch()).rejects.toThrow('repository access denied');
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledWith('getRoomGitHubToken', { roomId: 'exact-room' });
  });

  it('selects the no-reviewer and reviewer matrix', () => {
    expect(cornerMergeInstruction(true)).toContain('merge this pull request with gh');
    expect(cornerMergeInstruction(false)).toContain('never merge');
    expect(cornerMergeInstruction(false)).toContain('human owner to turn yolo on');
    for (const yolo of [false, true]) {
      const instruction = cornerMergeInstruction(yolo, 'echo');
      expect(instruction).not.toContain('please review');
      expect(instruction).toContain('do not merge until @echo has reviewed');
      expect(instruction).toContain('whether or not it tags you');
      expect(instruction).toContain('only if the complete gate passes');
      expect(instruction).toContain('gh pr merge --squash --match-head-commit <sha>');
    }
  });

  it('selects the reviewer role by identity only for a non-opener', () => {
    const reviewer = {
      reviewerHandle: 'echo',
      agentHandle: 'echo',
      authorHandle: 'bee',
      openedByAgent: false,
      pullRequestNumber: 42,
      headSha: 'a'.repeat(40),
      briefRevision: 2,
    };
    const instruction = cornerReviewerInstruction(reviewer)!;
    expect(instruction).toContain(`Checks are green on PR #42 at ${'a'.repeat(40)}`);
    expect(instruction).toContain(`call the approve_merge tool for ${'a'.repeat(40)}`);
    expect(instruction).toContain('assigned brief revision 2');
    expect(instruction).toContain('briefRevision=2');
    expect(instruction).toContain(`@bee approved ${'a'.repeat(40)}, merge`);
    expect(instruction).toContain('Never merge yourself');
    expect(instruction).toContain('Never say you are holding or waiting for checks');
    expect(instruction).not.toContain('pending checks');
    expect(instruction).not.toContain('unknown checks');
    expect(cornerReviewerInstruction({ ...reviewer, openedByAgent: true })).toBeUndefined();
    expect(cornerReviewerInstruction({ ...reviewer, agentHandle: 'bee' })).toBeUndefined();
  });

  it('gives the self-reviewer line only when the reviewer opens its own corner', () => {
    const selfReviewer = { reviewerHandle: 'echo', agentHandle: 'echo', openedByAgent: true };
    const instruction = cornerSelfReviewerInstruction(selfReviewer)!;
    expect(instruction).toContain("You are this Room's reviewer");
    expect(instruction).toContain('do not request one');
    expect(instruction).toContain('do not tag any agent for review');
    expect(instruction).toContain('merge yourself');
    // A non-reviewer opener (someone else is the configured reviewer): nothing.
    expect(cornerSelfReviewerInstruction({ ...selfReviewer, agentHandle: 'bee' })).toBeUndefined();
    // The reviewer on someone else's corner: `cornerReviewerInstruction` covers
    // that case instead, so this stays undefined.
    expect(
      cornerSelfReviewerInstruction({ ...selfReviewer, openedByAgent: false }),
    ).toBeUndefined();
    // No reviewer configured at all: nothing either.
    expect(
      cornerSelfReviewerInstruction({ ...selfReviewer, reviewerHandle: undefined }),
    ).toBeUndefined();
  });

  it('nudges delivery for dirty work without disposing of it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-corner-delivery-'));
    roots.push(root);
    await execFileAsync('git', ['init', root]);
    await execFileAsync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
    await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Test']);
    await writeFile(join(root, 'tracked.txt'), 'clean\n');
    await execFileAsync('git', ['-C', root, 'add', 'tracked.txt']);
    await execFileAsync('git', ['-C', root, 'commit', '-m', 'initial']);

    expect(await cornerHasUndeliveredRepositoryWork(root)).toBe(false);
    await writeFile(join(root, 'tracked.txt'), 'agent decides this change\n');
    expect(await cornerHasUndeliveredRepositoryWork(root)).toBe(true);
    expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('agent decides this change\n');

    await execFileAsync('git', ['-C', root, 'add', 'tracked.txt']);
    await execFileAsync('git', ['-C', root, 'commit', '-m', 'local delivery']);
    await execFileAsync('git', [
      '-C',
      root,
      'update-ref',
      'refs/remotes/origin/feature/widget',
      'HEAD~1',
    ]);
    expect(await cornerHasUndeliveredRepositoryWork(root, 'feature/widget')).toBe(true);
    await execFileAsync('git', [
      '-C',
      root,
      'update-ref',
      '-d',
      'refs/remotes/origin/feature/widget',
    ]);
    await execFileAsync('git', ['-C', root, 'update-ref', 'refs/remotes/origin/main', 'HEAD~1']);
    expect(await cornerHasUndeliveredRepositoryWork(root, 'feature/widget', 'main')).toBe(true);
  });

  it('keeps delivery cleanup under agent control and the merge reminder behind yolo', () => {
    expect(CORNER_DELIVERY_NUDGE).toContain('commit and push');
    expect(CORNER_DELIVERY_NUDGE).toContain('do not discard');
    expect(CORNER_DELIVERY_NUDGE).toContain('## Reproduced');
    expect(CORNER_DELIVERY_NUDGE).toContain('## Demonstrated');
    expect(CORNER_YOLO_MERGE_NUDGE).toContain('Yolo is on');
    expect(CORNER_YOLO_MERGE_NUDGE).toContain('pr_checks_status');
    expect(CORNER_YOLO_MERGE_NUDGE).toContain('checks="unknown"');
    expect(CORNER_YOLO_MERGE_NUDGE).toContain('instead of retrying');
  });

  it('reports the owner wait instead of a no-reply completion while host access is pending', async () => {
    const agent = stored('11'.repeat(32), 'Bee');
    const execute = vi.fn(async (name: string) =>
      name === 'authorizeHostCall'
        ? { allowed: false, status: 'pending', ownerHandle: 'moonscannerai' }
        : { allowed: true, id: 'write', createdAt: 1 },
    );
    const scheduler = new SessionScheduler({ maxLiveSessions: 1 });
    const schedule = vi.spyOn(scheduler, 'run');
    const createAcpClient = vi.fn();
    const root = await mkdtemp(join(tmpdir(), 'corner-approval-'));
    roots.push(root);
    const loop = new MonolithCornerTurnLoop({
      cornerId: 'corner-id',
      parentRoomId: 'room-id',
      workspaceId: 'workspace',
      objective: 'Edit the repository',
      worktreePath: root,
      runtime: { agent, supervisorRoot: root } as AgentRuntimeRecord,
      config: { agentHomeRoot: root } as BodyConfig,
      api: { execute } as unknown as DaemonApiClient,
      scheduler,
      onPoll: vi.fn(),
      onFailure: vi.fn(),
      onCloseRequested: vi.fn(),
      createAcpClient,
    });
    await (loop as unknown as { prompt(id: string, trigger: string): Promise<void> }).prompt(
      'request',
      'work',
    );
    expect(execute).toHaveBeenCalledWith('authorizeRepositoryCall', { roomId: 'corner-id' });
    expect(schedule).not.toHaveBeenCalled();
    expect(createAcpClient).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      'postRoomMessage',
      expect.objectContaining({
        requestId: 'request',
        text: "I'm waiting for @moonscannerai to approve the pending host-access request, so I haven't started this corner yet.",
      }),
    );
    expect(execute).toHaveBeenCalledWith(
      'postAgentTurnReceipt',
      expect.objectContaining({ status: 'complete' }),
    );
    expect(execute).not.toHaveBeenCalledWith(
      'postAgentTurnReceipt',
      expect.objectContaining({ completionKind: 'no-reply' }),
    );
    await scheduler.dispose();
  });

  it('refreshes a non-opener reviewer to the latest stable head inside the live session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-corner-reviewer-'));
    roots.push(root);
    await execFileAsync('git', ['init', root]);
    await execFileAsync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
    await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Test']);
    await writeFile(join(root, 'reviewed.txt'), 'first head\n');
    await execFileAsync('git', ['-C', root, 'add', 'reviewed.txt']);
    await execFileAsync('git', ['-C', root, 'commit', '-m', 'first head']);
    const firstHead = (await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
    let lifecycleHead = firstHead;
    const agent = stored('11'.repeat(32), 'Echo');
    const runtime = {
      version: 2,
      communityId: 'workspace',
      pairedBy: 'human',
      agent,
      body: stored('22'.repeat(32), 'Body'),
      rooms: [],
      supervisorRoot: root,
      transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
      agentBinary: '/fake-agent',
      agentKind: 'goose',
      agentCommand: '/fake-agent',
      agentArgs: [],
      mcpBinary: '/fake-dev-mcp',
    } as unknown as AgentRuntimeRecord;
    const api = {
      execute: vi.fn(async (name: string) => {
        if (name === 'authorizeRepositoryCall' || name === 'authorizeHostCall')
          return { allowed: true };
        if (name === 'getAgentConfiguration')
          return { commands: [], yoloMode: true, reviewerHandle: 'echo' };
        if (name === 'getWorkspaceRoster')
          return {
            members: [
              {
                identityId: agent.publicKey,
                kind: 'agent',
                name: 'Echo',
                handle: 'echo',
                role: 'member',
              },
              {
                identityId: 'author-id',
                kind: 'agent',
                name: 'Bee',
                handle: 'bee',
                role: 'member',
              },
            ],
          };
        if (name === 'getCornerRestoreState')
          return {
            cornerId: 'corner-id',
            objective: 'Implement the widget',
            closeRequested: false,
            lifecycle: {
              lifecycle: 'in-review',
              checks: 'passing',
              pr: {
                number: 7,
                url: 'https://github.com/acme/widgets/pull/7',
                title: 'Widget',
                targetBranch: 'main',
                headSha: lifecycleHead,
              },
            },
          };
        if (name === 'getRoomConversation') return { items: [], cursor: 'latest' };
        if (name.startsWith('post')) return { id: 'write-id', createdAt: 1 };
        if (name === 'retractAgentLiveOutput') return { id: 'write-id', createdAt: 1 };
        throw new Error(`unexpected operation ${name}`);
      }),
      connection: () => ({
        baseUrl: 'https://server.example',
        daemonToken: 'daemon-token',
        agentId: agent.publicKey,
      }),
    } as unknown as DaemonApiClient;
    const acp = new AcpClient({ agentBinary: '/fake-agent', agentEnv: {} });
    vi.spyOn(acp, 'start').mockResolvedValue(undefined);
    vi.spyOn(acp, 'stop').mockResolvedValue(undefined);
    const sessionNew = vi
      .spyOn(acp, 'sessionNew')
      .mockResolvedValue({ sessionId: 'review-session', raw: {} });
    const loop = new MonolithCornerTurnLoop({
      cornerId: 'corner-id',
      parentRoomId: 'room-id',
      workspaceId: 'workspace',
      openedBy: 'author-id',
      objective: 'Implement the widget',
      worktreePath: root,
      repository: {
        featureBranch: 'feature/widget',
        targetBranch: 'main',
        gitCommonDir: join(root, '.git'),
        githubToken: 'room-token',
      },
      runtime,
      config: {
        agentBinary: '/fake-agent',
        agentKind: 'goose',
        agentCommand: '/fake-agent',
        agentArgs: [],
        mcpBinary: '/fake-dev-mcp',
        readonlyMcpCommand: '/fake-beeline-mcp',
        agentEnv: {},
        workspaceRoot: root,
        agentHomeRoot: join(root, 'agent-home'),
        autoApprovePermissions: true,
        codegraphCommand: '/usr/bin/false',
      },
      api,
      scheduler: new SessionScheduler({ maxLiveSessions: 1 }),
      onPoll: vi.fn(),
      onFailure: vi.fn(),
      onCloseRequested: vi.fn(async () => undefined),
      createAcpClient: () => acp,
    });

    await (loop as unknown as { activate(): Promise<string> }).activate();
    const input = sessionNew.mock.calls[0]?.[0];
    expect(input?.mcpServers.some((server) => server.name === 'codegraph')).toBe(false);
    expect(
      await (loop as unknown as { sessionIsCurrent(): Promise<boolean> }).sessionIsCurrent(),
    ).toBe(true);
    expect(input?.systemPrompt).toContain(CORNER_REVIEWER_SESSION_INSTRUCTION);
    expect(input?.systemPrompt).not.toContain(firstHead);
    expect(input?.systemPrompt).not.toContain('reply only with its full URL');
    expect(input?.mcpServers).toContainEqual(
      expect.objectContaining({
        name: 'buzz-dev-mcp',
        env: expect.arrayContaining([
          { name: 'GH_TOKEN', value: 'room-token' },
          { name: 'GITHUB_TOKEN', value: 'room-token' },
        ]),
      }),
    );
    const agentServer = input?.mcpServers.find((server) => server.name === 'beeline-agent');
    expect(agentServer?.env).toEqual(
      expect.arrayContaining([
        { name: 'BEELINE_DAEMON_CORNER_ID', value: 'corner-id' },
        { name: 'BEELINE_CORNER_AGENT_CLOSE', value: '1' },
        { name: 'BEELINE_CORNER_REVIEWER', value: '1' },
      ]),
    );
    const agentEnvironment = new Map(agentServer?.env.map(({ name, value }) => [name, value]));
    expect(
      agentToolsFor(
        agentEnvironment.get('BEELINE_MCP_SURFACE') === 'agent',
        agentEnvironment.get('BEELINE_AGENT_DM') === '1',
        Boolean(agentEnvironment.get('BEELINE_DAEMON_CORNER_ID')),
        agentEnvironment.get('BEELINE_CORNER_REVIEWER') === '1',
        Boolean(agentEnvironment.get('BEELINE_GRANT_RUNNER_URL')),
        agentEnvironment.get('BEELINE_CORNER_AGENT_CLOSE') === '1',
      ).map((tool) => tool.name),
    ).toContain('approve_merge');
    const activeInstruction = () =>
      (
        loop as unknown as {
          activeReviewerInstruction(): Promise<string | undefined>;
        }
      ).activeReviewerInstruction();
    const firstInstruction = await activeInstruction();
    expect(firstInstruction).toContain(`Checks are green on PR #7 at ${firstHead}`);
    expect(firstInstruction).toContain(`call the approve_merge tool for ${firstHead}`);
    const reviewSkill = join(root, 'agent-home', 'codex', 'skills', 'beeline-review', 'SKILL.md');
    expect(firstInstruction).toContain(reviewSkill);
    expect(await readFile(reviewSkill, 'utf8')).toContain('Read the server-assigned brief');
    await writeFile(join(root, 'reviewed.txt'), 'latest head\n');
    await execFileAsync('git', ['-C', root, 'add', 'reviewed.txt']);
    await execFileAsync('git', ['-C', root, 'commit', '-m', 'latest head']);
    const latestHead = (
      await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'])
    ).stdout.trim();
    lifecycleHead = latestHead;
    const refreshedInstruction = await activeInstruction();
    expect(refreshedInstruction).toContain(`Checks are green on PR #7 at ${latestHead}`);
    expect(refreshedInstruction).toContain(`call the approve_merge tool for ${latestHead}`);
    expect(refreshedInstruction).not.toContain(firstHead);
    lifecycleHead = firstHead;
    expect(await activeInstruction()).toBe(CORNER_REVIEWER_UNSTABLE_HEAD_INSTRUCTION);

    lifecycleHead = latestHead;
    vi.spyOn(loop as unknown as { syncBranch(): Promise<void> }, 'syncBranch').mockResolvedValue(
      undefined,
    );
    let promptRun = 0;
    let moveHeadOnPrompt = false;
    let newestHead = '';
    const sessionPrompt = vi.spyOn(acp, 'sessionPrompt').mockImplementation(async () => {
      promptRun += 1;
      if (moveHeadOnPrompt) {
        moveHeadOnPrompt = false;
        await writeFile(join(root, 'reviewed.txt'), 'newest head\n');
        await execFileAsync('git', ['-C', root, 'add', 'reviewed.txt']);
        await execFileAsync('git', ['-C', root, 'commit', '-m', 'newest head']);
        newestHead = (await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
        lifecycleHead = newestHead;
      }
      return {
        stopReason: 'end_turn',
        updates: [],
        agentText: `review pass ${promptRun}`,
        toolCalls: [],
      };
    });
    const stableTrigger = `GitHub passed a check on ${latestHead}`;
    await (
      loop as unknown as {
        prompt(
          requestId: string,
          trigger: string,
          attachments: [],
          requestedById: undefined,
          restates: string[],
        ): Promise<void>;
      }
    ).prompt('stable-review-turn', stableTrigger, [], undefined, [stableTrigger]);
    expect(sessionPrompt).toHaveBeenCalledTimes(2);
    expect(sessionPrompt.mock.calls[0]?.[1]).toContain(
      `Checks are green on PR #7 at ${latestHead}`,
    );
    expect(sessionPrompt.mock.calls[1]?.[1]).toContain(
      `Checks are green on PR #7 at ${latestHead}`,
    );
    expect(api.execute.mock.calls.filter(([name]) => name === 'postRoomMessage')[0]?.[1]).toEqual(
      expect.objectContaining({ text: 'review pass 2' }),
    );

    moveHeadOnPrompt = true;
    const trigger = `GitHub passed a check on stale head ${firstHead}`;
    await (
      loop as unknown as {
        prompt(
          requestId: string,
          trigger: string,
          attachments: [],
          requestedById: undefined,
          restates: string[],
        ): Promise<void>;
      }
    ).prompt('review-turn', trigger, [], undefined, [trigger]);
    expect(sessionPrompt).toHaveBeenCalledTimes(4);
    expect(sessionPrompt.mock.calls[2]?.[1]).toContain(
      `Checks are green on PR #7 at ${latestHead}`,
    );
    expect(sessionPrompt.mock.calls[3]?.[1]).toContain(
      `Checks are green on PR #7 at ${newestHead}`,
    );
    expect(sessionPrompt.mock.calls[3]?.[1]).not.toContain(latestHead);
    const durableReplies = api.execute.mock.calls.filter(([name]) => name === 'postRoomMessage');
    expect(durableReplies).toHaveLength(2);
    expect(durableReplies[1]?.[1]).toEqual(expect.objectContaining({ text: 'review pass 4' }));
    await (loop as unknown as { discardSession(): Promise<void> }).discardSession();
  });
});

describe('corner close-request polling cadence', () => {
  it('spreads the recovery poll with up to three seconds of jitter', () => {
    expect(cornerClosePollMs(() => 0)).toBe(CORNER_CLOSE_POLL_BASE_MS);
    expect(cornerClosePollMs(() => 0.999)).toBeGreaterThan(CORNER_CLOSE_POLL_BASE_MS);
    expect(cornerClosePollMs(() => 0.999)).toBeLessThan(CORNER_CLOSE_POLL_BASE_MS + 3_000);
    expect(cornerClosePollMs(() => 0.5)).not.toBe(cornerClosePollMs(() => 0.75));
  });

  it('runs a chat-only corner in scratch and attaches a generated file without git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-chat-corner-'));
    roots.push(root);
    const workspace = join(root, 'rooms', 'corner-id', 'scratch');
    const scratchRoot = join(workspace, 'agent-home');
    await mkdir(scratchRoot, { recursive: true });
    const runtime = {
      agentId: '11'.repeat(32),
      agent: stored('11'.repeat(32), 'Bee'),
      rooms: [],
      supervisorRoot: root,
      transport: {
        kind: 'monolith',
        baseUrl: 'https://server.example',
        daemonToken: 'daemon-token',
      },
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
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'getRoomGitHubToken') throw new Error('chat-only corner requested GitHub');
      if (name === 'getAgentConfiguration') return { commands: [] };
      if (name === 'getWorkspaceRoster') {
        return {
          members: [
            { identityId: runtime.agent.publicKey, kind: 'agent', name: 'Bee', role: 'member' },
          ],
        };
      }
      if (name === 'getRoomConversation') return { items: [], cursor: 'latest' };
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getCornerCloseRequests') {
        return { items: [], cursor: 'latest', closeRequested: true };
      }
      calls.push({ name, input });
      return { id: 'write-id', createdAt: 1 };
    });
    const api = {
      execute,
      connection: () => ({
        baseUrl: 'https://server.example',
        daemonToken: 'daemon-token',
        agentId: runtime.agent.publicKey,
      }),
    } as unknown as DaemonApiClient;
    const acp = new AcpClient({ agentBinary: '/fake-agent', agentEnv: {} });
    vi.spyOn(acp, 'start').mockResolvedValue(undefined);
    let sessionInput: Parameters<AcpClient['sessionNew']>[0] | undefined;
    vi.spyOn(acp, 'sessionNew').mockImplementation(async (input) => {
      sessionInput = input;
      return { sessionId: 'corner-session', raw: {} };
    });
    vi.spyOn(acp, 'sessionPrompt').mockImplementation(async () => {
      const agentServer = sessionInput?.mcpServers.find(
        (server) => server.name === 'beeline-agent',
      );
      const env = new Map(agentServer?.env.map((entry) => [entry.name, entry.value]));
      const generated = await writeScratchFile(
        {
          path: 'clips/demo.mp4',
          content: Buffer.from('video-bytes').toString('base64'),
          encoding: 'base64',
        },
        { root: env.get('BEELINE_ATTACH_SCRATCH_ROOT')! },
      );
      expect(generated).toContain('demo.mp4');
      await postArtifact(
        { path: 'clips/demo.mp4' },
        {
          roots: [env.get('BEELINE_ATTACH_ROOT')!, env.get('BEELINE_ATTACH_SCRATCH_ROOT')!],
          roomId: 'corner-id',
          upload: async (bytes, mime, title) => ({
            url: 'https://server.example/v1/media/clip',
            mimeType: mime,
            size: bytes.length,
            title,
          }),
          queue: async (attachment) => {
            await api.execute('postAgentAttachment', { roomId: 'corner-id', attachment });
          },
        },
      );
      return {
        stopReason: 'end_turn',
        updates: [],
        agentText: 'Attached the clip.',
        toolCalls: [],
      };
    });
    const scheduler = new SessionScheduler({ maxLiveSessions: 2 });
    const onCloseRequested = vi.fn(async () => undefined);
    await new MonolithCornerTurnLoop({
      cornerId: 'corner-id',
      parentRoomId: 'room-id',
      workspaceId: 'workspace',
      objective: 'Generate and attach a clip',
      worktreePath: workspace,
      runtime,
      config,
      api: commandFixtureApi(
        api,
        'corner-id',
        runtime.agent.publicKey,
        'Generate and attach a clip',
      ),
      scheduler,
      pollMs: 1,
      onPoll: vi.fn(),
      onFailure: vi.fn(),
      onCloseRequested,
      createAcpClient: () => acp,
    }).run();
    await scheduler.dispose();

    expect(sessionInput).toMatchObject({
      cwd: workspace,
      mode: 'edit',
      mcpServers: [expect.objectContaining({ name: 'beeline-agent' })],
      systemPrompt: expect.stringContaining('no-code corner with no repository checkout'),
    });
    expect(sessionInput?.systemPrompt).not.toContain(CORNER_AUTHOR_CONTRACT);
    expect(sessionInput?.mcpServers.some((server) => server.name === 'buzz-dev-mcp')).toBe(false);
    expect(execute).not.toHaveBeenCalledWith('getRoomGitHubToken', expect.anything());
    expect(calls).toContainEqual(
      expect.objectContaining({
        name: 'postAgentAttachment',
        input: expect.objectContaining({
          roomId: 'corner-id',
          attachment: expect.objectContaining({ name: 'demo.mp4', size: 11 }),
        }),
      }),
    );
    expect(onCloseRequested).toHaveBeenCalledOnce();
  });

  it('re-checks close requests immediately after a turn completes', async () => {
    // pollMs is far beyond the test timeout: the flow turns once, then the
    // next close-request read must happen without any idle wait — a
    // regression that waits the full interval after a turn would hang.
    const root = await mkdtemp(join(tmpdir(), 'beeline-corner-immediate-'));
    roots.push(root);
    await execFileAsync('git', ['init', root]);
    await writeFile(join(root, 'retained-agent-work.txt'), 'keep until the agent decides\n');
    const worktree = root;
    const gitCommonDir = join(root, '.git');
    const runtime = {
      agentId: '11'.repeat(32),
      agent: stored('11'.repeat(32), 'Bee'),
      rooms: [],
      supervisorRoot: root,
      transport: {
        kind: 'monolith',
        baseUrl: 'https://server.example',
        daemonToken: 'daemon-token',
      },
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
      workspaceRoot: root,
      autoApprovePermissions: true,
    };
    const abort = new AbortController();
    let closeReads = 0;
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentConfiguration') return { commands: [] };
      if (name === 'getWorkspaceRoster') {
        return {
          members: [{ identityId: '11'.repeat(32), kind: 'agent', name: 'Bee', role: 'member' }],
        };
      }
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getCornerCloseRequests') {
        closeReads += 1;
        if (closeReads === 1) {
          return {
            items: [
              {
                id: 'human-msg',
                authorId: '22'.repeat(32),
                createdAt: 1,
                type: 'message',
                body: 'Please continue',
                attachments: [],
              },
            ],
            cursor: 'human-msg',
          };
        }
        return { items: [], cursor: 'latest', closeRequested: true };
      }
      if (name === 'getRoomConversation') return { items: [], cursor: 'latest' };
      if (name === 'getRoomAuthority') return { member: true, principalKind: 'human' };
      return { id: 'write-id', createdAt: 1 };
    });
    const api = {
      execute,
      connection: () => ({
        baseUrl: 'https://server.example',
        daemonToken: 'daemon-token',
        agentId: runtime.agent.publicKey,
      }),
    } as unknown as DaemonApiClient;
    const acp = new AcpClient({ agentBinary: '/fake-agent', agentEnv: {} });
    vi.spyOn(acp, 'start').mockResolvedValue(undefined);
    vi.spyOn(acp, 'sessionNew').mockResolvedValue({ sessionId: 'corner-session', raw: {} });
    const sessionPrompt = vi
      .spyOn(acp, 'sessionPrompt')
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        updates: [],
        agentText: 'PR opened: https://github.com/acme/widgets/pull/7',
        toolCalls: [],
      })
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        updates: [],
        agentText: 'Kept retained-agent-work.txt for the next turn.',
        toolCalls: [],
      })
      .mockResolvedValue({
        stopReason: 'end_turn',
        updates: [],
        agentText: 'Done.',
        toolCalls: [],
      });
    const scheduler = new SessionScheduler({ maxLiveSessions: 2 });
    const onCloseRequested = vi.fn(async () => undefined);
    await new MonolithCornerTurnLoop({
      cornerId: 'corner-id',
      parentRoomId: 'room-id',
      workspaceId: 'workspace',
      objective: 'Implement the widget',
      worktreePath: worktree,
      repository: {
        featureBranch: 'feature/widget',
        targetBranch: 'main',
        gitCommonDir,
        githubToken: 'token',
      },
      runtime,
      config,
      api: commandFixtureApi(api, 'corner-id', runtime.agent.publicKey, 'Implement the widget'),
      scheduler,
      signal: abort.signal,
      pollMs: 60_000,
      onPoll: vi.fn(),
      onFailure: vi.fn(),
      onCloseRequested,
      createAcpClient: () => acp,
    }).run();
    await scheduler.dispose();
    expect(sessionPrompt).toHaveBeenCalledTimes(3);
    expect(sessionPrompt.mock.calls[1]?.[1]).toBe(CORNER_DELIVERY_NUDGE);
    expect(execute).toHaveBeenCalledWith(
      'postRoomMessage',
      expect.objectContaining({
        text:
          'PR opened: https://github.com/acme/widgets/pull/7\n\n' +
          'Kept retained-agent-work.txt for the next turn.',
      }),
    );
    expect(execute).not.toHaveBeenCalledWith(
      'postAgentTurnReceipt',
      expect.objectContaining({ status: 'failed' }),
    );
    expect(onCloseRequested).toHaveBeenCalledOnce();
  });

  it('keeps anonymous tool narration distinct after a provider re-pin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-corner-stream-'));
    roots.push(root);
    await execFileAsync('git', ['init', root]);
    const runtime = {
      agentId: '11'.repeat(32),
      agent: stored('11'.repeat(32), 'Bee'),
      rooms: [],
      supervisorRoot: root,
      transport: {
        kind: 'monolith',
        baseUrl: 'https://server.example',
        daemonToken: 'daemon-token',
      },
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
      workspaceRoot: root,
      autoApprovePermissions: true,
    };
    const abort = new AbortController();
    let inboxReads = 0;
    let activityWrites = 0;
    const activityAttempts: Record<string, unknown>[] = [];
    const writes: Array<{ name: string; input: Record<string, unknown> }> = [];
    const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'getAgentConfiguration') return { commands: [] };
      if (name === 'getWorkspaceRoster') {
        return {
          members: [{ identityId: '11'.repeat(32), kind: 'agent', name: 'Bee', role: 'member' }],
        };
      }
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getCornerCloseRequests') {
        inboxReads += 1;
        if (inboxReads === 1) {
          return {
            items: [
              {
                id: 'human-msg',
                authorId: '22'.repeat(32),
                createdAt: 1,
                type: 'message',
                body: 'Please continue',
                attachments: [],
              },
            ],
            cursor: 'human-msg',
          };
        }
        return { items: [], cursor: 'latest', closeRequested: true };
      }
      if (name === 'getRoomConversation') {
        return {
          items: [{ type: 'message', authorId: runtime.agent.publicKey, body: 'Already working.' }],
          cursor: 'latest',
        };
      }
      if (name === 'getRoomAuthority') return { member: true, principalKind: 'human' };
      if (name === 'postAgentActivity') {
        activityAttempts.push(input);
        if (++activityWrites === 1) throw new Error('temporary activity failure');
      }
      writes.push({ name, input });
      return { id: 'write-id', createdAt: 1 };
    });
    const api = {
      execute,
      connection: () => ({
        baseUrl: 'https://server.example',
        daemonToken: 'daemon-token',
        agentId: runtime.agent.publicKey,
      }),
    } as unknown as DaemonApiClient;
    const acp = new AcpClient({ agentBinary: '/fake-agent', agentEnv: {} });
    vi.spyOn(acp, 'start').mockResolvedValue(undefined);
    vi.spyOn(acp, 'sessionNew').mockResolvedValue({ sessionId: 'corner-session', raw: {} });
    let promptCalls = 0;
    vi.spyOn(acp, 'sessionPrompt').mockImplementation(
      async (_id, _prompt, _timeout, draft, _activity, toolActivity) => {
        promptCalls += 1;
        if (promptCalls === 1) {
          draft?.('Inspecting', 'Inspecting');
          toolActivity?.([
            {
              kind: 'read',
              title: 'Read first provider',
              rawInput: { path: 'first.json' },
              status: 'in_progress',
            },
          ]);
          draft?.(' while waiting.', 'Inspecting while waiting.');
          toolActivity?.([
            {
              kind: 'read',
              title: 'Read first provider',
              rawInput: { path: 'first.json' },
              status: 'in_progress',
              resultReceived: true,
              content: 'first provider contents',
            },
          ]);
          return {
            stopReason: 'end_turn',
            updates: [],
            agentText: '',
            toolCalls: [
              {
                kind: 'read',
                title: 'Read first provider',
                rawInput: { path: 'first.json' },
                status: 'in_progress',
                resultReceived: true,
                content: 'first provider contents',
              },
            ],
          };
        }
        // The reported shape: prose, a tool call, then the closing prose. The
        // ACP delta hook is handed EVERY assistant run joined, while the result
        // carries only the LAST run — two different strings.
        draft?.('I inspected', 'I inspected');
        draft?.(' the code.', 'I inspected the code.');
        toolActivity?.([
          {
            kind: 'read',
            title: 'Read package.json',
            rawInput: { path: 'package.json' },
            status: 'in_progress',
          },
        ]);
        toolActivity?.([
          {
            kind: 'read',
            title: 'Read package.json',
            rawInput: { path: 'package.json' },
            status: 'in_progress',
            resultReceived: true,
            content: 'package contents',
          },
        ]);
        draft?.('The fix', 'I inspected the code.\n\nThe fix');
        draft?.(' is ready.', 'I inspected the code.\n\nThe fix is ready.');
        return {
          stopReason: 'end_turn',
          updates: [],
          agentText: 'The fix is ready.',
          toolCalls: [
            {
              kind: 'read',
              title: 'Read package.json',
              rawInput: { path: 'package.json' },
              status: 'in_progress',
              resultReceived: true,
              content: 'package contents',
            },
          ],
        };
      },
    );
    const scheduler = new SessionScheduler({ maxLiveSessions: 2 });
    const loop = new MonolithCornerTurnLoop({
      cornerId: 'corner-id',
      parentRoomId: 'room-id',
      workspaceId: 'workspace',
      objective: 'Implement the widget',
      worktreePath: root,
      repository: {
        featureBranch: 'feature/widget',
        targetBranch: 'main',
        gitCommonDir: join(root, '.git'),
        githubToken: 'token',
      },
      runtime,
      config,
      api: commandFixtureApi(api, 'corner-id', runtime.agent.publicKey, null),
      scheduler,
      signal: abort.signal,
      pollMs: 60_000,
      onPoll: vi.fn(),
      onFailure: vi.fn(),
      onCloseRequested: vi.fn(async () => undefined),
      createAcpClient: () => acp,
    });
    (loop as unknown as { pinnedProviders: string[] }).pinnedProviders = ['first', 'second'];
    await loop.run();
    await scheduler.dispose();

    expect(promptCalls).toBe(2);
    const posts = writes.filter((write) => write.name === 'postRoomMessage');
    expect(activityWrites).toBe(3);
    expect(activityAttempts).toHaveLength(3);
    expect(activityAttempts[1]).toEqual(activityAttempts[0]);
    expect(activityAttempts[0]?.cornerActivityKey).toBe('1:tool-0');
    expect(activityAttempts[2]?.cornerActivityKey).toBe('2:tool-0');
    // The closing message lands WHOLE and under the turn's request id, so it
    // settles the receipt. Nothing is cut by a stream offset.
    expect(posts[0]).toEqual(
      expect.objectContaining({
        input: expect.objectContaining({
          roomId: 'corner-id',
          requestId: 'human-msg',
          text: 'The fix is ready.',
          presentation: 'message',
        }),
      }),
    );
    for (const post of posts) expect(post.input.requestId).toEqual(expect.any(String));
    expect(posts.filter((post) => post.input.text === 'I inspected the code.')).toEqual([]);
    expect(writes.filter((write) => write.name === 'postAgentActivity')).toEqual([
      expect.objectContaining({
        input: expect.objectContaining({
          roomId: 'corner-id',
          requestId: 'human-msg',
          cornerActivityKey: '1:tool-0',
          activity: [
            {
              kind: 'output',
              title: 'Update',
              text: 'Inspecting',
              requestedBy: { pubkey: '22'.repeat(32) },
            },
            expect.objectContaining({
              kind: 'tool',
              operation: 'read',
              title: 'Read first provider',
            }),
          ],
        }),
      }),
      expect.objectContaining({
        input: expect.objectContaining({
          roomId: 'corner-id',
          requestId: 'human-msg',
          cornerActivityKey: '2:tool-0',
          activity: [
            {
              kind: 'output',
              title: 'Update',
              text: 'I inspected the code.',
              requestedBy: { pubkey: '22'.repeat(32) },
            },
            expect.objectContaining({
              kind: 'tool',
              operation: 'read',
              title: 'Read package.json',
            }),
          ],
        }),
      }),
    ]);
    // The pre-tool prose was shown provisionally on the draft lane, keyed by
    // the same request id so the durable reply settles it (#903). The lane
    // carries one write at a time and only the newest waiting snapshot, so a
    // burst of four deltas the wire could not keep up with reaches the reader
    // as its first frame and its newest one — forward, never backwards.
    const draftTexts = writes
      .filter((write) => write.name === 'postAgentDraft')
      .map((write) => write.input.text);
    expect(draftTexts).toContain('Inspecting');
    // The lane ends on the unsaved tail: `I inspected the code.` is the Update
    // row asserted above, so the draft gives it up and shows the rest alone.
    expect(draftTexts.at(-1)).toBe('The fix is ready.');
    for (const draft of writes.filter((write) => write.name === 'postAgentDraft')) {
      expect(draft.input.turnId).toBe('human-msg');
    }
    expect(writes).toContainEqual(
      expect.objectContaining({
        name: 'retractAgentLiveOutput',
        input: expect.objectContaining({ turnId: 'human-msg', kind: 'draft' }),
      }),
    );
  });

  async function cornerHarness(
    execute: ReturnType<typeof vi.fn>,
    pollMs: number,
    liveSubscribe?: DaemonApiClient['liveSubscribe'],
    closePollMs?: number,
  ) {
    const root = await mkdtemp(join(tmpdir(), 'beeline-corner-wake-'));
    roots.push(root);
    await execFileAsync('git', ['init', root]);
    const runtime = {
      agentId: '11'.repeat(32),
      agent: stored('11'.repeat(32), 'Bee'),
      rooms: [],
      supervisorRoot: root,
      transport: {
        kind: 'monolith',
        baseUrl: 'https://server.example',
        daemonToken: 'daemon-token',
      },
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
      workspaceRoot: root,
      autoApprovePermissions: true,
    };
    const api = {
      execute,
      connection: () => ({
        baseUrl: 'https://server.example',
        daemonToken: 'daemon-token',
        agentId: runtime.agent.publicKey,
      }),
      ...(liveSubscribe ? { liveSubscribe } : {}),
    } as unknown as DaemonApiClient;
    const acp = new AcpClient({ agentBinary: '/fake-agent', agentEnv: {} });
    vi.spyOn(acp, 'start').mockResolvedValue(undefined);
    vi.spyOn(acp, 'sessionNew').mockResolvedValue({ sessionId: 'corner-session', raw: {} });
    vi.spyOn(acp, 'sessionPrompt').mockResolvedValue({
      stopReason: 'end_turn',
      updates: [],
      agentText: 'Done.',
      toolCalls: [],
    });
    const scheduler = new SessionScheduler({ maxLiveSessions: 2 });
    const abort = new AbortController();
    const onPoll = vi.fn();
    return {
      acp,
      abort,
      onPoll,
      root,
      loop: new MonolithCornerTurnLoop({
        cornerId: 'corner-id',
        parentRoomId: 'room-id',
        workspaceId: 'workspace',
        objective: 'Implement the widget',
        worktreePath: root,
        repository: {
          featureBranch: 'feature/widget',
          targetBranch: 'main',
          gitCommonDir: join(root, '.git'),
          githubToken: 'token',
        },
        runtime,
        config,
        api: commandFixtureApi(api, 'corner-id', runtime.agent.publicKey, null),
        scheduler,
        signal: abort.signal,
        pollMs,
        ...(closePollMs !== undefined ? { closePollMs } : {}),
        onPoll,
        onFailure: vi.fn(),
        onCloseRequested: async () => undefined,
        createAcpClient: () => acp,
      }),
      scheduler,
    };
  }

  it('publishes a settled tool call before a still-running sibling call completes', async () => {
    let closeReads = 0;
    let selectedModel = 'grok-4-fast';
    const writes: Array<{ name: string; input: Record<string, unknown> }> = [];
    const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'getAgentConfiguration') return { commands: [], model: selectedModel };
      if (name === 'getWorkspaceRoster') {
        return {
          members: [{ identityId: '11'.repeat(32), kind: 'agent', name: 'Bee', role: 'member' }],
        };
      }
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getCornerCloseRequests') {
        closeReads += 1;
        if (closeReads === 1) {
          return {
            items: [
              {
                id: 'human-msg',
                authorId: '22'.repeat(32),
                createdAt: 1,
                type: 'message',
                body: 'Please continue',
                attachments: [],
              },
            ],
            cursor: 'human-msg',
          };
        }
        return { items: [], cursor: 'latest', closeRequested: true };
      }
      if (name === 'getRoomConversation') return { items: [], cursor: 'latest' };
      if (name === 'getRoomAuthority') return { member: true, principalKind: 'human' };
      writes.push({ name, input });
      return { id: 'write-id', createdAt: 1 };
    });
    const { acp, loop, scheduler } = await cornerHarness(execute, 60_000);
    const activityTitleAt = (): string[] =>
      writes
        .filter((write) => write.name === 'postAgentActivity')
        .flatMap((write) =>
          (write.input.activity as Array<{ title?: string }>).map((activity) => activity.title),
        );
    let titlesWhileSlowCallStillRunning: string[] = [];
    vi.spyOn(acp, 'sessionPrompt').mockImplementation(
      async (_id, _prompt, _timeout, draft, _activity, toolActivity) => {
        // Tool call A: issued and completes immediately.
        const fast = {
          kind: 'execute' as const,
          title: 'Run fast check',
          rawInput: { command: 'echo fast' },
          status: 'in_progress' as const,
        };
        toolActivity?.([fast]);
        // The saved setting changes while this ACP session still runs its old model.
        selectedModel = 'newer-model';
        const settledFast = { ...fast, status: 'completed' as const };
        toolActivity?.([settledFast]);
        // Let the corner turn's async activity-publish chain settle before the
        // long-running sibling call (B) even starts, so a production 6-minute
        // second tool call cannot be what makes A's row appear.
        await new Promise<void>((resolve) => setImmediate(resolve));
        titlesWhileSlowCallStillRunning = activityTitleAt();
        // Tool call B: still running (never settled until here).
        const slow = {
          kind: 'execute' as const,
          title: 'Run slow test suite',
          rawInput: { command: 'vitest run' },
          status: 'in_progress' as const,
        };
        toolActivity?.([slow]);
        const settledSlow = { ...slow, status: 'completed' as const };
        toolActivity?.([settledSlow]);
        return {
          stopReason: 'end_turn',
          updates: [],
          agentText: 'Done.',
          toolCalls: [settledFast, settledSlow],
        };
      },
    );
    await loop.run();
    await scheduler.dispose();

    // The failing-test behavior this reproduces: A's activity row was batched
    // with B's and posted only after the whole turn (and B) finished, so
    // `titlesWhileSlowCallStillRunning` came back empty here.
    expect(titlesWhileSlowCallStillRunning).toContain('Run fast check');
    expect(titlesWhileSlowCallStillRunning).not.toContain('Run slow test suite');
    expect(activityTitleAt()).toEqual(
      expect.arrayContaining(['Run fast check', 'Run slow test suite']),
    );
    expect(writes.filter((write) => write.name === 'postAgentActivity')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ input: expect.objectContaining({ agentModel: 'grok-4-fast' }) }),
      ]),
    );
    expect(
      writes
        .filter((write) => write.name === 'postAgentActivity')
        .every((write) => write.input.agentModel === 'grok-4-fast'),
    ).toBe(true);
  });

  it('keeps a tool-only narration in the final reply once', async () => {
    let closeReads = 0;
    const writes: Array<{ name: string; input: Record<string, unknown> }> = [];
    const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'getAgentConfiguration') return { commands: [] };
      if (name === 'getWorkspaceRoster') {
        return {
          members: [{ identityId: '11'.repeat(32), kind: 'agent', name: 'Bee', role: 'member' }],
        };
      }
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getCornerCloseRequests') {
        closeReads += 1;
        if (closeReads === 1) {
          return {
            items: [
              {
                id: 'human-msg',
                authorId: '22'.repeat(32),
                createdAt: 1,
                type: 'message',
                body: 'Please continue',
                attachments: [],
              },
            ],
            cursor: 'human-msg',
          };
        }
        return { items: [], cursor: 'latest', closeRequested: true };
      }
      if (name === 'getRoomConversation') {
        return {
          items: [
            {
              type: 'message',
              authorId: stored('11'.repeat(32), 'Bee').publicKey,
              body: 'Already working.',
            },
          ],
          cursor: 'latest',
        };
      }
      if (name === 'getRoomAuthority') return { member: true, principalKind: 'human' };
      writes.push({ name, input });
      return { id: 'write-id', createdAt: 1 };
    });
    const { acp, loop, scheduler } = await cornerHarness(execute, 60_000);
    vi.spyOn(acp, 'sessionPrompt').mockImplementation(
      async (_id, _prompt, _timeout, draft, _activity, toolActivity) => {
        draft?.('Inspecting', 'Inspecting');
        toolActivity?.([
          {
            kind: 'read',
            title: 'Read package.json',
            rawInput: { path: 'package.json' },
            status: 'in_progress',
          },
        ]);
        const tool = {
          kind: 'read' as const,
          title: 'Read package.json',
          rawInput: { path: 'package.json' },
          status: 'completed' as const,
        };
        toolActivity?.([tool]);
        return { stopReason: 'end_turn', updates: [], agentText: 'Inspecting', toolCalls: [tool] };
      },
    );
    await loop.run();
    await scheduler.dispose();

    const durableTexts = [
      ...writes
        .filter((write) => write.name === 'postAgentActivity')
        .flatMap((write) =>
          (write.input.activity as Array<{ kind: string; text?: string }>)
            .filter((activity) => activity.kind === 'output')
            .map((activity) => activity.text),
        ),
      ...writes
        .filter((write) => write.name === 'postRoomMessage')
        .map((write) => write.input.text),
    ];
    expect(durableTexts).toEqual(['Inspecting']);
    expect(writes.filter((write) => write.name === 'postAgentActivity')).toEqual([
      expect.objectContaining({
        input: expect.objectContaining({
          activity: [expect.objectContaining({ kind: 'tool', title: 'Read package.json' })],
        }),
      }),
    ]);
  });

  it('drafts only the unsaved tail and settles the remainder past the saved narration', async () => {
    // Reproduction C100-OFFSET. The turn speaks, a tool settles that prose
    // into the work ledger, then the SAME assistant run keeps writing. Without
    // a persisted stream offset the draft keeps showing the saved sentence and
    // the durable reply carries it a second time, directly under the ledger
    // row the reader is already looking at.
    let closeReads = 0;
    const writes: Array<{ name: string; input: Record<string, unknown> }> = [];
    const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'getAgentConfiguration') return { commands: [] };
      if (name === 'getWorkspaceRoster') {
        return {
          members: [{ identityId: '11'.repeat(32), kind: 'agent', name: 'Bee', role: 'member' }],
        };
      }
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getCornerCloseRequests') {
        closeReads += 1;
        if (closeReads === 1) {
          return {
            items: [
              {
                id: 'human-msg',
                authorId: '22'.repeat(32),
                createdAt: 1,
                type: 'message',
                body: 'Please continue',
                attachments: [],
              },
            ],
            cursor: 'human-msg',
          };
        }
        return { items: [], cursor: 'latest', closeRequested: true };
      }
      if (name === 'getRoomConversation') return { items: [], cursor: 'latest' };
      if (name === 'getRoomAuthority') return { member: true, principalKind: 'human' };
      writes.push({ name, input });
      return { id: 'write-id', createdAt: 1 };
    });
    const { acp, loop, scheduler } = await cornerHarness(execute, 60_000);
    const FIRST = 'I read the ledger.';
    const SECOND = 'Every row lines up.';
    const CLOSING = 'Nothing needs changing.';
    const read = (title: string, path: string) => ({
      kind: 'read' as const,
      title,
      rawInput: { path },
      status: 'completed' as const,
    });
    const first = read('Read package.json', 'package.json');
    const second = read('Read turbo.json', 'turbo.json');
    /** Wait for the activity write that moves the offset to actually land. */
    const saved = async (count: number) => {
      for (let tick = 0; tick < 200; tick += 1) {
        const landed = writes.filter((write) => write.name === 'postAgentActivity').length;
        if (landed >= count) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    vi.spyOn(acp, 'sessionPrompt').mockImplementation(
      async (_id, _prompt, _timeout, draft, _activity, toolActivity) => {
        draft?.(FIRST, FIRST, FIRST);
        toolActivity?.([first]);
        // A second call is what releases the first one's narration to the
        // ledger; until then the loop holds it back for the final-reply dedupe.
        draft?.(SECOND, `${FIRST}\n\n${SECOND}`, SECOND);
        toolActivity?.([first, second]);
        await saved(1);
        // The run that will BE the answer carries on past the sentence the
        // ledger just took from it — the seam the retired offset mangled.
        draft?.(` ${CLOSING}`, `${FIRST}\n\n${SECOND} ${CLOSING}`, `${SECOND} ${CLOSING}`);
        return {
          stopReason: 'end_turn',
          updates: [],
          agentText: `${SECOND} ${CLOSING}`,
          toolCalls: [first, second],
        };
      },
    );
    await loop.run();
    await scheduler.dispose();

    const drafts = writes
      .filter((write) => write.name === 'postAgentDraft')
      .map((write) => write.input.text);
    const ledger = writes
      .filter((write) => write.name === 'postAgentActivity')
      .flatMap((write) =>
        (write.input.activity as Array<{ kind: string; text?: string }>)
          .filter((activity) => activity.kind === 'output')
          .map((activity) => activity.text),
      );
    const replies = writes
      .filter((write) => write.name === 'postRoomMessage')
      .map((write) => write.input.text);

    expect(ledger).toEqual([FIRST, SECOND]);
    // What the reader watches, frame by frame: the stream grows, and each time
    // a sentence reaches the ledger the draft gives it up on the spot rather
    // than waiting for the next delta to stop repeating it.
    expect(drafts).toEqual([
      FIRST, //                   nothing saved yet
      `${FIRST}\n\n${SECOND}`, // still nothing saved
      SECOND, //                  FIRST reached the ledger
      `${SECOND} ${CLOSING}`, //  the closing run carries on
      CLOSING, //                 SECOND reached the ledger
    ]);
    // No draft published after a save repeats what that save took.
    expect(drafts.slice(drafts.indexOf(SECOND)).join('\n')).not.toContain(FIRST);
    // And the reply is the remainder: the offset reached INTO the closing run,
    // so the sentence the ledger took from it is gone and the rest survives.
    expect(replies).toEqual([CLOSING]);
    // The whole point: every sentence the turn wrote, in exactly one place.
    for (const text of [FIRST, SECOND, CLOSING]) {
      expect([...ledger, ...replies].filter((row) => row?.includes(text))).toHaveLength(1);
    }
  });

  it('does not reply with narration saved by a timed-out attempt of the same request', async () => {
    // Reproduction: the first attempt saved this output beside a tool, then
    // timed out. The resumed command keeps its request id and says it again.
    const narration = 'I checked the release path.';
    let closeReads = 0;
    const writes: Array<{ name: string; input: Record<string, unknown> }> = [];
    const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'getAgentConfiguration') return { commands: [] };
      if (name === 'getWorkspaceRoster') return { members: [] };
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getCornerCloseRequests') {
        closeReads += 1;
        return closeReads === 1
          ? {
              items: [
                {
                  id: 'human-msg',
                  authorId: '22'.repeat(32),
                  createdAt: 1,
                  type: 'message',
                  body: 'Continue',
                  attachments: [],
                },
              ],
              cursor: 'human-msg',
            }
          : { items: [], cursor: 'latest', closeRequested: true };
      }
      if (name === 'getRoomConversation') {
        expect(input.narrationRequestId).toBe('human-msg');
        return { items: [], cursor: 'latest', savedNarration: [narration] };
      }
      if (name === 'getRoomAuthority') return { member: true, principalKind: 'human' };
      writes.push({ name, input });
      return { id: 'write-id', createdAt: 1 };
    });
    const { acp, loop, scheduler } = await cornerHarness(execute, 60_000);
    vi.spyOn(acp, 'sessionPrompt').mockImplementation(async (_id, _prompt, _timeout, draft) => {
      draft?.(narration, narration, narration);
      return { stopReason: 'end_turn', updates: [], agentText: narration, toolCalls: [] };
    });
    await loop.run();
    await scheduler.dispose();

    expect(writes.some((write) => write.name === 'postRoomMessage')).toBe(false);
    expect(writes).toContainEqual(
      expect.objectContaining({
        name: 'postAgentTurnReceipt',
        input: expect.objectContaining({ status: 'complete', completionKind: 'no-reply' }),
      }),
    );
  });

  it('does not publish an unfinished corner tool as successful activity', async () => {
    let closeReads = 0;
    const writes: Array<{ name: string; input: Record<string, unknown> }> = [];
    const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'getAgentConfiguration') return { commands: [] };
      if (name === 'getWorkspaceRoster') {
        return {
          members: [{ identityId: '11'.repeat(32), kind: 'agent', name: 'Bee', role: 'member' }],
        };
      }
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getCornerCloseRequests') {
        closeReads += 1;
        if (closeReads === 1) {
          return {
            items: [
              {
                id: 'human-msg',
                authorId: '22'.repeat(32),
                createdAt: 1,
                type: 'message',
                body: 'Please continue',
                attachments: [],
              },
            ],
            cursor: 'human-msg',
          };
        }
        return { items: [], cursor: 'latest', closeRequested: true };
      }
      if (name === 'getRoomConversation') return { items: [], cursor: 'latest' };
      if (name === 'getRoomAuthority') return { member: true, principalKind: 'human' };
      writes.push({ name, input });
      return { id: 'write-id', createdAt: 1 };
    });
    const { acp, loop, scheduler } = await cornerHarness(execute, 60_000);
    vi.spyOn(acp, 'sessionPrompt').mockImplementation(
      async (_id, _prompt, _timeout, draft, _activity, toolActivity) => {
        draft?.('Inspecting', 'Inspecting');
        const tool = {
          kind: 'read' as const,
          title: 'Read package.json',
          rawInput: { path: 'package.json' },
          status: 'in_progress' as const,
        };
        toolActivity?.([tool]);
        return { stopReason: 'end_turn', updates: [], agentText: 'Done.', toolCalls: [tool] };
      },
    );
    await loop.run();
    await scheduler.dispose();

    expect(writes.filter((write) => write.name === 'postAgentActivity')).toEqual([]);
    expect(writes).toContainEqual(
      expect.objectContaining({
        name: 'postRoomMessage',
        input: expect.objectContaining({ text: 'Done.' }),
      }),
    );
  });

  it('does not persist pure harness retry narration', async () => {
    let closeReads = 0;
    const writes: Array<{ name: string; input: Record<string, unknown> }> = [];
    const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'getAgentConfiguration') return { commands: [] };
      if (name === 'getWorkspaceRoster') {
        return {
          members: [{ identityId: '11'.repeat(32), kind: 'agent', name: 'Bee', role: 'member' }],
        };
      }
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getCornerCloseRequests') {
        closeReads += 1;
        if (closeReads === 1) {
          return {
            items: [
              {
                id: 'human-msg',
                authorId: '22'.repeat(32),
                createdAt: 1,
                type: 'message',
                body: 'Please continue',
                attachments: [],
              },
            ],
            cursor: 'human-msg',
          };
        }
        return { items: [], cursor: 'latest', closeRequested: true };
      }
      if (name === 'getRoomConversation') {
        return {
          items: [
            {
              type: 'message',
              authorId: stored('11'.repeat(32), 'Bee').publicKey,
              body: 'Already working.',
            },
          ],
          cursor: 'latest',
        };
      }
      if (name === 'getRoomAuthority') return { member: true, principalKind: 'human' };
      writes.push({ name, input });
      return { id: 'write-id', createdAt: 1 };
    });
    const { acp, loop, scheduler } = await cornerHarness(execute, 60_000);
    vi.spyOn(acp, 'sessionPrompt').mockImplementation(
      async (_id, _prompt, _timeout, draft, _activity, toolActivity) => {
        draft?.('Retrying (attempt 1/3, waiting 2s)...', 'Retrying (attempt 1/3, waiting 2s)...');
        toolActivity?.([
          {
            kind: 'read',
            title: 'Read package.json',
            rawInput: { path: 'package.json' },
            status: 'in_progress',
          },
        ]);
        const tool = {
          kind: 'read' as const,
          title: 'Read package.json',
          rawInput: { path: 'package.json' },
          status: 'completed' as const,
        };
        toolActivity?.([tool]);
        return { stopReason: 'end_turn', updates: [], agentText: 'Done.', toolCalls: [tool] };
      },
    );
    await loop.run();
    await scheduler.dispose();

    expect(writes.filter((write) => write.name === 'postAgentActivity')).toEqual([
      expect.objectContaining({
        input: expect.objectContaining({
          activity: [expect.objectContaining({ kind: 'tool', title: 'Read package.json' })],
        }),
      }),
    ]);
  });

  it('replays a committed corner activity with its original git metadata', async () => {
    let closeReads = 0;
    let activityWrites = 0;
    const activityAttempts: Record<string, unknown>[] = [];
    let root = '';
    const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'getAgentConfiguration') return { commands: [] };
      if (name === 'getWorkspaceRoster') {
        return {
          members: [{ identityId: '11'.repeat(32), kind: 'agent', name: 'Bee', role: 'member' }],
        };
      }
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getCornerCloseRequests') {
        closeReads += 1;
        if (closeReads === 1) {
          return {
            items: [
              {
                id: 'human-msg',
                authorId: '22'.repeat(32),
                createdAt: 1,
                type: 'message',
                body: 'Please continue',
                attachments: [],
              },
            ],
            cursor: 'human-msg',
          };
        }
        return { items: [], cursor: 'latest', closeRequested: true };
      }
      if (name === 'getRoomConversation') return { items: [], cursor: 'latest' };
      if (name === 'getRoomAuthority') return { member: true, principalKind: 'human' };
      if (name === 'postAgentActivity') {
        activityAttempts.push(input);
        if (++activityWrites === 1) {
          await writeFile(join(root, 'second.txt'), 'second\n');
          await execFileAsync('git', ['-C', root, 'add', 'second.txt']);
          await execFileAsync('git', ['-C', root, 'commit', '-m', 'Second commit']);
          throw new Error('activity response lost');
        }
      }
      return { id: 'write-id', createdAt: 1 };
    });
    const harness = await cornerHarness(execute, 60_000);
    root = harness.root;
    await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Bee']);
    await execFileAsync('git', ['-C', root, 'config', 'user.email', 'bee@example.test']);
    await writeFile(join(root, 'first.txt'), 'first\n');
    await execFileAsync('git', ['-C', root, 'add', 'first.txt']);
    await execFileAsync('git', ['-C', root, 'commit', '-m', 'First commit']);
    vi.spyOn(harness.acp, 'sessionPrompt').mockImplementation(
      async (_id, _prompt, _timeout, draft, _activity, toolActivity) => {
        draft?.('Inspecting', 'Inspecting');
        toolActivity?.([
          {
            kind: 'execute',
            title: 'Run git commit',
            rawInput: { command: 'git commit -m "First commit"' },
            status: 'in_progress',
          },
        ]);
        const tool = {
          kind: 'execute' as const,
          title: 'Run git commit',
          rawInput: { command: 'git commit -m "First commit"' },
          status: 'completed' as const,
        };
        toolActivity?.([tool]);
        return { stopReason: 'end_turn', updates: [], agentText: 'Done.', toolCalls: [tool] };
      },
    );
    await harness.loop.run();
    await harness.scheduler.dispose();

    const retries = activityAttempts.filter((activity) => activity.requestId === 'human-msg');
    expect(retries.length).toBeGreaterThanOrEqual(2);
    for (const activity of retries.slice(1)) expect(activity).toEqual(retries[0]);
    expect(retries[0]).toMatchObject({
      activity: [
        expect.objectContaining({ kind: 'output', text: 'Inspecting' }),
        expect.objectContaining({ title: 'committed 1 files: First commit' }),
      ],
    });
  });

  it('persists a long-ID corner tool within the activity key limit', async () => {
    let closeReads = 0;
    const persisted: Record<string, unknown>[] = [];
    const longToolId = 'tool-'.padEnd(500, 'x');
    const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'getAgentConfiguration') return { commands: [] };
      if (name === 'getWorkspaceRoster') {
        return {
          members: [{ identityId: '11'.repeat(32), kind: 'agent', name: 'Bee', role: 'member' }],
        };
      }
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getCornerCloseRequests') {
        closeReads += 1;
        if (closeReads === 1) {
          return {
            items: [
              {
                id: 'human-msg',
                authorId: '22'.repeat(32),
                createdAt: 1,
                type: 'message',
                body: 'Please continue',
                attachments: [],
              },
            ],
            cursor: 'human-msg',
          };
        }
        return { items: [], cursor: 'latest', closeRequested: true };
      }
      if (name === 'getRoomConversation') return { items: [], cursor: 'latest' };
      if (name === 'getRoomAuthority') return { member: true, principalKind: 'human' };
      if (name === 'postAgentActivity') {
        if (String(input.cornerActivityKey).length > 200) {
          throw new Error('corner activity key exceeds 200 characters');
        }
        persisted.push(input);
      }
      return { id: 'write-id', createdAt: 1 };
    });
    const { acp, loop, scheduler } = await cornerHarness(execute, 60_000);
    vi.spyOn(acp, 'sessionPrompt').mockImplementation(
      async (_id, _prompt, _timeout, draft, _activity, toolActivity) => {
        draft?.('Inspecting', 'Inspecting');
        toolActivity?.([
          {
            id: longToolId,
            kind: 'read',
            title: 'Read package.json',
            rawInput: { path: 'package.json' },
            status: 'in_progress',
          },
        ]);
        const tool = {
          id: longToolId,
          kind: 'read' as const,
          title: 'Read package.json',
          rawInput: { path: 'package.json' },
          status: 'completed' as const,
        };
        toolActivity?.([tool]);
        return { stopReason: 'end_turn', updates: [], agentText: 'Done.', toolCalls: [tool] };
      },
    );
    await loop.run();
    await scheduler.dispose();

    const activities = persisted.filter((activity) => activity.requestId === 'human-msg');
    expect(activities).toEqual([
      expect.objectContaining({
        cornerActivityKey: expect.stringMatching(/^1:id-[a-f0-9]{64}$/),
        activity: [
          expect.objectContaining({ kind: 'output', text: 'Inspecting' }),
          expect.objectContaining({ kind: 'tool', title: 'Read package.json' }),
        ],
      }),
    ]);
  });

  it('persists ordered assistant runs before a corner tool', async () => {
    let closeReads = 0;
    const writes: Array<{ name: string; input: Record<string, unknown> }> = [];
    const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'getAgentConfiguration') return { commands: [] };
      if (name === 'getWorkspaceRoster') {
        return {
          members: [{ identityId: '11'.repeat(32), kind: 'agent', name: 'Bee', role: 'member' }],
        };
      }
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getCornerCloseRequests') {
        closeReads += 1;
        if (closeReads === 1) {
          return {
            items: [
              {
                id: 'human-msg',
                authorId: '22'.repeat(32),
                createdAt: 1,
                type: 'message',
                body: 'Please continue',
                attachments: [],
              },
            ],
            cursor: 'human-msg',
          };
        }
        return { items: [], cursor: 'latest', closeRequested: true };
      }
      if (name === 'getRoomConversation') return { items: [], cursor: 'latest' };
      if (name === 'getRoomAuthority') return { member: true, principalKind: 'human' };
      writes.push({ name, input });
      return { id: 'write-id', createdAt: 1 };
    });
    const { acp, loop, scheduler } = await cornerHarness(execute, 60_000);
    vi.spyOn(acp, 'sessionPrompt').mockImplementation(
      async (_id, _prompt, _timeout, draft, _activity, toolActivity) => {
        draft?.('First', 'First', 'First', ['First']);
        draft?.('Second', 'First\n\nSecond', 'Second', ['First', 'Second']);
        toolActivity?.([
          {
            kind: 'read',
            title: 'Read package.json',
            rawInput: { path: 'package.json' },
            status: 'in_progress',
          },
        ]);
        const tool = {
          kind: 'read' as const,
          title: 'Read package.json',
          rawInput: { path: 'package.json' },
          status: 'completed' as const,
        };
        toolActivity?.([tool]);
        return { stopReason: 'end_turn', updates: [], agentText: 'Done.', toolCalls: [tool] };
      },
    );
    await loop.run();
    await scheduler.dispose();

    expect(writes).toContainEqual(
      expect.objectContaining({
        name: 'postAgentActivity',
        input: expect.objectContaining({
          activity: [
            expect.objectContaining({ kind: 'output', text: 'First\n\nSecond' }),
            expect.objectContaining({ kind: 'tool', title: 'Read package.json' }),
          ],
        }),
      }),
    );
    expect(writes).toContainEqual(
      expect.objectContaining({
        name: 'postRoomMessage',
        input: expect.objectContaining({ text: 'Done.' }),
      }),
    );
  });

  it('keeps a whitespace-terminated narration separate from the final corner reply', async () => {
    let closeReads = 0;
    const writes: Array<{ name: string; input: Record<string, unknown> }> = [];
    const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'getAgentConfiguration') return { commands: [] };
      if (name === 'getWorkspaceRoster') {
        return {
          members: [{ identityId: '11'.repeat(32), kind: 'agent', name: 'Bee', role: 'member' }],
        };
      }
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getCornerCloseRequests') {
        closeReads += 1;
        if (closeReads === 1) {
          return {
            items: [
              {
                id: 'human-msg',
                authorId: '22'.repeat(32),
                createdAt: 1,
                type: 'message',
                body: 'Please continue',
                attachments: [],
              },
            ],
            cursor: 'human-msg',
          };
        }
        return { items: [], cursor: 'latest', closeRequested: true };
      }
      if (name === 'getRoomConversation') {
        return {
          items: [
            {
              type: 'message',
              authorId: stored('11'.repeat(32), 'Bee').publicKey,
              body: 'Already working.',
            },
          ],
          cursor: 'latest',
        };
      }
      if (name === 'getRoomAuthority') return { member: true, principalKind: 'human' };
      writes.push({ name, input });
      return { id: 'write-id', createdAt: 1 };
    });
    const { acp, loop, scheduler } = await cornerHarness(execute, 60_000);
    vi.spyOn(acp, 'sessionPrompt').mockImplementation(
      async (_id, _prompt, _timeout, draft, _activity, toolActivity) => {
        draft?.('Inspecting ', 'Inspecting ', 'Inspecting ', ['Inspecting ']);
        toolActivity?.([
          {
            kind: 'read',
            title: 'Read package.json',
            rawInput: { path: 'package.json' },
            status: 'in_progress',
          },
        ]);
        draft?.('done.', 'Inspecting \n\ndone.', 'done.', ['Inspecting ', 'done.']);
        const tool = {
          kind: 'read' as const,
          title: 'Read package.json',
          rawInput: { path: 'package.json' },
          status: 'completed' as const,
        };
        toolActivity?.([tool]);
        return { stopReason: 'end_turn', updates: [], agentText: 'done.', toolCalls: [tool] };
      },
    );
    await loop.run();
    await scheduler.dispose();

    const durableTexts = [
      ...writes
        .filter((write) => write.name === 'postAgentActivity')
        .flatMap((write) =>
          (write.input.activity as Array<{ kind: string; text?: string }>)
            .filter((activity) => activity.kind === 'output')
            .map((activity) => activity.text),
        ),
      ...writes
        .filter((write) => write.name === 'postRoomMessage')
        .map((write) => write.input.text),
    ];
    expect(durableTexts).toEqual(['Inspecting', 'done.']);
    expect(durableTexts).not.toContain('Inspecting done.');
  });

  it('folds a corner wake into the live stream without the retired long-poll', async () => {
    let closeReads = 0;
    let publishWake: (() => void) | undefined;
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentConfiguration') return { commands: [] };
      if (name === 'getWorkspaceRoster') return { members: [] };
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getRoomConversation')
        return { items: [{ type: 'message', authorId: '11'.repeat(32), requestId: 'r1' }] };
      if (name === 'getCornerCloseRequests') {
        closeReads += 1;
        if (closeReads === 1) return { items: [], cursor: 'latest' };
        return { items: [], cursor: 'latest', closeRequested: true };
      }
      return { id: 'write-id', createdAt: 1 };
    });
    const liveSubscribe = vi.fn((_roomId, _cursor, onItems, onState) => {
      onState?.(true, { pushIntake: true, connectionPresence: true });
      publishWake = () =>
        onItems?.(
          [
            {
              id: 'wake',
              authorId: 'server',
              createdAt: 1,
              type: 'system',
              body: '',
              attachments: [],
            },
          ],
          'latest',
        );
      return () => undefined;
    }) as unknown as DaemonApiClient['liveSubscribe'];
    const { loop, scheduler, onPoll } = await cornerHarness(execute, 60_000, liveSubscribe);
    const started = Date.now();
    const running = loop.run();
    await vi.waitFor(() => expect(onPoll).toHaveBeenCalledTimes(1));
    publishWake?.();
    loop.requestClose();
    await running;
    await scheduler.dispose();
    expect(closeReads).toBe(1);
    expect(execute).not.toHaveBeenCalledWith('waitForCornerWake', expect.anything());
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('keeps the timed fallback against an older server without live subscriptions', async () => {
    let closeReads = 0;
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentConfiguration') return { commands: [] };
      if (name === 'getWorkspaceRoster') return { members: [] };
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getRoomConversation')
        return { items: [{ type: 'message', authorId: '11'.repeat(32), requestId: 'r1' }] };
      if (name === 'getCornerCloseRequests') {
        closeReads += 1;
        if (closeReads === 1) return { items: [], cursor: 'latest' };
        return { items: [], cursor: 'latest', closeRequested: true };
      }
      return { id: 'write-id', createdAt: 1 };
    });
    // A dropped `corner-complete` costs latency, never correctness: with no
    // push at all the corner is still reaped by the durable close read, here
    // on a short stand-in for the 10-minute recovery interval.
    const { loop, scheduler } = await cornerHarness(execute, 20, undefined, 20);
    await loop.run();
    await scheduler.dispose();
    expect(closeReads).toBe(2);
  });

  it('still closes on a pushed corner-complete after a reconciliation sweep', async () => {
    let closeReads = 0;
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentConfiguration') return { commands: [] };
      if (name === 'getWorkspaceRoster') return { members: [] };
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getRoomConversation')
        return { items: [{ type: 'message', authorId: '11'.repeat(32), requestId: 'r1' }] };
      if (name === 'getCornerCloseRequests') {
        closeReads += 1;
        return { items: [], cursor: 'latest' };
      }
      return { id: 'write-id', createdAt: 1 };
    });
    const liveSubscribe = vi.fn((_roomId, _cursor, _onItems, onState) => {
      onState?.(true, { pushIntake: true, connectionPresence: true });
      return () => undefined;
    }) as unknown as DaemonApiClient['liveSubscribe'];
    const { loop, scheduler, onPoll } = await cornerHarness(execute, 60_000, liveSubscribe);
    const started = Date.now();
    const running = loop.run();
    await vi.waitFor(() => expect(onPoll).toHaveBeenCalledTimes(1));
    // The sweep's wake must not consume the intake wake: the close below is
    // the only thing that can end this loop inside the test's deadline.
    loop.requestReconciliation();
    await new Promise((resolve) => setTimeout(resolve, 50));
    loop.requestClose();
    await running;
    await scheduler.dispose();
    // One read at intake start and one the sweep asked for; neither reports a
    // close, so only the pushed close can have ended the loop.
    expect(closeReads).toBe(2);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('runs the throttled close read again when the reconcile sweep asks', async () => {
    let closeReads = 0;
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentConfiguration') return { commands: [] };
      if (name === 'getWorkspaceRoster') return { members: [] };
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getRoomConversation')
        return { items: [{ type: 'message', authorId: '11'.repeat(32), requestId: 'r1' }] };
      if (name === 'getCornerCloseRequests') {
        closeReads += 1;
        if (closeReads === 1) return { items: [], cursor: 'latest' };
        return { items: [], cursor: 'latest', closeRequested: true };
      }
      return { id: 'write-id', createdAt: 1 };
    });
    const liveSubscribe = vi.fn((_roomId, _cursor, _onItems, onState) => {
      onState?.(true, { pushIntake: true, connectionPresence: true });
      return () => undefined;
    }) as unknown as DaemonApiClient['liveSubscribe'];
    // A close published while the socket was down reaches nobody, and the
    // throttle would otherwise hold the durable read for the whole interval.
    const { loop, scheduler, onPoll } = await cornerHarness(
      execute,
      60_000,
      liveSubscribe,
      10 * 60_000,
    );
    const started = Date.now();
    const running = loop.run();
    await vi.waitFor(() => expect(onPoll).toHaveBeenCalledTimes(1));
    loop.requestReconciliation();
    await running;
    await scheduler.dispose();
    expect(closeReads).toBe(2);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('does not use the configured fast recovery cadence after push acknowledgement', async () => {
    let closeReads = 0;
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentConfiguration') return { commands: [] };
      if (name === 'getWorkspaceRoster') return { members: [] };
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getRoomConversation')
        return { items: [{ type: 'message', authorId: '11'.repeat(32), requestId: 'r1' }] };
      if (name === 'getCornerCloseRequests') {
        closeReads += 1;
        return { items: [], cursor: 'latest' };
      }
      return { id: 'write-id', createdAt: 1 };
    });
    const liveSubscribe = vi.fn((_roomId, _cursor, _onItems, onState) => {
      onState?.(true, { pushIntake: true, connectionPresence: true });
      return () => undefined;
    }) as unknown as DaemonApiClient['liveSubscribe'];
    const { loop, scheduler, abort } = await cornerHarness(execute, 300, liveSubscribe);
    const running = loop.run();
    await new Promise((resolve) => setTimeout(resolve, 900));
    abort.abort();
    await running;
    await scheduler.dispose();
    expect(closeReads).toBe(1);
    expect(execute).not.toHaveBeenCalledWith('waitForCornerWake', expect.anything());
  });
});

describe('thin monolith corner turn', () => {
  it('summarizes a commit with its file count and subject', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-corner-commit-'));
    roots.push(root);
    await execFileAsync('git', ['init', root]);
    await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Bee']);
    await execFileAsync('git', ['-C', root, 'config', 'user.email', 'bee@example.test']);
    await Promise.all([
      writeFile(join(root, 'one.txt'), 'one\n'),
      writeFile(join(root, 'two.txt'), 'two\n'),
    ]);
    await execFileAsync('git', ['-C', root, 'add', 'one.txt', 'two.txt']);
    await execFileAsync('git', ['-C', root, 'commit', '-m', 'Fix the widget']);

    await expect(
      cornerToolActivity(
        {
          id: 'commit-1',
          kind: 'execute',
          title: 'Run shell command',
          rawInput: { command: 'git commit -m "Fix the widget"' },
          status: 'completed',
        },
        root,
      ),
    ).resolves.toEqual(expect.objectContaining({ title: 'committed 2 files: Fix the widget' }));
  });

  it('emits bounded, redacted command, file, status, and output detail for a settled tool', async () => {
    const activity = await cornerToolActivity(
      {
        id: 'tool-1',
        kind: 'execute',
        title: 'Bash',
        rawInput: { command: 'GH_TOKEN=super-secret npm test -- --runInBand' },
        content: [
          'first line',
          'second line',
          'third line',
          'fourth line',
          'middle line that is omitted',
          'another omitted line',
          'seventh line',
          'eighth line',
          'ninth line',
          'last line: github_pat_abcdefghijklmnopqrstuvwxyz',
        ].join('\n'),
        status: 'failed',
      },
      '/worktree',
    );
    expect(activity).toMatchObject({
      kind: 'tool',
      operation: 'execute',
      command: 'GH_TOKEN=[REDACTED] npm test -- --runInBand',
      status: 'error',
      output: expect.stringContaining('first line'),
    });
    expect(activity.output).toContain('last line: [REDACTED]');
    expect(activity.output).not.toContain('middle line that is omitted');
    expect(JSON.stringify(activity)).not.toContain('super-secret');

    const encoded = await cornerToolActivity(
      {
        id: 'encoded',
        kind: 'execute',
        title: 'Bash',
        status: 'completed',
        content: JSON.stringify({ formatted_output: '  first\n\nsecond\n' + 'é'.repeat(4000) }),
      },
      '/worktree',
    );
    expect(encoded.output).toContain('  first\n\nsecond');
    expect(encoded.output).not.toContain('formatted_output');
    expect(Buffer.byteLength(encoded.output!)).toBeLessThanOrEqual(3200);
    expect(encoded.output).not.toContain('\ufffd');

    const rawOnly = await cornerToolActivity(
      {
        id: 'raw-only',
        kind: 'execute',
        title: 'Bash',
        status: 'completed',
        rawOutput: { output: { text: 'first\n\nsecond' } },
      },
      '/worktree',
    );
    expect(rawOnly.output).toBe('first\n\nsecond');

    const grokError = await cornerToolActivity(
      {
        id: 'grok-error',
        kind: 'execute',
        title: 'open_corner',
        status: 'failed',
        rawOutput: {
          type: 'MCP',
          tool_name: 'open_corner',
          server_name: 'beeline-agent',
          output: { Error: 'the objective is 43 words; the limit is 24' },
          is_error: true,
        },
      },
      '/worktree',
    );
    expect(grokError.output).toBe('the objective is 43 words; the limit is 24');

    await expect(
      cornerToolActivity(
        {
          id: 'edit-1',
          kind: 'edit',
          title: 'Write',
          rawInput: { file_path: '/worktree/apps/mobile/ToolRow.tsx' },
          content: { ok: true },
          status: 'completed',
        },
        '/worktree',
      ),
    ).resolves.toMatchObject({
      operation: 'edit',
      input: '{"file_path":"/worktree/apps/mobile/ToolRow.tsx"}',
      files: [{ path: 'apps/mobile/ToolRow.tsx' }],
      status: 'ok',
    });
  });

  it('starts in edit mode, streams to the corner, and carries the server-check merge gate', async () => {
    vi.stubEnv('BEELINE_INSTITUTIONAL_MEMORY_ENABLED', 'true');
    const root = await mkdtemp(join(tmpdir(), 'beeline-thin-corner-'));
    roots.push(root);
    const worktree = join(root, 'worktree');
    const gitCommonDir = join(worktree, '.git');
    await mkdir(worktree);
    await execFileAsync('git', ['init', worktree]);
    const runtime: AgentRuntimeRecord = {
      version: 2,
      communityId: 'workspace',
      pairedBy: 'human',
      agent: stored('11'.repeat(32), 'Bee'),
      body: stored('22'.repeat(32), 'Body'),
      rooms: [],
      supervisorRoot: root,
      transport: {
        kind: 'monolith',
        baseUrl: 'https://server.example',
        daemonToken: 'daemon-token',
      },
      agentBinary: '/fake-agent',
      agentKind: 'codex',
      agentCommand: '/fake-agent',
      agentArgs: [],
      mcpBinary: '/fake-dev-mcp',
    };
    const config: BodyConfig = {
      agentBinary: '/fake-agent',
      agentKind: 'codex',
      agentCommand: '/fake-agent',
      agentArgs: [],
      mcpBinary: '/fake-dev-mcp',
      readonlyMcpCommand: '/fake-beeline-mcp',
      agentEnv: {},
      workspaceRoot: root,
      autoApprovePermissions: true,
    };
    const abort = new AbortController();
    const writes: Array<{ name: string; input: Record<string, unknown> }> = [];
    let conversationReads = 0;
    let inboxReads = 0;
    let institutionalReads = 0;
    const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'getAgentConfiguration') {
        return {
          commands: [],
          yoloMode: true,
          soul: { name: 'Terra', instructions: 'Steady, exact, and kind.' },
        };
      }
      if (name === 'getWorkspaceRoster') {
        return {
          members: [
            {
              identityId: runtime.agent.publicKey,
              kind: 'agent',
              name: 'Bee',
              role: 'member',
            },
            {
              identityId: 'peer-agent',
              kind: 'agent',
              name: 'Goosy',
              handle: 'goosy-2',
              role: 'member',
            },
          ],
        };
      }
      if (name === 'getRoomInbox' || name === 'getCornerCloseRequests') {
        inboxReads += 1;
        if (inboxReads === 2) {
          return {
            items: [
              {
                id: 'checks-event',
                authorId: runtime.agent.publicKey,
                createdAt: 2,
                type: 'system',
                body: 'GitHub passed a check Beeline CI',
                attachments: [],
              },
            ],
            cursor: 'checks-event',
          };
        }
        if (inboxReads === 3) {
          return { items: [], cursor: 'close-event', closeRequested: true };
        }
        return { items: [], cursor: 'latest' };
      }
      if (name === 'getRoomConversation') {
        conversationReads += 1;
        return {
          items: [
            {
              id: 'objective-message',
              authorId: runtime.agent.publicKey,
              createdAt: 1,
              type: 'message',
              body: 'Implement the widget',
              requestId: 'cornerid',
              attachments: [],
            },
            // A transcript long enough that a warm second turn has something to
            // leave out. Human-authored, so the corner still has no durable
            // agent reply and still kicks the objective off.
            ...Array.from({ length: 40 }, (_, index) => ({
              id: `corner-row-${index + 1}`,
              authorId: 'human-pubkey',
              createdAt: index + 2,
              type: 'message',
              body: `corner row ${index + 1}`,
              attachments: [],
            })),
          ],
          cursor: 'latest',
        };
      }
      if (name === 'getCornerRestoreState')
        return {
          cornerId: 'corner-id',
          objective: 'Implement the widget',
          closeRequested: false,
          brief: {
            id: 'corner-id',
            revision: 2,
            legacy: false,
            authorId: runtime.agent.publicKey,
            sourceRoomId: 'room-id',
            sourceMessageId: 'correction-message',
            attachments: [],
            content: 'Preserve the requested widget size and deliberate amber label.',
            intentVerbatim: [
              {
                sourceMessageId: 'intent-message',
                snapshot: 'Build the requested widget at the agreed size.',
              },
              {
                sourceMessageId: 'correction-message',
                snapshot: 'Correction: keep the label amber, not blue.',
              },
            ],
            buildSpec: 'Preserve the requested widget size and deliberate amber label.',
            criteria: [
              { id: 'AC-1', text: 'The widget keeps the requested size.' },
              { id: 'AC-2', text: 'The label remains amber.' },
            ],
            nonGoals: ['Changing the label to the conventional blue.'],
            references: [
              {
                label: 'Approved widget mock',
                authority: 'approved-reference',
                description: 'The corrected amber visual.',
              },
            ],
            approvalBasis: {
              kind: 'explicit-human-answer',
              sourceMessageId: 'correction-message',
              snapshot: 'Correction: keep the label amber, not blue.',
              approvedBy: 'human-pubkey',
              briefHash: 'a'.repeat(64),
            },
            revisionHash: 'a'.repeat(64),
          },
        };
      if (name === 'getInstitutionalContext') {
        institutionalReads += 1;
        const text = `Corner institutional snapshot ${institutionalReads}`;
        return {
          snapshotRevision: institutionalReads,
          text,
          itemIds: [`corner-memory-${institutionalReads}`],
          totalBytes: Buffer.byteLength(text),
          omitted: {},
        };
      }
      writes.push({ name, input });
      return { id: 'write-id', createdAt: 1 };
    });
    const api = {
      execute,
      connection: () => ({
        baseUrl: 'https://server.example',
        daemonToken: 'daemon-token',
        agentId: runtime.agent.publicKey,
      }),
    } as unknown as DaemonApiClient;
    const acp = new AcpClient({ agentBinary: '/fake-agent', agentEnv: {} });
    vi.spyOn(acp, 'start').mockResolvedValue(undefined);
    const sessionNew = vi.spyOn(acp, 'sessionNew').mockResolvedValue({
      sessionId: 'corner-session',
      raw: {},
    });
    const sessionPrompt = vi
      .spyOn(acp, 'sessionPrompt')
      .mockImplementation(async (_id, prompt, _timeout, draft, _activity, toolActivity) => {
        draft?.('Opening PR', 'Opening PR');
        const checksTurn = prompt.includes('passed a check') || prompt === CORNER_YOLO_MERGE_NUDGE;
        const toolCalls = checksTurn
          ? []
          : [
              {
                id: 'read-1',
                kind: 'read',
                title: 'Read package.json',
                status: 'completed',
              },
            ];
        toolActivity?.(toolCalls);
        toolActivity?.(toolCalls);
        return {
          stopReason: 'end_turn',
          updates: [],
          agentText: checksTurn
            ? 'Merged https://github.com/acme/widgets/pull/7'
            : 'PR: https://github.com/acme/widgets/pull/7',
          toolCalls,
        };
      });
    const scheduler = new SessionScheduler({ maxLiveSessions: 2 });
    const onCloseRequested = vi.fn(async () => undefined);
    const loop = new MonolithCornerTurnLoop({
      cornerId: 'corner-id',
      parentRoomId: 'room-id',
      workspaceId: 'workspace',
      objective: 'Implement the widget',
      worktreePath: worktree,
      repository: {
        featureBranch: 'feature/widget',
        targetBranch: 'main',
        gitCommonDir,
        githubToken: 'room-installation-token',
      },
      runtime,
      config,
      api: commandFixtureApi(api, 'corner-id', runtime.agent.publicKey, 'Implement the widget'),
      scheduler,
      signal: abort.signal,
      pollMs: 1,
      onPoll: vi.fn(),
      onFailure: vi.fn(),
      onCloseRequested,
      createAcpClient: () => acp,
    });
    await loop.run();
    await scheduler.dispose();

    expect(conversationReads).toBeGreaterThanOrEqual(2);
    expect(institutionalReads).toBe(2);
    expect(sessionPrompt).toHaveBeenCalledTimes(3);
    expect(onCloseRequested).toHaveBeenCalledOnce();
    expect(sessionPrompt.mock.calls[1]?.[1]).toContain('passed a check');
    expect(sessionPrompt.mock.calls[2]?.[1]).toBe(CORNER_YOLO_MERGE_NUDGE);
    // The first turn on a cold session renders the whole transcript window.
    const firstPrompt = String(sessionPrompt.mock.calls[0]?.[1]);
    const secondPrompt = String(sessionPrompt.mock.calls[1]?.[1]);
    expect(firstPrompt).toContain('Corner transcript:');
    expect(firstPrompt).toContain('Corner institutional snapshot 1');
    expect(secondPrompt).toContain('Corner institutional snapshot 2');
    expect(firstPrompt).toContain('[message id: corner-row-1]\nBeeline [message]: corner row 1');
    expect(firstPrompt).toContain('corner row 1');
    expect(firstPrompt).toContain('Reaction target message id: cornerid\nNewest trigger:');
    // The second turn is the SAME warm session: it sends only what is new, and
    // the objective — which lives outside the transcript window — still rides
    // on every prompt.
    expect(secondPrompt).toContain('New in the corner since your last turn');
    expect(secondPrompt).not.toContain('corner row 1\n');
    expect(firstPrompt).toContain(
      'Corner navigation summary (not product authority):\nImplement the widget',
    );
    expect(secondPrompt).toContain(
      'Corner navigation summary (not product authority):\nImplement the widget',
    );
    expect(firstPrompt).toContain('Room members, and the exact spelling that tags each one:');
    expect(secondPrompt).toContain('Room members, and the exact spelling that tags each one:');
    expect(firstPrompt).toContain('- @goosy-2 — Goosy (agent)');
    expect(secondPrompt).toContain('- @goosy-2 — Goosy (agent)');
    expect(sessionNew).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: worktree,
        mode: 'edit',
        mcpServers: expect.arrayContaining([
          expect.objectContaining({
            name: 'buzz-dev-mcp',
            // Exact, not a superset: this server's env carries this corner's
            // own repository token and the shared package cache, and nothing
            // else of the host's.
            env: [
              { name: 'GH_TOKEN', value: 'room-installation-token' },
              { name: 'GITHUB_TOKEN', value: 'room-installation-token' },
              { name: 'npm_config_cache', value: sharedNpmCacheDir(root) },
              { name: 'PNPM_CONFIG_STORE_DIR', value: sharedPnpmStoreDir(root) },
              { name: 'CARGO_TARGET_DIR', value: sharedCargoTargetDir(root) },
            ],
          }),
          expect.objectContaining({ name: 'beeline-agent' }),
        ]),
        systemPrompt: expect.stringContaining('On a later checks turn, call pr_checks_status'),
      }),
    );
    expect(sessionNew).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining(cornerMergeInstruction(true)),
      }),
    );
    const repositorySystemPrompt = String(sessionNew.mock.calls[0]?.[0].systemPrompt);
    expect(repositorySystemPrompt).toContain(CORNER_AUTHOR_CONTRACT);
    expect(repositorySystemPrompt).toContain("beeline-triage skill's bugfix execution contract");
    expect(repositorySystemPrompt).toContain('record it under Reproduction <id>');
    expect(repositorySystemPrompt).toContain(
      'never stop and never condition the fix on reproduction',
    );
    expect(repositorySystemPrompt).toContain('when none was obtained, state that plainly');
    expect(repositorySystemPrompt).not.toContain('do not write a fix for a bug you have not seen');
    expect(repositorySystemPrompt).not.toContain('report_to_room');
    expect(repositorySystemPrompt).not.toMatch(/report .* to the Room/i);
    expect(repositorySystemPrompt).not.toContain('Proposed corner:');
    expect(repositorySystemPrompt.indexOf(CORNER_AUTHOR_CONTRACT)).toBeLessThan(
      repositorySystemPrompt.indexOf(cornerMergeInstruction(true)),
    );
    expect(sessionNew).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining(
          'Do not tag the user when a corner turn finishes: the server posts the merge summary card and its push already cover completion.',
        ),
      }),
    );
    expect(sessionNew).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining(
          'When asked whether the reviewer was woken, call pr_checks_status and report reviewerWake',
        ),
      }),
    );
    expect(sessionNew).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining('Never restate server check or merge notes'),
      }),
    );
    // Item 2: no schedule may poll the merge gate, and a schedule-triggered
    // turn stays as silent as a checks turn unless it is actionable.
    expect(sessionNew).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining(
          'Never create a schedule to poll pr_checks_status or the merge gate',
        ),
      }),
    );
    expect(sessionNew).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining(
          'tagging any agent other than the configured reviewer cannot clear the gate',
        ),
      }),
    );
    expect(sessionNew).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining(
          'If a schedule wakes you in this corner anyway, follow the same rule as a checks turn: say nothing unless you merge, push a fix, or report a genuinely new blocker.',
        ),
      }),
    );
    expect(sessionNew).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining(
          'Human-authored Workspace persona: Terra. Steady, exact, and kind.',
        ),
      }),
    );
    // One shared house rule, said once beside the persona and never per soul.
    expect(sessionNew).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: expect.stringContaining(SOUL_HOUSE_RULE) }),
    );
    for (const call of [sessionPrompt.mock.calls[0], sessionPrompt.mock.calls[1]]) {
      expect(call[1]).toContain('Assigned corner brief corner-id revision 2');
      expect(call[1]).toContain('(hash ' + 'a'.repeat(64));
      expect(call[1]).toContain(
        '[message correction-message] Correction: keep the label amber, not blue.',
      );
      expect(call[1]).toContain('AC-2: The label remains amber.');
      expect(call[1]).toContain('Approval basis bound to this revision:');
      expect(call[1]).toContain('explicit-human-answer by human-pubkey');
      expect(call[1]).toContain('Your Beeline identity is Bee.');
      expect(call[1]).toContain(
        'Human-authored Workspace persona: Terra. Steady, exact, and kind.',
      );
      expect(call[1]).toContain(SOUL_HOUSE_RULE);
      expect(call[1]).toMatch(
        /Maintain your assigned identity and soul in every response, including when tools or permissions block the requested action\.$/,
      );
    }
    expect(writes).toContainEqual(
      expect.objectContaining({
        name: 'postRoomMessage',
        input: expect.objectContaining({
          roomId: 'corner-id',
          text: 'PR: https://github.com/acme/widgets/pull/7',
        }),
      }),
    );
    // The daemon never phrases a system line: the server's GitHub webhook
    // inscribes "opened a pull request" from the event.
    expect(writes).not.toContainEqual(
      expect.objectContaining({
        name: 'postRoomMessage',
        input: expect.objectContaining({ presentation: 'system' }),
      }),
    );
    expect(writes.filter((write) => write.name === 'postAgentActivity')).toEqual([
      expect.objectContaining({
        input: expect.objectContaining({
          activity: [
            expect.objectContaining({
              kind: 'output',
              title: 'Update',
              text: 'Opening PR',
            }),
            expect.objectContaining({
              kind: 'tool',
              operation: 'read',
              title: 'Read package.json',
            }),
          ],
        }),
      }),
    ]);
    // The draft lane's turn id must equal its turn's durable final request id,
    // so a missed retract event is healed by the settled message instead of
    // leaving the final message rendered twice (#802 regression).
    const turnRequestIds = new Set(
      writes
        .filter(
          (write) =>
            write.name === 'postRoomMessage' &&
            (write.input.presentation ?? 'message') === 'message',
        )
        .map((write) => write.input.requestId),
    );
    expect(turnRequestIds.size).toBeGreaterThan(0);
    const drafts = writes.filter((write) => write.name === 'postAgentDraft');
    expect(drafts.length).toBeGreaterThan(0);
    for (const draft of drafts) {
      expect(draft.input).toMatchObject({ roomId: 'corner-id' });
      expect(turnRequestIds.has(draft.input.turnId)).toBe(true);
    }
    const retracts = writes.filter((write) => write.name === 'retractAgentLiveOutput');
    expect(retracts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ input: expect.objectContaining({ kind: 'draft' }) }),
      ]),
    );
    for (const retract of retracts) {
      expect(turnRequestIds.has(retract.input.turnId)).toBe(true);
    }
  });
});

describe('corner turn failure receipt', () => {
  it('reports failed with a distilled, secret-free reason and never a stack trace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-corner-failure-'));
    roots.push(root);
    await execFileAsync('git', ['init', root]);
    const runtime = {
      agentId: '11'.repeat(32),
      agent: stored('11'.repeat(32), 'Bee'),
      rooms: [],
      supervisorRoot: root,
      transport: {
        kind: 'monolith',
        baseUrl: 'https://server.example',
        daemonToken: 'daemon-token',
      },
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
      workspaceRoot: root,
      autoApprovePermissions: true,
    };
    const abort = new AbortController();
    let inboxReads = 0;
    const receipts: Array<Record<string, unknown>> = [];
    const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'getAgentConfiguration') return { commands: [] };
      if (name === 'getWorkspaceRoster') {
        return {
          members: [{ identityId: '11'.repeat(32), kind: 'agent', name: 'Bee', role: 'member' }],
        };
      }
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getCornerCloseRequests') {
        inboxReads += 1;
        if (inboxReads === 1) {
          return {
            items: [
              {
                id: 'human-msg',
                authorId: '22'.repeat(32),
                createdAt: 1,
                type: 'message',
                body: 'Please continue',
                attachments: [],
              },
            ],
            cursor: 'human-msg',
          };
        }
        return { items: [], cursor: 'latest' };
      }
      if (name === 'getRoomConversation') return { items: [], cursor: 'latest' };
      if (name === 'getRoomAuthority') return { member: true, principalKind: 'human' };
      if (name === 'postAgentTurnReceipt') receipts.push(input);
      return { id: 'write-id', createdAt: 1 };
    });
    const api = {
      execute,
      connection: () => ({
        baseUrl: 'https://server.example',
        daemonToken: 'daemon-token',
        agentId: runtime.agent.publicKey,
      }),
    } as unknown as DaemonApiClient;
    const acp = new AcpClient({ agentBinary: '/fake-agent', agentEnv: {} });
    vi.spyOn(acp, 'start').mockResolvedValue(undefined);
    vi.spyOn(acp, 'sessionNew').mockResolvedValue({ sessionId: 'corner-session', raw: {} });
    const failure = new Error(
      'ACP session/prompt timed out after 120000ms of inactivity GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz',
    );
    failure.stack = `${failure.message}\n    at AcpClient.request (/opt/beeline/acp.js:984:20)`;
    vi.spyOn(acp, 'sessionPrompt').mockRejectedValueOnce(failure).mockResolvedValue({
      stopReason: 'end_turn',
      updates: [],
      agentText: 'Recovered.',
      toolCalls: [],
    });
    const scheduler = new SessionScheduler({ maxLiveSessions: 2 });
    const running = new MonolithCornerTurnLoop({
      cornerId: 'corner-id',
      parentRoomId: 'room-id',
      workspaceId: 'workspace',
      objective: 'Implement the widget',
      worktreePath: root,
      repository: {
        featureBranch: 'feature/widget',
        targetBranch: 'main',
        gitCommonDir: join(root, '.git'),
        githubToken: 'token',
      },
      runtime,
      config,
      api: commandFixtureApi(api, 'corner-id', runtime.agent.publicKey, 'Implement the widget'),
      scheduler,
      signal: abort.signal,
      pollMs: 10,
      onPoll: vi.fn(),
      onFailure: vi.fn(),
      onCloseRequested: vi.fn(async () => undefined),
      createAcpClient: () => acp,
    })
      .run()
      // The objective kickoff rethrows: the supervisor restarts the corner.
      .catch((error: unknown) => error);
    await vi.waitFor(
      () => expect(receipts.some((receipt) => receipt.status === 'failed')).toBe(true),
      { timeout: 5_000 },
    );
    abort.abort();
    await expect(running).resolves.toBeUndefined();
    await scheduler.dispose();

    const failed = receipts.find((receipt) => receipt.status === 'failed')!;
    expect(failed).toEqual(expect.objectContaining({ roomId: 'corner-id', status: 'failed' }));
    const reason = failed.reason as string;
    expect(reason).toContain('timed out after 120000ms of inactivity');
    expect(reason).toContain('[REDACTED]');
    expect(reason).not.toMatch(/ghp_abc|\n|\bat AcpClient/);
  });
});
