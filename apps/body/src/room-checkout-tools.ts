import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { credentialMaskPaths, wrapAgentCommand, type SandboxSessionSpec } from './bwrap-sandbox.js';
import { prepareDependencyGeneration } from './dependency-generation.js';
import { isPlanRefusal, readWarmPlan, sharedNpmCacheDir, warmNodeModulesStoreDir } from './warm-node-modules.js';

const exec = promisify(execFile);

/** One dependency generation belongs to the shared checkout, never to an agent. */
export async function prepareRoomCheckoutDependencies(root: string, supervisorRoot: string, bwrapPath?: string): Promise<void> {
  const plan = await readWarmPlan(root);
  if (isPlanRefusal(plan)) {
    if (plan.failure === 'unsafe-lockfile') throw new Error('Unsafe Room dependency lockfile');
    return;
  }
  if (!bwrapPath) throw new Error('Room dependencies require a working bubblewrap sandbox');
  const npm = (await exec('which', ['npm'])).stdout.trim();
  const cache = sharedNpmCacheDir(supervisorRoot);
  await mkdir(cache, { recursive: true });
  await prepareDependencyGeneration({ root, store: warmNodeModulesStoreDir(supervisorRoot), npm, cache,
    install: async () => {
      const home = await mkdtemp(resolve(root, '.beeline-install-'));
      try {
        const command = wrapAgentCommand({ bwrapPath,
          spec: { mode: 'readonly', cwd: root, additionalWritablePaths: [root, cache],
            maskPaths: [...credentialMaskPaths(undefined),
              ...['agents', 'corners', 'repositories'].map(part => resolve(supervisorRoot, 'beeline', part))
                .filter(path => existsSync(path)).map(path => ({ path, kind: 'dir' as const }))] },
          command: npm, args: ['ci', '--prefix', root, '--no-audit', '--no-fund'] });
        await exec(command.command, command.args, { cwd: root,
          env: { PATH: process.env.PATH, HOME: home, npm_config_cache: cache },
          maxBuffer: 16 * 1024 * 1024 });
      } finally { await rm(home, { recursive: true, force: true }); }
    },
  });
}

/** Private refs, index and worktree administration overlay the read-only .git. */
export async function prepareRoomGitDirectory(checkout: string, home: string,
  sandbox: { bwrapPath: string; spec?: SandboxSessionSpec } = { bwrapPath: 'bwrap' },
): Promise<string | undefined> {
  if (!existsSync(resolve(checkout, '.git'))) return undefined;
  const target = resolve(home, `room-repository-${createHash('sha256').update(checkout).digest('hex').slice(0, 24)}.git`);
  const info = await lstat(target).catch(() => undefined);
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Invalid private Room Git directory');
  const run = (program: string, args: string[]) => {
    const command = wrapAgentCommand({ bwrapPath: sandbox.bwrapPath,
      spec: sandbox.spec ?? { mode: 'readonly', cwd: checkout, additionalWritablePaths: [home],
        maskPaths: credentialMaskPaths(undefined) }, command: program, args });
    return exec(command.command, command.args, { cwd: checkout,
      env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } });
  };
  const git = (...args: string[]) => run('git', args);
  if (!existsSync(resolve(target, 'HEAD'))) {
    await mkdir(home, { recursive: true });
    // The helper retains seed objects; agents can read but never mutate them.
    await git('clone', '--bare', '--shared', checkout, target);
    const remote = (await git('-C', checkout, 'remote', 'get-url', 'origin')).stdout.trim();
    await git(`--git-dir=${target}`, 'remote', 'set-url', 'origin', remote);
  }
  const seedObjects = resolve(target, 'beeline-seed-objects');
  const alternates = async (source: string) => run(process.execPath, ['-e',
    'const fs=require("node:fs"),p=require("node:path");fs.mkdirSync(process.argv[1],{recursive:true});fs.writeFileSync(p.join(process.argv[2],"objects/info/alternates"),process.argv[3]+"\\n");',
    seedObjects, target, source]);
  // Preparation runs before the overlay; the harness gets the stable read-only mount.
  await alternates(resolve(checkout, '.git/objects'));
  const head = (await git('-C', checkout, 'rev-parse', 'HEAD')).stdout.trim();
  await git(`--git-dir=${target}`, 'fetch', '--no-tags', checkout, head);
  await git(`--git-dir=${target}`, 'update-ref', '--no-deref', 'HEAD', head);
  await git(`--git-dir=${target}`, 'config', 'core.bare', 'false');
  await git(`--git-dir=${target}`, 'config', 'core.worktree', checkout);
  await git(`--git-dir=${target}`, 'read-tree', head);
  await alternates(seedObjects);
  return target;
}
