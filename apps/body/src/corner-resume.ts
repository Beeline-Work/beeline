import { git } from '@beeline/gate';

export interface CornerGitResumeState {
  changedFiles: string[];
  commits: string[];
}

function lines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Read-only, bounded git facts for a newly reactivated corner process. */
export async function readCornerGitResumeState(
  cwd: string,
  targetRef: string,
): Promise<CornerGitResumeState> {
  const mergeBase = await git(cwd, ['merge-base', targetRef, 'HEAD']);
  const base = mergeBase.ok ? mergeBase.stdout.trim() : targetRef;
  const committedFiles = await git(cwd, ['diff', '--name-only', `${base}...HEAD`]);
  const status = await git(cwd, ['status', '--porcelain']);
  const dirtyFiles = status.ok
    ? status.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) =>
          line
            .slice(3)
            .replace(/^.* -> /, '')
            .trim(),
        )
    : [];
  const log = await git(cwd, ['log', '--format=%h %s', '-n', '12', `${base}..HEAD`]);
  return {
    changedFiles: [
      ...new Set([...(committedFiles.ok ? lines(committedFiles.stdout) : []), ...dirtyFiles]),
    ]
      .filter(Boolean)
      .slice(0, 40),
    commits: (log.ok ? lines(log.stdout) : []).slice(0, 12),
  };
}
