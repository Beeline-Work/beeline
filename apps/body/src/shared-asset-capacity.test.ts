import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { admitSharedAssets, privateRecoveryReservePath, releaseReserveOnEnospc } from './shared-asset-capacity.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('stops shared admission at the floor and frees the preallocated private reserve', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-reserve-'));
  roots.push(root);
  const reserve = privateRecoveryReservePath(root);
  let free = 1024n;
  const options = { floorBytes: 512, reserveBytes: 128, freeBytes: async () => free };
  expect(await admitSharedAssets(root, 128, options)).toBe(true);
  expect((await stat(reserve)).size).toBe(128);
  free = 500n;
  expect(await admitSharedAssets(root, 0, options)).toBe(false);
  await expect(stat(reserve)).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(resolve(root, 'private-conversation'), 'persisted');
  expect(await readFile(resolve(root, 'private-conversation'), 'utf8')).toBe('persisted');
});

it('releases reserve on a real ENOSPC-shaped asset failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-reserve-'));
  roots.push(root);
  await admitSharedAssets(root, 0, { floorBytes: 0, reserveBytes: 64 });
  await releaseReserveOnEnospc(root, Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
  await expect(stat(privateRecoveryReservePath(root))).rejects.toMatchObject({ code: 'ENOENT' });
});
