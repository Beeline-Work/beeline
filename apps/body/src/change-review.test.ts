import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listChangeReviewFiles,
  MAX_RENDERABLE_PATCH_BYTES,
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
  it('lists file status and line totals, then returns a per-file unified patch', async () => {
    const { directory, base, tip } = fixture();
    const files = await listChangeReviewFiles(directory, base, tip);

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
    const patch = await readChangeReviewPatch(directory, base, tip, readme);
    expect(patch.content).toContain('diff --git a/README.md b/README.md');
    expect(patch.content).toContain('-# Before');
    expect(patch.content).toContain('+# After');
    expect(patch.content).toContain('+New line');
    expect(patch.patchBytes).toBe(Buffer.byteLength(patch.content!));
  });

  it('streams a multi-megabyte single-line diff into a too-large stub', async () => {
    const { directory, base } = fixture();
    writeFileSync(resolve(directory, 'vendor.min.js'), 'x'.repeat(3_000_000));
    writeFileSync(resolve(directory, 'small.ts'), 'export const stillReviewable = true;\n');
    command(directory, ['add', '.']);
    command(directory, ['commit', '-m', 'large vendor and ordinary source']);
    const tip = command(directory, ['rev-parse', 'HEAD']);
    const files = await listChangeReviewFiles(directory, base, tip);

    const large = await readChangeReviewPatch(
      directory,
      base,
      tip,
      files.find((file) => file.path === 'vendor.min.js')!,
    );
    const small = await readChangeReviewPatch(
      directory,
      base,
      tip,
      files.find((file) => file.path === 'small.ts')!,
    );

    expect(large).toEqual({
      patchBytes: expect.any(Number),
      renderUnavailableReason: 'too-large',
    });
    expect(large.patchBytes).toBeGreaterThan(MAX_RENDERABLE_PATCH_BYTES);
    expect(small.content).toContain('+export const stillReviewable = true;');
  });

  it('resolves the merge base', async () => {
    const { directory, base } = fixture();
    expect(await resolveReviewBaseTip(directory, 'refs/heads/main')).toBe(base);
  });
});
