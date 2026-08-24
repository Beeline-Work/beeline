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
