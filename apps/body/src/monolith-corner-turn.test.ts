import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import {
  cornerClosePollMs,
  cornerToolActivity,
  MonolithCornerTurnLoop,
} from './monolith-corner-turn.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { SOUL_HOUSE_RULE } from './response-directives.js';
import { SessionScheduler } from './session-scheduler.js';

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

describe('corner close-request polling cadence', () => {
  it('polls on a 10-15 second interval with jitter, not once per second', () => {
    expect(cornerClosePollMs(() => 0)).toBeGreaterThanOrEqual(10_000);
    expect(cornerClosePollMs(() => 0)).toBeLessThanOrEqual(12_000);
    expect(cornerClosePollMs(() => 0.999)).toBeGreaterThanOrEqual(12_000);
    expect(cornerClosePollMs(() => 0.999)).toBeLessThanOrEqual(15_000);
    expect(cornerClosePollMs(() => 0.5)).not.toBe(cornerClosePollMs(() => 0.75));
  });

  it('re-checks close requests immediately after a turn completes', async () => {
    // pollMs is far beyond the test timeout: the flow turns once, then the
    // next close-request read must happen without any idle wait — a
    // regression that waits the full interval after a turn would hang.
    const root = await mkdtemp(join(tmpdir(), 'beeline-corner-immediate-'));
    roots.push(root);
    await execFileAsync('git', ['init', root]);
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
                mentionIds: [],
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
    const sessionPrompt = vi.spyOn(acp, 'sessionPrompt').mockResolvedValue({
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
      featureBranch: 'feature/widget',
      targetBranch: 'main',
      worktreePath: worktree,
      gitCommonDir,
      githubToken: 'token',
      runtime,
      config,
      api,
      scheduler,
      signal: abort.signal,
      pollMs: 60_000,
      onPoll: vi.fn(),
      onFailure: vi.fn(),
      onCloseRequested,
      createAcpClient: () => acp,
    }).run();
    await scheduler.dispose();
    expect(sessionPrompt).toHaveBeenCalledTimes(2);
    expect(onCloseRequested).toHaveBeenCalledOnce();
  });

  it('keeps completed narration segments as durable corner ledger lines, not only the final', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-corner-narration-'));
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
                mentionIds: [],
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
      async (_id, _prompt, _timeout, draft, _activity, _toolActivity) => {
        promptCalls += 1;
        if (promptCalls > 1) {
          return { stopReason: 'end_turn', updates: [], agentText: 'All done.', toolCalls: [] };
        }
        draft?.('I will', 'I will');
        draft?.(
          'I will update only the ledger.',
          'I will update only the ledger.',
        );
        draft?.(
          'I will update only the ledger. Then commit.',
          'I will update only the ledger. Then commit.',
        );
        return {
          stopReason: 'end_turn',
          updates: [],
          agentText: 'I will update only the ledger. Then commit.',
          toolCalls: [],
        };
      },
    );
    const scheduler = new SessionScheduler({ maxLiveSessions: 2 });
    await new MonolithCornerTurnLoop({
      cornerId: 'corner-id',
      parentRoomId: 'room-id',
      workspaceId: 'workspace',
      objective: 'Implement the widget',
      featureBranch: 'feature/widget',
      targetBranch: 'main',
      worktreePath: root,
      gitCommonDir: join(root, '.git'),
      githubToken: 'token',
      runtime,
      config,
      api,
      scheduler,
      signal: abort.signal,
      pollMs: 60_000,
      onPoll: vi.fn(),
      onFailure: vi.fn(),
      onCloseRequested: vi.fn(async () => undefined),
      createAcpClient: () => acp,
    }).run();
    await scheduler.dispose();

    // The completed narration segment lands as a durable colloquial line
    // with NO request id: it must never settle the turn's receipt.
    const narrationPosts = writes.filter(
      (write) =>
        write.name === 'postRoomMessage' &&
        write.input.presentation === 'message' &&
        write.input.requestId === undefined,
    );
    expect(narrationPosts).toEqual([
      expect.objectContaining({
        input: expect.objectContaining({
          roomId: 'corner-id',
          text: 'I will update only the ledger.',
        }),
      }),
    ]);
    // The durable final carries only the un-posted tail, under the turn's
    // request id so it settles the receipt.
    expect(writes).toContainEqual(
      expect.objectContaining({
        name: 'postRoomMessage',
        input: expect.objectContaining({
          roomId: 'corner-id',
          requestId: 'cornerid',
          text: 'Then commit.',
          presentation: 'message',
        }),
      }),
    );
    expect(
      writes.filter(
        (write) =>
          write.name === 'postRoomMessage' && write.input.text === 'I will update only the ledger. Then commit.',
      ),
    ).toEqual([]);
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
              requestId: 'request-id',
              attachments: [],
            },
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
        const checksTurn = prompt.includes('passed a check');
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
      featureBranch: 'feature/widget',
      targetBranch: 'main',
      worktreePath: worktree,
      gitCommonDir,
      githubToken: 'room-installation-token',
      runtime,
      config,
      api,
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
    expect(sessionPrompt).toHaveBeenCalledTimes(2);
    expect(onCloseRequested).toHaveBeenCalledOnce();
    expect(sessionPrompt.mock.calls[1]?.[1]).toContain('passed a check');
    expect(sessionNew).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: worktree,
        mode: 'edit',
        mcpServers: expect.arrayContaining([
          expect.objectContaining({
            name: 'buzz-dev-mcp',
            env: [
              { name: 'GH_TOKEN', value: 'room-installation-token' },
              { name: 'GITHUB_TOKEN', value: 'room-installation-token' },
            ],
          }),
          expect.objectContaining({ name: 'beeline-agent' }),
        ]),
        systemPrompt: expect.stringContaining('server-posted checks-passed note'),
      }),
    );
    expect(sessionNew).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining(
          'Merge the PR yourself only after the checks-passed event shows every check green; if any check failed or is still running, say exactly which and stop - never merge red.',
        ),
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
          'GitHub check and merge notes are server lines already in the corner: never restate them',
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
    for (const call of sessionPrompt.mock.calls) {
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
    const failure = new Error('ACP session/prompt timed out after 120000ms of inactivity GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz');
    failure.stack = `${failure.message}\n    at AcpClient.request (/opt/beeline/acp.js:984:20)`;
    vi.spyOn(acp, 'sessionPrompt')
      .mockRejectedValueOnce(failure)
      .mockResolvedValue({ stopReason: 'end_turn', updates: [], agentText: 'Recovered.', toolCalls: [] });
    const scheduler = new SessionScheduler({ maxLiveSessions: 2 });
    const running = new MonolithCornerTurnLoop({
      cornerId: 'corner-id',
      parentRoomId: 'room-id',
      workspaceId: 'workspace',
      objective: 'Implement the widget',
      featureBranch: 'feature/widget',
      targetBranch: 'main',
      worktreePath: root,
      gitCommonDir: join(root, '.git'),
      githubToken: 'token',
      runtime,
      config,
      api,
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
    await expect(running).resolves.toBe(failure);
    await scheduler.dispose();

    const failed = receipts.find((receipt) => receipt.status === 'failed')!;
    expect(failed).toEqual(expect.objectContaining({ roomId: 'corner-id', status: 'failed' }));
    const reason = failed.reason as string;
    expect(reason).toContain('timed out after 120000ms of inactivity');
    expect(reason).toContain('[REDACTED]');
    expect(reason).not.toMatch(/ghp_abc|\n|\bat AcpClient/);
  });
});

