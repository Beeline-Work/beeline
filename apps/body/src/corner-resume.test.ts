import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { readCornerGitResumeState } from './corner-resume.js';

function run(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

describe('corner resume git state', () => {
  it('reads committed and half-finished files from a real repository without mutating it', async () => {
    const repo = await mkdtemp(resolve(tmpdir(), 'beeline-corner-resume-'));
    run(repo, ['init', '-b', 'main']);
    run(repo, ['config', 'user.name', 'Beeline Test']);
    run(repo, ['config', 'user.email', 'beeline@example.test']);
    await writeFile(resolve(repo, 'base.txt'), 'base\n');
    run(repo, ['add', 'base.txt']);
    run(repo, ['commit', '-m', 'base']);
    run(repo, ['checkout', '-b', 'feature/continuity']);
    await writeFile(resolve(repo, 'committed.ts'), 'export const committed = true;\n');
    run(repo, ['add', 'committed.ts']);
    run(repo, ['commit', '-m', 'feat: preserve reasoning']);
    await writeFile(resolve(repo, 'unfinished.ts'), 'export const unfinished = true;\n');

    const before = run(repo, ['rev-parse', 'HEAD']);
    expect(readCornerGitResumeState(repo, 'main')).toEqual({
      changedFiles: ['committed.ts', 'unfinished.ts'],
      commits: [expect.stringMatching(/^[0-9a-f]+ feat: preserve reasoning$/)],
    });
    expect(run(repo, ['rev-parse', 'HEAD'])).toBe(before);
  });
});
