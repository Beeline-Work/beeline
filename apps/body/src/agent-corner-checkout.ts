import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { copyFile, cp, link, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CRASH_SAFE_CLONE_ARGS, fetchRepositoryCache } from './repository-cache-repair.js';

const execFileAsync = promisify(execFile);
const git = (args: string[], env?: NodeJS.ProcessEnv) => execFileAsync('git', args, { env, timeout: 120_000, killSignal: 'SIGKILL' });

/** Private refs let agents check out the same public branch independently. */
export function agentCornerCheckoutPaths(root: string, cornerId: string, agentId: string) {
  for (const value of [cornerId, agentId]) {
    if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('invalid corner checkout identity');
  }
  const key = createHash('sha256').update(`${cornerId}:${agentId}`).digest('hex');
  return {
    path: resolve(root, 'beeline', 'corners', key),
    gitCommonDir: resolve(root, 'beeline', 'repositories', `agent-corner-${key}.git`),
  };
}

/** Preserve legacy work privately; dependency sharing begins at sealed activation. */
async function copyLegacy(source: string, target: string): Promise<void> {
  for (const entry of await readdir(source)) {
    if (entry === '.git') continue;
    const from = resolve(source, entry), to = resolve(target, entry);
    const stat = await lstat(from);
    if (stat.isDirectory()) {
      await mkdir(to, { recursive: true });
      await copyLegacy(from, to);
    } else await cp(from, to, { verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  }
}

/**
 * A mirror of the seed whose object files are hard links. `git clone --local`
 * ignores `--local` for a shallow seed and writes a full private pack
 * (about 0.5 GiB per Beeline copy), so the objects are linked here directly.
 * `objects/info` is skipped: it may name alternates or a stale commit-graph.
 */
async function linkSeedRepository(seed: string, staging: string): Promise<void> {
  await git([...CRASH_SAFE_CLONE_ARGS, 'init', '--bare', '--quiet', staging]);
  // `clone -c` would persist these settings; `init -c` does not.
  for (const setting of CRASH_SAFE_CLONE_ARGS.filter(arg => arg !== '-c')) {
    const [key, value] = setting.split('=', 2) as [string, string];
    await git([`--git-dir=${staging}`, 'config', key, value]);
  }
  const linkTree = async (from: string, to: string): Promise<void> => {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const source = resolve(from, entry.name), target = resolve(to, entry.name);
      if (entry.isDirectory()) await linkTree(source, target);
      else if (entry.isFile()) await link(source, target).catch(async (error: NodeJS.ErrnoException) => {
        // Another mount (a sandbox bind) cannot hold a link: copy instead.
        if (error.code === 'EXDEV') await copyFile(source, target);
        else if (error.code !== 'EEXIST') throw error;
      });
    }
  };
  for (const entry of await readdir(resolve(seed, 'objects'), { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'info')
      await linkTree(resolve(seed, 'objects', entry.name), resolve(staging, 'objects', entry.name));
  }
  await copyFile(resolve(seed, 'shallow'), resolve(staging, 'shallow')).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  // Every object is already present, so this copies only the refs.
  await git([...CRASH_SAFE_CLONE_ARGS, `--git-dir=${staging}`, 'fetch', '--quiet', '--update-shallow',
    '--no-write-fetch-head', seed, '+refs/*:refs/*']);
  await git([`--git-dir=${staging}`, 'config', 'remote.origin.url', seed]);
  await git([`--git-dir=${staging}`, 'config', 'remote.origin.mirror', 'true']);
}

/**
 * Clone immutable local objects with hard links, never refs or alternates.
 * One coordinator owns each corner+agent setup; there are no checkout locks.
 * The source cache remains recovery evidence until ordinary archive cleanup.
 */
export async function materializeAgentCornerCheckout(input: {
  root: string; cornerId: string; agentId: string; sourceGitDir: string;
  remote: string; branch: string; startRef: string;
  targetBranch?: string; env?: NodeJS.ProcessEnv;
  /** Only the server's current implementer receives the old shared work. */
  legacyPath?: string;
}): Promise<{ path: string; gitCommonDir: string }> {
  const paths = agentCornerCheckoutPaths(input.root, input.cornerId, input.agentId);
  await mkdir(dirname(paths.gitCommonDir), { recursive: true });
  if ((await lstat(paths.path).catch(() => undefined))?.isSymbolicLink()) throw new Error('refusing symlinked agent checkout');
  let legacy = input.legacyPath && existsSync(resolve(input.legacyPath, '.git')) ? input.legacyPath : undefined;
  const transferRecord = legacy ? resolve((await git(['-C', legacy, 'rev-parse', '--absolute-git-dir'])).stdout.trim(), 'beeline-agent-checkout') : undefined;
  const transferred = transferRecord ? await readFile(transferRecord, 'utf8').catch(() => undefined) : undefined;
  if (transferred && transferred !== paths.path) legacy = undefined;
  const pending = resolve(paths.gitCommonDir, 'beeline-legacy-pending');
  const creating = !existsSync(resolve(paths.gitCommonDir, 'HEAD'));
  const label = `repositories/${basename(paths.gitCommonDir)}`;
  if (creating) {
    const staging = `${paths.gitCommonDir}.creating`;
    await rm(staging, { recursive: true, force: true });
    try {
      try {
        await linkSeedRepository(input.sourceGitDir, staging);
        await git([`--git-dir=${staging}`, 'fsck', '--connectivity-only', '--no-dangling']);
      } catch (error) {
        if (!input.targetBranch) throw error;
        // A damaged immutable seed must not disable every new corner. Rebuild
        // only this private staging copy from the remote; keep the seed intact.
        await rm(staging, { recursive: true, force: true });
        await git(['clone', '--mirror', ...CRASH_SAFE_CLONE_ARGS, input.remote, staging], input.env);
        if (legacy) {
          const localHead = (await git(['-C', legacy, 'rev-parse', 'HEAD'])).stdout.trim();
          await git([`--git-dir=${staging}`, 'fetch', input.sourceGitDir, localHead]);
        }
      }
      await git([`--git-dir=${staging}`, 'config', '--unset', 'remote.origin.mirror']);
      await git([`--git-dir=${staging}`, 'remote', 'set-url', 'origin', input.remote]);
      await git([`--git-dir=${staging}`, 'config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
      let startRef = input.startRef;
      if (input.targetBranch) {
        const fetch = (branch: string) => fetchRepositoryCache({ gitDir: staging, label,
          args: ['origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], env: input.env });
        await fetch(input.targetBranch);
        const published = await fetch(input.branch).then(() => true, error => {
          if (/remote ref does not exist|remote reference does not exist|couldn't find remote ref/i.test(String(error))) return false;
          throw error;
        });
        startRef = `refs/remotes/origin/${published ? input.branch : input.targetBranch}`;
      }
      const head = (await git(legacy
        ? ['-C', legacy, 'rev-parse', '--verify', 'HEAD']
        : [`--git-dir=${staging}`, 'rev-parse', '--verify', startRef])).stdout.trim();
      await git([`--git-dir=${staging}`, 'update-ref', `refs/heads/${input.branch}`, head]);
      await git([`--git-dir=${staging}`, 'symbolic-ref', 'HEAD', `refs/heads/${input.branch}`]);
      // Seed objects are shared; inherited local branches are not this agent's
      // work. Keep only its branch so later publication checks cover every
      // branch the agent creates without pinning other legacy corners.
      const inherited = (await git([`--git-dir=${staging}`, 'for-each-ref', '--format=%(refname)', 'refs/heads'])).stdout
        .trim().split('\n').filter(ref => ref && ref !== `refs/heads/${input.branch}`);
      if (!legacy) inherited.push('refs/stash');
      const prune = git([`--git-dir=${staging}`, 'update-ref', '--stdin']);
      prune.child.stdin?.on('error', () => undefined);
      prune.child.stdin?.end(inherited.map(ref => `delete ${ref}\n`).join(''));
      await prune;

      if (legacy) await writeFile(resolve(staging, 'beeline-legacy-pending'), legacy);
      await rename(staging, paths.gitCommonDir);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  await git([`--git-dir=${paths.gitCommonDir}`, 'config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
  if (!creating && input.targetBranch) await fetchRepositoryCache({ gitDir: paths.gitCommonDir, label,
    args: ['origin', `+refs/heads/${input.targetBranch}:refs/remotes/origin/${input.targetBranch}`], env: input.env });
  if (!existsSync(resolve(paths.path, '.git'))) {
    await mkdir(dirname(paths.path), { recursive: true });
    await git([`--git-dir=${paths.gitCommonDir}`, 'worktree', 'add', paths.path, input.branch]);
  }
  await git([`--git-dir=${paths.gitCommonDir}`, 'config', 'extensions.worktreeConfig', 'true']);
  await git(['-C', paths.path, 'config', '--worktree', 'core.bare', 'false']);
  const source = await readFile(pending, 'utf8').catch(() => undefined);
  if (source) {
    // A pending copy has never been handed to a harness. Rebuilding it also
    // preserves staged deletions, which overlaying a fresh checkout would undo.
    if (source !== legacy || relative(resolve(input.root, 'beeline/corners'), source) !== input.cornerId)
      throw new Error('legacy corner import source changed');
    for (const entry of await readdir(paths.path)) {
      if (entry !== '.git') await rm(resolve(paths.path, entry), { recursive: true, force: true });
    }
    await copyLegacy(source, paths.path);
    const index = async (path: string) => (await git(['-C', path, 'rev-parse', '--path-format=absolute', '--git-path', 'index'])).stdout.trim();
    await copyFile(await index(source), await index(paths.path));
    await rename(pending, resolve(paths.gitCommonDir, 'beeline-legacy-imported'));
    if (transferRecord) await writeFile(transferRecord, paths.path);
  }
  // Git must identify exactly this checkout, including when root is symlinked.
  const top = (await git(['-C', paths.path, 'rev-parse', '--show-toplevel'])).stdout.trim();
  if (await realpath(top) !== await realpath(paths.path)) throw new Error('agent corner checkout escaped its root');
  return paths;
}
