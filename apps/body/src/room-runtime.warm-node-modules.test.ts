import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
  remoteRoot = await mkdtemp(resolve(tmpdir(), 'beeline-warm-remote-'));
  remote = await remoteWithLockfile(remoteRoot);
});
afterAll(async () => rm(remoteRoot, { recursive: true, force: true }));

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
  it('arrives with the warm tree already hardlinked in', async () => {
    const supervisorRoot = await scratch('beeline-warm-supervisor-');
    const key = await warmStore(supervisorRoot);

    const worktree = await materialize(supervisorRoot, remote, 'corner-warm');

    const linked = resolve(worktree.path, 'node_modules', 'left-pad', 'index.js');
    const stored = resolve(
      warmNodeModulesStoreDir(supervisorRoot),
      key,
      'node_modules',
      'left-pad',
      'index.js',
    );
    expect(await readFile(linked, 'utf8')).toBe('module.exports = 1;\n');
    expect((await stat(linked)).ino).toBe((await stat(stored)).ino);
    // The seed is not a commit: the corner's own `git status` stays clean, and
    // no staging directory is left where the agent would see it.
    const status = await execFileAsync('git', ['-C', worktree.path, 'status', '--porcelain=v1']);
    expect(status.stdout.trim()).toBe('');
  });

  it('is cut normally when the store has nothing for its lockfile', async () => {
    const supervisorRoot = await scratch('beeline-warm-supervisor-');

    const worktree = await materialize(supervisorRoot, remote, 'corner-cold');

    expect(await readFile(resolve(worktree.path, 'package-lock.json'), 'utf8')).toBe(LOCKFILE);
    await expect(stat(resolve(worktree.path, 'node_modules'))).rejects.toThrow();
  });
});
