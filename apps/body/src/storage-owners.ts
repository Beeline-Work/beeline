import { lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentRuntimeRecord } from './runtime.js';
import { runtimeDirectory } from './runtime.js';
import { workspaceAssetRoot } from './workspace-assets.js';
import { writePrivateFileAtomically } from './atomic-private-file.js';
import { reclaimWholeStorageObject, capturePrivateProcessUse, storageTree, isSquirePath, reclaimHelperStorage, type StorageRoomState, type WholeStorageOptions } from './helper-storage.js';

const execFileAsync = promisify(execFile);
export interface StorageOwner { workspaceId: string; roomId: string; kind: 'corners' | 'room-checkouts'; itemId: string }
function ownersRoot(supervisorRoot: string): string { return resolve(supervisorRoot, 'beeline', 'storage-owners'); }
export async function rememberStorageOwner(supervisorRoot: string, owner: StorageOwner): Promise<void> {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(owner.itemId)) throw new Error('invalid storage owner item');
  const path = resolve(ownersRoot(supervisorRoot), `${owner.kind}-${owner.itemId}.json`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writePrivateFileAtomically(path, JSON.stringify(owner));
}

/** Local publication evidence remains authoritative after the owner's token
 * is revoked. Failed reads, local changes and unpublished HEADs all preserve. */
