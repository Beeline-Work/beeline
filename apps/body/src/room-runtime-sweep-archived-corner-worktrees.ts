import { removeArchivedCornerData } from './archived-corner-cleanup.js';
import { collectDependencyStore } from './dependency-generation.js';
import { warmNodeModulesStoreDir, mobileNodeModulesStoreDir } from './warm-node-modules.js';
import { basename, dirname, resolve } from 'node:path';
import { DaemonApiError } from './daemon-api-client.js';
import { type CornerRestoreResult } from '@beeline/api-contract/daemon';
import { reclaimHelperStorage, type StorageRoomState } from './helper-storage.js';
import { pruneOpenCheckoutObjects, rememberStorageOwner, discoverLegacyStorageOwners, readStorageOwners, reclaimOwnedCheckout, type StorageOwner } from './storage-owners.js';
import { RoomRuntimeCoordinator, localCornerWorktreeIds, CornerWorktree, CornerScratch } from './room-runtime.js';



  /**
   * Startup/reconcile recovery for worktrees no current process remembers.
   * Archived server state names the exact corner; local discovery is limited
   * to that exact directory and the host's bare-repository cache.
   */
  export async function roomRuntimeCoordinatorSweepArchivedCornerWorktrees(ctx: RoomRuntimeCoordinator,
    _corners: ReadonlyMap<string, { cornerId: string; parentRoomId: string }>,
    desired: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const localIds = await localCornerWorktreeIds(ctx.runtime.supervisorRoot);
    const owners = await readStorageOwners(ctx.runtime.supervisorRoot);
    for (const itemId of [...localIds]) {
      const mapped = owners.find(owner => owner.kind === 'corners' && owner.itemId === itemId);
      const cornerId = mapped?.roomId ?? (!/^[a-f0-9]{64}$/.test(itemId) ? itemId : undefined);
      if (!cornerId) {
        console.warn(`[body] corner copy ${itemId} mapping unknown; keeping all files`);
        continue;
      }
      await ctx.yieldReconciliation();
      if (ctx.stopped) return;
      if (desired.has(cornerId) || ctx.running.has(cornerId)) continue;
      if (await ctx.cleanupWasRefused(cornerId)) continue;
      try {
        const state = await ctx.options.daemonApi.execute('getCornerRestoreState', { cornerId });
        if (state.archived !== true) {
          if (state.archived !== false)
            console.warn(`[body] corner ${cornerId} archive state unknown; keeping all files until next pass`);
          continue;
        }
        const owner: StorageOwner = { ...mapped, workspaceId: ctx.runtime.communityId, roomId: cornerId, kind: 'corners', itemId, ended: true, archived: true };
        await rememberStorageOwner(ctx.runtime.supervisorRoot, owner);
        await reclaimOwnedCheckout(ctx.runtime.supervisorRoot, owner, { progress: () => ctx.yieldReconciliation() });
        localIds.delete(itemId);

      } catch (error) {
        if (error instanceof DaemonApiError && error.status >= 400 && error.status < 500 && !error.retryable)
          await ctx.refuseArchiveCleanup(cornerId, error);
        else
          console.warn(`[body] corner ${cornerId} archive state or cleanup unavailable:`, error);
      }
    }
  }


  export async function roomRuntimeCoordinatorReapCornerWorktree(ctx: RoomRuntimeCoordinator, worktree: CornerWorktree): Promise<void> {
    // A failed lookup is not archive authority. Remote branch permissions do
    // not control removal of local data after an authoritative close.
    const state = await ctx.options.daemonApi.execute('getCornerRestoreState', { cornerId: worktree.cornerId });
    if (state?.archived !== true) return;
    const owner: StorageOwner = {
      workspaceId: ctx.runtime.communityId, roomId: worktree.cornerId,
      kind: 'corners', itemId: basename(worktree.path), archived: true, ended: true, endedAt: Date.now(),
    };
    await rememberStorageOwner(ctx.runtime.supervisorRoot, owner);
    await reclaimOwnedCheckout(ctx.runtime.supervisorRoot, owner, {
      progress: () => ctx.yieldReconciliation(),
      log: entry => console.log(`[body] archived corner ${entry.roomId} deleted ${entry.path}; freed ${entry.freedBytes} bytes`),
    });
    await ctx.collectDependencyStores();
    (await ctx.getLocalWorktreeIds()).delete(worktree.cornerId);
  }


  export async function roomRuntimeCoordinatorReapCornerScratch(ctx: RoomRuntimeCoordinator, scratch: CornerScratch): Promise<void> {
    if (resolve(scratch.path) !== resolve(ctx.roomRoot(scratch.cornerId), 'scratch'))
      throw new Error(`refusing scratch outside corner ${scratch.cornerId}`);
    await ctx.cleanupArchivedCornerLocalState(scratch.cornerId);
  }


  /** A failed/missing restore read cannot authorize private reclamation. Shared
   * checkouts are reaped separately, under their unpublished-work protections. */
  export async function roomRuntimeCoordinatorCleanupArchivedCornerLocalState(ctx: RoomRuntimeCoordinator, cornerId: string): Promise<boolean> {
    if (ctx.running.has(cornerId) || ctx.startingCorners.has(cornerId)) return false;
    if (await ctx.cleanupWasRefused(cornerId)) return false;
    let restore: CornerRestoreResult;
    try {
      restore = await ctx.options.daemonApi.execute('getCornerRestoreState', { cornerId });
    } catch (error) {
      if (error instanceof DaemonApiError && !error.retryable && error.status >= 400 && error.status < 500)
        await ctx.refuseArchiveCleanup(cornerId, error);
      return false;
    }
    if (restore.archived !== true) return false;
    const owner: StorageOwner = { workspaceId: ctx.runtime.communityId, roomId: cornerId, kind: 'corners', itemId: cornerId, ended: true, archived: true };
    await rememberStorageOwner(ctx.runtime.supervisorRoot, owner);
    await reclaimOwnedCheckout(ctx.runtime.supervisorRoot, owner, { progress: () => ctx.yieldReconciliation() });
    return (await ctx.reclaimPrivateStorage([{ roomId: cornerId, archived: true }])).length > 0;
  }


  export async function roomRuntimeCoordinatorReclaimPrivateStorage(ctx: RoomRuntimeCoordinator, states: readonly StorageRoomState[]) {
    const owners = await readStorageOwners(ctx.runtime.supervisorRoot);
    return reclaimHelperStorage({
      runtimeDir: dirname(ctx.configPath),
      removeArchived: roomId => removeArchivedCornerData(ctx.runtime.supervisorRoot, roomId,
        resolve(ctx.runtime.supervisorRoot, 'beeline/corners', roomId), {
          runtimeDir: dirname(ctx.configPath),
          log: entry => console.log(`[body] archived private storage deleted ${entry.path}; freed ${entry.freedBytes} bytes`),
          progress: () => ctx.yieldReconciliation(),
        }),
      readStates: async () => states,
      progress: () => ctx.yieldReconciliation(),
      relatedRoots: roomId => [resolve(ctx.runtime.supervisorRoot, 'beeline/corners', roomId),
        ...owners.filter(owner => owner.roomId === roomId).map(owner => resolve(ctx.runtime.supervisorRoot, 'beeline', owner.kind, owner.itemId))],
      operatorHome: ctx.baseConfig.operatorHome,
      withIdleRoom: async (roomId, task) => {
        if (ctx.stopped || ctx.startingRooms.has(roomId) || ctx.startingCorners.has(roomId) ||
            ctx.running.get(roomId)?.body.isBusy() ||
            ctx.roomRoot(roomId) !== resolve(dirname(ctx.configPath), 'rooms', roomId)) return false;
        return ctx.scheduler.withIdleStorage(roomId, async () => {
          ctx.storageMaintenanceRooms.add(roomId);
          try { await task(); }
          finally { ctx.storageMaintenanceRooms.delete(roomId); }
        });
      },
      log: entry => console.log(`[body] private storage: Room ${entry.roomId} ${entry.kind} deleted ${entry.path}; freed ${entry.freedBytes} bytes`),
    });
  }


  /** Archive cleanup runs on each authoritative reconciliation. Open private
   * folders are reconsidered every six hours; no file-age decision is made. */
  export async function roomRuntimeCoordinatorSweepRoomPrivateStorage(ctx: RoomRuntimeCoordinator, states: readonly StorageRoomState[]): Promise<void> {
    for (const owner of await discoverLegacyStorageOwners(ctx.runtime.supervisorRoot, ctx.runtime.communityId, states, () => ctx.yieldReconciliation()))
      await rememberStorageOwner(ctx.runtime.supervisorRoot, owner);
    await ctx.reclaimPrivateStorage(states);
    await pruneOpenCheckoutObjects(ctx.runtime.supervisorRoot, states, {
      progress: () => ctx.yieldReconciliation(),
      log: entry => console.log(`[body] open checkout storage deleted ${entry.path}; freed ${entry.freedBytes} bytes`),
    });
    const archived = new Set(states.filter(state => state.archived).map(state => state.roomId));
    for (const owner of await readStorageOwners(ctx.runtime.supervisorRoot)) {
      await ctx.yieldReconciliation();
      if (!archived.has(owner.roomId) || owner.agentId && owner.agentId !== ctx.agent.publicKey) continue;
      const state = states.find(state => state.roomId === owner.roomId)!;
      await rememberStorageOwner(ctx.runtime.supervisorRoot, { ...owner, archived: true, ended: true, landedHeadSha: state.landedHeadSha });
      if (ctx.running.has(owner.roomId) || ctx.startingRooms.has(owner.roomId)) continue;
      await ctx.scheduler.withIdleStorage(owner.roomId, async () => {
        await reclaimOwnedCheckout(ctx.runtime.supervisorRoot, { ...owner, archived: true, ended: true, endedAt: owner.endedAt ?? Date.now() }, {
          landedHeadSha: state.landedHeadSha,
          progress: () => ctx.yieldReconciliation(),
          log: entry => console.log(`[body] Room ${owner.roomId} checkout deleted ${entry.path}; freed ${entry.freedBytes} bytes`),
        });
      });
    }
  }


  export async function roomRuntimeCoordinatorCollectDependencyStores(ctx: RoomRuntimeCoordinator): Promise<void> {
    for (const store of new Set([warmNodeModulesStoreDir(ctx.runtime.supervisorRoot), mobileNodeModulesStoreDir(ctx.runtime.supervisorRoot), resolve(ctx.runtime.supervisorRoot, 'beeline/node-modules-mobile')])) {
      await collectDependencyStore(store);
    }
  }


  export function roomRuntimeCoordinatorNotePoll(ctx: RoomRuntimeCoordinator, roomId: string): void {
    ctx.surfaceHealth.intakeReady(roomId);
    const room = ctx.running.get(roomId);
    if (!room) return;
    if (ctx.deferredRepositoryRestarts.has(roomId) && !room.body.isBusy()) {
      ctx.deferredRepositoryRestarts.delete(roomId);
      void ctx.stopRunning(roomId, room)
        .then(() => ctx.stopped ? undefined : ctx.startRoom(roomId))
        .catch((error) => {
          console.error(`[thin-core] failed to restart Room ${roomId} after repository change:`, error);
        });
    }
    if (ctx.isWorkspaceIdle()) ctx.interactiveIdleListener?.();
  }


  export function roomRuntimeCoordinatorBeginShutdown(ctx: RoomRuntimeCoordinator): void {
    if (ctx.stopped) return;
    ctx.stopped = true;
    ctx.stopStorageAvailable();
    ctx.restartRequested = true;
    for (const cornerId of ctx.idleCornerSubscriptions.keys()) ctx.unwatchCorner(cornerId);
    ctx.options.daemonApi.closeLive?.();
    ctx.pendingMembershipEvents.clear();
    for (const room of ctx.running.values()) room.controller.abort();
  }


  export async function roomRuntimeCoordinatorShutdown(ctx: RoomRuntimeCoordinator): Promise<void> {
    // A pushed membership apply runs outside the run loop's signal, so a Room
    // whose start is in flight here would land in `running` after the abort
    // pass and never be stopped — its live subscription outlives the daemon.
    // Refuse further pushes, then wait — to the deadline, never past it — for
    // the in-flight apply, so whatever it started is in the snapshot below.
    ctx.beginShutdown();
    if (ctx.membershipDrain) await ctx.membershipDrain;
    if (ctx.maintenanceFlight) await ctx.maintenanceFlight;
    const rooms = [...ctx.running.values()];
    for (const room of rooms) room.controller.abort();
    const drained = Promise.all(rooms.map((room) => room.promise.catch(() => undefined)));
    await drained;
    await ctx.grantRunnerServer.close();
    await ctx.scheduler.dispose();
  }
