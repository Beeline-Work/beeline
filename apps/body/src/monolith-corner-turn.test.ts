import { commandFixtureApi } from './command-fixture.test-support.js';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient, AcpTurnBackstopError, TURN_BACKSTOP_MS } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import {
  cornerHasUndeliveredRepositoryWork,
  cornerToolActivity,
  MonolithCornerTurnLoop,
} from './monolith-corner-turn.js';
import {
  CORNER_AUTHOR_CONTRACT,
  CORNER_DELIVERY_NUDGE,
  CORNER_REVIEWER_SESSION_INSTRUCTION,
  CORNER_REVIEWER_UNSTABLE_HEAD_INSTRUCTION,
  CORNER_YOLO_MERGE_NUDGE,
  cornerMergeInstruction,
  cornerReviewerInstruction,
  cornerSelfReviewerInstruction,
} from './prompt-assembly.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { agentToolsFor, postArtifact, writeScratchFile } from './read-only-mcp.js';
import { SessionScheduler } from './session-scheduler.js';
import {
  sharedCargoTargetDir,
  sharedNpmCacheDir,
  sharedPnpmStoreDir,
} from './warm-node-modules.js';

/** `core.voice` and `core.tagging` from `prompt-assembly.ts`. */
const VOICE_RULE =
  'Your voice never changes the facts: never trim, soften, exaggerate, or invent a detail for style.';
const TAGGING_RULE =
  'Every exact @handle you write wakes that member. Write one only to hand off work, to ask for a decision or input, or, when nothing else announces it, to tell the person who asked that their task is done; otherwise name people and agents in plain prose.';

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

