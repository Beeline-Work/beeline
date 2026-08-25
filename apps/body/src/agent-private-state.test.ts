import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import {
  agentPrivateStateInstructions,
  isBodyOwnedPrivateStateLink,
  prepareCornerAgentPrivateState,
  projectDirtyStatus,
} from './agent-private-state.js';

const cleanup: string[] = [];

async function fixture(): Promise<{ root: string; worktree: string; privateRoot: string }> {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-private-state-'));
  cleanup.push(root);
  const worktree = resolve(root, 'corner');
  const privateRoot = resolve(root, 'room-state/private');
  await mkdir(worktree, { recursive: true });
  execFileSync('git', ['init', '--quiet', worktree]);
  return { root, worktree, privateRoot };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('corner agent-private state', () => {
  it('routes persona bookkeeping out of the repository through a Body-owned link', async () => {
    const { worktree, privateRoot } = await fixture();
    const state = await prepareCornerAgentPrivateState({
      root: privateRoot,
      worktreePath: worktree,
      channelId: 'corner-1234',
    });
    await mkdir(resolve(state.worktreePath, 'memory'), { recursive: true });
    await writeFile(resolve(state.worktreePath, 'memory/episodes.json'), '{"learned":true}\n');

    expect(isBodyOwnedPrivateStateLink(worktree, state)).toBe(true);
    expect(await readFile(resolve(privateRoot, 'memory/episodes.json'), 'utf8')).toContain(
      'learned',
    );
    const status = execFileSync(
      'git',
      ['-C', worktree, 'status', '--porcelain=v1', '--untracked-files=all', '-z'],
      { encoding: 'utf8' },
    );
    expect(projectDirtyStatus(worktree, status, state)).toEqual([]);
    execFileSync('git', ['-C', worktree, 'add', '.']);
    expect(
      execFileSync('git', ['-C', worktree, 'diff', '--cached', '--name-only'], {
        encoding: 'utf8',
      }),
    ).toBe('');
    expect(agentPrivateStateInstructions(state)).toMatch(/project-owned memory\//i);
  });

  it('never replaces a project-owned path that uses the preferred private-link name', async () => {
    const { worktree, privateRoot } = await fixture();
    const projectPath = resolve(worktree, '.beeline-agent-private-corner12');
    await writeFile(projectPath, 'project content\n');

    const state = await prepareCornerAgentPrivateState({
      root: privateRoot,
      worktreePath: worktree,
      channelId: 'corner-1234',
    });

    expect(await readFile(projectPath, 'utf8')).toBe('project content\n');
    expect(basename(state.worktreePath)).toBe('.beeline-agent-private-corner12-2');
    expect((await lstat(state.worktreePath)).isSymbolicLink()).toBe(true);
    const status = execFileSync(
      'git',
      ['-C', worktree, 'status', '--porcelain=v1', '--untracked-files=all', '-z'],
      { encoding: 'utf8' },
    );
    expect(projectDirtyStatus(worktree, status, state)).toEqual([
      '?? .beeline-agent-private-corner12',
    ]);
  });

  it('does not trust a stored path after the Body-owned symlink is replaced', async () => {
    const { worktree, privateRoot } = await fixture();
    const state = await prepareCornerAgentPrivateState({
      root: privateRoot,
      worktreePath: worktree,
      channelId: 'corner-1234',
    });
    await rm(state.worktreePath);
    await writeFile(state.worktreePath, 'project replacement\n');
    expect(isBodyOwnedPrivateStateLink(worktree, state)).toBe(false);
    expect(projectDirtyStatus(worktree, `?? ${basename(state.worktreePath)}\0`, state)).toEqual([
      `?? ${basename(state.worktreePath)}`,
    ]);
  });

  it('never reads a Body-seeded node_modules symlink as project dirt, but a real directory still is', async () => {
    const { worktree } = await fixture();
    // Body seeds dependencies by symlinking the source checkout's
    // node_modules into the worktree (corner-toolchain.ts). In a repository
    // that does not ignore node_modules this shows up untracked and must not
    // block merge readiness — but only while it really is the seeded link.
    await symlink(resolve(worktree, '..', 'source-deps'), resolve(worktree, 'node_modules'), 'dir');
    await mkdir(resolve(worktree, 'apps', 'mobile'), { recursive: true });
    await symlink(
      resolve(worktree, '..', 'source-deps-mobile'),
      resolve(worktree, 'apps', 'mobile', 'node_modules'),
      'dir',
    );
    // A REAL directory with the same name stays dirt: only the link is ours.
    const real = resolve(worktree, 'packages', 'thing');
    await mkdir(resolve(real, 'node_modules'), { recursive: true });
    expect(
      projectDirtyStatus(
        worktree,
        '?? node_modules\0?? apps/mobile/node_modules\0?? packages/thing/node_modules\0',
        undefined,
      ),
    ).toEqual(['?? packages/thing/node_modules']);
  });

  it('ignores only Beeline provisioning sentinels inside real node_modules trees', async () => {
    const { worktree } = await fixture();
    await mkdir(resolve(worktree, 'node_modules'), { recursive: true });
    await writeFile(resolve(worktree, 'node_modules', '.beeline-provisioned'), '');
    await mkdir(resolve(worktree, 'apps', 'mobile', 'node_modules'), { recursive: true });
    await writeFile(resolve(worktree, 'apps', 'mobile', 'node_modules', '.beeline-provisioned'), '');

    const sentinelOnlyStatus = execFileSync(
      'git',
      ['-C', worktree, 'status', '--porcelain=v1', '--untracked-files=all', '-z'],
      { encoding: 'utf8' },
    );
    expect(sentinelOnlyStatus.split('\0').filter(Boolean)).toEqual([
      '?? apps/mobile/node_modules/.beeline-provisioned',
      '?? node_modules/.beeline-provisioned',
    ]);
    expect(projectDirtyStatus(worktree, sentinelOnlyStatus, undefined)).toEqual([]);

    await writeFile(resolve(worktree, 'node_modules', 'project-owned.txt'), 'keep visible\n');
    await mkdir(resolve(worktree, 'packages', 'thing', 'node_modules'), { recursive: true });
    await writeFile(
      resolve(worktree, 'packages', 'thing', 'node_modules', '.beeline-provisioned'),
      'keep visible\n',
    );
    await mkdir(resolve(worktree, 'project'), { recursive: true });
    await writeFile(resolve(worktree, 'project', '.beeline-provisioned'), 'keep visible\n');
    await writeFile(resolve(worktree, 'unrelated.txt'), 'keep visible\n');
    const neighboringStatus = execFileSync(
      'git',
      ['-C', worktree, 'status', '--porcelain=v1', '--untracked-files=all', '-z'],
      { encoding: 'utf8' },
    );
    expect(projectDirtyStatus(worktree, neighboringStatus, undefined)).toEqual([
      '?? node_modules/project-owned.txt',
      '?? packages/thing/node_modules/.beeline-provisioned',
      '?? project/.beeline-provisioned',
      '?? unrelated.txt',
    ]);
  });

  it('keeps a tracked provisioning sentinel visible as project dirt', async () => {
    const { worktree } = await fixture();
    await mkdir(resolve(worktree, 'node_modules'), { recursive: true });
    await writeFile(resolve(worktree, 'node_modules', '.beeline-provisioned'), '');
    execFileSync('git', ['-C', worktree, 'add', 'node_modules/.beeline-provisioned']);

    const status = execFileSync(
      'git',
      ['-C', worktree, 'status', '--porcelain=v1', '--untracked-files=all', '-z'],
      { encoding: 'utf8' },
    );
    expect(projectDirtyStatus(worktree, status, undefined)).toEqual([
      'A  node_modules/.beeline-provisioned',
    ]);
  });

  it('does not trust non-empty files or symlinks at the provisioning sentinel paths', async () => {
    const { worktree } = await fixture();
    const sentinelPaths = [
      'node_modules/.beeline-provisioned',
      'apps/mobile/node_modules/.beeline-provisioned',
    ];
    for (const path of sentinelPaths) {
      await mkdir(resolve(worktree, path, '..'), { recursive: true });
      await writeFile(resolve(worktree, path), 'project owned\n');
    }

    const status = (): string =>
      execFileSync(
        'git',
        ['-C', worktree, 'status', '--porcelain=v1', '--untracked-files=all', '-z'],
        { encoding: 'utf8' },
      );
    expect(projectDirtyStatus(worktree, status(), undefined)).toEqual(
      sentinelPaths.map((path) => `?? ${path}`).sort(),
    );

    for (const path of sentinelPaths) {
      await rm(resolve(worktree, path));
      await symlink(tmpdir(), resolve(worktree, path), 'dir');
    }
    expect(projectDirtyStatus(worktree, status(), undefined)).toEqual(
      sentinelPaths.map((path) => `?? ${path}`).sort(),
    );

    for (const path of sentinelPaths) await rm(resolve(worktree, path));
    const disappearedStatus = `${sentinelPaths.map((path) => `?? ${path}`).join('\0')}\0`;
    expect(projectDirtyStatus(worktree, disappearedStatus, undefined)).toEqual(
      sentinelPaths.map((path) => `?? ${path}`),
    );
  });
});
