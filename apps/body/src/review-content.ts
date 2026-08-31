import { git } from '@beeline/gate';

const PATCH_ID = /^[0-9a-f]{40}$/;

/**
 * Return Git's stable patch identity for the complete reviewed diff.
 *
 * Unlike a commit SHA, `git patch-id --stable` ignores commit metadata and
 * line-number movement. The same reviewed change therefore keeps its identity
 * when the corner is rebased onto a newer target, while any actual content
 * edit produces a different identity.
 */
export async function reviewPatchId(
  cwd: string,
  base: string,
  tip: string,
): Promise<string | undefined> {
  const diff = await git(
    cwd,
    ['diff', '--binary', '--full-index', '--no-ext-diff', `${base}..${tip}`],
    { maxOutputBytes: 64 * 1024 * 1024 },
  );
  if (!diff.ok || !diff.stdout || diff.truncated) return undefined;

  const patch = await git(cwd, ['patch-id', '--stable'], {
    stdin: diff.stdout,
    maxOutputBytes: 1024,
  });
  if (!patch.ok || patch.truncated) return undefined;
  const id = patch.stdout.trim().split(/\s+/)[0];
  return id && PATCH_ID.test(id) ? id : undefined;
}

/**
 * Whether a reviewed diff is already present as a commit on the target.
 *
 * A squash merge deliberately creates a different commit SHA. Git's stable
 * patch identity is the durable content comparison: scan one bounded recent
 * target history in a single `git log | git patch-id` pass instead of spawning
 * a process per commit.
 */
export async function targetHistoryContainsPatchId(
  cwd: string,
  targetTip: string,
  patchId: string,
  maxCommits = 512,
): Promise<boolean> {
  if (!PATCH_ID.test(targetTip) || !PATCH_ID.test(patchId)) return false;
  const boundedMax = Math.max(1, Math.min(2_000, Math.floor(maxCommits)));
  const history = await git(
    cwd,
    [
      'log',
      `--max-count=${boundedMax}`,
      '--format=commit %H',
      '--patch',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      targetTip,
    ],
    { maxOutputBytes: 64 * 1024 * 1024 },
  );
  if (!history.ok || history.truncated || !history.stdout) return false;
  const identities = await git(cwd, ['patch-id', '--stable'], {
    stdin: history.stdout,
    maxOutputBytes: 256 * 1024,
  });
  if (!identities.ok || identities.truncated) return false;
  return identities.stdout.split('\n').some((line) => line.trim().split(/\s+/)[0] === patchId);
}
