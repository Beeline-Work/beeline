/**
 * Corner toolchain seeding — reproduction tests for the dominant live failure
 * class (2026-08-23 owner report): a fresh `git worktree` carries no untracked
 * files, so a new corner had no `node_modules` and burned dozens of tool calls
 * on `sh: 1: vitest: not found` / `tsc: not found` /
 * `Cannot find module '@beeline/buzz-client'` storms instead of its task.
 *
 * These tests drive REAL git repos and worktrees, mirroring
 * Body.createWorktree's shape, and assert the fix at the same boundary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { seedCornerNodeModules, toolchainProvisionSteps } from './corner-toolchain.js';

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  return { ok: res.status === 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('seedCornerNodeModules', () => {
  let root: string;
  let checkout: string;
  let worktree: string;

  beforeEach(async () => {
    root = await mkdtemp(resolve(tmpdir(), 'corner-toolchain-'));
    checkout = resolve(root, 'canonical');
    worktree = resolve(root, 'corners', 'c1');
    git(root, ['init', '-q', '-b', 'main', 'canonical']);
    git(checkout, ['config', 'user.email', 'op@buzzy.local']);
    git(checkout, ['config', 'user.name', 'operator']);
    await writeFile(resolve(checkout, '.gitignore'), 'node_modules\n');
    await writeFile(resolve(checkout, 'README.md'), 'hi\n');
    git(checkout, ['add', '.']);
    git(checkout, ['commit', '-qm', 'init']);
    // A first-level workspace member, like apps/mobile.
    await mkdir(resolve(checkout, 'apps/mobile'), { recursive: true });
    await writeFile(resolve(checkout, 'apps', 'mobile', 'package.json'), '{}\n');
    git(checkout, ['add', '.']);
    git(checkout, ['commit', '-qm', 'apps']);
    const add = git(checkout, ['worktree', 'add', '-b', 'feature/c1', worktree, 'main']);
    expect(add.ok).toBe(true);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reproduces the live failure: a fresh worktree has no node_modules at all', () => {
    expect(existsSync(resolve(worktree, 'node_modules'))).toBe(false);
    expect(existsSync(resolve(worktree, 'apps', 'mobile', 'node_modules'))).toBe(false);
  });

  it('links the root and workspace node_modules from the source checkout', async () => {
    await mkdir(resolve(checkout, 'node_modules/vitest'), { recursive: true });
    await mkdir(resolve(checkout, 'apps/mobile/node_modules/.bin'), { recursive: true });

    const seeded = seedCornerNodeModules({ worktreePath: worktree, sourceCheckout: checkout });

    expect(seeded.linked).toEqual(['node_modules', 'apps/mobile/node_modules']);
    // The link resolves: the corner can now read the toolchain.
    expect(existsSync(resolve(worktree, 'node_modules', 'vitest'))).toBe(true);
    expect(existsSync(resolve(worktree, 'apps', 'mobile', 'node_modules', '.bin'))).toBe(true);
  });

  it('is idempotent and never touches an existing node_modules', async () => {
    await mkdir(resolve(checkout, 'node_modules'), { recursive: true });
    seedCornerNodeModules({ worktreePath: worktree, sourceCheckout: checkout });
    // A second pass (spawn-time re-seed) adds nothing.
    expect(
      seedCornerNodeModules({ worktreePath: worktree, sourceCheckout: checkout }).linked,
    ).toEqual([]);
    // A real directory already present is left alone.
    const real = resolve(worktree, 'apps', 'mobile', 'node_modules');
    await mkdir(real, { recursive: true });
    await writeFile(resolve(real, 'marker.txt'), 'real\n');
    seedCornerNodeModules({ worktreePath: worktree, sourceCheckout: checkout });
    expect(readFileSync(resolve(real, 'marker.txt'), 'utf8')).toBe('real\n');
  });

  it('keeps the links out of git status even without a .gitignore entry', async () => {
    // Remove the repo-level ignore so only the per-worktree exclude covers it.
    git(checkout, ['rm', '-q', '--cached', '.gitignore']);
    git(checkout, ['commit', '-qm', 'drop ignore']);
    const add = git(checkout, ['worktree', 'add', '-b', 'feature/c2', `${worktree}2`, 'main']);
    expect(add.ok).toBe(true);
    const wt2 = `${worktree}2`;
    await mkdir(resolve(checkout, 'node_modules'), { recursive: true });

    seedCornerNodeModules({ worktreePath: wt2, sourceCheckout: checkout });

    const status = git(wt2, ['status', '--porcelain']).stdout.trim();
    expect(status).toBe('');
  });

  it('does nothing when the source checkout has no dependencies installed', () => {
    const seeded = seedCornerNodeModules({ worktreePath: worktree, sourceCheckout: checkout });
    expect(seeded.linked).toEqual([]);
  });
});

describe('toolchainProvisionSteps', () => {
  it('asks for the installs and package builds a bare checkout still needs', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'provision-steps-'));
    try {
      await mkdir(resolve(root, 'apps/mobile'), { recursive: true });
      await mkdir(resolve(root, 'packages/nostr/src'), { recursive: true });
      await mkdir(resolve(root, 'packages/buzz-client/src'), { recursive: true });
      for (const p of ['package.json', 'package-lock.json']) {
        await writeFile(resolve(root, p), '{}\n');
      }
      await writeFile(resolve(root, 'apps/mobile/package.json'), '{}\n');
      await writeFile(resolve(root, 'packages/nostr/package.json'), '{"name":"@beeline/nostr"}\n');
      await writeFile(
        resolve(root, 'packages/buzz-client/package.json'),
        '{"name":"@beeline/buzz-client"}\n',
      );

      const labels = toolchainProvisionSteps(root).map((step) => step.label);
      expect(labels).toEqual([
        'npm ci (root)',
        'npm ci (apps/mobile)',
        'build @beeline/nostr',
        'build @beeline/buzz-client',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('is empty once everything is present — no repeated provisioning', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'provision-done-'));
    try {
      await writeFile(resolve(root, 'package.json'), '{}\n');
      await mkdir(resolve(root, 'node_modules'), { recursive: true });
      await mkdir(resolve(root, 'packages/buzz-client/dist'), { recursive: true });
      await writeFile(resolve(root, 'packages/buzz-client/dist/index.js'), '');
      // No packages/nostr at all in this fixture: nothing to build either.
      expect(toolchainProvisionSteps(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never proposes steps outside a real package root', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'provision-empty-'));
    try {
      expect(toolchainProvisionSteps(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
