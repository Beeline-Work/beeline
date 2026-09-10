import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Two agents, one branch.
 *
 * A corner works like a Room: every member agent may be addressed in it and
 * carries the same work on, and the branch on GitHub — not any one helper's
 * worktree — is the artifact they share. So a helper's local checkout is never
 * assumed to be the branch: before a turn runs, the remote branch is fetched
 * and this worktree is brought onto it.
 *
 *   - remote absent, or already contained in this worktree → nothing to do;
 *   - this worktree strictly behind → fast-forward;
 *   - the histories diverged → rebase this worktree's own commits on top;
 *   - that rebase conflicts → realign to the shared remote head.
 *
 * Realignment discards only this helper's unpushed local commits. The remote
 * branch remains authoritative and is never force-pushed; the next turn can
 * redo the fixed objective against the other helper's accepted work.
 */
export type CornerBranchSync = 'unchanged' | 'fast-forwarded' | 'rebased' | 'realigned';

export interface CornerBranchSyncInput {
  readonly worktreePath: string;
  readonly featureBranch: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Seam for tests; defaults to running real git in the worktree. */
  readonly git?: (args: readonly string[]) => Promise<string>;
}

export async function syncCornerBranch(input: CornerBranchSyncInput): Promise<CornerBranchSync> {
  const git =
    input.git ??
    (async (args: readonly string[]) =>
      (
        await execFileAsync('git', ['-C', input.worktreePath, ...args], {
          ...(input.env ? { env: input.env } : {}),
          maxBuffer: 4 * 1024 * 1024,
        })
      ).stdout);
  const remoteRef = `refs/remotes/origin/${input.featureBranch}`;
  const fetched = await git([
    'fetch',
    'origin',
    `+refs/heads/${input.featureBranch}:${remoteRef}`,
  ]).then(
    () => true,
    () => false,
  );
  // Nothing has been pushed to this corner's branch yet: this worktree is the
  // whole of it, and there is nobody to be behind.
  if (!fetched) return 'unchanged';
  const remote = await git(['rev-parse', remoteRef]).then(
    (value) => value.trim(),
    () => '',
  );
  if (!remote) return 'unchanged';
  const local = (await git(['rev-parse', 'HEAD'])).trim();
  if (local === remote) return 'unchanged';
  // The remote head is already an ancestor: this worktree is ahead, and its
  // push will fast-forward the branch.
  if (await contains(git, local, remote)) return 'unchanged';
  const behind = await contains(git, remote, local);
  try {
    await git(behind ? ['merge', '--ff-only', remote] : ['rebase', remote]);
    return behind ? 'fast-forwarded' : 'rebased';
  } catch {
    await git(['rebase', '--abort']).catch(() => undefined);
    await git(['reset', '--hard', remote]);
    return 'realigned';
  }
}

/** Whether `ancestor` is already reachable from `head`. */
async function contains(
  git: (args: readonly string[]) => Promise<string>,
  head: string,
  ancestor: string,
): Promise<boolean> {
  return git(['merge-base', '--is-ancestor', ancestor, head]).then(
    () => true,
    () => false,
  );
}
