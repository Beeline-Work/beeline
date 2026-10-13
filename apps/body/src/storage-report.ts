/** Read-only storage proof: existing credentials only, no helper socket,
 * credential exchange/write-back, service manager or apply operation. */
import { lstat, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DaemonBootstrapResult, CornerListResult } from '@beeline/api-contract/daemon';
import { capturePrivateProcessUse, hasNonSquirePayload, reclaimWholeStorageObject, reclaimHelperStorage, type StorageReclaimEntry, type StorageRoomState } from './helper-storage.js';
import { pruneDeletedRuntimes, pruneRepositoryCaches, pruneMachineStorage } from './host-disk-retention.js';
import { pruneEndedOwnerStorage, pruneOpenCheckoutObjects, discoverLegacyStorageOwners, readStorageOwners, reclaimOwnedCheckout } from './storage-owners.js';
import { workspaceAssetRoot } from './workspace-assets.js';
import { defaultSupervisorRoot, type AgentRuntimeRecord } from './runtime.js';

export async function helperStorageReport(supervisorRoot = defaultSupervisorRoot(), input: { orphanOnly?: boolean } = {}) {
  const processUse = input.orphanOnly ? () => true : await capturePrivateProcessUse();
  const entries: Array<StorageReclaimEntry & { rule: string }> = [];
  const orphans: Array<{ path: string; owner: string; reason: string }> = [];
  const unknown: Array<{ path: string; reason: string }> = [];
  const states = new Map<string, StorageRoomState>();
  const legacyOwners: Awaited<ReturnType<typeof readStorageOwners>> = [];
  const root = resolve(supervisorRoot, 'beeline');
  const options = (rule: string) => ({ dryRun: true, onError: (path: string, _error: unknown) => { unknown.push({ path, reason: 'filesystem inventory unavailable; retained' }); }, inUse: async (path: string) => processUse(path),
    log: (entry: StorageReclaimEntry) => entries.push({ ...entry, rule }) });
  for (const agent of await readdir(resolve(root, 'agents'), { withFileTypes: true }).catch(() => [])) {
    if (!agent.isDirectory() || !/^[0-9a-f]{64}$/i.test(agent.name)) continue;
    const runtimeDir = resolve(root, 'agents', agent.name);
    try {
      const runtime = JSON.parse(await readFile(resolve(runtimeDir, 'runtime.json'), 'utf8')) as AgentRuntimeRecord;
      if (!runtime.transport?.daemonToken) throw new Error('no existing daemon token; no exchange attempted');
      const operation = async <T>(name: string, operationInput: unknown): Promise<T> => {
        const response = await fetch(new URL(`/v1/daemon/operations/${name}`, runtime.transport!.baseUrl), {
          method: 'POST', headers: { authorization: `Bearer ${runtime.transport!.daemonToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(operationInput), signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({})) as { error?: string; code?: string };
          if (response.status === 403 && [payload.code, payload.error].includes('agent_removed')) {
            orphans.push({ path: runtimeDir, owner: agent.name, reason: 'server-confirmed removed agent' });
            if (!input.orphanOnly) await reclaimWholeStorageObject(runtimeDir, true, options('deleted-agent-runtime'));
          }
          throw new Error(`${name} refused (${response.status})`);
        }
        return await response.json() as T;
      };
      const bootstrap = await operation<DaemonBootstrapResult>('getDaemonBootstrap', { agentId: runtime.agent.publicKey });
      let agentStates: readonly StorageRoomState[] = bootstrap.storageRooms ?? [];
      if (!bootstrap.storageRooms) {
        const byId = new Map<string, StorageRoomState>(bootstrap.rooms.map(room => [room.roomId, room]));
        for (const room of bootstrap.rooms) {
          try {
            const listed = await operation<CornerListResult>('listRoomCorners', { roomId: room.roomId });
            for (const corner of listed.corners) if (typeof corner.archived === 'boolean')
              byId.set(corner.cornerId, { roomId: corner.cornerId, archived: corner.archived });
          } catch { /* No archive inference from a failed read. */ }
        }
        agentStates = [...byId.values()];
      }
      legacyOwners.push(...await discoverLegacyStorageOwners(supervisorRoot, runtime.communityId, agentStates));
      const byId = new Map(agentStates.map(state => [state.roomId, state]));
      for (const state of agentStates) states.set(state.roomId, state);
      for (const room of await readdir(resolve(runtimeDir, 'rooms'), { withFileTypes: true }).catch(() => [])) {
        if (!room.isDirectory()) continue;
        const state = byId.get(room.name);
        const path = resolve(runtimeDir, 'rooms', room.name);
        if (state?.archived && await hasNonSquirePayload(path)) orphans.push({ path, owner: room.name, reason: 'server-confirmed archived Room/corner' });
        else if (!state) unknown.push({ path, reason: 'no settled lifecycle answer' });
      }
      if (!bootstrap.workspaceIds.includes(runtime.communityId)) {
        orphans.push({ path: runtimeDir, owner: runtime.communityId, reason: 'server-confirmed Workspace removed from agent' });
      }
      if (!input.orphanOnly) await reclaimHelperStorage({ runtimeDir, readStates: async () => agentStates,
        relatedRoots: roomId => [resolve(root, 'corners', roomId), ...legacyOwners.filter(owner => owner.roomId === roomId).map(owner => resolve(root, owner.kind, owner.itemId))],
        ...options('room-private'), withIdleRoom: async (_id, task) => { await task(); return true; },
        emulatorLeaseRoot: resolve(workspaceAssetRoot(supervisorRoot, runtime.communityId), 'cache/android-leases'),
        log: entry => entries.push({ ...entry, rule: entry.kind === 'archived' ? 'archived-room-private' : 'unused-open-room-object' }),
        onError: (roomId, error) => unknown.push({ path: resolve(runtimeDir, 'rooms', roomId), reason: error instanceof Error ? error.message : 'inventory unavailable' }),
      });
    } catch (error) {
      if (!await hasNonSquirePayload(runtimeDir)) continue;
      unknown.push({ path: runtimeDir, reason: error instanceof SyntaxError ? 'invalid runtime/lifecycle JSON; retained' : error instanceof Error ? error.message : 'read failed' });
    } finally {
      console.error(`[storage dry-run] inspected agent ${agent.name}; ${entries.length} eligible objects, ${orphans.length} confirmed orphan folders`);
    }
  }
  const checkoutOwners = [...new Map([...(await readStorageOwners(supervisorRoot)), ...legacyOwners].map(owner => [`${owner.kind}/${owner.itemId}`, owner])).values()];
  for (const owner of checkoutOwners) {
    if (states.get(owner.roomId)?.archived) {
      const path = resolve(root, owner.kind, owner.itemId);
      if (!await lstat(path).catch(() => undefined)) continue;
      orphans.push({ path, owner: owner.roomId, reason: 'server-confirmed archived checkout owner' });
      if (!input.orphanOnly) await reclaimOwnedCheckout(supervisorRoot, owner, options('archived-checkout'));
    }
  }
  if (!input.orphanOnly) await pruneOpenCheckoutObjects(supervisorRoot, [...states.values()], options('unused-open-checkout-object'), legacyOwners);
  for (const kind of ['corners', 'room-checkouts'] as const) {
    for (const id of await readdir(resolve(root, kind)).catch(() => [])) {
      if (!checkoutOwners.some(owner => owner.kind === kind && owner.itemId === id))
        unknown.push({ path: resolve(root, kind, id), reason: 'legacy checkout has no persisted owner record' });
    }
  }
  for (const entry of await readdir(resolve(root, 'deleted-runtimes')).catch(() => [])) {
    if (/^[a-f0-9]{64}-\d{13}$/.test(entry) && await hasNonSquirePayload(resolve(root, 'deleted-runtimes', entry))) orphans.push({ path: resolve(root, 'deleted-runtimes', entry), owner: 'retired agent', reason: 'recorded ended-agent tombstone' });
  }
  if (!input.orphanOnly) await pruneDeletedRuntimes(supervisorRoot, Date.now(), options('deleted-agent-runtime'));
  if (!input.orphanOnly) await pruneEndedOwnerStorage(supervisorRoot, { ...options('ended-owner'),
    log: entry => entries.push({ ...entry, rule: entry.path.includes('/workspaces/') ? 'ended-workspace' : entry.path.includes('/agents/') ? 'deleted-agent-runtime' : 'ended-checkout' }),
  });
  if (!input.orphanOnly) await pruneRepositoryCaches(supervisorRoot, Date.now(), options('unused-bare-clone'));
  if (!input.orphanOnly) await pruneMachineStorage(supervisorRoot, { ...options('unused-machine-object'),
    log: entry => entries.push({ ...entry, rule: entry.path.includes('/workspaces/') ? 'unused-workspace-object' : 'unused-machine-object' }),
  });
  const rules: Record<string, { objects: number; GB: number }> = {};
  for (const entry of entries) {
    const total = rules[entry.rule] ??= { objects: 0, GB: 0 };
    total.objects++;
    total.GB += entry.freedBytes / 1e9;
  }
  return { mode: 'dry-run', capturedAt: new Date().toISOString(), rules,
    reclaimableGB: entries.reduce((sum, entry) => sum + entry.freedBytes, 0) / 1e9,
    orphans, unknown, entries };
}

export async function runStorageReportCommand(args: string[]): Promise<void> {
  if (args.some(arg => !['--dry-run', '--orphans'].includes(arg)))
    throw new Error('Usage: beeline storage [--dry-run|--orphans] (read-only)');
  const report = await helperStorageReport(defaultSupervisorRoot(), { orphanOnly: args.includes('--orphans') });
  console.log(JSON.stringify(args.includes('--orphans') ? { mode: report.mode, orphans: report.orphans, unknown: report.unknown } : report, null, 2));
}