/** The server's corner-complete frame follows a settled turn in these fixtures. */
function closePushAfterReceipt(
  api: DaemonApiClient,
  loop: () => MonolithCornerTurnLoop,
  afterReceipts = 1,
): DaemonApiClient {
  let receipts = 0;
  return new Proxy(api, {
    get(target, key) {
      if (key === 'execute')
        return async (
          name: Parameters<DaemonApiClient['execute']>[0],
          input: Record<string, unknown>,
        ) => {
          const result = await target.execute(name, input as never);
          if (
            name === 'postAgentTurnReceipt' &&
            input.status !== 'working' &&
            ++receipts === afterReceipts
          )
            queueMicrotask(() => loop().requestClose());
          return result;
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

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
    // The server merges once its gate opens; no variant tells the author to
    // merge, and only a reviewer with yolo on names the server as the merger.
    for (const yolo of [false, true]) {
      expect(cornerMergeInstruction(yolo)).toContain('no configured reviewer');
      expect(cornerMergeInstruction(yolo)).toContain('never merge');
      expect(cornerMergeInstruction(yolo)).not.toContain('gh pr merge');
    }
    const off = cornerMergeInstruction(false, 'echo');
    expect(off).toContain('Yolo is off');
    expect(off).toContain('never merge');
    expect(off).not.toContain('gh pr merge');
    const on = cornerMergeInstruction(true, 'echo');
    expect(on).toContain('after its PASS the server merges the pull request itself');
    expect(on).toContain('Never merge it yourself');
    expect(on).toContain(
      'You are woken only to fix failing checks, requested changes, or a merge GitHub refused',
    );
    expect(on).not.toContain('gh pr merge');
    for (const instruction of [off, on]) {
      expect(instruction).not.toContain('please review');
      expect(instruction).not.toContain('@echo');
      expect(instruction).toContain('the reviewer (echo)');
    }
  });

  it('selects the reviewer role by identity only for a non-opener', () => {
    const reviewer = {
      isReviewer: true,
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
    expect(instruction).toContain(
      `reply \`approved ${'a'.repeat(40)}\` without tagging bee: the server merges it`,
    );
    expect(instruction).not.toContain(`approved ${'a'.repeat(40)}, merge`);
    expect(instruction).toContain('Never merge yourself or tell the author to merge');
    expect(instruction).not.toContain('gh pr merge');
    expect(instruction).toContain('Never merge yourself');
    expect(instruction).toContain('Never say you are holding or waiting for checks');
    expect(instruction).not.toContain('pending checks');
    expect(instruction).not.toContain('unknown checks');
    expect(cornerReviewerInstruction({ ...reviewer, openedByAgent: true })).toBeUndefined();
    expect(cornerReviewerInstruction({ ...reviewer, isReviewer: false })).toBeUndefined();
  });

  it('gives the self-reviewer line only when the reviewer opens its own corner', () => {
    const selfReviewer = { isReviewer: true, openedByAgent: true };
    const instruction = cornerSelfReviewerInstruction(selfReviewer)!;
    expect(instruction).toContain("You are this Room's reviewer");
    expect(instruction).toContain('do not request one');
    expect(instruction).toContain('tag any agent for review');
    expect(instruction).toContain(
      'The server merges it once checks are green, yolo is on, and no human hold stands',
    );
    expect(instruction).toContain('never merge it yourself');
    expect(instruction).not.toContain('gh pr merge');
    // A non-reviewer opener (someone else is the configured reviewer): nothing.
    expect(cornerSelfReviewerInstruction({ ...selfReviewer, isReviewer: false })).toBeUndefined();
    // The reviewer on someone else's corner: `cornerReviewerInstruction` covers
    // that case instead, so this stays undefined.
    expect(
      cornerSelfReviewerInstruction({ ...selfReviewer, openedByAgent: false }),
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

  it.each([
    { label: 'agent-opened code', lane: 'code', openedBy: undefined },
    { label: 'agent-opened no-code', lane: 'no_code', openedBy: undefined },
    { label: 'BBC in a forwarded human corner', lane: 'no_code', openedBy: 'human-id' },
  ] as const)('starts $label without a repository or host permission request', async (case_) => {
    const agent = stored('11'.repeat(32), case_.openedBy ? 'BBC' : 'Bee');
    const execute = vi.fn(async (name: string) =>
      name === 'authorizeRepositoryCall' || name === 'authorizeHostCall'
        ? { allowed: false, status: 'pending' }
        : { allowed: true, id: 'write', createdAt: 1 },
    );
    const root = await mkdtemp(join(tmpdir(), 'corner-repository-gate-'));
    roots.push(root);
    const scheduler = new SessionScheduler({ maxLiveSessions: 1 });
    const schedule = vi.spyOn(scheduler, 'run').mockResolvedValue(undefined);
    const loop = new MonolithCornerTurnLoop({
      cornerId: 'corner-id',
      parentRoomId: 'room-id',
      workspaceId: 'workspace',
      objective: 'Answer the human request',
      lane: case_.lane,
      ...(case_.openedBy ? { openedBy: case_.openedBy } : {}),
      worktreePath: root,
      runtime: { agent, supervisorRoot: root } as AgentRuntimeRecord,
      config: { agentHomeRoot: root } as BodyConfig,
      api: { execute } as unknown as DaemonApiClient,
      scheduler,
      onPoll: vi.fn(),
      onFailure: vi.fn(),
      onCloseRequested: vi.fn(),
      createAcpClient: vi.fn(),
    });
    await (
      loop as unknown as {
        prompt(id: string, trigger: string, attachments: [], requestedById?: string): Promise<void>;
      }
    ).prompt('request', 'work', [], 'human-id');
    expect(execute).not.toHaveBeenCalledWith('authorizeRepositoryCall', expect.anything());
    expect(execute).not.toHaveBeenCalledWith('authorizeHostCall', expect.anything());
    expect(schedule).toHaveBeenCalledOnce();
    await scheduler.dispose();
  });

  it.each([
    ['approve_merge', 'completed'],
    ['record_validation_stage', 'completed'],
    ['approve_merge', 'in_progress'],
    ['approve_merge', 'failed'],
    ['unrelated_tool', 'completed'],
  ])('R8e refreshes reviewer %s (%s) without duplicating a completed verdict', async (tool, status) => {
    const stableRuns = status === 'completed' && tool !== 'unrelated_tool' ? 1 : 2;
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
        if (name === 'getAgentConfiguration')
          return { commands: [], yoloMode: true, isReviewer: true, reviewerHandle: 'echo' };
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
        if (name === 'listRoomCorners') return { corners: [] };
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
        { name: 'BEELINE_CORNER_LANE', value: 'code' },
      ]),
    );
    const agentEnvironment = new Map(agentServer?.env.map(({ name, value }) => [name, value]));
    expect(
      agentToolsFor(
        agentEnvironment.get('BEELINE_MCP_SURFACE') === 'agent',
        agentEnvironment.get('BEELINE_AGENT_DM') === '1',
        Boolean(agentEnvironment.get('BEELINE_DAEMON_CORNER_ID')),
        agentEnvironment.get('BEELINE_CORNER_LANE') === 'code',
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
        toolCalls: [{ id: 'verdict', title: `beeline.${tool}`, status }],
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
    expect(sessionPrompt).toHaveBeenCalledTimes(stableRuns);
    expect(sessionPrompt.mock.calls[0]?.[1]).toContain(
      `Checks are green on PR #7 at ${latestHead}`,
    );
    expect(api.execute.mock.calls.filter(([name]) => name === 'postRoomMessage')[0]?.[1]).toEqual(
      expect.objectContaining({ text: `review pass ${stableRuns}` }),
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
    expect(sessionPrompt).toHaveBeenCalledTimes(stableRuns + 2);
    expect(sessionPrompt.mock.calls[stableRuns]?.[1]).toContain(
      `Checks are green on PR #7 at ${latestHead}`,
    );
    expect(sessionPrompt.mock.calls[stableRuns + 1]?.[1]).toContain(
      `Checks are green on PR #7 at ${newestHead}`,
    );
    expect(sessionPrompt.mock.calls[stableRuns + 1]?.[1]).not.toContain(latestHead);
    const durableReplies = api.execute.mock.calls.filter(([name]) => name === 'postRoomMessage');
    expect(durableReplies).toHaveLength(2);
    expect(durableReplies[1]?.[1]).toEqual(expect.objectContaining({ text: `review pass ${stableRuns + 2}` }));
    await (loop as unknown as { discardSession(): Promise<void> }).discardSession();
  }, 30_000);
});

describe('corner close-request delivery', () => {
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
          content: Buffer.from('\0\0\0\x18ftypiso', 'latin1').toString('base64'),
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
    let loop!: MonolithCornerTurnLoop;
    loop = new MonolithCornerTurnLoop({
      cornerId: 'corner-id',
      parentRoomId: 'room-id',
      workspaceId: 'workspace',
      objective: 'Generate and attach a clip',
      worktreePath: workspace,
      runtime,
      config,
      api: commandFixtureApi(
        closePushAfterReceipt(api, () => loop),
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
    });
    await loop.run();
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

  it('closes on a pushed completion immediately after a turn completes', async () => {
    // The socket completion arrives after the turn's terminal receipt; no
    // idle timer or close-request read is involved.
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
    let loop!: MonolithCornerTurnLoop;
    loop = new MonolithCornerTurnLoop({
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
      api: commandFixtureApi(
        closePushAfterReceipt(api, () => loop),
        'corner-id',
        runtime.agent.publicKey,
        'Implement the widget',
      ),
      scheduler,
      signal: abort.signal,
      pollMs: 60_000,
      onPoll: vi.fn(),
      onFailure: vi.fn(),
      onCloseRequested,
      createAcpClient: () => acp,
    });
    await loop.run();
    await scheduler.dispose();
    expect(sessionPrompt).toHaveBeenCalledTimes(2);
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
    let initialCommandDelivered = false;
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
      if (name === 'getRoomInbox') {
        if (initialCommandDelivered) return { items: [], cursor: 'human-msg' };
        initialCommandDelivered = true;
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
      api: commandFixtureApi(
        closePushAfterReceipt(api, () => loop),
        'corner-id',
        runtime.agent.publicKey,
        null,
      ),
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
    let loop: MonolithCornerTurnLoop;
    let inboxSent = false;
    const api = {
      execute: async (name: string, input: Record<string, unknown>) => {
        if (!liveSubscribe && name === 'getRoomInbox') {
          if (inboxSent) return { items: [], cursor: 'human-msg' };
          inboxSent = true;
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
        const result = await execute(name, input);
        // The server closes a corner through the live socket. Most mechanics
        // fixtures settle one command and then receive that push; the tests
        // with an explicit live socket drive their own close/reconnect events.
        if (!liveSubscribe && name === 'postAgentTurnReceipt' && input.status !== 'working')
          queueMicrotask(() => loop.requestClose());
        return result;
      },
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
      loop: (loop = new MonolithCornerTurnLoop({
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
      })),
      scheduler,
    };
  }

  it('loads member siblings from the parent and excludes itself from steer context', async () => {
    const execute = vi.fn(async (name: string) => {
      if (name === 'getWorkspaceRoster') return { members: [] };
      if (name === 'getRoomConversation') return { items: [], cursor: 'latest' };
      if (name === 'listRoomCorners')
        return {
          corners: [
            { cornerId: 'corner-id', parentRoomId: 'room-id', objective: 'This work' },
            { cornerId: 'sibling-id', parentRoomId: 'room-id', objective: 'Coordinate endpoint' },
            { cornerId: 'closed-id', parentRoomId: 'room-id', objective: 'Old work', archived: true },
          ],
        };
      return { id: 'write-id', createdAt: 1 };
    });
    const { acp, loop, scheduler } = await cornerHarness(execute, 60_000);
    const prompt = vi.spyOn(acp, 'sessionPrompt');
    await loop.run();
    await scheduler.dispose();
    expect(execute).toHaveBeenCalledWith('listRoomCorners', { roomId: 'room-id' });
    expect(prompt.mock.calls[0]?.[1]).toContain('sibling-id');
    expect(prompt.mock.calls[0]?.[1]).not.toContain('"cornerId":"corner-id"');
    expect(prompt.mock.calls[0]?.[1]).not.toContain('closed-id');
  });

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
    expect(closeReads).toBe(0);
    expect(execute).not.toHaveBeenCalledWith('waitForCornerWake', expect.anything());
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('closes from a pushed completion without a timed fallback', async () => {
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
    // The fixture emits the close push after the terminal turn receipt.
    const { loop, scheduler } = await cornerHarness(execute, 20, undefined, 20);
    await loop.run();
    await scheduler.dispose();
    expect(closeReads).toBe(0);
  });

  it('still closes on a pushed corner-complete after a reconciliation sweep', async () => {
    let closeReads = 0;
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentConfiguration') return { commands: [] };
      if (name === 'getWorkspaceRoster') return { members: [] };
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getRoomConversation')
        return { items: [{ type: 'message', authorId: '11'.repeat(32), requestId: 'r1' }] };
      if (name === 'getCornerRestoreState') {
        closeReads += 1;
        return { cornerId: 'corner-id', closeRequested: false };
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
    // The reconnect wake must not consume the intake wake: the close below is
    // the only thing that can end this loop inside the test's deadline.
    loop.requestReconciliation();
    await vi.waitFor(() => expect(closeReads).toBe(1));
    loop.requestClose();
    await running;
    await scheduler.dispose();
    // One durable read on reconciliation reports no close. Only the pushed
    // completion ends the loop.
    expect(closeReads).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('reads durable close state once on reconnect reconciliation', async () => {
    let closeReads = 0;
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentConfiguration') return { commands: [] };
      if (name === 'getWorkspaceRoster') return { members: [] };
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getRoomConversation')
        return { items: [{ type: 'message', authorId: '11'.repeat(32), requestId: 'r1' }] };
      if (name === 'getCornerRestoreState') {
        closeReads += 1;
        return { cornerId: 'corner-id', closeRequested: true };
      }
      return { id: 'write-id', createdAt: 1 };
    });
    const liveSubscribe = vi.fn((_roomId, _cursor, _onItems, onState) => {
      onState?.(true, { pushIntake: true, connectionPresence: true });
      return () => undefined;
    }) as unknown as DaemonApiClient['liveSubscribe'];
    // A close published while the socket was down reaches nobody, so one
    // reconciliation read recovers it when the socket reconnects.
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
    expect(closeReads).toBe(1);
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
    expect(closeReads).toBe(0);
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

  it.each(['completed', 'in_progress', 'failed', 'missing'])('R8f checks outcome (%s) controls the yolo follow-up', async (status) => {
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
            authorId: runtime.agent.publicKey,
            sourceRoomId: 'room-id',
            sourceMessageId: 'correction-message',
            attachments: [],
            spec: '## Intent\n> Build the requested widget at the agreed size. (intent-message)\n\n## Checklist\n- The widget keeps the requested size.\n- The label remains amber.\n\n## Non-goals\n- Changing the label to the conventional blue.',
            approval: {
              sourceMessageId: 'correction-message',
              text: 'Correction: keep the label amber, not blue.',
              approvedBy: 'human-pubkey',
              approverName: 'Rae',
            },
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
          ? (status === 'missing' ? [] : [{ id: 'checks', title: 'beeline.pr_checks_status', status }])
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
      api: commandFixtureApi(
        closePushAfterReceipt(api, () => loop, 2),
        'corner-id',
        runtime.agent.publicKey,
        'Implement the widget',
      ),
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
    expect(sessionPrompt).toHaveBeenCalledTimes(status === 'completed' ? 2 : 3);
    expect(onCloseRequested).toHaveBeenCalledOnce();
    expect(sessionPrompt.mock.calls[1]?.[1]).toContain('passed a check');
    if (status === 'completed')
      expect(sessionPrompt.mock.calls.map((call) => call[1])).not.toContain(CORNER_YOLO_MERGE_NUDGE);
    else expect(sessionPrompt.mock.calls[2]?.[1]).toBe(CORNER_YOLO_MERGE_NUDGE);
    // The first turn on a cold session renders the whole transcript window.
    const firstPrompt = String(sessionPrompt.mock.calls[0]?.[1]);
    const secondPrompt = String(sessionPrompt.mock.calls[1]?.[1]);
    expect(firstPrompt).toContain('Corner transcript:');
    expect(firstPrompt).toContain('Corner institutional snapshot 1');
    expect(secondPrompt).toContain('Corner institutional snapshot 2');
    expect(firstPrompt).toContain('[message id: corner-row-1]\nBeeline [message]: corner row 1');
    expect(firstPrompt).toContain('corner row 1');
    expect(firstPrompt).toContain('Reaction target message id: cornerid\nNewest message:');
    // The second turn is the SAME warm session: it sends only what is new —
    // here nothing, so no transcript at all — and the objective, which lives
    // outside the transcript window, still rides on every prompt.
    expect(secondPrompt).not.toContain('Corner transcript:');
    expect(secondPrompt).not.toContain('corner row');
    expect(firstPrompt).toContain(
      'Corner objective (navigation only, not product authority): Implement the widget',
    );
    expect(secondPrompt).toContain(
      'Corner objective (navigation only, not product authority): Implement the widget',
    );
    expect(firstPrompt).not.toContain('rename_corner');
    expect(firstPrompt).toContain('Members (exact tag spellings):');
    expect(secondPrompt).toContain('Members (exact tag spellings):');
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
        systemPrompt: expect.stringContaining('the merge gate never opens for you: never merge'),
      }),
    );
    expect(sessionNew).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining(cornerMergeInstruction(true)),
      }),
    );
    const repositorySystemPrompt = String(sessionNew.mock.calls[0]?.[0].systemPrompt);
    expect(repositorySystemPrompt).not.toContain('gh pr merge');
    // A code-lane session that did not boot as the reviewer still mounts
    // approve_merge, even with institutional memory off: the server decides
    // whether this caller is the configured reviewer.
    const codeAgentEnvironment = new Map(
      sessionNew.mock.calls[0]?.[0].mcpServers
        .find((server) => server.name === 'beeline-agent')
        ?.env.map(({ name, value }) => [name, value]),
    );
    expect(codeAgentEnvironment.get('BEELINE_CORNER_LANE')).toBe('code');
    expect(codeAgentEnvironment.has('BEELINE_CORNER_REVIEWER')).toBe(false);
    expect(
      agentToolsFor(
        codeAgentEnvironment.get('BEELINE_MCP_SURFACE') === 'agent',
        codeAgentEnvironment.get('BEELINE_AGENT_DM') === '1',
        Boolean(codeAgentEnvironment.get('BEELINE_DAEMON_CORNER_ID')),
        codeAgentEnvironment.get('BEELINE_CORNER_LANE') === 'code',
        Boolean(codeAgentEnvironment.get('BEELINE_GRANT_RUNNER_URL')),
        codeAgentEnvironment.get('BEELINE_CORNER_AGENT_CLOSE') === '1',
        false,
      ).map((tool) => tool.name),
    ).toContain('approve_merge');
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
    expect(repositorySystemPrompt).not.toContain('do not tag anyone');
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
          'Never schedule polls of pr_checks_status or the merge gate',
        ),
      }),
    );
    expect(sessionNew).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining(
          'On it, say nothing unless you push a fix or report checks="unknown", and then use one short line.',
        ),
      }),
    );
    expect(sessionNew).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining(
          'If a schedule wakes you here anyway, treat it as a checks turn.',
        ),
      }),
    );
    expect(sessionNew).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining('Soul (Terra): Steady, exact, and kind.'),
      }),
    );
    // One shared voice rule (core.voice), said once beside the soul and never per soul.
    expect(sessionNew).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: expect.stringContaining(VOICE_RULE) }),
    );
    // Every exact @handle is a wake, so peers are named in prose (core.tagging,
    // shared by both turn loops).
    expect(sessionNew).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining(TAGGING_RULE),
      }),
    );
    for (const call of [sessionPrompt.mock.calls[0], sessionPrompt.mock.calls[1]]) {
      expect(call[1]).toContain('Brief revision 2:\n## Intent');
      expect(call[1]).toContain('- The label remains amber.');
      expect(call[1]).toContain(
        'Approved by Rae, message correction-message: Correction: keep the label amber, not blue.',
      );
      // This harness drops the session prompt, so the session rules ride every turn.
      expect(call[1]).toContain(
        'You are Bee in Beeline. Stay Bee in every reply, including when a tool or permission blocks you.',
      );
      expect(call[1]).toContain('Soul (Terra): Steady, exact, and kind.');
      expect(call[1]).toContain(VOICE_RULE);
      expect(call[1]).toContain(TAGGING_RULE);
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
    expect(writes.filter((write) => write.name === 'postAgentActivity')[0]).toEqual(
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
    );
    if (status === 'completed' || status === 'failed')
      expect(writes.filter((write) => write.name === 'postAgentActivity')).toContainEqual(
        expect.objectContaining({
          input: expect.objectContaining({
            activity: expect.arrayContaining([
              expect.objectContaining({ kind: 'tool', title: 'beeline.pr_checks_status' }),
            ]),
          }),
        }),
      );
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

describe('corner turn institutional-memory prefetch', () => {
  it('starts the snapshot fetch before activation, and serves a snapshot slower than the raw budget when it still beats activation', async () => {
    vi.stubEnv('BEELINE_INSTITUTIONAL_MEMORY_ENABLED', 'true');
    const root = await mkdtemp(join(tmpdir(), 'beeline-corner-memory-prefetch-'));
    roots.push(root);
    await execFileAsync('git', ['init', root]);
    const runtime = {
      agentId: '11'.repeat(32),
      agent: stored('11'.repeat(32), 'Bee'),
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
      workspaceRoot: root,
      autoApprovePermissions: true,
    };
    const abort = new AbortController();
    const order: string[] = [];
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const receipts: Array<Record<string, unknown>> = [];
    const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'getAgentConfiguration') return { commands: [] };
      if (name === 'getWorkspaceRoster') {
        return {
          members: [{ identityId: '11'.repeat(32), kind: 'agent', name: 'Bee', role: 'member' }],
        };
      }
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getCornerCloseRequests') return { items: [], cursor: 'latest' };
      if (name === 'getRoomConversation') return { items: [], cursor: 'latest' };
      if (name === 'getCornerRestoreState') return { cornerId: 'corner-id' };
      if (name === 'getInstitutionalContext') {
        // Activation (below) takes 300ms; this snapshot alone needs 250ms —
        // longer than the raw 200ms budget on its own, but shorter than
        // activation, so a fetch started alongside activation (not after it)
        // has already resolved by the time the turn asks for it.
        order.push('institutional-context');
        await delay(250);
        return {
          snapshotRevision: 1,
          text: 'Prefetched institutional snapshot',
          itemIds: ['memory-1'],
          totalBytes: 34,
          omitted: {},
        };
      }
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
    const sessionNew = vi.spyOn(acp, 'sessionNew').mockImplementation(async () => {
      order.push('session-new');
      await delay(300);
      return { sessionId: 'corner-session', raw: {} };
    });
    const sessionPrompt = vi.spyOn(acp, 'sessionPrompt').mockResolvedValue({
      stopReason: 'end_turn',
      updates: [],
      agentText: 'Done.',
      toolCalls: [],
    });
    const scheduler = new SessionScheduler({ maxLiveSessions: 2 });
    let loop!: MonolithCornerTurnLoop;
    loop = new MonolithCornerTurnLoop({
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
      api: closePushAfterReceipt(
        commandFixtureApi(api, 'corner-id', runtime.agent.publicKey, 'Implement the widget'),
        () => loop,
        1,
      ),
      scheduler,
      signal: abort.signal,
      pollMs: 10,
      onPoll: vi.fn(),
      onFailure: vi.fn(),
      onCloseRequested: vi.fn(async () => undefined),
      createAcpClient: () => acp,
    });
    await loop.run();
    await scheduler.dispose();

    // The fetch was kicked off before activation was even called, not after
    // it resolved.
    expect(order).toEqual(['institutional-context', 'session-new']);
    expect(sessionNew).toHaveBeenCalledOnce();
    // A snapshot that took longer than the raw 200ms budget on its own is
    // still served, because it was already in flight once activation's own
    // 300ms gave it somewhere to finish.
    expect(String(sessionPrompt.mock.calls[0]?.[1])).toContain('Prefetched institutional snapshot');
    expect(receipts.some((receipt) => receipt.status === 'complete')).toBe(true);
  }, 10_000);
});

