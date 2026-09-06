import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThinDaemonCore } from './thin-core.js';
import { RoomRuntimeCoordinator, shouldPostInitialCornerWorkingState } from './room-runtime.js';
import { identityFromKey, stageMonolithAgentRuntime } from './runtime.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';

const roots: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('monolith-only thin daemon', () => {
  it('does not publish a fresh working state when restoring a corner with remote PR facts', () => {
    expect(
      shouldPostInitialCornerWorkingState({
        cornerId: 'corner',
        featureBranch: 'feature/corner',
        closeRequested: false,
        lifecycle: {
          lifecycle: 'in-review',
          branch: 'feature/corner',
          checks: 'passing',
          pr: {
            number: 3,
            url: 'https://github.com/example/repo/pull/3',
            title: 'Keep the review facts',
            targetBranch: 'main',
            headSha: 'a'.repeat(40),
            mergeability: 'clean',
          },
        },
      }),
    ).toBe(false);
  });

  it('stages and reads only an authenticated monolith runtime', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-thin-runtime-'));
    roots.push(root);
    const staged = await stageMonolithAgentRuntime({
      workspaceId: 'workspace',
      pairedBy: 'human',
      daemonExchangeToken: `bde_${'a'.repeat(43)}`,
      agentBinary: 'codex-acp',
      agentKind: 'codex',
      agentCommand: 'codex-acp',
      agentArgs: [],
      mcpBinary: 'unused',
      agentIdentity: identityFromKey('11'.repeat(32), 'Bee'),
      bodyIdentity: identityFromKey('22'.repeat(32), 'Body'),
      supervisorRoot: root,
    });
    expect(staged.runtime.transport).toMatchObject({ kind: 'monolith' });
    expect(staged.runtime.rooms).toEqual([]);
    // Nobody but the person who paired it may drive it, unless they said so.
    expect(staged.runtime.accessPolicy).toBe('creator');
  });

  it('stages the access policy connect was given, so a greeter can answer anyone', async () => {
    // A Room's greeter must answer the people it greets, and a newcomer is
    // never its creator: `usebeeline connect --access everyone`.
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-thin-access-'));
    roots.push(root);
    const staged = await stageMonolithAgentRuntime({
      workspaceId: 'workspace',
      pairedBy: 'human',
      daemonExchangeToken: `bde_${'c'.repeat(43)}`,
      agentBinary: 'pi-acp',
      agentKind: 'pi',
      agentCommand: 'pi-acp',
      agentArgs: [],
      mcpBinary: 'unused',
      agentIdentity: identityFromKey('55'.repeat(32), 'Hoots'),
      bodyIdentity: identityFromKey('66'.repeat(32), 'Body'),
      supervisorRoot: root,
      accessPolicy: 'everyone',
    });
    expect(staged.runtime.accessPolicy).toBe('everyone');
  });

  it('discovers Rooms through the daemon API and never constructs relay transport', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-thin-core-'));
    roots.push(root);
    const staged = await stageMonolithAgentRuntime({
      workspaceId: 'workspace',
      pairedBy: 'human',
      daemonExchangeToken: `bde_${'b'.repeat(43)}`,
      agentBinary: '/nonexistent',
      agentKind: 'codex',
      agentCommand: '/nonexistent',
      agentArgs: [],
      mcpBinary: 'unused',
      agentIdentity: identityFromKey('33'.repeat(32), 'Bee'),
      bodyIdentity: identityFromKey('44'.repeat(32), 'Body'),
      supervisorRoot: root,
    });
    const execute = vi.fn(async (name: string) => {
      if (name === 'getDaemonBootstrap') return { workspaceIds: ['workspace'], rooms: [{ roomId: 'room', archived: false }] };
      if (name === 'listRoomCorners') return { corners: [] };
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      return { id: 'write', createdAt: 1 };
    });
    const api = { execute } as unknown as DaemonApiClient;
    const config: BodyConfig = {
      agentBinary: '/nonexistent',
      agentKind: 'codex',
      agentCommand: '/nonexistent',
      agentArgs: [],
      mcpBinary: 'unused',
      readonlyMcpCommand: '/nonexistent',
      agentEnv: {},
      workspaceRoot: root,
      autoApprovePermissions: false,
    };
    const controller = new AbortController();
    const core = new ThinDaemonCore(staged.runtime, staged.configPath, config, { daemonApi: api });
    const result = core.run({
      pollMs: 1,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    await expect(result).resolves.toBe('aborted');
    expect(execute).toHaveBeenCalledWith('getDaemonBootstrap', expect.any(Object));
    expect(execute).toHaveBeenCalledWith('postAgentPresence', expect.objectContaining({ roomId: 'room' }));
  });

  it('recovers a corner objective from the OLDEST page, not the newest one', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-corner-objective-'));
    roots.push(root);
    const staged = await stageMonolithAgentRuntime({
      workspaceId: 'workspace',
      pairedBy: 'human',
      daemonExchangeToken: `bde_${'c'.repeat(43)}`,
      agentBinary: '/nonexistent',
      agentKind: 'codex',
      agentCommand: '/nonexistent',
      agentArgs: [],
      mcpBinary: 'unused',
      agentIdentity: identityFromKey('77'.repeat(32), 'Bee'),
      bodyIdentity: identityFromKey('88'.repeat(32), 'Body'),
      supervisorRoot: root,
    });
    const HANDOFF = [
      'Handoff from the parent Room: add a `--dry-run` flag to the importer CLI.',
      'It must print the plan it would apply and exit 0 without touching the database.',
    ].join(' ');
    // The server answers the default window with the newest page; only the
    // `earliest` window reaches back to the corner's opening message.
    const conversationReads: Array<Record<string, unknown>> = [];
    const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'getCornerRestoreState') return { cornerId: 'corner', lifecycle: {} };
      if (name === 'getRoomGitHubToken') return { token: 'gh-token' };
      if (name === 'getRoomRepositoryState') {
        return {
          resolution: 'repository' as const,
          remote: 'https://github.example/x/y',
          targetBranch: 'main',
        };
      }
      if (name === 'getRoomConversation') {
        conversationReads.push(input);
        const items =
          input.window === 'earliest'
            ? [
                {
                  id: 'row-1',
                  authorId: 'human',
                  createdAt: 1,
                  type: 'message',
                  body: HANDOFF,
                  mentionIds: [],
                  attachments: [],
                },
                {
                  id: 'row-2',
                  authorId: 'agent',
                  createdAt: 2,
                  type: 'message',
                  body: 'on it',
                  mentionIds: [],
                  attachments: [],
                },
              ]
            : [
                {
                  id: 'row-249',
                  authorId: 'agent',
                  createdAt: 249,
                  type: 'message',
                  body: 'pushed the branch',
                  mentionIds: [],
                  attachments: [],
                },
              ];
        return { items, cursor: 'c' };
      }
      throw new Error(`unexpected daemon operation: ${name}`);
    });
    const failures: string[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
      failures.push(
        parts.map((part) => (part instanceof Error ? part.message : String(part))).join(' '),
      );
    });
    const coordinator = new RoomRuntimeCoordinator(
      staged.runtime,
      staged.configPath,
      { workspaceRoot: root } as BodyConfig,
      { daemonApi: { execute } as unknown as DaemonApiClient },
    );
    // The clone against a bogus remote is what ends this run; everything the
    // objective depends on has already happened by then.
    await (
      coordinator as unknown as {
        startCorner(corner: { cornerId: string; parentRoomId: string }): Promise<void>;
      }
    ).startCorner({ cornerId: 'corner', parentRoomId: 'room' });
    error.mockRestore();

    // The objective read is the one that asks for the OLDEST page. The second
    // read is the start-failure report looking for the message that asked for
    // this corner, so the agent says why it could not open it.
    expect(conversationReads[0]).toEqual({ roomId: 'corner', limit: 200, window: 'earliest' });
    expect(
      conversationReads.filter((read) => (read as { window?: string }).window === 'earliest'),
    ).toHaveLength(1);
    // The objective was found. The failure that did happen is the clone, not a
    // corner whose opening message fell off the far end of the page.
    expect(failures.join('\n')).not.toContain('corner has no durable objective post');
    expect(failures.join('\n')).toContain('failed to start corner corner');
  });

  it('says why it could not open a corner it was addressed in, instead of nothing', async () => {
    // A corner is carried by its members, so a helper is now told to open one
    // it has never touched. A restore that fails there used to be a daemon log
    // line and total silence in the corner itself.
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-corner-restore-fail-'));
    roots.push(root);
    const staged = await stageMonolithAgentRuntime({
      workspaceId: 'workspace',
      pairedBy: 'human',
      daemonExchangeToken: `bde_${'a'.repeat(43)}`,
      agentBinary: '/nonexistent',
      agentKind: 'codex',
      agentCommand: '/nonexistent',
      agentArgs: [],
      mcpBinary: 'unused',
      agentIdentity: identityFromKey('99'.repeat(32), 'Goosy'),
      bodyIdentity: identityFromKey('aa'.repeat(32), 'Body'),
      supervisorRoot: root,
    });
    const agentId = staged.runtime.agent.publicKey;
    const receipts: Array<Record<string, unknown>> = [];
    const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'getCornerRestoreState') return { cornerId: 'corner', lifecycle: {} };
      if (name === 'getRoomGitHubToken') return { token: 'gh-token' };
      if (name === 'getRoomRepositoryState') {
        return {
          resolution: 'repository' as const,
          // Unreachable: standing in for the restore that cannot be done.
          remote: 'https://github.example/x/y',
          targetBranch: 'main',
        };
      }
      if (name === 'getRoomConversation') {
        return {
          items: [
            {
              id: 'objective-row',
              authorId: 'human',
              createdAt: 1,
              type: 'message',
              body: 'Rip out the legacy path.',
              mentionIds: [],
              attachments: [],
            },
            {
              id: 'handoff-row',
              authorId: 'human',
              createdAt: 2,
              type: 'message',
              body: '@Goosy can you pick up where Codex left off?',
              mentionIds: [agentId],
              attachments: [],
            },
          ],
          cursor: 'c',
        };
      }
      if (name === 'postAgentTurnReceipt') {
        receipts.push(input);
        return { id: 'receipt', createdAt: 1 };
      }
      throw new Error(`unexpected daemon operation: ${name}`);
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const coordinator = new RoomRuntimeCoordinator(
      staged.runtime,
      staged.configPath,
      { workspaceRoot: root } as BodyConfig,
      { daemonApi: { execute } as unknown as DaemonApiClient },
    );
    const start = coordinator as unknown as {
      startCorner(corner: { cornerId: string; parentRoomId: string }): Promise<void>;
    };
    await start.startCorner({ cornerId: 'corner', parentRoomId: 'room' });
    error.mockRestore();

    // The failed receipt carries the reason; the server turns it into
    // `<agent> could not answer · <reason>` against the message that asked.
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      roomId: 'corner',
      requestId: 'handoff-row',
      status: 'failed',
      agentId,
    });
    expect(String(receipts[0]!.reason)).not.toBe('');
  });

  it('materializes the server-bound repository as a Room inspection checkout', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-room-checkout-'));
    roots.push(root);
    const repositoryRoot = join(root, 'source');
    await mkdir(repositoryRoot);
    await writeFile(join(repositoryRoot, 'ROOM_PROOF.md'), 'searchable Room checkout\n');
    await execFileAsync('git', ['init', '--initial-branch=main', repositoryRoot]);
    await execFileAsync('git', ['-C', repositoryRoot, 'config', 'user.name', 'Room proof']);
    await execFileAsync('git', ['-C', repositoryRoot, 'config', 'user.email', 'room@example.test']);
    await execFileAsync('git', ['-C', repositoryRoot, 'add', 'ROOM_PROOF.md']);
    await execFileAsync('git', ['-C', repositoryRoot, 'commit', '-m', 'room proof fixture']);
    const staged = await stageMonolithAgentRuntime({
      workspaceId: 'workspace',
      pairedBy: 'human',
      daemonExchangeToken: `bde_${'c'.repeat(43)}`,
      agentBinary: '/nonexistent',
      agentKind: 'codex',
      agentCommand: '/nonexistent',
      agentArgs: [],
      mcpBinary: 'unused',
      agentIdentity: identityFromKey('55'.repeat(32), 'Bee'),
      bodyIdentity: identityFromKey('66'.repeat(32), 'Body'),
      supervisorRoot: root,
    });
    const execute = vi.fn(async (name: string) => {
      if (name === 'getRoomRepositoryState') {
        return {
          resolution: 'repository' as const,
          remote: `file://${repositoryRoot}`,
          targetBranch: 'main',
        };
      }
      throw new Error(`unexpected daemon operation: ${name}`);
    });
    const coordinator = new RoomRuntimeCoordinator(
      staged.runtime,
      staged.configPath,
      { workspaceRoot: root } as BodyConfig,
      { daemonApi: { execute } as unknown as DaemonApiClient },
    );
    const checkout = await (
      coordinator as unknown as { materializeRoomCheckout(roomId: string): Promise<string> }
    ).materializeRoomCheckout('room');

    await expect(readFile(join(checkout, 'ROOM_PROOF.md'), 'utf8')).resolves.toContain('searchable Room checkout');
    expect(execute).toHaveBeenCalledWith('getRoomRepositoryState', { roomId: 'room' });
  });
});
