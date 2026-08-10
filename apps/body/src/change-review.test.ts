import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  chunkChangeReviewPatch,
  listChangeReviewFiles,
  readChangeReviewPatch,
  resolveReviewBaseTip,
} from './change-review.js';

const temporaryDirectories: string[] = [];

function command(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const directory = mkdtempSync(resolve(tmpdir(), 'buzzy-review-'));
  temporaryDirectories.push(directory);
  command(directory, ['init', '-b', 'main']);
  command(directory, ['config', 'user.name', 'Review Test']);
  command(directory, ['config', 'user.email', 'review@test.invalid']);
  writeFileSync(resolve(directory, 'README.md'), '# Before\n\nOld line\n');
  writeFileSync(resolve(directory, 'old-name.ts'), 'export const oldName = true;\n');
  command(directory, ['add', '.']);
  command(directory, ['commit', '-m', 'base']);
  const base = command(directory, ['rev-parse', 'HEAD']);
  command(directory, ['checkout', '-b', 'feature/review']);
  writeFileSync(resolve(directory, 'README.md'), '# After\n\nOld line\nNew line\n');
  command(directory, ['mv', 'old-name.ts', 'new-name.ts']);
  writeFileSync(resolve(directory, 'added.ts'), 'export const added = true;\n');
  command(directory, ['add', '.']);
  command(directory, ['commit', '-m', 'feature']);
  const tip = command(directory, ['rev-parse', 'HEAD']);
  return { directory, base, tip };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('change review git metadata', () => {
  it('lists file status and line totals, then returns a per-file unified patch', () => {
    const { directory, base, tip } = fixture();
    const files = listChangeReviewFiles(directory, base, tip);

    expect(files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'README.md',
          status: 'modified',
          linesAdded: 2,
          linesRemoved: 1,
        }),
        expect.objectContaining({
          path: 'added.ts',
          status: 'added',
          linesAdded: 1,
          linesRemoved: 0,
        }),
        expect.objectContaining({
          path: 'new-name.ts',
          previousPath: 'old-name.ts',
          status: 'renamed',
        }),
      ]),
    );

    const readme = files.find((file) => file.path === 'README.md')!;
    const patch = readChangeReviewPatch(directory, base, tip, readme);
    expect(patch).toContain('diff --git a/README.md b/README.md');
    expect(patch).toContain('-# Before');
    expect(patch).toContain('+# After');
    expect(patch).toContain('+New line');
  });

  it('resolves the merge base and chunks large patches without data loss', () => {
    const { directory, base } = fixture();
    expect(resolveReviewBaseTip(directory, 'refs/heads/main')).toBe(base);

    const patch = `header\n${'x'.repeat(70_000)}\nfooter`;
    const chunks = chunkChangeReviewPatch(patch);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.join('')).toBe(patch);
  });
});
