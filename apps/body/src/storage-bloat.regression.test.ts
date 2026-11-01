import { execFile } from 'node:child_process';
import { access, chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { reclaimHelperStorage } from './helper-storage.js';
import { pruneDeletedRuntimes, pruneMachineStorage, pruneRepositoryCaches } from './host-disk-retention.js';
import { activateRelease, pruneHelperReleases, readUpdateState, type BeelineInstallLayout } from './self-update.js';
import { pruneArchivedCheckoutStorage, pruneUnusedCheckoutStorage, rememberStorageOwner } from './storage-owners.js';
import { materializeCornerWorktree } from './room-runtime.js';
import { SessionScheduler } from './session-scheduler.js';

const git = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(resolve(tmpdir(), 'beeline-bloat-')); roots.push(root); return root; }
async function file(path: string, content = 'disposable bytes') { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); return path; }
const exists = (path: string) => access(path).then(() => true, () => false);
async function age(path: string) {
  const info = await lstat(path);
  if (info.isDirectory()) for (const name of await readdir(path)) await age(resolve(path, name));
  if (!info.isSymbolicLink()) { const old = new Date(Date.now() - 8 * 86400_000); await utimes(path, old, old); }
}
async function repository(root: string, path: string) {
  const source = resolve(root, 'source');
  await git('git', ['init', '-b', 'main', source]);
  await file(resolve(source, 'README'), 'published source');
  await git('git', ['-C', source, 'add', '.']);
  await git('git', ['-C', source, '-c', 'user.name=Bee', '-c', 'user.email=bee@example.test', 'commit', '-m', 'published']);
  await mkdir(dirname(path), { recursive: true });
  await git('git', ['clone', source, path]);
  return source;
}

it('keeps exactly the active helper and the version it displaced, repairing old installs on startup', async () => {
  const root = await fixture();
  const layout: BeelineInstallLayout = { libDir: resolve(root, 'lib/beeline'), binDir: resolve(root, 'bin'), releasesRoot: resolve(root, 'lib/beeline-releases') };
  for (const id of ['old', 'previous', 'current', 'next']) await file(resolve(layout.releasesRoot, id, 'lib/beeline/beeline-cli.mjs'));
  await symlink('beeline-releases/current', layout.libDir);
  await age(resolve(layout.releasesRoot, 'old'));
  await file(resolve(layout.releasesRoot, 'incomplete/download-fragment'));
  await rm(resolve(layout.releasesRoot, 'next'), { recursive: true });
  await pruneHelperReleases(layout);
  expect(new Set((await readdir(layout.releasesRoot)).filter(name => name !== '.state'))).toEqual(new Set(['previous', 'current']));
  await file(resolve(layout.releasesRoot, 'next/lib/beeline/beeline-cli.mjs'));
  await activateRelease(layout, 'next');
  expect(new Set((await readdir(layout.releasesRoot)).filter(name => name !== '.state'))).toEqual(new Set(['current', 'next']));
  expect((await readUpdateState(layout)).previousReleaseId).toBe('current');
});

it('deletes read-only downloaded tools in all recorded retired-runtime layouts while preserving Squire', async () => {
  const root = await fixture();
  for (const name of [`${'a'.repeat(64)}-${Date.now()}`, `orphan-20260904-${'b'.repeat(64)}`, `husk-${'c'.repeat(64)}`]) {
    const runtime = resolve(root, 'beeline/deleted-runtimes', name);
    const tool = await file(resolve(runtime, 'rooms/room/agent-home/cache/dotslash/tool/bin/executable'));
    const vault = await file(resolve(runtime, 'rooms/room/agent-home/user/.trusty-squire/vault'), 'squire');
    await chmod(dirname(tool), 0o500); await chmod(resolve(dirname(tool), '..'), 0o500);
    await pruneDeletedRuntimes(root, Date.now(), { inUse: async () => false });
    expect(await exists(tool)).toBe(false);
    expect(await readFile(vault, 'utf8')).toBe('squire');
  }
});

