/**
 * Session sandbox policy — the fail-closed Room/Corner permission boundary.
 *
 * The live breach this covers: a Room session whose cwd was correctly the
 * Room's canonical checkout edited a file in the operator's personal tree by
 * ABSOLUTE PATH, and ran builds/tests in the Room. cwd isolation constrains the
 * default directory, not absolute-path reach, so the boundary has to live in
 * the ACP permission handler. See `session-sandbox.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  ROOM_READ_ONLY_STEER,
  classifyCornerPermission,
  classifyRoomPermission,
  pathEscapesRoot,
  permissionTargetPaths,
} from './session-sandbox.js';

describe('Room sessions are read-only, whatever path a tool names', () => {
  it('denies every write/edit/delete/move/execute request outright', () => {
    for (const request of [
      { toolCall: { kind: 'edit', title: 'Write', rawInput: { path: 'README.md' } } },
      { toolCall: { kind: 'delete', title: 'Delete file' } },
      { toolCall: { kind: 'move', title: 'Rename' } },
      { toolCall: { kind: 'execute', rawInput: { command: 'npm run typecheck' } } },
      { toolCall: { kind: 'execute', rawInput: { command: 'git commit -am wip' } } },
      { toolCall: { title: 'str_replace_editor' } },
    ]) {
      expect(classifyRoomPermission(request).decision).toBe('deny');
    }
  });

  it('denies a write aimed at the operator tree exactly as it denies a local one', () => {
    const outside = classifyRoomPermission({
      toolCall: {
        kind: 'edit',
        title: 'Write',
        rawInput: { path: '/home/lunchbox/proj-buzzy/apps/mobile/sources/x.ts' },
      },
    });
    const inside = classifyRoomPermission({
      toolCall: { kind: 'edit', title: 'Write', rawInput: { path: 'apps/mobile/sources/x.ts' } },
    });
    // Path-scoping a Room denial would be no boundary at all: a Room denies both.
    expect(outside.decision).toBe('deny');
    expect(inside.decision).toBe('deny');
    if (outside.decision === 'deny') {
      expect(outside.code).toBe('room-read-only');
      expect(outside.reason).toBe(ROOM_READ_ONLY_STEER);
    }
  });

  it('steers the agent to open a corner instead of just saying no', () => {
    expect(ROOM_READ_ONLY_STEER).toMatch(/read-only/i);
    expect(ROOM_READ_ONLY_STEER).toMatch(/open a corner/i);
  });

  it('leaves reads and inspection alone', () => {
    expect(
      classifyRoomPermission({ toolCall: { kind: 'read', title: 'Read a file' } }).decision,
    ).toBe('allow');
    expect(
      classifyRoomPermission({ toolCall: { kind: 'fetch', title: 'Search text' } }).decision,
    ).toBe('allow');
  });
});

describe('Corner sessions may only mutate inside their own worktree', () => {
  let root: string;
  let worktree: string;
  let operator: string;

  beforeEach(async () => {
    root = realpathSync(await mkdtemp(resolve(tmpdir(), 'buzzy-sandbox-')));
    worktree = resolve(root, '.beeline-corners/proj/c1');
    operator = resolve(root, 'proj-buzzy');
    await mkdir(resolve(worktree, 'src'), { recursive: true });
    await mkdir(resolve(operator, 'apps'), { recursive: true });
    await writeFile(resolve(operator, 'apps/target.ts'), 'export const x = 1;\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const edit = (rawInput: unknown) => ({ toolCall: { kind: 'edit', title: 'Write', rawInput } });

  it('allows a write inside the worktree', () => {
    expect(classifyCornerPermission(edit({ path: 'src/a.ts' }), worktree, operator).decision).toBe(
      'allow',
    );
    expect(
      classifyCornerPermission(
        edit({ file_path: resolve(worktree, 'src/a.ts') }),
        worktree,
        operator,
      ).decision,
    ).toBe('allow');
  });

  it('denies a write to an absolute path outside the worktree', () => {
    const verdict = classifyCornerPermission(
      edit({ file_path: resolve(operator, 'apps/target.ts') }),
      worktree,
      operator,
    );
    expect(verdict.decision).toBe('deny');
    if (verdict.decision === 'deny') expect(verdict.code).toBe('path-escape');
  });

  it('allows writes only to the explicitly mounted agent-private state root', async () => {
    const agentPrivateState = resolve(root, 'room-state/agent-private');
    await mkdir(agentPrivateState, { recursive: true });
    const allowed = classifyCornerPermission(
      edit({ file_path: resolve(agentPrivateState, 'memory/episode.json') }),
      worktree,
      operator,
      [agentPrivateState],
    );
    const unrelated = classifyCornerPermission(
      edit({ file_path: resolve(root, 'other-state/memory/episode.json') }),
      worktree,
      operator,
      [agentPrivateState],
    );

    expect(allowed.decision).toBe('allow');
    expect(unrelated.decision).toBe('deny');
  });

  it('denies a `..` traversal out of the worktree', () => {
    const verdict = classifyCornerPermission(
      edit({ path: '../../../proj-buzzy/apps/target.ts' }),
      worktree,
      operator,
    );
    expect(verdict.decision).toBe('deny');
    if (verdict.decision === 'deny') expect(verdict.code).toBe('path-escape');
  });

  it('denies a write laundered through a symlink that escapes the worktree', async () => {
    await symlink(operator, resolve(worktree, 'escape'));
    const verdict = classifyCornerPermission(
      edit({ path: 'escape/apps/target.ts' }),
      worktree,
      operator,
    );
    expect(verdict.decision).toBe('deny');
    if (verdict.decision === 'deny') expect(verdict.code).toBe('path-escape');
  });

  it('finds the target path wherever an adapter puts it', () => {
    // codex-acp's file-change request carries no rawInput: the paths are in _meta.
    const codex = {
      toolCall: { kind: 'edit', title: 'Editing files' },
      _meta: { codex: { params: { changes: [{ path: resolve(operator, 'apps/target.ts') }] } } },
    };
    expect(classifyCornerPermission(codex, worktree, operator).decision).toBe('deny');

    // A tracked tool_call's `content` diff rows and `locations` are merged in
    // by AcpClient before the handler runs.
    const located = {
      toolCall: {
        kind: 'edit',
        title: 'Write',
        locations: [{ path: resolve(operator, 'apps/target.ts') }],
      },
    };
    expect(classifyCornerPermission(located, worktree, operator).decision).toBe('deny');
  });

  it('denies a shell command that writes outside the worktree', () => {
    for (const command of [
      `echo hi > ${resolve(operator, 'apps/target.ts')}`,
      `cp src/a.ts ${resolve(operator, 'apps/target.ts')}`,
      `rm -rf ${resolve(operator, 'apps')}`,
      `sed -i s/a/b/ ${resolve(operator, 'apps/target.ts')}`,
      // A write behind a wrapper is still a write.
      `sudo tee ${resolve(operator, 'apps/target.ts')}`,
      `npm run build && cp dist/x ${resolve(operator, 'apps/target.ts')}`,
    ]) {
      const verdict = classifyCornerPermission(
        { toolCall: { kind: 'execute', rawInput: { command } } },
        worktree,
        operator,
      );
      expect(verdict.decision, command).toBe('deny');
    }
  });

  it('keeps the cd-guard, and keeps ordinary in-worktree work working', () => {
    const escape = classifyCornerPermission(
      {
        toolCall: {
          kind: 'execute',
          rawInput: { command: `cd ${operator} && git commit -am wip` },
        },
      },
      worktree,
      operator,
    );
    expect(escape.decision).toBe('deny');
    if (escape.decision === 'deny') expect(escape.code).toBe('persistent-cd');

    for (const command of [
      'git commit -am wip',
      'npm run typecheck',
      'rm -rf dist',
      'mkdir -p src/nested',
      'echo hi > src/a.txt',
      'cat /etc/hostname',
      // A discard sink is not an escape, and `2>` is not a redirection target.
      'npm run build > /dev/null 2>&1',
      // `install` only counts as the head word, never mid-command.
      'npm install --prefix /usr/lib/whatever',
    ]) {
      expect(
        classifyCornerPermission(
          { toolCall: { kind: 'execute', rawInput: { command } } },
          worktree,
          operator,
        ).decision,
        command,
      ).toBe('allow');
    }
  });

  it('leaves reads outside the worktree alone (unchanged corner policy)', () => {
    expect(
      classifyCornerPermission(
        {
          toolCall: {
            kind: 'read',
            title: 'Read',
            rawInput: { path: resolve(operator, 'apps/target.ts') },
          },
        },
        worktree,
        operator,
      ).decision,
    ).toBe('allow');
  });
});

describe('path helpers', () => {
  it('treats a bare relative path as inside the root', () => {
    expect(pathEscapesRoot('src/a.ts', '/tmp/wt')).toBe(false);
    expect(pathEscapesRoot('../a.ts', '/tmp/wt')).toBe(true);
    expect(pathEscapesRoot('/etc/passwd', '/tmp/wt')).toBe(true);
  });

  it('collects only path-shaped fields, never a command string', () => {
    const paths = permissionTargetPaths({
      toolCall: { kind: 'execute', rawInput: { command: 'rm -rf /', cwd: '/tmp/wt' } },
    });
    expect(paths).toEqual(['/tmp/wt']);
  });
});
