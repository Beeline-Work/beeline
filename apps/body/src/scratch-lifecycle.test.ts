import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  allocatedDirectoryBytes, assertScratchWriteBudget, pruneSharedModelCache,
  scratchBudgetMessage, scratchGrowthExceedsBudget, sweepStaleCornerScratch,
} from './scratch-lifecycle.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

it('reports usage, refuses an over-budget write, and expires only old scratch files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-scratch-'));
  roots.push(root);
  const home = join(root, 'agent-home');
  await mkdir(home);
  await writeFile(join(home, 'session'), 'must survive');
  await writeFile(join(root, 'old.txt'), 'expire');
  await writeFile(join(root, 'new.txt'), 'keep');
  const now = Date.now();
  await utimes(join(root, 'old.txt'), new Date(now - 15 * 86400_000), new Date(now - 15 * 86400_000));
  expect(await allocatedDirectoryBytes(root)).toBeGreaterThan(0);
  await expect(assertScratchWriteBudget(root, 1, 1)).rejects.toThrow(/OVER BUDGET/);
  expect(scratchBudgetMessage(0)).toMatch(/14 days/);
  expect(scratchGrowthExceedsBudget(11, 5, 10)).toBe(true);
  expect(scratchGrowthExceedsBudget(11, 12, 10)).toBe(false);
  expect((await sweepStaleCornerScratch(root, now)).files).toBe(1);
  await expect(access(join(root, 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('keep');
  expect(await readFile(join(home, 'session'), 'utf8')).toBe('must survive');
});

it('prunes old complete model entries after the shared cache exceeds its budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-model-cache-'));
  roots.push(root);
  const hub = join(root, 'hub');
  const old = join(hub, 'models--old');
  const fresh = join(hub, 'models--fresh');
  await mkdir(old, { recursive: true });
  await mkdir(fresh);
  await writeFile(join(old, 'weights'), Buffer.alloc(4096));
  await writeFile(join(fresh, 'weights'), Buffer.alloc(4096));
  const now = Date.now();
  await utimes(old, new Date(now - 2 * 86400_000), new Date(now - 2 * 86400_000));
  expect(await pruneSharedModelCache(root, now, 1)).toEqual([old]);
  await expect(access(old)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(fresh)).resolves.toBeUndefined();
});
