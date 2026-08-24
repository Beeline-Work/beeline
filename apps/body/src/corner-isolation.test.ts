/**
 * Corner worktree isolation — mirrors firstmate's treehouse/spawn isolation.
 *
 * Covers the corner-review guarantee: a corner's edit work lands on its own
 * feature branch in an isolated top-level worktree, never on the operator's
 * shared primary checkout (`main`). See `corner-isolation.ts` and the CLAUDE.md
 * "Corner edit work must land on the corner's feature branch" note.
 *
 * @jest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  CornerIsolationError,
  assertCornerWorktreeIsolated,
  classifyCornerCommand,
  cornerWorktreePath,
} from './corner-isolation.js';

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  return { ok: res.status === 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Create a corner worktree exactly like Body.createWorktree does for a paired checkout. */
function addCornerWorktree(primary: string, worktreePath: string, branch: string): void {
  const add = git(primary, ['worktree', 'add', '-b', branch, worktreePath, 'refs/heads/main']);
  expect(add.ok).toBe(true);
  git(worktreePath, ['config', 'user.email', 'agent@buzzy.local']);
  git(worktreePath, ['config', 'user.name', 'buzzy-agent']);
}

describe('corner worktree isolation', () => {
  let root: string;
  let primary: string;

  beforeEach(async () => {
    root = await mkdtemp(resolve(tmpdir(), 'corner-isolation-'));
    // The operator's shared primary checkout, on `main`.
    primary = resolve(root, 'proj-buzzy');
    git(root, ['init', '-q', '-b', 'main', 'proj-buzzy']);
    git(primary, ['config', 'user.email', 'op@buzzy.local']);
    git(primary, ['config', 'user.name', 'operator']);
    spawnSync('bash', ['-c', 'echo hello > README.md'], { cwd: primary });
    git(primary, ['add', '.']);
    git(primary, ['commit', '-qm', 'init']);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('places a paired-checkout corner at a clean top-level sibling, never inside the primary', () => {
    const worktreePath = cornerWorktreePath({
      workspaceRoot: resolve(primary, '.git', 'beeline', 'rooms', 'r1'),
      sourceCheckout: primary,
      subchannelId: 'corner-abc',
    });
    // Not nested inside the primary checkout or its .git.
    expect(worktreePath.startsWith(resolve(primary) + '/')).toBe(false);
    // A hidden sibling grouped by repo name.
    expect(worktreePath).toBe(resolve(root, '.beeline-corners', 'proj-buzzy', 'corner-abc'));
  });

  it('(a) an isolated corner worktree resolves to a top-level distinct from the primary', async () => {
    const worktreePath = cornerWorktreePath({
      workspaceRoot: primary,
      sourceCheckout: primary,
      subchannelId: 'c1',
    });
    addCornerWorktree(primary, worktreePath, 'feature/c1');

    // git rev-parse --show-toplevel of the worktree is the worktree itself.
    const top = git(worktreePath, ['rev-parse', '--show-toplevel']);
    expect(realpathSync(top.stdout.trim())).toBe(realpathSync(worktreePath));
    expect(realpathSync(top.stdout.trim())).not.toBe(realpathSync(primary));

    // The fail-closed assertion accepts it.
    await expect(assertCornerWorktreeIsolated(worktreePath, primary)).resolves.toBeUndefined();
  });

  it('(b) a commit in the corner lands on its feature branch, NOT the primary main', async () => {
    const worktreePath = cornerWorktreePath({
      workspaceRoot: primary,
      sourceCheckout: primary,
      subchannelId: 'c2',
    });
    addCornerWorktree(primary, worktreePath, 'feature/c2');
    await assertCornerWorktreeIsolated(worktreePath, primary);

    const mainBefore = git(primary, ['rev-parse', 'refs/heads/main']).stdout.trim();

    spawnSync('bash', ['-c', 'echo change > feature.txt'], { cwd: worktreePath });
    git(worktreePath, ['add', '.']);
    const commit = git(worktreePath, ['commit', '-qm', 'corner work']);
    expect(commit.ok).toBe(true);

    // The primary's main is untouched.
    expect(git(primary, ['rev-parse', 'refs/heads/main']).stdout.trim()).toBe(mainBefore);
    // The feature branch advanced past main.
    const featureTip = git(primary, ['rev-parse', 'refs/heads/feature/c2']).stdout.trim();
    expect(featureTip).not.toBe(mainBefore);
    // HEAD inside the worktree is on the feature branch.
    expect(git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()).toBe(
      'feature/c2',
    );
  });

  it('(c) the review gate sees a non-empty base→tip diff after the corner commits', () => {
    const worktreePath = cornerWorktreePath({
      workspaceRoot: primary,
      sourceCheckout: primary,
      subchannelId: 'c3',
    });
    addCornerWorktree(primary, worktreePath, 'feature/c3');
    const base = git(primary, ['rev-parse', 'refs/heads/main']).stdout.trim();

    spawnSync('bash', ['-c', 'echo diff > review.txt'], { cwd: worktreePath });
    git(worktreePath, ['add', '.']);
    git(worktreePath, ['commit', '-qm', 'reviewable change']);
    const tip = git(worktreePath, ['rev-parse', 'HEAD']).stdout.trim();

    const files = git(worktreePath, ['diff', '--name-only', `${base}..${tip}`]).stdout.trim();
    expect(files).toContain('review.txt');
  });

  it('(d) two corners open at once each commit to their own branch; primary main is untouched', async () => {
    const mainBefore = git(primary, ['rev-parse', 'refs/heads/main']).stdout.trim();
    const wtA = cornerWorktreePath({
      workspaceRoot: primary,
      sourceCheckout: primary,
      subchannelId: 'A',
    });
    const wtB = cornerWorktreePath({
      workspaceRoot: primary,
      sourceCheckout: primary,
      subchannelId: 'B',
    });
    addCornerWorktree(primary, wtA, 'feature/A');
    addCornerWorktree(primary, wtB, 'feature/B');
    await assertCornerWorktreeIsolated(wtA, primary);
    await assertCornerWorktreeIsolated(wtB, primary);
    expect(realpathSync(wtA)).not.toBe(realpathSync(wtB));

    spawnSync('bash', ['-c', 'echo a > a.txt'], { cwd: wtA });
    git(wtA, ['add', '.']);
    git(wtA, ['commit', '-qm', 'work A']);
    spawnSync('bash', ['-c', 'echo b > b.txt'], { cwd: wtB });
    git(wtB, ['add', '.']);
    git(wtB, ['commit', '-qm', 'work B']);

    const tipA = git(primary, ['rev-parse', 'refs/heads/feature/A']).stdout.trim();
    const tipB = git(primary, ['rev-parse', 'refs/heads/feature/B']).stdout.trim();
    expect(tipA).not.toBe(tipB);
    expect(tipA).not.toBe(mainBefore);
    expect(tipB).not.toBe(mainBefore);
    expect(git(primary, ['rev-parse', 'refs/heads/main']).stdout.trim()).toBe(mainBefore);
  });

  it('(e) the isolation assertion refuses a root that resolves to the primary checkout', async () => {
    // The primary checkout itself is a git toplevel — but it IS the primary.
    await expect(assertCornerWorktreeIsolated(primary, primary)).rejects.toBeInstanceOf(
      CornerIsolationError,
    );
    // A non-git directory is refused too (not a worktree at all).
    const notGit = resolve(root, 'not-a-repo');
    spawnSync('mkdir', ['-p', notGit]);
    await expect(assertCornerWorktreeIsolated(notGit, primary)).rejects.toBeInstanceOf(
      CornerIsolationError,
    );
  });
});

describe('corner cd-guard policy', () => {
  const worktree = '/pool/.beeline-corners/proj/corner-1';
  const primary = '/home/op/proj-buzzy';

  it('(f) denies the reported command: a persistent cd into the shared checkout before commit', () => {
    const verdict = classifyCornerCommand(`cd ${primary} && git commit -am wip`, worktree, primary);
    expect(verdict.decision).toBe('deny');
    if (verdict.decision === 'deny') expect(verdict.code).toBe('persistent-cd');
  });

  it('denies any persistent cd/pushd/popd, even a relative one', () => {
    for (const cmd of ['cd ..', 'ls && cd /tmp', 'X=1 cd foo', 'pushd /x', 'command cd ..']) {
      expect(classifyCornerCommand(cmd, worktree, primary).decision).toBe('deny');
    }
  });

  it('denies git -C / --git-dir escaping the worktree into the shared checkout', () => {
    expect(
      classifyCornerCommand(`git -C ${primary} commit -am x`, worktree, primary).decision,
    ).toBe('deny');
    expect(classifyCornerCommand('git -C ../../elsewhere status', worktree, primary).decision).toBe(
      'deny',
    );
    expect(
      classifyCornerCommand(`git --git-dir=${primary}/.git log`, worktree, primary).decision,
    ).toBe('deny');
  });

  it('allows ordinary commands that stay inside the worktree', () => {
    for (const cmd of [
      'git commit -am work',
      'git status',
      'git -C subpkg build',
      'ls -la && grep foo *.ts',
      '(cd tmp && ls)',
      'echo "cd /home/op/proj-buzzy is just text"',
      'npm test | grep pass',
    ]) {
      expect(classifyCornerCommand(cmd, worktree, primary).decision).toBe('allow');
    }
  });

  it('never throws — fails open on unparseable input', () => {
    expect(classifyCornerCommand('"unterminated && cd /x', worktree, primary).decision).toBe(
      'allow',
    );
  });
});
