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

    expect(conversationReads).toEqual([{ roomId: 'corner', limit: 200, window: 'earliest' }]);
    // The objective was found. The failure that did happen is the clone, not a
    // corner whose opening message fell off the far end of the page.
    expect(failures.join('\n')).not.toContain('corner has no durable objective post');
    expect(failures.join('\n')).toContain('failed to start corner corner');
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
