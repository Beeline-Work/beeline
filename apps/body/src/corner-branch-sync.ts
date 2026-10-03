import { execFile } from 'node:child_process';

export const CORNER_GIT_SYNC_TIMEOUT_MS = 120_000;
export const CORNER_GIT_SYNC_KILL_GRACE_MS = 1_000;

class CornerGitSyncInterruptedError extends Error {}

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
  readonly signal?: AbortSignal;
  /** Seam for tests; defaults to running real git in the worktree. */
  readonly git?: (args: readonly string[]) => Promise<string>;
}

export async function syncCornerBranch(input: CornerBranchSyncInput): Promise<CornerBranchSync> {
  const git = async (args: readonly string[]): Promise<string> => {
    const controller = new AbortController();
    const signal = input.signal
      ? AbortSignal.any([input.signal, controller.signal])
      : controller.signal;
    const timer = setTimeout(() => controller.abort(), CORNER_GIT_SYNC_TIMEOUT_MS);
    const interrupted = () =>
      new CornerGitSyncInterruptedError(
        `corner git sync ${args[0]} ${controller.signal.aborted ? `timed out after ${CORNER_GIT_SYNC_TIMEOUT_MS}ms` : 'stopped'}`,
      );
    try {
      if (signal.aborted) throw interrupted();
      return await new Promise<string>((resolve, reject) => {
        let killTimer: NodeJS.Timeout | undefined;
        let stdout = '';
        let failure: Error | null = null;
        const child = input.git
          ? undefined
          : execFile(
              'git',
              ['-C', input.worktreePath, ...args],
              {
                ...(input.env ? { env: input.env } : {}),
                signal,
                maxBuffer: 4 * 1024 * 1024,
              },
              (error, output) => {
                failure = error;
                stdout = output;
              },
            );
        const abort = () => {
          if (!child) {
            cleanup();
            reject(interrupted());
          } else {
            killTimer = setTimeout(() => child.kill('SIGKILL'), CORNER_GIT_SYNC_KILL_GRACE_MS);
          }
        };
        signal.addEventListener('abort', abort, { once: true });
        const cleanup = () => {
          signal.removeEventListener('abort', abort);
          if (killTimer) clearTimeout(killTimer);
        };
        if (child)
          child.once('close', () => {
            cleanup();
            if (signal.aborted) reject(interrupted());
            else if (failure) reject(failure);
            else resolve(stdout);
          });
        else input.git!(args).then(resolve, reject).finally(cleanup);
      });
    } finally {
      clearTimeout(timer);
    }
  };
  const remoteRef = `refs/remotes/origin/${input.featureBranch}`;
  const fetched = await git([
    'fetch',
    'origin',
    `+refs/heads/${input.featureBranch}:${remoteRef}`,
  ]).then(
    () => true,
    (error) => {
      const text = error instanceof Error ? error.message : String(error);
      if (
        /remote ref does not exist|remote reference does not exist|couldn't find remote ref/i.test(
          text,
        )
      )
        return false;
      throw error;
    },
  );
  // Nothing has been pushed to this corner's branch yet: this worktree is the
  // whole of it, and there is nobody to be behind.
  if (!fetched) return 'unchanged';
  const remote = (await git(['rev-parse', remoteRef])).trim();
  if (!remote) throw new Error(`fetched corner branch has no remote ref: ${remoteRef}`);
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
    if (error instanceof CornerGitSyncInterruptedError) throw error;
    await git(['rebase', '--abort']).catch((error) => {
      if (error instanceof CornerGitSyncInterruptedError) throw error;
    });
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
    (error) => {
      if (error instanceof CornerGitSyncInterruptedError) throw error;
      return false;
    },
  );
}