it('expires old video frames beside recent frames in an open agent home, and removes an archived read-only cache', async () => {
  const runtimeDir = await fixture();
  const room = resolve(runtimeDir, 'rooms/room');
  const old = await file(resolve(room, 'agent-home/video-build/old/frame.png'));
  await age(dirname(old));
  const recent = await file(resolve(room, 'agent-home/video-build/new/frame.png'));
  const transcript = await file(resolve(room, 'agent-home/codex/sessions/transcript.jsonl'));
  const transcriptMemory = await file(resolve(room, 'agent-home/warm-transcript.json'));
  await age(transcriptMemory);
  const input = { runtimeDir, inUse: async () => false, withIdleRoom: async (_id: string, task: () => Promise<void>) => { await task(); return true; } };
  await reclaimHelperStorage({ ...input, readStates: async () => [{ roomId: 'room', archived: false }] });
  expect(await exists(old)).toBe(false); expect(await exists(recent)).toBe(true); expect(await exists(transcript)).toBe(true);
  expect(await exists(transcriptMemory)).toBe(true);
  await chmod(dirname(recent), 0o500);
  await reclaimHelperStorage({ ...input, readStates: async () => [{ roomId: 'room', archived: true }] });
  expect(await exists(room)).toBe(false); // The server keeps the transcript.
});

it('reaps an archived squash-merged corner after access refusal, treating the Squire skill as source and its vault as storage', async () => {
  const root = await fixture(); const path = resolve(root, 'beeline/corners/corner');
  await repository(root, path);
  await file(resolve(path, 'skills/trusty-squire/SKILL.md'), 'skill code');
  await git('git', ['-C', path, 'add', '.']);
  await git('git', ['-C', path, '-c', 'user.name=Bee', '-c', 'user.email=bee@example.test', 'commit', '-m', 'accepted head']);
  const landedHeadSha = (await git('git', ['-C', path, 'rev-parse', 'HEAD'])).stdout.trim();
  await file(resolve(root, 'beeline/agents', 'a'.repeat(64), 'corner-cleanup-refusals/corner.json'), '{"status":403}');
  await rememberStorageOwner(root, { workspaceId: 'workspace', roomId: 'corner', kind: 'corners', itemId: 'corner', ended: true, archived: true, landedHeadSha });
  await pruneArchivedCheckoutStorage(root, { inUse: async () => false });
  expect(await exists(path)).toBe(false);
});

it('expires published legacy Room checkouts without owner records, preserving unpublished changes', async () => {
  const root = await fixture(); const path = resolve(root, 'beeline/room-checkouts', 'a'.repeat(24));
  await repository(root, path); await file(resolve(path, 'unpublished'), 'local work'); await age(path);
  await pruneUnusedCheckoutStorage(root, { inUse: async () => false });
  expect(await exists(path)).toBe(true);
  await rm(resolve(path, 'unpublished')); await age(path);
  await pruneUnusedCheckoutStorage(root, { inUse: async () => false });
  expect(await exists(path)).toBe(false);
});

it('expires a bare clone whose original branch is an older published ancestor of origin', async () => {
  const root = await fixture(); const checkout = resolve(root, 'checkout'); const source = await repository(root, checkout);
  const bare = resolve(root, 'beeline/repositories', `${'a'.repeat(24)}.git`); await mkdir(dirname(bare), { recursive: true });
  await git('git', ['clone', '--bare', source, bare]);
  await file(resolve(source, 'new'), 'remote advanced'); await git('git', ['-C', source, 'add', '.']);
  await git('git', ['-C', source, '-c', 'user.name=Bee', '-c', 'user.email=bee@example.test', 'commit', '-m', 'advance']);
  await git('git', [`--git-dir=${bare}`, 'fetch', source, '+refs/heads/main:refs/remotes/origin/main']); await age(bare);
  await pruneRepositoryCaches(root, Date.now(), { inUse: async () => false });
  expect(await exists(bare)).toBe(false);
});

it('expires old npm blobs even when another package and its parent store are recent', async () => {
  const root = await fixture(); const cache = resolve(root, 'beeline/npm-cache');
  const old = await file(resolve(cache, '_cacache/content-v2/sha512/old/blob')); await age(old);
  const recent = await file(resolve(cache, '_cacache/content-v2/sha512/recent/blob'));
  await pruneMachineStorage(root, { inUse: async () => false });
  expect(await exists(old)).toBe(false); expect(await exists(recent)).toBe(true);
});

