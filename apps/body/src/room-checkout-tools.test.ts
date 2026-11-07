import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { it, expect } from 'vitest';
import { wrapAgentCommand } from './bwrap-sandbox.js';
import { prepareRoomGitDirectory } from './room-checkout-tools.js';
import { roomRuntimeCoordinatorMaterializeRoomCheckout } from './room-runtime-reconciliation-diagnostics.js';
import type { RoomRuntimeCoordinator } from './room-runtime.js';

const exec = promisify(execFile);
const sandboxAvailable = spawnSync('bwrap', ['--ro-bind', '/', '/', 'true']).status === 0;

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'room-checkout-proof-'));
  const seed = resolve(root, 'seed');
  await mkdir(resolve(seed, 'packages/proof'), { recursive: true });
  await writeFile(resolve(seed, 'package.json'), JSON.stringify({ name: 'fixture', private: true, workspaces: ['packages/*'],
    scripts: { proof: 'node -e "console.log(require(\'room-proof\'))"' } }));
  await writeFile(resolve(seed, 'packages/proof/package.json'), '{"name":"room-proof","version":"1.0.0","main":"index.js"}');
  await writeFile(resolve(seed, 'packages/proof/index.js'), 'module.exports = "workspace ready";');
  await writeFile(resolve(seed, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3,
    packages: { '': { name: 'fixture', workspaces: ['packages/*'] },
      'packages/proof': { name: 'room-proof', version: '1.0.0' },
      'node_modules/room-proof': { resolved: 'packages/proof', link: true } } }));
  await exec('git', ['init', '-b', 'main', seed]);
  await exec('git', ['-C', seed, 'add', '.']);
  await exec('git', ['-C', seed, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture']);
  const ctx = { runtime: { supervisorRoot: root, communityId: 'workspace' }, baseConfig: { bwrapPath: 'bwrap' },
    roomRoot: () => resolve(root, 'room-state'), options: { daemonApi: { execute: async () => ({}) } } } as unknown as RoomRuntimeCoordinator;
  const repository = { resolution: 'repository' as const, remote: `file://${seed}`, targetBranch: 'main' };
  const refresh = () => roomRuntimeCoordinatorMaterializeRoomCheckout(ctx, 'room', repository);
  return { root, seed, refresh };
}

it.skipIf(!sandboxAvailable)('Reproduction room-checkout-tools: refresh installs one shared workspace generation and reuses it', async () => {
  const { root, seed, refresh } = await fixture();
  try {
    const cwd = await refresh();
    const run = () => {
      const command = wrapAgentCommand({ bwrapPath: 'bwrap', spec: { mode: 'readonly', cwd },
        command: 'npm', args: ['run', 'proof'] });
      return exec(command.command, command.args, { cwd });
    };
    expect((await run()).stdout).toContain('workspace ready');
    const before = await stat(resolve(cwd, 'node_modules/.beeline-generation'));
    await writeFile(resolve(seed, 'unrelated'), 'new commit, same dependencies');
    await exec('git', ['-C', seed, 'add', '.']);
    await exec('git', ['-C', seed, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'refresh']);
    expect(await refresh()).toBe(cwd);
    expect((await stat(resolve(cwd, 'node_modules/.beeline-generation'))).mtimeMs).toBe(before.mtimeMs);
    expect((await run()).stdout).toContain('workspace ready');
    const oldGeneration = await readFile(resolve(cwd, 'node_modules/.beeline-generation'), 'utf8');
    const lock = JSON.parse(await readFile(resolve(seed, 'package-lock.json'), 'utf8'));
    lock.packages['packages/proof'].version = '2.0.0';
    await writeFile(resolve(seed, 'packages/proof/package.json'), '{"name":"room-proof","version":"2.0.0","main":"index.js"}');
    await writeFile(resolve(seed, 'package-lock.json'), JSON.stringify(lock));
    await exec('git', ['-C', seed, 'add', '.']);
    await exec('git', ['-C', seed, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'dependency change']);
    await refresh();
    expect(await readFile(resolve(cwd, 'node_modules/.beeline-generation'), 'utf8')).not.toBe(oldGeneration);
    expect((await run()).stdout).toContain('workspace ready');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);

it.skipIf(!sandboxAvailable)('Reproduction room-checkout-tools: git worktree add writes only private administration and home', async () => {
  const { root, refresh } = await fixture();
  try {
    const cwd = await refresh();
    const homes = [resolve(root, 'agent-a'), resolve(root, 'agent-b')];
    await Promise.all(homes.map(async home => { await mkdir(home); await writeFile(resolve(home, "private"), "secret"); }));
    const sharedHead = await readFile(resolve(cwd, '.git/HEAD'), 'utf8');
    for (const home of homes) {
      const roomGitDirectory = await prepareRoomGitDirectory(cwd, home);
      const spec = { mode: 'readonly' as const, cwd, roomGitDirectory,
        additionalWritablePaths: [home], maskPaths: homes.filter(other => other !== home).map(path => ({ path, kind: 'dir' as const })) };
      const run = (command: string, args: string[]) => {
        const wrapped = wrapAgentCommand({ bwrapPath: 'bwrap', spec, command, args });
        return exec(wrapped.command, wrapped.args, { cwd, env: { ...process.env, HOME: home } });
      };
      await run('git', ['worktree', 'add', '-b', 'same-private-branch', resolve(home, 'wt'), 'HEAD']);
      expect(await readFile(resolve(home, 'wt/packages/proof/index.js'), 'utf8')).toContain('workspace ready');
      expect((await run('git', ['-C', resolve(home, 'wt'), 'status', '--porcelain'])).stdout).toBe('');
      await expect(run('touch', [resolve(cwd, 'forbidden')])).rejects.toThrow();
      await expect(run('touch', [resolve(roomGitDirectory!, 'beeline-seed-objects/forbidden')])).rejects.toThrow();
      await expect(run('cat', [resolve(homes.find(other => other !== home)!, 'private')])).rejects.toThrow();
      await prepareRoomGitDirectory(cwd, home);
      expect((await run('git', ['worktree', 'list'])).stdout).toContain(resolve(home, 'wt'));
    }
    expect(await readFile(resolve(cwd, '.git/HEAD'), 'utf8')).toBe(sharedHead);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);
