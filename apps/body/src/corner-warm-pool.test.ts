import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git } from '@beeline/gate';
import { assertCornerWorktreeIsolated } from './corner-isolation.js';
import {
  cornerWarmPoolRoot,
  replenishCornerWarmPool,
  takeWarmCornerWorktree,
} from './corner-warm-pool.js';

const roots: string[] = [];

async function fixture(): Promise<{ root: string; repo: string; corners: string }> {
  const root = await mkdtemp(resolve(tmpdir(), 'corner-warm-pool-'));
  roots.push(root);
  const repo = resolve(root, 'repo');
  const corners = resolve(root, '.beeline-corners', 'repo');
  await mkdir(repo, { recursive: true });
  expect((await git(repo, ['init', '-b', 'main'])).ok).toBe(true);
  await git(repo, ['config', 'user.name', 'Pool Test']);
  await git(repo, ['config', 'user.email', 'pool@example.test']);
  await writeFile(resolve(repo, 'README.md'), 'one\n');
  await git(repo, ['add', 'README.md']);
  expect((await git(repo, ['commit', '-m', 'initial'])).ok).toBe(true);
  return { root, repo, corners };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('Body-owned corner warm pool', () => {
  it('opens a real isolated worktree from a provisioned slot in under ten seconds', async () => {
    const { repo, corners } = await fixture();
    let provisions = 0;
    const provision = async (path: string) => {
      provisions += 1;
      await mkdir(resolve(path, 'node_modules'), { recursive: true });
      await writeFile(resolve(path, 'node_modules', '.beeline-provisioned'), 'warm');
    };
    const common = {
      repositoryRoot: repo,
      cornersRoot: corners,
      targetRef: 'refs/heads/main',
      runGit: git,
      provision,
      size: 1,
    };
    await replenishCornerWarmPool(common);
    const slot = resolve(cornerWarmPoolRoot(corners, common.targetRef), 'slot-1');
    await assertCornerWorktreeIsolated(slot, repo);

    const destination = resolve(corners, 'corner-fast');
    const started = performance.now();
    await expect(
      takeWarmCornerWorktree({
        ...common,
        destination,
        featureBranch: 'feature/fast-corner',
      }),
    ).resolves.toBe(true);
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(10_000);
    expect(provisions).toBe(2);
    expect(await readFile(resolve(destination, 'node_modules', '.beeline-provisioned'), 'utf8')).toBe(
      'warm',
    );
    await assertCornerWorktreeIsolated(destination, repo);
    expect(
      resolve(destination, (await git(destination, ['rev-parse', '--git-common-dir'])).stdout.trim()),
    ).toBe(resolve(repo, '.git'));
    expect((await git(destination, ['branch', '--show-current'])).stdout.trim()).toBe(
      'feature/fast-corner',
    );

    // The ordinary Body teardown remains authoritative after assignment.
    expect((await git(repo, ['worktree', 'remove', '--force', destination])).ok).toBe(true);
    await replenishCornerWarmPool(common);
    await expect(assertCornerWorktreeIsolated(slot, repo)).resolves.toBeUndefined();
  });

  it('refreshes a waiting slot to the current target before branching', async () => {
    const { repo, corners } = await fixture();
    const provision = async (path: string) => {
      await mkdir(resolve(path, 'node_modules'), { recursive: true });
    };
    const common = {
      repositoryRoot: repo,
      cornersRoot: corners,
      targetRef: 'refs/heads/main',
      runGit: git,
      provision,
      size: 1,
    };
    await replenishCornerWarmPool(common);
    await writeFile(resolve(repo, 'latest.txt'), 'latest target\n');
    await git(repo, ['add', 'latest.txt']);
    expect((await git(repo, ['commit', '-m', 'advance target'])).ok).toBe(true);

    const destination = resolve(corners, 'corner-refreshed');
    await expect(
      takeWarmCornerWorktree({
        ...common,
        destination,
        featureBranch: 'feature/refreshed-corner',
      }),
    ).resolves.toBe(true);
    expect(await readFile(resolve(destination, 'latest.txt'), 'utf8')).toBe('latest target\n');
  });

  it('returns false without side effects when no warm slot is available', async () => {
    const { repo, corners } = await fixture();
    await expect(
      takeWarmCornerWorktree({
        repositoryRoot: repo,
        cornersRoot: corners,
        targetRef: 'refs/heads/main',
        destination: resolve(corners, 'cold-corner'),
        featureBranch: 'feature/cold-corner',
        runGit: git,
        provision: async () => undefined,
        size: 1,
      }),
    ).resolves.toBe(false);
  });
});
