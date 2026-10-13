import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile, utimes, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { identityFromKey, stageMonolithAgentRuntime, runtimeDirectory } from './runtime.js';
import { reclaimHelperStorage, reclaimWholeStorageObject, isSquirePath } from './helper-storage.js';
import { retireRemovedAgent } from './agent-retirement.js';
import { materializeCornerWorktree } from './room-runtime.js';
import { rememberStorageOwner, reclaimOwnedCheckout, pruneEndedOwnerStorage } from './storage-owners.js';
import { workspaceAssetRoot } from './workspace-assets.js';
import { helperStorageReport } from './storage-report.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const exists = (path: string) => access(path).then(() => true, () => false);
async function file(path: string, content = 'owned bytes') { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }
async function age(path: string) {
  const info = await lstat(path);
  if (info.isDirectory()) for (const child of await readdir(path)) await age(resolve(path, child));
  if (!info.isSymbolicLink()) { const old = new Date(Date.now() - 8 * 86400_000); await utimes(path, old, old); }
}

it('ends a Room, code corner, agent and last local Workspace; no payload byte survives outside Squire', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-storage-e2e-')); roots.push(root);
  const staged = await stageMonolithAgentRuntime({ workspaceId: 'workspace', pairedBy: 'human',
    daemonExchangeToken: `bde_${'a'.repeat(43)}`, agentBinary: '/nonexistent', agentKind: 'codex',
    agentCommand: '/nonexistent', agentArgs: [], mcpBinary: 'unused',
    agentIdentity: identityFromKey('31'.repeat(32), 'Bee'), bodyIdentity: identityFromKey('41'.repeat(32), 'Body'), supervisorRoot: root });
  const runtimeDir = runtimeDirectory(root, staged.runtime.agent.publicKey);
  const room = resolve(runtimeDir, 'rooms/room');
  const corner = resolve(runtimeDir, 'rooms/corner');
  const avd = 'agent-home/user/.android/avd/device.avd/snapshot';
  for (const owner of [room, corner]) for (const path of ['agent-home/cache/download', 'build/output', avd, 'agent-home/codex/sessions/transcript', 'scratch/data']) await file(resolve(owner, path));
  const squire = resolve(room, 'agent-home/user/.trusty-squire/vault'); await file(squire, 'squire');
  const workspace = resolve(workspaceAssetRoot(root, 'workspace'), '..');
  await file(resolve(workspace, 'shared-home/cache/npm/pkg'));
  await file(resolve(workspace, 'shared-home/avd-base/device/snapshot'));
  const seed = resolve(root, 'seed');
  await exec('git', ['init', '-b', 'main', seed]); await file(resolve(seed, 'README'));
  await exec('git', ['-C', seed, 'add', '.']);
  await exec('git', ['-C', seed, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'published']);
  const remote = resolve(root, 'remote.git'); await exec('git', ['clone', '--bare', seed, remote]);
  const code = await materializeCornerWorktree({ supervisorRoot: root, cornerId: 'corner', remote: `file://${remote}`, targetBranch: 'main', featureBranch: 'feature/corner', token: 'unused', committer: { name: 'Bee', publicKey: staged.runtime.agent.publicKey } });
  const codeOwner = { workspaceId: 'workspace', roomId: 'corner', kind: 'corners' as const, itemId: 'corner' };
  await rememberStorageOwner(root, codeOwner);
  await file(resolve(code.path, 'unpublished'), 'protect');
  expect(await reclaimOwnedCheckout(root, codeOwner)).toEqual([]);
  await rm(resolve(code.path, 'unpublished'));
  const readStates = async () => [{ roomId: 'room', archived: true }, { roomId: 'corner', archived: true }];
  const reclaimed = await reclaimHelperStorage({ runtimeDir, readStates,
    inUse: async () => false, withIdleRoom: async (_id, task) => { await task(); return true; } });
  expect(reclaimed.length).toBeGreaterThan(0);
  expect(await exists(corner)).toBe(false);
  expect(await readFile(squire, 'utf8')).toBe('squire');
  expect(await reclaimOwnedCheckout(root, codeOwner)).toEqual([code.path]);
  await retireRemovedAgent(staged.runtime, { run: vi.fn(async () => ({ stdout: 'not-found\n' })) });
  await pruneEndedOwnerStorage(root);
  expect(await exists(workspace)).toBe(false);
  expect(await exists(staged.configPath)).toBe(false);
  // Check every remaining file under owner payload stores, not selected names.
  const remaining: string[] = [];
  async function walk(path: string): Promise<void> {
    if (isSquirePath(path)) return;
    const info = await lstat(path).catch(() => undefined);
    if (!info) return;
    if (info.isDirectory()) for (const child of await readdir(path)) await walk(resolve(path, child));
    else remaining.push(path);
  }
  for (const store of ['agents', 'corners', 'room-checkouts', 'workspaces']) await walk(resolve(root, 'beeline', store));
  expect(remaining).toEqual([]);
  expect((await helperStorageReport(root)).orphans).toEqual([]);
});