it('lets unused shared objects be swept while another Room retains its warm process, while fencing new launches', async () => {
  const scheduler = new SessionScheduler();
  try {
    await scheduler.run('busy-room', { activate: async () => 'warm', suspend: async () => undefined }, async () => undefined);
    let release!: () => void;
    const hold = new Promise<void>(done => { release = done; });
    const sweep = SessionScheduler.withIdleHostStorage(async () => hold, { allowLiveSessions: true });
    let launched = false;
    const turn = scheduler.run('new-room', { activate: async () => { launched = true; return 'new'; }, suspend: async () => undefined }, async () => 'reply');
    expect(launched).toBe(false);
    release();
    expect(await sweep).toBe(true);
    expect(await turn).toBe('reply');
    expect(launched).toBe(true);
  } finally { await scheduler.dispose(); }
});

it('expires published legacy repository copies that the bare-clone filename filter never visited', async () => {
  const root = await fixture(); const path = resolve(root, 'beeline/repositories/github-1327312394-5c59c9a14ede');
  await repository(root, path); await age(path);
  await pruneUnusedCheckoutStorage(root, { inUse: async () => false });
  expect(await exists(path)).toBe(false);
});

it('reclaims a squash-merged agent copy and its private repository together', async () => {
  const root = await fixture(); const checkout = resolve(root, 'checkout'); const source = await repository(root, checkout);
  const worktree = await materializeCornerWorktree({ supervisorRoot: root, cornerId: 'landed', remote: `file://${source}`,
    targetBranch: 'main', featureBranch: 'feature/landed', token: 'unused', committer: { name: 'Bee', publicKey: 'a'.repeat(64) } });
  await file(resolve(worktree.path, 'feature'), 'accepted by squash'); await git('git', ['-C', worktree.path, 'add', '.']);
  await git('git', ['-C', worktree.path, '-c', 'user.name=Bee', '-c', 'user.email=bee@example.test', 'commit', '-m', 'accepted']);
  const landedHeadSha = (await git('git', ['-C', worktree.path, 'rev-parse', 'HEAD'])).stdout.trim();
  await rememberStorageOwner(root, { workspaceId: 'workspace', roomId: 'landed', kind: 'corners', itemId: basename(worktree.path), agentId: 'a'.repeat(64), ended: true, archived: true, landedHeadSha });
  await pruneArchivedCheckoutStorage(root, { inUse: async () => false });
  expect(await exists(worktree.path)).toBe(false);
  await expect(git('git', [`--git-dir=${worktree.gitCommonDir}`, 'show-ref', '--verify', 'refs/heads/feature/landed'])).rejects.toBeDefined();
  expect(await exists(worktree.gitCommonDir)).toBe(false);
});

it('expires nested legacy corner and warm-pool checkouts, removing their registrations and published local refs', async () => {
  const root = await fixture(); const clone = resolve(root, 'beeline/repositories/github-1327312394-5c59c9a14ede');
  await repository(root, clone);
  const paths = [resolve(root, 'beeline/repositories/.beeline-corners/github:1327312394/old-corner'),
    resolve(root, 'beeline/repositories/.beeline-corners/github-1327312394-5c59c9a14ede/.warm-pool/slot-1')];
  for (const [index, path] of paths.entries()) {
    await mkdir(dirname(path), { recursive: true });
    await git('git', ['-C', clone, 'worktree', 'add', '-b', `old-${index}`, path, 'origin/main']);
    await age(path);
  }
  await pruneUnusedCheckoutStorage(root, { inUse: async () => false });
  for (const [index, path] of paths.entries()) {
    expect(await exists(path)).toBe(false);
    await expect(git('git', ['-C', clone, 'show-ref', '--verify', `refs/heads/old-${index}`])).rejects.toBeDefined();
  }
});

it('expires unlisted private Room files after seven days without inventing an archive or removing credentials/history', async () => {
  const runtimeDir = await fixture(); const room = resolve(runtimeDir, 'rooms/deleted-room');
  const old = await file(resolve(room, 'agent-home/video-build/old/frame.png')); await age(old);
  const credential = await file(resolve(room, 'agent-home/codex/auth.json'), 'credential');
  const transcript = await file(resolve(room, 'agent-home/codex/sessions/thread'), 'history');
  const fresh = await file(resolve(room, 'agent-home/video-build/fresh/frame.png'));
  const entries = await reclaimHelperStorage({ runtimeDir, readStates: async () => [], inUse: async () => false,
    withIdleRoom: async (_id, task) => { await task(); return true; } });
  expect(await exists(old)).toBe(false); expect(await exists(fresh)).toBe(true);
  expect(await readFile(credential, 'utf8')).toBe('credential'); expect(await readFile(transcript, 'utf8')).toBe('history');
  expect(entries.every(entry => entry.kind === 'open')).toBe(true);
});
