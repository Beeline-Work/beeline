import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { materializeCornerWorktree } from './room-runtime.js';
import { harvestWarmNodeModules, warmNodeModulesStoreDir } from './warm-node-modules.js';

/**
 * The seam the whole warm start hangs on, proved against real git: a corner
 * worktree is cut from a bare clone, so `node_modules` is absent at exactly
 * the moment `materializeCornerWorktree` finishes — and that is the one moment
 * a warm tree can be linked in before any session reads the checkout.
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

const LOCKFILE = JSON.stringify({
  name: 'fixture',
  lockfileVersion: 3,
  packages: { '': { name: 'fixture' }, 'node_modules/left-pad': { version: '1.0.0' } },
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/**
 * One bare remote for the whole file. Real git against a real repository is
 * the point, and it is also the expensive part — the cases differ by what the
 * STORE holds, never by what the remote does.
 */
let remote: string;
let remoteRoot: string;
beforeAll(async () => {
  // File-only fixtures do not need the host's GitHub credential launcher.
  vi.stubEnv('PATH', `/usr/bin:/bin:${process.env.PATH ?? ''}`);
  remoteRoot = await mkdtemp(resolve(tmpdir(), 'beeline-warm-remote-'));
  remote = await remoteWithLockfile(remoteRoot);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(remoteRoot, { recursive: true, force: true });
});

/** A bare remote whose `main` carries the lockfile a corner would install. */
async function remoteWithLockfile(root: string): Promise<string> {
  const seed = resolve(root, 'seed');
  await execFileAsync('git', ['init', '-b', 'main', seed]);
  await writeFile(resolve(seed, 'package-lock.json'), LOCKFILE);
  await writeFile(resolve(seed, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(resolve(seed, '.gitignore'), 'node_modules\n');
  await execFileAsync('git', ['-C', seed, 'add', '.']);
  await execFileAsync('git', ['-C', seed, 'commit', '-m', 'seed'], {
    env: { ...process.env, ...COMMITTER },
  });
  const remote = resolve(root, 'remote.git');
  await execFileAsync('git', ['clone', '--bare', seed, remote]);
  return `file://${remote}`;
}

/** A finished install of `LOCKFILE`, stored under its key. */
async function warmStore(supervisorRoot: string): Promise<string> {
  const source = await scratch('beeline-warm-install-');
  await writeFile(resolve(source, 'package-lock.json'), LOCKFILE);
  await mkdir(resolve(source, 'node_modules', 'left-pad'), { recursive: true });
  // A real package, because completeness is checked on disk and not only in
  // npm's metadata: a directory without this is not an installed package.
  await writeFile(
    resolve(source, 'node_modules', 'left-pad', 'package.json'),
    JSON.stringify({ name: 'left-pad', version: '1.0.0' }),
  );
  await writeFile(resolve(source, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  await writeFile(
    resolve(source, 'node_modules', '.package-lock.json'),
    JSON.stringify({ packages: { 'node_modules/left-pad': {} } }),
  );
  const stored = await harvestWarmNodeModules({
    worktreePath: source,
    storeRoot: warmNodeModulesStoreDir(supervisorRoot),
  });
  expect(stored.reason).toBe('stored');
  return stored.key!;
}

async function materialize(supervisorRoot: string, remote: string, cornerId: string) {
  return materializeCornerWorktree({
    cornerId,
    remote,
    targetBranch: 'main',
    featureBranch: `feature/${cornerId}`,
    token: 'unused',
    supervisorRoot,
    committer: { name: 'Helper', publicKey: 'a'.repeat(64) },
  });
}

describe('a new corner worktree', () => {
  it('STARTUP-RACE-1: starts concurrent corners against one real mirror', async () => {
    const supervisorRoot = await scratch('beeline-concurrent-corners-');
    const worktrees = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      materialize(supervisorRoot, remote, `concurrent-${index}`),
    ));
    expect(new Set(worktrees.map(tree => tree.gitCommonDir)).size).toBe(1);
    for (const [index, tree] of worktrees.entries()) {
      const branch = await execFileAsync('git', ['-C', tree.path, 'branch', '--show-current']);
      expect(branch.stdout.trim()).toBe(`feature/concurrent-${index}`);
      expect((await execFileAsync('git', ['-C', tree.path, 'status', '--porcelain'])).stdout).toBe('');
    }
  }, 60_000);

  it('does not expose shared inodes before the harness can seal its mounts', async () => {
    const supervisorRoot = await scratch('beeline-warm-supervisor-');
    await warmStore(supervisorRoot);
    const worktree = await materialize(supervisorRoot, remote, 'corner-warm');
    await expect(stat(resolve(worktree.path, 'node_modules'))).rejects.toThrow();
  });

  it('is cut normally when the store has nothing for its lockfile', async () => {
    const supervisorRoot = await scratch('beeline-warm-supervisor-');

    const worktree = await materialize(supervisorRoot, remote, 'corner-cold');

    expect(await readFile(resolve(worktree.path, 'package-lock.json'), 'utf8')).toBe(LOCKFILE);
    await expect(stat(resolve(worktree.path, 'node_modules'))).rejects.toThrow();
  });
});
