import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { findObsoleteAssetCopies } from './obsolete-agent-assets.js';
import { applyRequestedStartupCleanup, requestStartupCleanup } from './startup-cleanup.js';
import { markWorkspaceLayoutLive, prepareWorkspaceAssets, workspaceAssetRoot } from './workspace-assets.js';
import { defaultSupervisorRoot } from './runtime.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('removes only identical downloaded copies after layout activation and preserves sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-cleanup-'));
  roots.push(root);
  expect(defaultSupervisorRoot({ XDG_STATE_HOME: root })).toBe(root);
  const agent = resolve(root, 'beeline/agents', 'a'.repeat(64));
  const home = resolve(agent, 'rooms/one/agent-home');
  const old = resolve(home, 'codex/cache');
  const shared = await prepareWorkspaceAssets(workspaceAssetRoot(root, 'workspace-one'));
  const target = resolve(shared.cache, 'codex/download');
  await mkdir(old, { recursive: true });
  await writeFile(resolve(agent, 'runtime.json'), JSON.stringify({ communityId: 'workspace-one', supervisorRoot: root }));
  await writeFile(resolve(old, 'catalog.json'), 'download');
  await writeFile(resolve(target, 'catalog.json'), 'download');
  await writeFile(resolve(old, 'local-only.json'), 'private cache');
  await writeFile(resolve(target, 'different.json'), 'new cache');
  await mkdir(resolve(home, 'codex/sessions'), { recursive: true });
  await writeFile(resolve(home, 'codex/sessions/thread.json'), 'private');
  expect(await findObsoleteAssetCopies(root)).toEqual([]);
  await markWorkspaceLayoutLive(shared);
  const inventory = await findObsoleteAssetCopies(root);
  expect(inventory).toHaveLength(1);
  expect(inventory[0]!.apparentBytes).toBe(8);
  await requestStartupCleanup(root);
  await applyRequestedStartupCleanup(root);
  await expect(stat(resolve(old, 'catalog.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(resolve(home, 'codex/sessions/thread.json'), 'utf8')).toBe('private');
  expect(await readFile(resolve(old, 'local-only.json'), 'utf8')).toBe('private cache');
  expect(await readFile(resolve(target, 'catalog.json'), 'utf8')).toBe('download');
});

it('ignores malformed runtime records and never treats them as cleanup authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-cleanup-malformed-'));
  roots.push(root);
  const agent = resolve(root, 'beeline/agents', 'b'.repeat(64));
  await mkdir(agent, { recursive: true });
  await writeFile(resolve(agent, 'runtime.json'), '{broken');
  expect(await findObsoleteAssetCopies(root)).toEqual([]);
});
