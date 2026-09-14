import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { computePatchId } from './patch-identity.js';

/**
 * Proved against real git: a fake would only prove the fake agrees with the
 * code, and the whole point of patch-id is exact git semantics across a
 * merge commit.
 */
const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

const COMMITTER = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    env: { ...process.env, ...COMMITTER },
  });
  return result.stdout.trim();
}

async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

describe('computePatchId', () => {
  it('stays the same across a clean merge-from-main and changes on a real edit', async () => {
    const remote = await scratchDir('beeline-patch-id-remote-');
    await execFileAsync('git', ['init', '--bare', '-b', 'main', remote]);

    const seed = await scratchDir('beeline-patch-id-seed-');
    await execFileAsync('git', ['init', '-b', 'main', seed]);
    await writeFile(resolve(seed, 'README.md'), 'objective\n');
    await git(seed, 'add', '.');
    await git(seed, 'commit', '-m', 'objective');
    await git(seed, 'remote', 'add', 'origin', remote);
    await git(seed, 'push', 'origin', 'main');

    await git(seed, 'checkout', '-b', 'feature');
    await writeFile(resolve(seed, 'feature.txt'), 'the reviewed change\n');
    await git(seed, 'add', '.');
    await git(seed, 'commit', '-m', 'feature work');
    await git(seed, 'push', 'origin', 'feature');

    const worktree = await scratchDir('beeline-patch-id-worktree-');
    await execFileAsync('git', ['clone', remote, worktree]);
    await git(worktree, 'checkout', 'feature');

    const beforeCatchUp = await computePatchId({ worktreePath: worktree, targetBranch: 'main' });
    expect(beforeCatchUp).toMatch(/^[0-9a-f]{40}$/);

    // Main moves on, unrelated to the reviewed diff.
    await git(seed, 'checkout', 'main');
    await writeFile(resolve(seed, 'unrelated.txt'), 'other work landed on main\n');
    await git(seed, 'add', '.');
    await git(seed, 'commit', '-m', 'unrelated main work');
    await git(seed, 'push', 'origin', 'main');

    // The author catches the branch up on main with a clean merge: no conflict,
    // no change to what was reviewed.
    await git(worktree, 'fetch', 'origin');
    await git(worktree, 'merge', 'origin/main', '--no-edit');
    const afterCatchUp = await computePatchId({ worktreePath: worktree, targetBranch: 'main' });
    expect(afterCatchUp).toBe(beforeCatchUp);

    // A real code change on top does change the reviewed diff.
    await writeFile(resolve(worktree, 'feature.txt'), 'the reviewed change, but different\n');
    await git(worktree, 'add', '.');
    await git(worktree, 'commit', '-m', 'actually change the reviewed diff');
    const afterRealEdit = await computePatchId({ worktreePath: worktree, targetBranch: 'main' });
    expect(afterRealEdit).toBeDefined();
    expect(afterRealEdit).not.toBe(beforeCatchUp);
  });

  it('returns undefined instead of throwing when there is no merge base', async () => {
    const worktree = await scratchDir('beeline-patch-id-orphan-');
    await execFileAsync('git', ['init', '-b', 'feature', worktree]);
    await writeFile(resolve(worktree, 'file.txt'), 'no main ref exists here\n');
    await git(worktree, 'add', '.');
    await git(worktree, 'commit', '-m', 'orphan commit');

    await expect(
      computePatchId({ worktreePath: worktree, targetBranch: 'main' }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when there is nothing to diff (head is on the target branch)', async () => {
    const remote = await scratchDir('beeline-patch-id-remote-empty-');
    await execFileAsync('git', ['init', '--bare', '-b', 'main', remote]);
    const worktree = await scratchDir('beeline-patch-id-empty-');
    await execFileAsync('git', ['init', '-b', 'main', worktree]);
    await writeFile(resolve(worktree, 'README.md'), 'nothing to review yet\n');
    await git(worktree, 'add', '.');
    await git(worktree, 'commit', '-m', 'objective');
    await git(worktree, 'remote', 'add', 'origin', remote);
    await git(worktree, 'push', 'origin', 'main');
    await git(worktree, 'fetch', 'origin');

    await expect(
      computePatchId({ worktreePath: worktree, targetBranch: 'main' }),
    ).resolves.toBeUndefined();
  });
});