describe('corner turn rename prompt', () => {
  it('asks the agent to rename a corner that still has its generated name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-corner-rename-'));
    roots.push(root);
    await execFileAsync('git', ['init', root]);
    const runtime = {
      agentId: '11'.repeat(32),
      agent: stored('11'.repeat(32), 'Bee'),
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
      workspaceRoot: root,
      autoApprovePermissions: true,
    };
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentConfiguration') return { commands: [] };
      if (name === 'getWorkspaceRoster') {
        return {
          members: [{ identityId: '11'.repeat(32), kind: 'agent', name: 'Bee', role: 'member' }],
        };
      }
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getCornerCloseRequests') return { items: [], cursor: 'latest' };
      if (name === 'getRoomConversation') return { items: [], cursor: 'latest' };
      if (name === 'getCornerRestoreState')
        return {
          cornerId: 'corner-id',
          kind: 'human',
          title: 'still harbor corner',
          titleGenerated: true,
        };
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
    const sessionPrompt = vi.spyOn(acp, 'sessionPrompt').mockResolvedValue({
      stopReason: 'end_turn',
      updates: [],
      agentText: 'Done.',
      toolCalls: [],
    });
    const scheduler = new SessionScheduler({ maxLiveSessions: 2 });
    let loop!: MonolithCornerTurnLoop;
    loop = new MonolithCornerTurnLoop({
      cornerId: 'corner-id',
      parentRoomId: 'room-id',
      workspaceId: 'workspace',
      objective: 'still harbor corner',
      worktreePath: root,
      runtime,
      config,
      api: closePushAfterReceipt(
        commandFixtureApi(api, 'corner-id', runtime.agent.publicKey, 'Fix the login redirect'),
        () => loop,
        1,
      ),
      scheduler,
      signal: new AbortController().signal,
      pollMs: 10,
      onPoll: vi.fn(),
      onFailure: vi.fn(),
      onCloseRequested: vi.fn(async () => undefined),
      createAcpClient: () => acp,
    });
    await loop.run();
    await scheduler.dispose();

    expect(String(sessionPrompt.mock.calls[0]?.[1])).toContain(
      'This human-opened corner still has its generated name, "still harbor corner". If the newest human message states the work, call rename_corner once before you reply',
    );
  }, 10_000);
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
    const failure = new AcpTurnBackstopError(
      TURN_BACKSTOP_MS,
      'plan',
      'GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz',
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
    expect(reason).toContain('turn_backstop: no ACP traffic for 30 minutes; last activity: plan');
    expect(reason).toContain('[REDACTED]');
    expect(reason).not.toMatch(/ghp_abc|\n|\bat AcpClient/);
  });
});

