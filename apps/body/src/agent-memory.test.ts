/**
 * Hermetic tests for Beeline-managed agent memory (`agent-memory.ts`) and its
 * wiring: writable in read-only Rooms and corners alike, durable across
 * simulated restarts, scoped per-(agent, workspace), and never widening the
 * Room read-only repo boundary.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENT_MEMORY_ENV,
  MEMORY_FILE_NAME,
  agentMemoryInstructions,
  memoryScopeKey,
  prepareAgentMemory,
} from './agent-memory.js';
import {
  classifyRoomPermission,
  isAgentMemoryWritePermissionRequest,
} from './session-sandbox.js';
import { sandboxMountPlan, type SandboxSessionSpec } from './bwrap-sandbox.js';
import { Body } from './body.js';
import type { BodyConfig } from './config.js';
import { AcpClient } from './acp.js';
import { newIdentity } from '@beeline/gate';

const roots: string[] = [];
function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('memory scope', () => {
  it('keys per workspace, sanitizing the community id', () => {
    expect(memoryScopeKey('3f2b9c1e-4a5d-6789-abcd-ef0123456789')).toBe(
      '3f2b9c1e-4a5d-6789-abcd-ef0123456789',
    );
    // Path-traversal-shaped input cannot escape the memory root: separators
    // are stripped, and an all-separator input falls back to the safe bucket.
    expect(memoryScopeKey('../../elsewhere')).toBe('elsewhere');
    expect(memoryScopeKey('../..')).toBe('global');
    expect(memoryScopeKey('')).toBe('global');
    expect(memoryScopeKey(null)).toBe('global');
    expect(memoryScopeKey(undefined)).toBe('global');
  });

  it('isolates workspaces and agents from each other', async () => {
    const agentARoot = tempRoot('buzzy-mem-agent-a-');
    const agentBRoot = tempRoot('buzzy-mem-agent-b-');
    const wsX = await prepareAgentMemory({ root: agentARoot, communityId: 'workspace-x' });
    const wsY = await prepareAgentMemory({ root: agentARoot, communityId: 'workspace-y' });
    const agentBWsX = await prepareAgentMemory({ root: agentBRoot, communityId: 'workspace-x' });

    expect(wsX.dir).not.toBe(wsY.dir);
    expect(wsX.file).not.toBe(wsY.file);
    expect(agentBWsX.dir).not.toBe(wsX.dir);
    // Agent B's store lives under agent B's own runtime root entirely.
    expect(agentBWsX.dir.startsWith(agentBRoot)).toBe(true);
    expect(wsX.dir.startsWith(agentARoot)).toBe(true);

    // Writes in one scope never appear in another.
    await writeFile(wsX.file, 'workspace X secret thought\n', 'utf8');
    await expect(readFile(wsY.file, 'utf8')).resolves.not.toContain('workspace X');
    await expect(readFile(agentBWsX.file, 'utf8')).resolves.not.toContain('workspace X');
  });
});

describe('memory persistence across a simulated restart', () => {
  it('seeds MEMORY.md once and preserves agent-written content in later sessions', async () => {
    const root = tempRoot('buzzy-mem-restart-');
    const communityId = 'community-1234';

    // Session 1: prepare creates the seed; the "agent" writes its memory.
    const first = await prepareAgentMemory({ root, communityId });
    const seeded = await readFile(first.file, 'utf8');
    expect(seeded).toContain('# Agent memory');
    await writeFile(first.file, `${seeded}\nCaptain prefers concise replies.\n`, 'utf8');

    // Session 2 (a later process, fresh Body state): same root + scope.
    const second = await prepareAgentMemory({ root, communityId });
    expect(second.dir).toBe(first.dir);
    expect(second.file).toBe(first.file);
    await expect(readFile(second.file, 'utf8')).resolves.toContain(
      'Captain prefers concise replies.',
    );

    // Preparing again never clobbers or duplicates the seed.
    const seededAgain = await readFile(second.file, 'utf8');
    expect(seededAgain.match(/# Agent memory/g)).toHaveLength(1);
  });

  it('degrades to no memory rather than throwing on an unusable root', async () => {
    const notADir = join(tempRoot('buzzy-mem-bad-'), 'file');
    writeFileSync(notADir, 'occupied', 'utf8');
    const bodyConfigRoot = join(notADir, 'memory');
    await expect(
      prepareAgentMemory({ root: bodyConfigRoot, communityId: 'ws' }).catch(() => undefined),
    ).resolves.toBeUndefined();
  });
});

describe('memory instructions', () => {
  it('tells the agent where memory lives and that it persists', () => {
    const text = agentMemoryInstructions({
      scopeKey: 'ws',
      dir: '/state/memory/ws',
      file: `/state/memory/ws/${MEMORY_FILE_NAME}`,
    });
    expect(text).toContain(`/state/memory/ws/${MEMORY_FILE_NAME}`);
    expect(text).toContain(AGENT_MEMORY_ENV);
    expect(text.toLowerCase()).toContain('persist');
    expect(text.toLowerCase()).toContain('every room and corner');
  });

  it('renders nothing when memory is unavailable', () => {
    expect(agentMemoryInstructions(undefined)).toBe('');
  });
});

describe('the room boundary keeps the repo read-only while memory stays writable', () => {
  const memoryDir = join(tempRoot('buzzy-mem-room-'), 'ws');

  it('allows an edit request whose paths all land inside the memory dir', () => {
    for (const request of [
      {
        toolCall: {
          kind: 'edit',
          title: 'Write',
          rawInput: { file_path: join(memoryDir, MEMORY_FILE_NAME), content: 'remembered' },
        },
      },
      {
        toolCall: {
          kind: 'edit',
          title: 'Edit',
          rawInput: { file_path: join(memoryDir, 'notes.md'), old_string: 'a', new_string: 'b' },
        },
      },
      {
        toolCall: {
          kind: 'delete',
          title: 'Delete',
          rawInput: { path: join(memoryDir, 'scratch.md') },
        },
      },
      // Codex apply_patch shape: paths ride _meta.changes[].path.
      {
        _meta: { changes: { 'MEMORY.md': { path: join(memoryDir, MEMORY_FILE_NAME) } } },
        toolCall: { kind: 'edit', title: 'apply_patch', rawInput: {} },
      },
    ]) {
      expect(isAgentMemoryWritePermissionRequest(request, memoryDir)).toBe(true);
    }
  });

  it('never lets a shell payload through by naming the memory dir', () => {
    for (const command of [
      `echo x > ${join(memoryDir, MEMORY_FILE_NAME)} && rm -rf /srv/repo`,
      `cat ~/.ssh/id_ed25519 >> ${memoryDir}/MEMORY.md`,
      `cp /srv/repo/.env ${memoryDir}/`,
    ]) {
      expect(
        isAgentMemoryWritePermissionRequest(
          { toolCall: { kind: 'execute', title: command, rawInput: { command } } },
          memoryDir,
        ),
      ).toBe(false);
    }
  });

  it('fails closed on paths outside memory, unnameable writes, and non-mutations of nothing', () => {
    // A repo write is still a plain read-only denial.
    expect(
      isAgentMemoryWritePermissionRequest(
        {
          toolCall: {
            kind: 'edit',
            title: 'Write',
            rawInput: { file_path: '/srv/checkout/src/index.ts', content: 'x' },
          },
        },
        memoryDir,
      ),
    ).toBe(false);
    // Symlink laundering: a link inside memory pointing at the repo does not
    // make the repo writable.
    expect(
      isAgentMemoryWritePermissionRequest(
        {
          toolCall: {
            kind: 'edit',
            title: 'Write',
            rawInput: { file_path: join(memoryDir, '..', 'escape-target'), content: 'x' },
          },
        },
        memoryDir,
      ),
    ).toBe(false);
    // A mutating request that names no path at all is not provably memory.
    expect(
      isAgentMemoryWritePermissionRequest(
        { toolCall: { kind: 'edit', title: 'Write something' } },
        memoryDir,
      ),
    ).toBe(false);
    // Reads were never gated and stay untouched.
    expect(classifyRoomPermission({ toolCall: { kind: 'read', title: 'Read file' } }).decision).toBe(
      'allow',
    );
    // Ordinary repo writes still deny with the room-read-only code.
    expect(
      classifyRoomPermission({
        toolCall: { kind: 'edit', title: 'Write', rawInput: { file_path: '/srv/checkout/x' } },
      }),
    ).toMatchObject({ decision: 'deny', code: 'room-read-only' });
  });
});

describe('sandbox mount table', () => {
  const spec = (over: Partial<SandboxSessionSpec>): SandboxSessionSpec => ({
    mode: 'readonly',
    cwd: '/srv/checkout',
    harnessStateDirs: ['/srv/rooms/r1/agent-home/claude'],
    ...over,
  });

  it('binds the granted memory dir writable in a READ-ONLY room session', () => {
    const plan = sandboxMountPlan(spec({ additionalWritablePaths: ['/state/memory/ws'] }));
    expect(plan.writable).toContain('/state/memory/ws');
    expect(plan.rootWritable).toBeUndefined();
    // The checkout itself stays read-only: bound nowhere writable.
    expect(plan.writable).not.toContain('/srv/checkout');
  });

  it('keeps the memory dir writable in an edit session alongside the worktree', () => {
    const plan = sandboxMountPlan(
      spec({
        mode: 'edit',
        worktreePath: '/srv/corners/c1',
        protectedPaths: ['/srv/checkout'],
        additionalWritablePaths: ['/state/memory/ws'],
      }),
    );
    expect(plan.writable).toContain('/state/memory/ws');
    expect(plan.writable).toContain('/srv/corners/c1');
    expect(plan.readOnly).toContain('/srv/checkout');
  });
});

describe('body wiring', () => {
  const baseConfig: BodyConfig = {
    agentBinary: '/nonexistent',
    mcpBinary: '/nonexistent',
    agentEnv: {},
    workspaceRoot: '/tmp/buzzy-memory-wiring',
    relayBaseUrl: 'http://relay.test',
    relayHost: 'relay.test',
    relayScheme: 'http',
    relayWsUrl: 'ws://relay.test',
    autoApprovePermissions: true,
    readonlyMcpCommand: '/buzz-readonly-mcp',
  };

  function stubRelay(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 })),
    );
  }

  it('provisioning a Room resolves the per-(agent, workspace) memory mount', async () => {
    const daemonState = tempRoot('buzzy-mem-daemon-');
    const body = new Body({
      ...baseConfig,
      agentMemoryRoot: join(daemonState, 'memory'),
    });
    vi.spyOn(body as never, 'ensureAgentInChannel' as never).mockResolvedValue(undefined as never);
    vi.spyOn(body as never, 'ensureAgentEntity' as never).mockResolvedValue(undefined as never);
    vi.spyOn(body as never, 'channelCommunityId' as never).mockResolvedValue('ws-abc' as never);
    const create = vi.spyOn(body as never, 'createManagedSession' as never).mockResolvedValue({
      channelId: 'room-id',
      sessionId: 'readonly-session',
      client: new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} }),
      mode: 'readonly',
    } as never);
    stubRelay();

    await body.provision('room-id', { repo: 'repo', localPath: '/paired/repo' });

    const input = create.mock.calls[0]![0] as { agentMemory?: { dir: string; file: string } };
    expect(input.agentMemory).toBeDefined();
    expect(input.agentMemory!.dir).toBe(join(daemonState, 'memory', 'ws-abc'));
    // The known file exists before any turn runs.
    await expect(readFile(input.agentMemory!.file, 'utf8')).resolves.toContain('# Agent memory');

    await body.dispose();
  });

  it('a restarted daemon hands a later session the SAME memory with the earlier content', async () => {
    const daemonState = tempRoot('buzzy-mem-restart-body-');
    const config = { ...baseConfig, agentMemoryRoot: join(daemonState, 'memory') };

    const makeProvisionedBody = async (): Promise<{ dir: string; file: string }> => {
      const body = new Body(config);
      vi.spyOn(body as never, 'ensureAgentInChannel' as never).mockResolvedValue(
        undefined as never,
      );
      vi.spyOn(body as never, 'ensureAgentEntity' as never).mockResolvedValue(undefined as never);
      vi.spyOn(body as never, 'channelCommunityId' as never).mockResolvedValue('ws-xyz' as never);
      const create = vi.spyOn(body as never, 'createManagedSession' as never).mockResolvedValue({
        channelId: 'room-id',
        sessionId: 'readonly-session',
        client: new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} }),
        mode: 'readonly',
      } as never);
      stubRelay();
      await body.provision('room-id', { repo: 'repo', localPath: '/paired/repo' });
      const input = create.mock.calls[0]![0] as { agentMemory?: { dir: string; file: string } };
      await body.dispose();
      return input.agentMemory!;
    };

    const firstSession = await makeProvisionedBody();
    // The "agent" writes memory during session 1.
    await writeFile(join(firstSession.dir, MEMORY_FILE_NAME), 'learned: tests live in apps/body\n');
    // Daemon restart: a brand-new Body resolves the identical mount.
    const secondSession = await makeProvisionedBody();
    expect(secondSession.dir).toBe(firstSession.dir);
    await expect(readFile(secondSession.file, 'utf8')).resolves.toContain(
      'learned: tests live in apps/body',
    );
  });

  it('a Room without a memory root simply has none (feature disabled)', async () => {
    const body = new Body(baseConfig);
    vi.spyOn(body as never, 'ensureAgentInChannel' as never).mockResolvedValue(undefined as never);
    vi.spyOn(body as never, 'ensureAgentEntity' as never).mockResolvedValue(undefined as never);
    vi.spyOn(body as never, 'channelCommunityId' as never).mockResolvedValue('ws-abc' as never);
    const create = vi.spyOn(body as never, 'createManagedSession' as never).mockResolvedValue({
      channelId: 'room-id',
      sessionId: 'readonly-session',
      client: new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} }),
      mode: 'readonly',
    } as never);
    stubRelay();

    await body.provision('room-id', { repo: 'repo', localPath: '/paired/repo' });

    const input = create.mock.calls[0]![0] as { agentMemory?: unknown };
    expect(input.agentMemory).toBeUndefined();
    await body.dispose();
  });

  it('the room permission handler allows a memory write but still refuses a repo write', async () => {
    const daemonState = tempRoot('buzzy-mem-handler-');
    const body = new Body({
      ...baseConfig,
      bwrapPath: '/usr/bin/bwrap',
      agentMemoryRoot: join(daemonState, 'memory'),
    });
    const memory = await prepareAgentMemory({ root: join(daemonState, 'memory'), communityId: 'ws' });
    // Place a session carrying the memory mount, as createManagedSession would.
    const sessions = Reflect.get(body, 'sessions') as Map<string, unknown>;
    sessions.set('room-id', {
      channelId: 'room-id',
      sessionId: '',
      client: new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} }),
      mode: 'readonly',
      agentMemory: memory,
    });
    const handler = (
      body as unknown as {
        handleRoomPermissionRequest(
          channelId: string,
          permission: unknown,
          policy?: string,
        ): Promise<'allow' | 'reject'>;
      }
    ).handleRoomPermissionRequest.bind(body);

    // Memory write inside the read-only Room: allowed without a human card.
    await expect(
      handler('room-id', {
        toolCall: {
          kind: 'edit',
          title: 'Write',
          rawInput: { file_path: memory.file, content: 'note to self' },
        },
      }),
    ).resolves.toBe('allow');

    // Repo write in the same Room: still refused.
    await expect(
      handler('room-id', {
        toolCall: {
          kind: 'edit',
          title: 'Write',
          rawInput: { file_path: '/paired/repo/src/main.ts', content: 'x' },
        },
      }),
    ).resolves.toBe('reject');

    // Shell payload naming the memory dir: refused (never resolved by name).
    await expect(
      handler('room-id', {
        toolCall: {
          kind: 'execute',
          title: `echo x > ${memory.file}`,
          rawInput: { command: `echo x > ${memory.file}` },
        },
      }),
    ).resolves.toBe('reject');
  });
});

describe('memory directory layout', () => {
  it('creates only the requested scope under the root', async () => {
    const root = tempRoot('buzzy-mem-layout-');
    await prepareAgentMemory({ root, communityId: 'ws-one' });
    const entries = await readdir(root);
    expect(entries).toEqual(['ws-one']);
    const stats = await (await import('node:fs/promises')).stat(join(root, 'ws-one'));
    // Agent-private: 0700 on the scope directory.
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it('seed helper mkdir is recursive-safe on a nested missing root', async () => {
    const root = join(tempRoot('buzzy-mem-nested-'), 'deep', 'memory');
    const mem = await prepareAgentMemory({ root, communityId: undefined });
    expect(mem.scopeKey).toBe('global');
    await expect(readFile(mem.file, 'utf8')).resolves.toContain('# Agent memory');
    void mkdirSync; // keep import used on all platforms
  });
});
