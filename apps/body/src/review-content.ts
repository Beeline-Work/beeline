import { spawnSync } from 'node:child_process';

const PATCH_ID = /^[0-9a-f]{40}$/;

/**
 * Return Git's stable patch identity for the complete reviewed diff.
 *
 * Unlike a commit SHA, `git patch-id --stable` ignores commit metadata and
 * line-number movement. The same reviewed change therefore keeps its identity
 * when the corner is rebased onto a newer target, while any actual content
 * edit produces a different identity.
 */
export function reviewPatchId(cwd: string, base: string, tip: string): string | undefined {
  const diff = spawnSync(
    'git',
    ['diff', '--binary', '--full-index', '--no-ext-diff', `${base}..${tip}`],
    { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (diff.status !== 0 || !diff.stdout) return undefined;

  const patch = spawnSync('git', ['patch-id', '--stable'], {
    cwd,
    encoding: 'utf8',
    input: diff.stdout,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (patch.status !== 0) return undefined;
  const id = patch.stdout.trim().split(/\s+/)[0];
  return id && PATCH_ID.test(id) ? id : undefined;
}