describe('a context-window overflow', () => {
  const OVERFLOW =
    "400 This endpoint's maximum context length is 1048576 tokens. However, you requested about 1053212 tokens (109494 of text input, 943718 in the output).";

  /** A pi-acp corner whose sessions each leave a pi record the test chooses. */
  async function overflowCorner(answers: Array<'overflow' | string>) {
    const root = await mkdtemp(join(tmpdir(), 'beeline-corner-overflow-'));
    roots.push(root);
    await execFileAsync('git', ['init', root]);
    const piDir = join(root, 'pi');
    const sessions = join(piDir, 'sessions', 'corner');
    await mkdir(sessions, { recursive: true });
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
      agentBinary: '/opt/bin/pi-acp',
      agentKind: 'codex',
      agentCommand: '/opt/bin/pi-acp',
      agentArgs: [],
      mcpBinary: '/fake-dev-mcp',
    } as unknown as AgentRuntimeRecord;
    const config: BodyConfig = {
      agentBinary: '/opt/bin/pi-acp',
      agentKind: 'codex',
      agentCommand: '/opt/bin/pi-acp',
      agentArgs: [],
      mcpBinary: '/fake-dev-mcp',
      readonlyMcpCommand: '/fake-beeline-mcp',
      agentEnv: { HOME: join(root, 'user'), PI_CODING_AGENT_DIR: piDir },
      workspaceRoot: root,
      autoApprovePermissions: true,
    };
    const abort = new AbortController();
    let inboxReads = 0;
    const writes: Array<{ name: string; input: Record<string, unknown> }> = [];
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
                body: 'Go.',
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
    const acp = new AcpClient({ agentBinary: '/opt/bin/pi-acp', agentEnv: {} });
    vi.spyOn(acp, 'start').mockResolvedValue(undefined);
    let opened = 0;
    const sessionNew = vi.spyOn(acp, 'sessionNew').mockImplementation(async () => {
      opened += 1;
      return { sessionId: `session-${opened}`, raw: {} };
    });
    const prompted: string[] = [];
    vi.spyOn(acp, 'sessionPrompt').mockImplementation(async (sessionId) => {
      prompted.push(sessionId);
      const answer = answers[prompted.length - 1] ?? 'overflow';
      // pi records every turn in its own session file; an overflow is an
      // assistant message with stopReason "error" and no ACP text at all.
      await writeFile(
        join(sessions, `2026_${sessionId}.jsonl`),
        [
          JSON.stringify({ type: 'message', message: { role: 'user', content: [] } }),
          JSON.stringify({
            type: 'message',
            message:
              answer === 'overflow'
                ? { role: 'assistant', content: [], stopReason: 'error', errorMessage: OVERFLOW }
                : { role: 'assistant', content: [{ type: 'text', text: answer }], stopReason: 'stop' },
          }),
        ].join('\n'),
      );
      return {
        stopReason: 'end_turn',
        updates: [],
        agentText: answer === 'overflow' ? '' : answer,
        toolCalls: [],
      };
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
      .catch((error: unknown) => error);
    await vi.waitFor(
      () =>
        expect(receipts.some((receipt) => ['complete', 'failed'].includes(String(receipt.status)))).toBe(
          true,
        ),
      { timeout: 10_000 },
    );
    abort.abort();
    await running;
    await scheduler.dispose();
    return { receipts, writes, prompted, sessionNew };
  }

  it('answers from a fresh session instead of failing the turn', async () => {
    const { receipts, writes, prompted, sessionNew } = await overflowCorner([
      'overflow',
      'Recovered in a fresh session.',
    ]);
    // The overflowed session is dropped once; everything after runs in the
    // fresh one (a delivery nudge may follow the answer in that same session).
    expect(prompted.slice(0, 2)).toEqual(['session-1', 'session-2']);
    expect(new Set(prompted.slice(1))).toEqual(new Set(['session-2']));
    expect(sessionNew).toHaveBeenCalledTimes(2);
    expect(receipts.some((receipt) => receipt.status === 'failed')).toBe(false);
    expect(receipts.some((receipt) => receipt.status === 'complete')).toBe(true);
    expect(JSON.stringify(writes)).toContain('Recovered in a fresh session.');
  });

  it('fails as context-overflow after one fresh session, never as a restartable hiccup', async () => {
    const { receipts, prompted } = await overflowCorner(['overflow', 'overflow', 'overflow']);
    expect(prompted).toEqual(['session-1', 'session-2']);
    const failed = receipts.find((receipt) => receipt.status === 'failed')!;
    expect(failed.reasonKind).toBe('context-overflow');
    expect(String(failed.reason)).toContain("maximum context length is 1048576 tokens");
  });
});

describe('an instantly approved device grant', () => {
  it('continues the same corner turn in a new session that mounts the device', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-corner-device-'));
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
      bwrapPath: '/usr/bin/bwrap',
    };
    const abort = new AbortController();
    let inboxReads = 0;
    let granted = false;
    const writes: Array<{ name: string; input: Record<string, unknown> }> = [];
    const receipts: Array<Record<string, unknown>> = [];
    const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'getAgentConfiguration') return { commands: [] };
      if (name === 'getWorkspaceRoster') {
        return {
          members: [{ identityId: '11'.repeat(32), kind: 'agent', name: 'Bee', role: 'member' }],
        };
      }
      if (name === 'listAgentGrants') {
        return {
          grants: granted
            ? [{ grantId: 'g-9', kind: 'device', target: '/dev/ttyUSB0', status: 'approved' }]
            : [],
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
                body: 'Flash the board on the serial port.',
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
    const spawns: Array<ConstructorParameters<typeof AcpClient>[0]> = [];
    const acp = new AcpClient({ agentBinary: '/fake-agent', agentEnv: {} });
    vi.spyOn(acp, 'start').mockResolvedValue(undefined);
    vi.spyOn(acp, 'stop').mockResolvedValue(undefined);
    let opened = 0;
    vi.spyOn(acp, 'sessionNew').mockImplementation(async () => {
      opened += 1;
      return { sessionId: `session-${opened}`, raw: {} };
    });
    const prompts: Array<{ sessionId: string; prompt: string }> = [];
    vi.spyOn(acp, 'sessionPrompt').mockImplementation(async (sessionId, prompt) => {
      prompts.push({ sessionId, prompt: String(prompt) });
      if (prompts.length > 1) {
        return { stopReason: 'end_turn', updates: [], agentText: 'Flashed the board.', toolCalls: [] };
      }
      granted = true;
      return {
        stopReason: 'end_turn',
        updates: [],
        agentText: 'Got the serial port; continuing.',
        toolCalls: [
          {
            id: 'call-1',
            title: 'mcp__beeline-agent__request_grant',
            status: 'completed',
            content: [
              {
                type: 'text',
                text: 'approved: use /dev/ttyUSB0 [grant g-9]. A running session cannot add a device, so end your turn now with one short line; this same turn continues straight away in a session that has /dev/ttyUSB0. Do not ask anyone to restart.',
              },
            ],
          },
        ],
      };
    });
    const scheduler = new SessionScheduler({ maxLiveSessions: 2 });
    const running = new MonolithCornerTurnLoop({
      cornerId: 'corner-id',
      parentRoomId: 'room-id',
      workspaceId: 'workspace',
      objective: 'Flash the board',
      worktreePath: root,
      repository: {
        featureBranch: 'feature/board',
        targetBranch: 'main',
        gitCommonDir: join(root, '.git'),
        githubToken: 'token',
      },
      runtime,
      config,
      api: commandFixtureApi(api, 'corner-id', runtime.agent.publicKey, 'Flash the board'),
      scheduler,
      signal: abort.signal,
      pollMs: 10,
      onPoll: vi.fn(),
      onFailure: vi.fn(),
      onCloseRequested: vi.fn(async () => undefined),
      createAcpClient: (options) => {
        spawns.push(options);
        return acp;
      },
    })
      .run()
      .catch((error: unknown) => error);
    await vi.waitFor(
      () =>
        expect(receipts.some((receipt) => ['complete', 'failed'].includes(String(receipt.status)))).toBe(
          true,
        ),
      { timeout: 10_000 },
    );
    abort.abort();
    await running;
    await scheduler.dispose();

    expect(receipts.some((receipt) => receipt.status === 'complete')).toBe(true);
    expect(prompts.slice(0, 2).map((prompt) => prompt.sessionId)).toEqual(['session-1', 'session-2']);
    expect(prompts[1]!.prompt).toContain('/dev/ttyUSB0 is in this session now');
    expect(prompts[1]!.prompt).toContain('Newest message:\nFlash the board');
    expect(JSON.stringify(writes)).toContain('Flashed the board.');
    const argv = (spawn: ConstructorParameters<typeof AcpClient>[0]) =>
      [spawn.agentCommand ?? spawn.agentBinary, ...(spawn.agentArgs ?? [])].join(' ');
    expect(spawns).toHaveLength(2);
    expect(argv(spawns[0]!)).not.toContain('/dev/ttyUSB0');
    expect(argv(spawns[1]!)).toContain('--dev-bind-try /dev/ttyUSB0 /dev/ttyUSB0');
  });
});
