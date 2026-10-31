import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { withKernelLock } from './kernel-lock.js';

const exec = promisify(execFile);

/** Private refs let agents check out the same public branch independently. */
export function agentCornerCheckoutPaths(root: string, cornerId: string, agentId: string) {
  for (const value of [cornerId, agentId]) {
    if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('invalid corner checkout identity');
  }
  const key = createHash('sha256').update(`${cornerId}:${agentId}`).digest('hex');
  return {
    path: resolve(root, 'beeline', 'agent-corners', cornerId, agentId),
    gitCommonDir: resolve(root, 'beeline', 'repositories', `agent-corner-${key}.git`),
  };
}

/**
 * Clone local objects with hard links, but never share mutable refs or alternates.
 * Removing or pruning the source cache cannot invalidate this agent's checkout.
 * Callers serialize source-cache updates while creating this repository.
 */
export async function materializeAgentCornerCheckout(input: {
  root: string;
  cornerId: string;
  agentId: string;
  sourceGitDir: string;
  remote: string;
  branch: string;
  startRef: string;
}): Promise<{ path: string; gitCommonDir: string }> {
  const paths = agentCornerCheckoutPaths(input.root, input.cornerId, input.agentId);
  await mkdir(dirname(paths.gitCommonDir), { recursive: true });
  const parent = await realpath(dirname(paths.gitCommonDir));
  return withKernelLock(`agent-corner-create:${parent}:${input.cornerId}:${input.agentId}`, async () => {
    if (!existsSync(resolve(paths.gitCommonDir, 'HEAD'))) {
      const staging = `${paths.gitCommonDir}.creating`;
      await rm(staging, { recursive: true, force: true });
      try {
        await exec('git', ['clone', '--bare', '--local', input.sourceGitDir, staging]);
        await exec('git', [`--git-dir=${staging}`, 'remote', 'set-url', 'origin', input.remote]);
        await exec('git', [`--git-dir=${staging}`, 'config', '--replace-all',
          'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
        // Resolve before publishing so a bad start ref never leaves a partial checkout.
        const head = (await exec('git', [`--git-dir=${input.sourceGitDir}`, 'rev-parse', '--verify', input.startRef])).stdout.trim();
        await exec('git', [`--git-dir=${staging}`, 'update-ref', `refs/heads/${input.branch}`, head]);
        await rename(staging, paths.gitCommonDir);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
    if (!existsSync(resolve(paths.path, '.git'))) {
      await mkdir(dirname(paths.path), { recursive: true });
      await exec('git', [`--git-dir=${paths.gitCommonDir}`, 'worktree', 'add', paths.path, input.branch]);
    }
    await exec('git', [`--git-dir=${paths.gitCommonDir}`, 'config', 'extensions.worktreeConfig', 'true']);
    await exec('git', ['-C', paths.path, 'config', '--worktree', 'core.bare', 'false']);
    return paths;
  });
}
