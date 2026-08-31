import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  reviewPatchId,
  targetContainsCornerPatch,
  targetHistoryContainsPatchId,
} from './review-content.js';

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

describe('review patch identity', () => {
  it('finds a branch-alive reviewed patch after a squash merge changes the SHA', async () => {
    const { root, base, reviewed } = fixture();
    const patchId = await reviewPatchId(root, base, reviewed);
    git(root, ['checkout', '-q', 'main']);
    git(root, ['merge', '--squash', 'feature']);
    git(root, ['commit', '-qm', 'squash reviewed change']);
    const squashTip = git(root, ['rev-parse', 'HEAD']);

    expect(git(root, ['show-ref', '--verify', 'refs/heads/feature'])).toContain(reviewed);
    expect(squashTip).not.toBe(reviewed);
    expect(patchId).toMatch(/^[0-9a-f]{40}$/);
    await expect(targetHistoryContainsPatchId(root, squashTip, patchId!)).resolves.toBe(true);
    await expect(targetContainsCornerPatch(root, squashTip, reviewed)).resolves.toBe(true);
  });
});