describe('corner check notes', () => {
  const AGENT_SECRET = '11'.repeat(32);

  async function runChecksFlow(
    polls: ReadonlyArray<{
      notes: ReadonlyArray<{ id: string; verb: string; object: string }>;
      checks?: 'passing' | 'failing' | 'pending';
    }>,
    answer: (prompt: string) => string,
  ) {
    const root = await mkdtemp(join(tmpdir(), 'beeline-corner-checks-'));
    roots.push(root);
    await execFileAsync('git', ['init', root]);
    const agent = stored(AGENT_SECRET, 'Bee');
    const AGENT = agent.publicKey;
    const runtime = {
      agent,
      rooms: [],
      supervisorRoot: root,
      transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
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
    const writes: Array<{ name: string; input: Record<string, unknown> }> = [];
    let closeReads = 0;
    let checks: 'passing' | 'failing' | 'pending' | undefined;
    const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'getAgentConfiguration') return { commands: [] };
      if (name === 'getWorkspaceRoster') {
        return { members: [{ identityId: AGENT, kind: 'agent', name: 'Bee', role: 'member' }] };
      }
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getCornerRestoreState') {
        return { cornerId: 'corner-id', closeRequested: false, ...(checks ? { lifecycle: { lifecycle: 'in-review', checks } } : {}) };
      }
      if (name === 'getCornerCloseRequests') {
        const poll = polls[closeReads];
        closeReads += 1;
        if (!poll) return { items: [], cursor: 'latest', closeRequested: true };
        checks = poll.checks;
        return {
          items: poll.notes.map((note) => ({
            id: note.id,
            authorId: '33'.repeat(32),
            createdAt: closeReads,
            type: 'system',
            body: `GitHub ${note.verb} ${note.object}`,
            systemEvent: {
              subject: { kind: 'github', name: 'GitHub' },
              verb: note.verb,
              object: { text: note.object },
            },
            mentionIds: [],
            attachments: [],
          })),
          cursor: poll.notes[poll.notes.length - 1]?.id ?? 'latest',
        };
      }
      if (name === 'getRoomConversation') {
        // One durable agent reply already exists, so the loop does not re-run the objective.
        return {
          items: [
            {
              id: 'pr-line',
              authorId: AGENT,
              createdAt: 1,
              type: 'message',
              body: 'PR: https://github.com/acme/widgets/pull/7',
              mentionIds: [],
              attachments: [],
            },
          ],
          cursor: 'latest',
        };
      }
      writes.push({ name, input });
      return { id: 'write-id', createdAt: 1 };
    });
    const api = {
      execute,
      connection: () => ({ baseUrl: 'https://server.example', daemonToken: 'token', agentId: AGENT }),
    } as unknown as DaemonApiClient;
    const acp = new AcpClient({ agentBinary: '/fake-agent', agentEnv: {} });
    vi.spyOn(acp, 'start').mockResolvedValue(undefined);
    vi.spyOn(acp, 'sessionNew').mockResolvedValue({ sessionId: 'corner-session', raw: {} });
    const sessionPrompt = vi
      .spyOn(acp, 'sessionPrompt')
      .mockImplementation(async (_id, prompt, _timeout, draft) => {
        const text = answer(prompt);
        // Stream in two halves so a sentence boundary posts a narration segment.
        const half = Math.ceil(text.length / 2);
        draft?.(text.slice(0, half), text.slice(0, half));
        draft?.(text.slice(half), text);
        return { stopReason: 'end_turn', updates: [], agentText: text, toolCalls: [] };
      });
    const scheduler = new SessionScheduler({ maxLiveSessions: 2 });
    await new MonolithCornerTurnLoop({
      cornerId: 'corner-id',
      parentRoomId: 'room-id',
      workspaceId: 'workspace',
      objective: 'Implement the widget',
      featureBranch: 'feature/widget',
      targetBranch: 'main',
      worktreePath: root,
      gitCommonDir: join(root, '.git'),
      githubToken: 'token',
      runtime,
      config,
      api,
      scheduler,
      signal: abort.signal,
      pollMs: 1,
      onPoll: vi.fn(),
      onFailure: vi.fn(),
      onCloseRequested: vi.fn(async () => undefined),
      createAcpClient: () => acp,
    }).run();
    await scheduler.dispose();
    const messages = writes
      .filter((write) => write.name === 'postRoomMessage')
      .map((write) => write.input.text as string);
    const receipts = writes
      .filter((write) => write.name === 'postAgentTurnReceipt')
      .map((write) => ({ requestId: write.input.requestId, status: write.input.status }));
    return { prompts: sessionPrompt.mock.calls.map((call) => call[1] as string), messages, receipts };
  }

  it('starts one turn per changed server check state, never per delivered note', async () => {
    const { prompts, messages, receipts } = await runChecksFlow(
      [
        { notes: [{ id: 'ci-start', verb: 'started a check', object: 'Beeline CI' }], checks: 'pending' },
        { notes: [{ id: 'ci-fail', verb: 'failed a check', object: 'Beeline CI' }], checks: 'failing' },
        { notes: [{ id: 'ci-fail-again', verb: 'failed a check', object: 'Beeline CI' }], checks: 'failing' },
        { notes: [{ id: 'ci-restart', verb: 'started a check', object: 'Beeline CI' }], checks: 'pending' },
        { notes: [{ id: 'ci-pass', verb: 'passed a check', object: 'Beeline CI' }], checks: 'pending' },
        {
          notes: [
            { id: 'lint-pass', verb: 'passed a check', object: 'Lint' },
            { id: 'build-pass', verb: 'passed a check', object: 'Build' },
          ],
          checks: 'passing',
        },
        { notes: [{ id: 'lint-pass-again', verb: 'passed a check', object: 'Lint' }], checks: 'passing' },
      ],
      (prompt) =>
        prompt.includes('failed a check')
          ? 'Beeline CI failed on the typecheck step; pushing a fix.'
          : 'PR checks have passed. CI has passed.',
    );

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('GitHub failed a check Beeline CI');
    // Every completed note of one poll rides in that one turn.
    expect(prompts[1]).toContain('GitHub passed a check Lint\nGitHub passed a check Build');
    // The failing turn said something new and it stayed; the green turn only
    // restated the server's lines and nothing reached the Room.
    expect(messages).toEqual(['Beeline CI failed on the typecheck step; pushing a fix.']);
    expect(receipts).toEqual([
      { requestId: 'ci-fail', status: 'working' },
      { requestId: 'ci-fail', status: 'complete' },
      { requestId: 'build-pass', status: 'working' },
      { requestId: 'build-pass', status: 'complete' },
    ]);
  });

  it('keeps a green turn that acts, and falls back to the notes when the server carries no state', async () => {
    const { prompts, messages, receipts } = await runChecksFlow(
      [{ notes: [{ id: 'ci-pass', verb: 'passed a check', object: 'Beeline CI' }] }],
      () => 'Checks passed. Merged https://github.com/acme/widgets/pull/7',
    );
    expect(prompts).toHaveLength(1);
    // The narration segment "Checks passed." restates the note and is dropped;
    // the merge line is a new fact and lands.
    expect(messages).toEqual(['Merged https://github.com/acme/widgets/pull/7']);
    expect(receipts).toEqual([
      { requestId: 'ci-pass', status: 'working' },
      { requestId: 'ci-pass', status: 'complete' },
    ]);
  });

  it('settles a silent green turn through its receipt instead of failing it', async () => {
    const { messages, receipts } = await runChecksFlow(
      [{ notes: [{ id: 'ci-pass', verb: 'passed a check', object: 'Beeline CI' }], checks: 'passing' }],
      () => '',
    );
    expect(messages).toEqual([]);
    expect(receipts).toEqual([
      { requestId: 'ci-pass', status: 'working' },
      { requestId: 'ci-pass', status: 'complete' },
    ]);
  });
});
