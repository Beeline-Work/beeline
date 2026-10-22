import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as native from './native-helper.js';
import { bootstrapMachine } from './recovery.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it.each(['staged', 'active'] as const)('boots the verified %s release without a publication request', async kind => {
  const home = await mkdtemp(resolve(tmpdir(), 'beeline-fast-boot-'));
  roots.push(home);
  const libDir = resolve(home, '.local/lib/beeline');
  const releases = resolve(home, '.local/lib/beeline-releases');
  for (const id of ['obsolete', 'old', 'new']) {
    await mkdir(resolve(releases, id, 'lib/beeline'), { recursive: true });
    await writeFile(resolve(releases, id, 'lib/beeline/beeline-cli.mjs'), 'export {};');
    await writeFile(resolve(releases, id, '.stage-ok'), 'a'.repeat(64));
  }
  await symlink('beeline-releases/old', libDir);
  if (kind === 'staged') {
    await mkdir(resolve(releases, '.state'), { recursive: true });
    await writeFile(resolve(releases, '.state/update-state.json'), JSON.stringify({ stagedReleaseId: 'new' }));
  }
  vi.spyOn(native, 'nativeHelperStatus').mockResolvedValue({ MainPID: '123' });
  const network = vi.fn().mockRejectedValue(new Error('publication unavailable'));
  vi.stubGlobal('fetch', network);
  const entry = await bootstrapMachine({ ...process.env, HOME: home,
    BEELINE_LIB_DIR: libDir, BEELINE_BOOT_LAUNCHER_PID: '123' });
  expect(network).not.toHaveBeenCalled();
  expect(entry).toBe(resolve(releases, kind === 'staged' ? 'new' : 'old', 'lib/beeline/beeline-cli.mjs'));
  // Release retention belongs to the serving helper, never successor import.
  expect(await readFile(resolve(releases, 'obsolete/lib/beeline/beeline-cli.mjs'), 'utf8')).toBe('export {};');
});
