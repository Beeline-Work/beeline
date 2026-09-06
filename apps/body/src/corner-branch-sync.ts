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
 *   - the histories diverged → rebase this worktree's own commits on top.
 *
 * A rebase that cannot be resolved is not swallowed and is not force-pushed
 * over: it is aborted and raised as one sentence a turn failure can carry into
 * the corner, so the humans reading it learn that two agents pushed and the
 * branch needs a person. The alternative — pushing anyway — is the clobber
 * this exists to prevent.
 */
export type CornerBranchSync = 'unchanged' | 'fast-forwarded' | 'rebased';

export class CornerBranchDivergedError extends Error {
  override readonly name = 'CornerBranchDivergedError';
}

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
  } catch (error) {
    // Leaving a half-finished rebase behind would fail every later turn for a
    // reason that has nothing to do with the work.
    await git(['rebase', '--abort']).catch(() => undefined);
    throw new CornerBranchDivergedError(divergedReason(input.featureBranch, error));
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

/** One line, inside the turn-failure reason budget, naming the branch and the fix. */
export function divergedReason(featureBranch: string, error?: unknown): string {
  const detail = String((error as { stderr?: string })?.stderr ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /conflict|could not|error:/i.test(line));
  return [
    `could not rebase onto origin/${featureBranch}: another agent pushed to this corner's branch`,
    detail ? ` (${detail})` : '',
    '. Nothing was pushed; the branch needs a person.',
  ]
    .join('')
    .slice(0, 200);
}