it('uses newest descendant access time for a whole host object; links cannot delete external storage', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-whole-object-')); roots.push(root);
  const item = resolve(root, 'cache'); await file(resolve(item, 'pkg/old'));
  await age(item);
  const recentlyRead = new Date(); const old = new Date(Date.now() - 8 * 86400_000);
  await utimes(resolve(item, 'pkg/old'), recentlyRead, old);
  expect(await reclaimWholeStorageObject(item, false, { inUse: async () => false })).toEqual([]);
  const external = resolve(root, 'external'); await file(resolve(external, 'vault'));
  await symlink(external, resolve(item, 'external-link'));
  await reclaimWholeStorageObject(item, true, { inUse: async () => false });
  expect(await readFile(resolve(external, 'vault'), 'utf8')).toBe('owned bytes');
});

it('reports unknown/read-failed lifecycle separately from confirmed orphans, with no deletes', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-orphan-report-')); roots.push(root);
  const agent = 'a'.repeat(64); const runtime = resolve(root, 'beeline/agents', agent);
  await file(resolve(runtime, 'runtime.json'), JSON.stringify({ agent: { publicKey: agent }, communityId: 'workspace', supervisorRoot: root,
    transport: { baseUrl: 'https://example.test', daemonToken: 'test' } }));
  await file(resolve(runtime, 'rooms/unknown/data')); await file(resolve(runtime, 'rooms/archived/data'));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ workspaceIds: ['workspace'], rooms: [], storageRooms: [{ roomId: 'archived', archived: true }] }))));
  const report = await helperStorageReport(root);
  expect(report.orphans.map(item => item.path)).toEqual([resolve(runtime, 'rooms/archived')]);
  expect(report.unknown.some(item => item.path === resolve(runtime, 'rooms/unknown'))).toBe(true);
  expect(await exists(resolve(runtime, 'rooms/archived/data'))).toBe(true);
  await file(resolve(runtime, 'rooms/archived/agent-home/user/.trusty-squire/vault'));
  await rm(resolve(runtime, 'rooms/archived/data'));
  expect((await helperStorageReport(root, { orphanOnly: true })).orphans).toEqual([]);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  expect((await helperStorageReport(root)).orphans).toEqual([]);
});

it('a settled archive removes private folders of stopped members too, but host Room activity defers everyone', async () => {
  const { reclaimArchivedMemberStorage } = await import('./storage-owners.js');
  const { SessionScheduler } = await import('./session-scheduler.js');
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-stopped-member-')); roots.push(root);
  for (const agent of ['a', 'b']) await file(resolve(root, 'beeline/agents', agent.repeat(64), 'rooms/room/agent-home/cache/data'));
  const scheduler = new SessionScheduler();
  try {
    await scheduler.run('room', { activate: async () => 'live', suspend: async () => undefined }, async () => undefined);
    await reclaimArchivedMemberStorage(root, [{ roomId: 'room', archived: true }], { inUse: async () => false });
    for (const agent of ['a', 'b']) expect(await exists(resolve(root, 'beeline/agents', agent.repeat(64), 'rooms/room'))).toBe(true);
    await scheduler.suspend('room');
    await reclaimArchivedMemberStorage(root, [{ roomId: 'room', archived: true }], { inUse: async () => false });
    for (const agent of ['a', 'b']) expect(await exists(resolve(root, 'beeline/agents', agent.repeat(64), 'rooms/room'))).toBe(false);
  } finally { await scheduler.dispose(); }
});

it('retires a stopped agent only on terminal agent_removed, preserving it on failed/unknown reads', async () => {
  const { pruneStoppedAgentStorage } = await import('./storage-owners.js');
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-stopped-retirement-')); roots.push(root);
  const agent = 'a'.repeat(64); const runtime = resolve(root, 'beeline/agents', agent);
  await file(resolve(runtime, 'runtime.json'), JSON.stringify({ agent: { publicKey: agent }, communityId: 'workspace', supervisorRoot: root,
    transport: { baseUrl: 'https://example.test', daemonToken: 'test' } }));
  await file(resolve(runtime, 'stopped')); await file(resolve(runtime, 'rooms/room/build/output'));
  for (const status of [401, 500]) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'agent_removed' }), { status })));
    await pruneStoppedAgentStorage(root, { inUse: async () => false });
    expect(await exists(runtime)).toBe(true);
  }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'agent_removed' }), { status: 403 })));
  await pruneStoppedAgentStorage(root, { inUse: async () => false });
  expect(await exists(runtime)).toBe(false);
});

it('reclaims whole unused ignored build directories while preserving tracked files and recent artifacts', async () => {
  const { pruneOpenCheckoutObjects } = await import('./storage-owners.js');
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-open-build-')); roots.push(root);
  const checkout = resolve(root, 'beeline/room-checkouts', 'a'.repeat(24));
  await exec('git', ['init', checkout]);
  await file(resolve(checkout, '.gitignore'), 'build/\ndist/\n');
  await file(resolve(checkout, 'build/stale')); await file(resolve(checkout, 'dist/recent'));
  await file(resolve(checkout, 'source'), 'keep source');
  const owner = { workspaceId: 'workspace', roomId: 'room', kind: 'room-checkouts' as const, itemId: 'a'.repeat(24) };
  await rememberStorageOwner(root, owner);
  await age(resolve(checkout, 'build'));
  await pruneOpenCheckoutObjects(root, [{ roomId: 'room', archived: false }], { inUse: async () => false });
  expect(await exists(resolve(checkout, 'build'))).toBe(false);
  expect(await exists(resolve(checkout, 'dist/recent'))).toBe(true);
  expect(await readFile(resolve(checkout, 'source'), 'utf8')).toBe('keep source');
});
