import { execFile } from 'node:child_process';

/**
 * The reviewed CHANGE, not the reviewed commit.
 *
 * A corner's PR approval is bound to a head sha, but catching a branch up on
 * main (merge or rebase, no new work) moves the head without changing what
 * was reviewed. `git patch-id --stable` hashes a diff's content independent
 * of the commit(s) that produced it, so the same net change against main
 * always yields the same id even after a clean catch-up; any real code
 * change yields a different one. Best-effort: returns undefined on any git
 * failure (detached worktree, no merge base, missing target ref) rather than
 * failing the caller — an absent patch id just means the caller falls back
 * to exact head-sha matching.
 */
export interface PatchIdentityInput {
  readonly worktreePath: string;
  readonly targetBranch: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Seam for tests; defaults to running real git (optionally piping stdin). */
  readonly git?: (args: readonly string[], stdin?: string) => Promise<string>;
}

export async function computePatchId(input: PatchIdentityInput): Promise<string | undefined> {
  const git = input.git ?? ((args, stdin) => runGit(input.worktreePath, args, input.env, stdin));
  try {
    const base = (await git(['merge-base', `origin/${input.targetBranch}`, 'HEAD'])).trim();
    if (!base) return undefined;
    const diff = await git(['diff', base, 'HEAD']);
    if (!diff.trim()) return undefined;
    const id = (await git(['patch-id', '--stable'], diff)).trim().split(/\s+/)[0];
    return id || undefined;
  } catch {
    return undefined;
  }
}

function runGit(
  worktreePath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
  stdin?: string,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      'git',
      ['-C', worktreePath, ...args],
      { ...(env ? { env } : {}), maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise(stdout);
      },
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}
