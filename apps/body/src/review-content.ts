import { git } from '@beeline/gate';

const PATCH_ID = /^[0-9a-f]{40}$/;

/** Stable content identity for the complete corner diff. */
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

/** Find a stable patch identity in one bounded recent target history. */
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

/** Direct-merge or squash-merge containment proof for one corner tip. */
export async function targetContainsCornerPatch(
  cwd: string,
  targetTip: string,
  cornerTip: string,
): Promise<boolean> {
  if (!PATCH_ID.test(targetTip) || !PATCH_ID.test(cornerTip)) return false;
  if ((await git(cwd, ['merge-base', '--is-ancestor', cornerTip, targetTip])).ok) return true;
  const mergeBase = (await git(cwd, ['merge-base', targetTip, cornerTip])).stdout.trim();
  if (!PATCH_ID.test(mergeBase)) return false;
  const patchId = await reviewPatchId(cwd, mergeBase, cornerTip);
  return patchId ? targetHistoryContainsPatchId(cwd, targetTip, patchId) : false;
}
