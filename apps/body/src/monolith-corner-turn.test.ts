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
  CORNER_DELIVERY_NUDGE,
  CORNER_YOLO_MERGE_NUDGE,
  cornerClosePollMs,
  cornerHasUndeliveredRepositoryWork,
  cornerMergeInstruction,
  cornerToolActivity,
  MonolithCornerTurnLoop,
} from './monolith-corner-turn.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { SOUL_HOUSE_RULE } from './response-directives.js';
import { attachFile, writeScratchFile } from './read-only-mcp.js';
import { SessionScheduler } from './session-scheduler.js';
import { sharedNpmCacheDir } from './warm-node-modules.js';

const roots: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => {
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
  it('allows autonomous merge only in yolo mode', () => {
    expect(cornerMergeInstruction(true)).toContain('merge this pull request with gh');
    expect(cornerMergeInstruction(false)).toContain('never merge');
    expect(cornerMergeInstruction(false)).toContain('explicit human approval');
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
    await execFileAsync('git', [
      '-C',
      root,
      'update-ref',
      'refs/remotes/origin/main',
      'HEAD~1',
    ]);
    expect(await cornerHasUndeliveredRepositoryWork(root, 'feature/widget', 'main')).toBe(true);
  });

  it('keeps delivery cleanup under agent control and the merge reminder behind yolo', () => {
    expect(CORNER_DELIVERY_NUDGE).toContain('commit and push');
    expect(CORNER_DELIVERY_NUDGE).toContain('do not discard');
    expect(CORNER_YOLO_MERGE_NUDGE).toContain('Yolo is on');
    expect(CORNER_YOLO_MERGE_NUDGE).toContain('pr_checks_status');
  });
});

describe('corner close-request polling cadence', () => {
  it('polls on a 10-15 second interval with jitter, not once per second', () => {
    expect(cornerClosePollMs(() => 0)).toBeGreaterThanOrEqual(10_000);
    expect(cornerClosePollMs(() => 0)).toBeLessThanOrEqual(12_000);
    expect(cornerClosePollMs(() => 0.999)).toBeGreaterThanOrEqual(12_000);
    expect(cornerClosePollMs(() => 0.999)).toBeLessThanOrEqual(15_000);
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
      await attachFile(
        { path: 'clips/demo.mp4' },
        {
          roots: [env.get('BEELINE_ATTACH_ROOT')!, env.get('BEELINE_ATTACH_SCRATCH_ROOT')!],
          baseUrl: 'https://server.example',
          token: 'daemon-token',
          roomId: 'corner-id',
          upload: async (bytes, mimeType, name) => ({
            url: 'https://server.example/v1/media/clip',
            name,
            mimeType,
            size: bytes.length,
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
      systemPrompt: expect.stringContaining('chat-only corner with no repository'),
    });
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
                mentionIds: [TEST_AGENT_PUBLIC_KEY],
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
                mentionIds: [TEST_AGENT_PUBLIC_KEY],
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
    expect(draftTexts.at(-1)).toBe('I inspected the code.\n\nThe fix is ready.');
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
        onPoll,
        onFailure: vi.fn(),
        onCloseRequested: async () => undefined,
        createAcpClient: () => acp,
      }),
      scheduler,
    };
  }

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
                mentionIds: [TEST_AGENT_PUBLIC_KEY],
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
                mentionIds: [TEST_AGENT_PUBLIC_KEY],
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
                mentionIds: [TEST_AGENT_PUBLIC_KEY],
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
                mentionIds: [TEST_AGENT_PUBLIC_KEY],
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
                mentionIds: [TEST_AGENT_PUBLIC_KEY],
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
                mentionIds: [TEST_AGENT_PUBLIC_KEY],
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
                mentionIds: [TEST_AGENT_PUBLIC_KEY],
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
              mentionIds: [],
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
    await running;
    await scheduler.dispose();
    expect(closeReads).toBe(2);
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
    // A short poll interval stands in for the wake's failure: the loop still
    // reaches the second intake through the ordinary timed wait.
    const { loop, scheduler } = await cornerHarness(execute, 20);
    await loop.run();
    await scheduler.dispose();
    expect(closeReads).toBe(2);
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
    const root = await mkdtemp(join(tmpdir(), 'beeline-thin-corner-'));
    roots.push(root);
    const worktree = join(root, 'worktree');
    const gitCommonDir = join(root, 'repo.git');
    await Promise.all([mkdir(worktree), mkdir(gitCommonDir)]);
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
                mentionIds: [],
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
              mentionIds: [],
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
              mentionIds: [],
              attachments: [],
            })),
          ],
          cursor: 'latest',
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
        const checksTurn =
          prompt.includes('passed a check') || prompt === CORNER_YOLO_MERGE_NUDGE;
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
    expect(sessionPrompt).toHaveBeenCalledTimes(3);
    expect(onCloseRequested).toHaveBeenCalledOnce();
    expect(sessionPrompt.mock.calls[1]?.[1]).toContain('passed a check');
    expect(sessionPrompt.mock.calls[2]?.[1]).toBe(CORNER_YOLO_MERGE_NUDGE);
    // The first turn on a cold session renders the whole transcript window.
    const firstPrompt = String(sessionPrompt.mock.calls[0]?.[1]);
    const secondPrompt = String(sessionPrompt.mock.calls[1]?.[1]);
    expect(firstPrompt).toContain('Corner transcript:');
    expect(firstPrompt).toContain('corner row 1');
    // The second turn is the SAME warm session: it sends only what is new, and
    // the objective — which lives outside the transcript window — still rides
    // on every prompt.
    expect(secondPrompt).toContain('New in the corner since your last turn');
    expect(secondPrompt).not.toContain('corner row 1\n');
    expect(firstPrompt).toContain('Corner objective:\nImplement the widget');
    expect(secondPrompt).toContain('Corner objective:\nImplement the widget');
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
          'Never restate server check or merge notes',
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
                mentionIds: [],
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
