import { access, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const osEvidence = vi.hoisted(() => ({ fail: false, files: '', mounts: '' }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const run = async (...args: unknown[]) => {
    if (args[0] === '/usr/sbin/lsof' || args[0] === '/sbin/mount') {
      if (osEvidence.fail) throw new Error('OS evidence unavailable');
      return { stdout: args[0] === '/usr/sbin/lsof' ? osEvidence.files : osEvidence.mounts, stderr: '' };
    }
    return Reflect.apply(promisify(actual.execFile), undefined, args);
  };
  const wrapped = (...args: unknown[]) => Reflect.apply(actual.execFile, undefined, args);
  Object.defineProperty(wrapped, promisify.custom, { value: run });
  return { ...actual, execFile: wrapped };
});
import { capturePrivateProcessUse, hasMount, reclaimHelperStorage, storageTree } from './helper-storage.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const roots: string[] = [];
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  osEvidence.fail = false; osEvidence.files = ''; osEvidence.mounts = '';
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const exists = (path: string) => access(path).then(() => true, () => false);

it('uses native macOS filesystem inventory and lsof to expire storage without Python or Linux /proc', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  const runtimeDir = await mkdtemp(resolve(tmpdir(), 'beeline-darwin-storage-')); roots.push(runtimeDir);
  const cache = resolve(runtimeDir, 'rooms/room/agent-home/cache');
  await mkdir(cache, { recursive: true }); await writeFile(resolve(cache, 'download'), 'old cache');
  const old = new Date(Date.now() - 8 * 86400_000);
  await utimes(resolve(cache, 'download'), old, old); await utimes(cache, old, old);
  const external = resolve(runtimeDir, 'external'); await mkdir(external); await writeFile(resolve(external, 'vault'), 'keep');
  await symlink(external, resolve(runtimeDir, 'rooms/room/external-link'));
  expect((await storageTree(resolve(runtimeDir, 'rooms/room'))).has(resolve(runtimeDir, 'rooms/room/external-link/vault'))).toBe(false);
  osEvidence.files = `p123\nn${resolve(cache, 'download')}\n`;
  const input = { runtimeDir, readStates: async () => [{ roomId: 'room', archived: false }],
    withIdleRoom: async (_id: string, task: () => Promise<void>) => { await task(); return true; } };
  expect(await reclaimHelperStorage(input)).toEqual([]);
  osEvidence.files = `p124\nn${external}/vault\n`;
  await reclaimHelperStorage(input);
  expect(await exists(resolve(cache, 'download'))).toBe(false);
  expect(await exists(resolve(external, 'vault'))).toBe(true);
});

it('protects mounted macOS descendants and retains storage when process or mount evidence is unavailable', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  osEvidence.files = 'p123\nn/elsewhere/file\n';
  osEvidence.mounts = '/dev/disk on / (apfs, local)\nmap on /private/cache/bound (autofs)\n';
  expect(await hasMount('/private/cache')).toBe(true);
  expect(await hasMount('/private/other')).toBe(false);
  expect((await capturePrivateProcessUse())('/private/other')).toBe(false);
  osEvidence.fail = true;
  expect((await capturePrivateProcessUse())('/private/other')).toBe(true);
  await expect(hasMount('/private/other')).rejects.toThrow('OS evidence unavailable');
});
