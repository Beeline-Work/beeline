import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { reviewPatchId } from './review-content.js';

const roots: string[] = [];

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function fixture(): { root: string; base: string; reviewed: string } {
  const root = mkdtempSync(join(tmpdir(), 'beeline-review-content-'));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Patch Identity Test']);
  git(root, ['config', 'user.email', 'patch@test.invalid']);
  writeFileSync(join(root, 'note.txt'), 'base\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  const base = git(root, ['rev-parse', 'HEAD']);
  git(root, ['checkout', '-qb', 'feature']);
  writeFileSync(join(root, 'note.txt'), 'base\nreviewed content\n');
  git(root, ['commit', '-qam', 'reviewed change']);
  return { root, base, reviewed: git(root, ['rev-parse', 'HEAD']) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('reviewPatchId', () => {
  it('survives a pure rebase while the commit SHA changes', async () => {
    const { root, base, reviewed } = fixture();
    const before = await reviewPatchId(root, base, reviewed);
    git(root, ['checkout', '-q', 'main']);
    writeFileSync(join(root, 'other.txt'), 'new target work\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'move target']);
    const movedBase = git(root, ['rev-parse', 'HEAD']);
    git(root, ['checkout', '-q', 'feature']);
    git(root, ['rebase', 'main']);
    const rebased = git(root, ['rev-parse', 'HEAD']);

    expect(rebased).not.toBe(reviewed);
    expect(await reviewPatchId(root, movedBase, rebased)).toBe(before);
  });

  it('changes when the reviewed content changes', async () => {
    const { root, base, reviewed } = fixture();
    const before = await reviewPatchId(root, base, reviewed);
    writeFileSync(join(root, 'note.txt'), 'base\nmaterially different content\n');
    git(root, ['commit', '-qam', 'change reviewed content']);

    expect(await reviewPatchId(root, base, git(root, ['rev-parse', 'HEAD']))).not.toBe(before);
  });
});
