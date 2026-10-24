import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

// Supply pending input at the stream boundary without exporting the private git helper.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (...args: Parameters<typeof actual.execFile>) => {
      const child = actual.execFile(...args);
      if (child.stdin) {
        const stdin = child.stdin;
        const end = stdin.end.bind(stdin);
        vi.spyOn(stdin, 'end').mockImplementation(() => end('x'.repeat(8 * 1024 * 1024)));
      }
      return child;
    },
  };
});

import { fetchRepositoryCache } from './repository-cache-repair.js';

it('reports git failure instead of crashing when git exits with input pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-cache-stdin-'));
  try {
    // Real git rejects the missing repository before reading the oversized stdin write.
    await expect(fetchRepositoryCache({
      gitDir: join(root, 'missing.git'),
      label: 'missing cache',
      args: ['origin'],
    })).rejects.toMatchObject({
      code: 128,
      stderr: expect.stringContaining('not a git repository'),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
