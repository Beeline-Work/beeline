// Exercise the built helper with real Git, npm and its Room sandbox.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { roomRuntimeCoordinatorMaterializeRoomCheckout } from '../apps/body/dist/room-runtime-reconciliation-diagnostics.js';
import { prepareRoomGitDirectory } from '../apps/body/dist/room-checkout-tools.js';
import { wrapAgentCommand } from '../apps/body/dist/bwrap-sandbox.js';

const exec = promisify(execFile);
const root = await mkdtemp(resolve(tmpdir(), 'room-checkout-demonstration-'));
try {
  const seed = resolve(root, 'seed'), home = resolve(root, 'agent-home');
  await mkdir(resolve(seed, 'packages/proof'), { recursive: true });
  await mkdir(home);
  await writeFile(resolve(seed, 'package.json'), JSON.stringify({ name: 'proof', private: true, workspaces: ['packages/*'],
    scripts: { proof: 'node -e "console.log(require(\'room-proof\'))"' } }));
  await writeFile(resolve(seed, 'packages/proof/package.json'), '{"name":"room-proof","version":"1.0.0","main":"index.js"}');
  await writeFile(resolve(seed, 'packages/proof/index.js'), 'module.exports = "workspace ready";');
  await writeFile(resolve(seed, 'package-lock.json'), JSON.stringify({ name: 'proof', lockfileVersion: 3, packages: {
    '': { name: 'proof', workspaces: ['packages/*'] }, 'packages/proof': { name: 'room-proof', version: '1.0.0' },
    'node_modules/room-proof': { link: true, resolved: 'packages/proof' } } }));
  await exec('git', ['init', '-b', 'main', seed]);
  await exec('git', ['-C', seed, 'add', '.']);
  await exec('git', ['-C', seed, '-c', 'user.name=Proof', '-c', 'user.email=proof@example.com', 'commit', '-m', 'proof']);
  const ctx = { runtime: { supervisorRoot: root, communityId: 'proof' }, baseConfig: { bwrapPath: 'bwrap' },
    roomRoot: () => resolve(root, 'room'), options: { daemonApi: { execute: async () => ({}) } } };
  const refresh = () => roomRuntimeCoordinatorMaterializeRoomCheckout(ctx, 'room', {
    resolution: 'repository', remote: `file://${seed}`, targetBranch: 'main' });
  const cwd = await refresh();
  const roomGitDirectory = await prepareRoomGitDirectory(cwd, home);
  const run = async (command, args) => {
    const wrapped = wrapAgentCommand({ bwrapPath: 'bwrap', spec: { mode: 'readonly', cwd,
      roomGitDirectory, additionalWritablePaths: [home] }, command, args });
    return exec(wrapped.command, wrapped.args, { cwd, env: { ...process.env, HOME: home } });
  };
  assert.match((await run('npm', ['run', 'proof'])).stdout, /workspace ready/);
  console.log('Reproduction room-checkout-tools: npm run proof in read-only refreshed checkout → workspace ready');
  const marker = resolve(cwd, 'node_modules/.beeline-generation');
  const before = await stat(marker);
  await refresh();
  assert.equal((await stat(marker)).mtimeMs, before.mtimeMs);
  console.log('Unchanged lockfile → same installed generation');
  await run('git', ['worktree', 'add', resolve(home, 'wt'), 'HEAD']);
  assert.match(await readFile(resolve(home, 'wt/packages/proof/index.js'), 'utf8'), /workspace ready/);
  assert.equal((await run('git', ['-C', resolve(home, 'wt'), 'status', '--porcelain'])).stdout, '');
  await assert.rejects(run('touch', [resolve(cwd, 'forbidden')]));
  console.log('Reproduction room-checkout-tools: git worktree add ~/wt HEAD → usable private worktree; shared source writes still refused');
} finally { await rm(root, { recursive: true, force: true }); }