export async function reclaimOwnedCheckout(supervisorRoot: string, owner: StorageOwner, options: WholeStorageOptions = {}): Promise<string[]> {
  if (!['corners', 'room-checkouts'].includes(owner.kind) || !/^[a-zA-Z0-9-]{1,80}$/.test(owner.itemId)) return [];
  const path = resolve(supervisorRoot, 'beeline', owner.kind, owner.itemId);
  const tree = await storageTree(path).catch(() => undefined);
  if (!tree || [...tree.keys()].some(isSquirePath)) return [];
  const published = async () => {
    try {
      if ((await execFileAsync('git', ['-C', path, 'status', '--porcelain=v1', '--untracked-files=all'], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout.trim()) return false;
      const contained = await execFileAsync('git', ['-C', path, 'for-each-ref', '--format=%(refname)', '--contains=HEAD', 'refs/remotes/origin/']);
      return Boolean(contained.stdout.trim());
    } catch { return false; }
  };
  const entries = await reclaimWholeStorageObject(path, true, { ...options, beforeRemove: published });
  if (entries.length && !options.dryRun && owner.kind === 'corners') {
    // Remove only now-stale worktree metadata. Published refs remain recoverable.
    const common = resolve(supervisorRoot, 'beeline', 'repositories');
    for (const repo of await readdir(common).catch(() => [])) {
      if (/^[a-f0-9]{24}\.git$/.test(repo))
        await execFileAsync('git', [`--git-dir=${resolve(common, repo)}`, 'worktree', 'prune', '--expire=now']);
    }
  }
  if (entries.length && !options.dryRun)
    await rm(resolve(ownersRoot(supervisorRoot), `${owner.kind}-${owner.itemId}.json`), { force: true });
  return entries.map(entry => entry.path);
}

export async function readStorageOwners(supervisorRoot: string): Promise<StorageOwner[]> {
  const root = ownersRoot(supervisorRoot);
  const owners: StorageOwner[] = [];
  for (const name of await readdir(root).catch(() => [])) {
    if (!/^(corners|room-checkouts)-[a-zA-Z0-9-]{1,80}\.json$/.test(name)) continue;
    const owner = await readFile(resolve(root, name), 'utf8').then(text => JSON.parse(text) as StorageOwner, () => undefined);
    if (owner) owners.push(owner);
  }
  return owners;
}

/** A persisted ended-owner fact retries cleanup if a detached process was
 * still running during retirement. Never infer removal from a missing config. */
export async function markAgentStorageEnded(runtime: AgentRuntimeRecord): Promise<void> {
  const path = resolve(ownersRoot(runtime.supervisorRoot), `ended-agent-${runtime.agent.publicKey}.json`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writePrivateFileAtomically(path, JSON.stringify({ agentId: runtime.agent.publicKey, workspaceId: runtime.communityId }));
}

/** Successful removal may leave only the ancestors needed by Squire. Empty
 * unknown directories still need retry authority if their rm failed. */
async function endedRootCleared(root: string): Promise<boolean> {
  if (!await lstat(root).catch(() => undefined)) return true;
  const tree = await storageTree(root).catch(() => undefined);
  if (!tree) return false;
  const squire = [...tree.keys()].filter(isSquirePath);
  return squire.length > 0 && [...tree].every(([path, item]) => isSquirePath(path) ||
    item.directory && squire.some(saved => saved.startsWith(`${path}/`)));
}

export async function pruneEndedOwnerStorage(supervisorRoot: string, options: WholeStorageOptions = {}): Promise<string[]> {
  const root = ownersRoot(supervisorRoot);
  const removed: string[] = [];
  for (const name of await readdir(root).catch(() => [])) {
    if (!/^ended-agent-[a-f0-9]{64}\.json$/.test(name)) continue;
    const owner = JSON.parse(await readFile(resolve(root, name), 'utf8')) as { agentId: string; workspaceId: string };
    if (!/^[a-f0-9]{64}$/.test(owner.agentId) || !owner.workspaceId) continue;
    const source = runtimeDirectory(supervisorRoot, owner.agentId);
    removed.push(...(await reclaimWholeStorageObject(source, true, options)).map(entry => entry.path));
    if ((!options.dryRun && !await endedRootCleared(source)) || await (options.inUse ?? (async path => (await capturePrivateProcessUse())(path)))(source)) continue;
    const agents = resolve(supervisorRoot, 'beeline', 'agents');
    let hasMember = false;
    for (const agent of await readdir(agents).catch(() => [])) {
      if (!/^[a-f0-9]{64}$/.test(agent) || agent === owner.agentId) continue;
      // Unreadable local membership fails closed for shared Workspace assets.
      const runtime = await readFile(resolve(agents, agent, 'runtime.json'), 'utf8')
        .then(text => JSON.parse(text) as AgentRuntimeRecord, () => undefined);
      if (!runtime && await endedRootCleared(resolve(agents, agent))) continue;
      if (!runtime || runtime.communityId === owner.workspaceId) { hasMember = true; break; }
    }
    if (!hasMember) {
      const cache = resolve(workspaceAssetRoot(supervisorRoot, owner.workspaceId), '..');
      removed.push(...(await reclaimWholeStorageObject(cache, true, { ...options, emulatorLeaseRoot: resolve(cache, 'shared-home/cache/android-leases') })).map(entry => entry.path));
      for (const checkout of await readStorageOwners(supervisorRoot)) {
        if (checkout.workspaceId === owner.workspaceId)
          removed.push(...await reclaimOwnedCheckout(supervisorRoot, checkout, options));
      }
    }
    const remainingCheckouts = (await readStorageOwners(supervisorRoot)).filter(checkout => checkout.workspaceId === owner.workspaceId);
    if (!options.dryRun && (hasMember || (await endedRootCleared(resolve(workspaceAssetRoot(supervisorRoot, owner.workspaceId), '..')) &&
      !(await Promise.all(remainingCheckouts.map(checkout => lstat(resolve(supervisorRoot, 'beeline', checkout.kind, checkout.itemId)).catch(() => undefined)))).some(Boolean))))
      await rm(resolve(root, name), { force: true });
  }
  return removed;
}


/** Recover the old deterministic checkout layout without treating a missing
 * server row as deletion authority. The hash binds Room, remote and branch. */
export async function discoverLegacyStorageOwners(supervisorRoot: string, workspaceId: string, states: readonly StorageRoomState[]): Promise<StorageOwner[]> {
  const owners: StorageOwner[] = [];
  const root = resolve(supervisorRoot, 'beeline');
  for (const state of states) {
    if (state.workspaceId && state.workspaceId !== workspaceId) continue;
    if (/^[a-zA-Z0-9-]{1,80}$/.test(state.roomId) && await lstat(resolve(root, 'corners', state.roomId)).catch(() => undefined))
      owners.push({ workspaceId, roomId: state.roomId, kind: 'corners', itemId: state.roomId });
  }
  const recorded = new Set((await readStorageOwners(supervisorRoot)).filter(owner => owner.kind === 'room-checkouts').map(owner => owner.itemId));
  for (const itemId of await readdir(resolve(root, 'room-checkouts')).catch(() => [])) {
    if (!/^[a-f0-9]{24}$/.test(itemId) || recorded.has(itemId)) continue;
    const path = resolve(root, 'room-checkouts', itemId);
    try {
      const remote = (await execFileAsync('git', ['-C', path, 'remote', 'get-url', 'origin'])).stdout.trim();
      const branches = (await execFileAsync('git', ['-C', path, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/'])).stdout.trim().split('\n');
      for (const state of states) {
        if (state.workspaceId && state.workspaceId !== workspaceId) continue;
        const match = branches.some(ref => createHash('sha256').update(`${state.roomId}\0${remote}\0${ref.replace('refs/remotes/origin/', '')}`).digest('hex').slice(0, 24) === itemId);
        if (match) { owners.push({ workspaceId, roomId: state.roomId, kind: 'room-checkouts', itemId }); break; }
      }
    } catch { /* Unknown checkout evidence preserves the folder. */ }
  }
  return owners;
}


const storageFactListeners = new Map<string, (states: readonly StorageRoomState[]) => void>();
export function watchStorageFacts(supervisorRoot: string, listener: (states: readonly StorageRoomState[]) => void): () => void {
  const root = resolve(supervisorRoot);
  storageFactListeners.set(root, listener);
  return () => { if (storageFactListeners.get(root) === listener) storageFactListeners.delete(root); };
}
export function publishStorageFacts(supervisorRoot: string, states: readonly StorageRoomState[]): void {
  storageFactListeners.get(resolve(supervisorRoot))?.(states);
}

/** Terminal archive facts apply to every local member, including stopped agents.
 * A host Room lease fences all schedulers; OS evidence still protects children. */
export async function reclaimArchivedMemberStorage(supervisorRoot: string, states: readonly StorageRoomState[], options: WholeStorageOptions = {}): Promise<void> {
  const { SessionScheduler } = await import('./session-scheduler.js');
  const archived = states.filter(state => state.archived === true);
  if (!archived.length) return;
  for (const agentId of await readdir(resolve(supervisorRoot, 'beeline/agents')).catch(() => [])) {
    if (!/^[a-f0-9]{64}$/.test(agentId)) continue;
    const runtime = await readFile(resolve(runtimeDirectory(supervisorRoot, agentId), 'runtime.json'), 'utf8').then(text => JSON.parse(text) as AgentRuntimeRecord, () => undefined);
    const owners = await readStorageOwners(supervisorRoot);
    await reclaimHelperStorage({ runtimeDir: runtimeDirectory(supervisorRoot, agentId), readStates: async () => archived,
      ...options, ...(runtime ? { emulatorLeaseRoot: resolve(workspaceAssetRoot(supervisorRoot, runtime.communityId), 'cache/android-leases') } : {}), relatedRoots: roomId => [resolve(supervisorRoot, 'beeline/corners', roomId),
        ...owners.filter(owner => owner.roomId === roomId).map(owner => resolve(supervisorRoot, 'beeline', owner.kind, owner.itemId))],
      withIdleRoom: (roomId, task) => SessionScheduler.withIdleHostRoom(roomId, task),
    });
  }
}

/** Stopped agents have no live Room client. Idle maintenance may authenticate
 * existing credentials for lifecycle only; it never exchanges tokens or claims
 * commands. Transport/auth uncertainty cannot retire an owner. */
export async function pruneStoppedAgentStorage(supervisorRoot: string, options: WholeStorageOptions = {}): Promise<void> {
  const { isAgentStopped } = await import('./runtime.js');
  const { SessionScheduler } = await import('./session-scheduler.js');
  for (const agentId of await readdir(resolve(supervisorRoot, 'beeline/agents')).catch(() => [])) {
    if (!/^[a-f0-9]{64}$/.test(agentId)) continue;
    const runtimeDir = runtimeDirectory(supervisorRoot, agentId);
    const configPath = resolve(runtimeDir, 'runtime.json');
    if (!await isAgentStopped(configPath)) continue;
    try {
      const runtime = JSON.parse(await readFile(configPath, 'utf8')) as AgentRuntimeRecord;
      if (!runtime.transport?.daemonToken) continue;
      const read = async () => {
        const response = await fetch(new URL('/v1/daemon/operations/getDaemonBootstrap', runtime.transport!.baseUrl), {
          method: 'POST', headers: { authorization: `Bearer ${runtime.transport!.daemonToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ agentId }), signal: AbortSignal.timeout(10_000),
        });
        const result = await response.json() as { code?: string; error?: string; workspaceIds?: string[]; storageRooms?: StorageRoomState[] };
        if (response.status === 403 && [result.code, result.error].includes('agent_removed')) return { removed: true as const };
        if (!response.ok || !Array.isArray(result.workspaceIds)) throw new Error('no settled storage lifecycle answer');
        return { removed: false as const, workspaceIds: result.workspaceIds, storageRooms: result.storageRooms ?? [] };
      };
      const answer = await read();
      const ended = answer.removed || !answer.workspaceIds.includes(runtime.communityId);
      if (ended) {
        // Match active-client removal confirmation: two successful absent
        // membership reads, or the exact terminal agent_removed refusal.
        if (!answer.removed) {
          const confirmation = await read();
          if (!confirmation.removed && confirmation.workspaceIds.includes(runtime.communityId)) continue;
        }
        if (!options.dryRun) { await markAgentStorageEnded(runtime); await pruneEndedOwnerStorage(supervisorRoot, options); }
      } else {
        await reclaimHelperStorage({ runtimeDir, readStates: async () => answer.storageRooms, ...options,
          emulatorLeaseRoot: resolve(workspaceAssetRoot(supervisorRoot, runtime.communityId), 'cache/android-leases'),
          withIdleRoom: async (roomId, task) => SessionScheduler.hostStoragePaused ? (await task(), true) : SessionScheduler.withIdleHostRoom(roomId, task),
        });
      }
    } catch (error) { console.warn(`[helper] stopped agent storage retained ${agentId}:`, error instanceof SyntaxError ? 'invalid runtime/lifecycle JSON; retained' : error instanceof Error ? error.message : 'read failed'); }
  }
}

/** Open code copies keep source and unpublished work. Only whole ignored build
 * objects qualify, and a tracked descendant preserves even an ignored parent. */
export async function pruneOpenCheckoutObjects(supervisorRoot: string, states: readonly StorageRoomState[], options: WholeStorageOptions = {}, discovered: readonly StorageOwner[] = []): Promise<void> {
  const { SessionScheduler } = await import('./session-scheduler.js');
  const byId = new Map(states.map(state => [state.roomId, state]));
  const owners = [...new Map([...(await readStorageOwners(supervisorRoot)), ...discovered].map(owner => [`${owner.kind}/${owner.itemId}`, owner])).values()];
  for (const owner of owners) {
    if (byId.get(owner.roomId)?.archived !== false) continue;
    const root = resolve(supervisorRoot, 'beeline', owner.kind, owner.itemId);
    const work = async () => {
      const inUse = options.inUse ?? (async (path: string) => (await capturePrivateProcessUse())(path));
      if (await inUse(root)) return;
      const ignored = await execFileAsync('git', ['-C', root, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'],
        { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 16 * 1024 * 1024 }).then(result => result.stdout.split('\0'), () => []);
      for (const name of ignored) {
        const relative = name.replace(/\/$/, '');
        if (!/(?:^|\/)(?:node_modules|\.beeline-cargo-target|target|dist|build|\.next|\.turbo)$/.test(relative)) continue;
        const path = resolve(root, relative);
        if (!path.startsWith(`${root}/`) || await inUse(root)) continue;
        await reclaimWholeStorageObject(path, false, { ...options,
          beforeRemove: async () => !(await execFileAsync('git', ['-C', root, 'ls-files', '-z', '--', relative])).stdout,
        });
      }
    };
    if (options.dryRun || SessionScheduler.hostStoragePaused) await work();
    else await SessionScheduler.withIdleHostRoom(owner.roomId, work);
  }
}
