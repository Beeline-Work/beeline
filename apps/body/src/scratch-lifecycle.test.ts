import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  allocatedDirectoryBytes, assertScratchWriteBudget, pruneSharedModelCache,
  scratchBudgetMessage, scratchGrowthExceedsBudget,
} from './scratch-lifecycle.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

it('reports usage and refuses an over-budget write without expiring user scratch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-scratch-'));
  roots.push(root);
  const home = join(root, 'agent-home');
  await mkdir(home);
  await mkdir(join(root, 'agent-private'));
  await writeFile(join(home, 'session'), 'must survive');
  await writeFile(join(root, 'agent-private/approval'), 'must survive');
  await writeFile(join(root, 'old.txt'), 'expire');
  await writeFile(join(root, 'new.txt'), 'keep');
  const now = Date.now();
  await utimes(join(root, 'old.txt'), new Date(now - 15 * 86400_000), new Date(now - 15 * 86400_000));
  expect(await allocatedDirectoryBytes(root)).toBeGreaterThan(0);
  await expect(assertScratchWriteBudget(root, 1, 1)).rejects.toThrow(/OVER BUDGET/);
  expect(scratchBudgetMessage(0)).not.toMatch(/expire|days/);
  expect(scratchGrowthExceedsBudget(11, 5, 10)).toBe(true);
  expect(scratchGrowthExceedsBudget(11, 12, 10)).toBe(false);
  expect(await readFile(join(root, 'old.txt'), 'utf8')).toBe('expire');
  expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('keep');
  expect(await readFile(join(home, 'session'), 'utf8')).toBe('must survive');
  expect(await readFile(join(root, 'agent-private/approval'), 'utf8')).toBe('must survive');
});

it('prunes old complete model entries only when every descendant has been unused for seven days', async () => {
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
  const stale = new Date(now - 8 * 86400_000);
  await utimes(join(old, 'weights'), stale, stale);
  await utimes(old, stale, stale);
  expect(await pruneSharedModelCache(root, now, 1)).toEqual([old]);
  await expect(access(old)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(fresh)).resolves.toBeUndefined();
});
