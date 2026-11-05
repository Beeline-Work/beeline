import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { BodyConfig } from './config.js';
import { type RoomMembershipChange } from './daemon-api-client.js';
import { type RoomRepositoryStateResult } from '@beeline/api-contract/daemon';
import { type GrantRunnerEndpoint } from './grant-runner.js';
import { stopKeptCornerEmulator } from './corner-emulator.js';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import type { InterruptedTurn } from './force-update-journal.js';
import { openRouterRoutingCacheDir } from './openrouter-routing.js';
import { turnTraceDirectory } from './turn-trace.js';
import { type StorageRoomState } from './helper-storage.js';
import { publishStorageFacts, rememberStorageOwner } from './storage-owners.js';
import { type SurfaceHealthState } from './surface-health.js';
import type { RoomRuntimeRecord } from './runtime.js';
import { workspaceAssetRoot } from './workspace-assets.js';
import { CRASH_SAFE_CLONE_ARGS, fetchRepositoryCache } from './repository-cache-repair.js';
import { AgentProcesses, type AgentProcessSnapshot } from './agent-process.js';
import { RoomRuntimeCoordinator, WorkspaceMembershipStatus, REMOVAL_CONFIRMATION_READS, mapWithConcurrency, ROOM_JOIN_CONCURRENCY, DesiredCorner, RunningRoom, roomCheckoutRemote, githubGitEnv, execFileAsync, isRemoteRefMissing } from './room-runtime.js';



  export function roomRuntimeCoordinatorReconciliationDiagnostics(ctx: RoomRuntimeCoordinator) {
    return { stage: ctx.reconciliationStage, elapsedMs: Date.now() - ctx.reconciliationStageAt };
  }


  export function roomRuntimeCoordinatorNoteReconciliationStage(ctx: RoomRuntimeCoordinator, stage: string): void {
    ctx.reconciliationStage = stage;
    ctx.reconciliationStageAt = Date.now();
  }


  export function roomRuntimeCoordinatorActiveRoomIds(ctx: RoomRuntimeCoordinator): string[] {
    return [...ctx.running.keys()].sort();
  }


  export function roomRuntimeCoordinatorSetDiscoveryWakeListener(ctx: RoomRuntimeCoordinator, listener: () => void): void {
    ctx.discoveryWakeListener = listener;
  }


  export function roomRuntimeCoordinatorSetReconciliationProgressListener(ctx: RoomRuntimeCoordinator, listener: () => void | Promise<void>): void {
    ctx.reconciliationProgressListener = listener;
  }


  export async function roomRuntimeCoordinatorYieldReconciliation(_ctx: RoomRuntimeCoordinator): Promise<void> {
    await Promise.resolve();
  }


  export function roomRuntimeCoordinatorSetInteractiveIdleListener(ctx: RoomRuntimeCoordinator, listener: () => void): void {
    ctx.interactiveIdleListener = listener;
  }


  export function roomRuntimeCoordinatorWakeDiscovery(ctx: RoomRuntimeCoordinator): void {
    ctx.discoveryWakeListener?.();
  }


  export function roomRuntimeCoordinatorActiveRoomCount(ctx: RoomRuntimeCoordinator): number {
    return new Set(
      [...ctx.running.keys()].map((id) => ctx.monolithCornerParents.get(id) ?? id),
    ).size;
  }


  export function roomRuntimeCoordinatorSurfaceHealthSnapshot(ctx: RoomRuntimeCoordinator): SurfaceHealthState[] {
    return ctx.surfaceHealth.snapshot();
  }


  export function roomRuntimeCoordinatorSurfaceHealthSummary(ctx: RoomRuntimeCoordinator): string {
    return ctx.surfaceHealth.summary();
  }


  export function roomRuntimeCoordinatorHasDegradedSurfaces(ctx: RoomRuntimeCoordinator): boolean {
    return ctx.surfaceHealth.hasDegraded();
  }


  /** Current running processes and ordered work, also recorded in turn traces. */
  export function roomRuntimeCoordinatorSchedulerSnapshot(ctx: RoomRuntimeCoordinator): AgentProcessSnapshot {
    return ctx.scheduler.snapshot();
  }


  export function roomRuntimeCoordinatorIsWorkspaceIdle(ctx: RoomRuntimeCoordinator): boolean {
    return ctx.activeTurnCount() === 0 && ctx.startingRooms.size === 0 && ctx.startingCorners.size === 0;
  }


  /** Turns executing right now. Serving a Room or corner with no turn in flight is idle. */
  export function roomRuntimeCoordinatorActiveTurnCount(ctx: RoomRuntimeCoordinator): number {
    let count = 0;
    for (const room of ctx.running.values()) if (room.body.isBusy()) count += 1;
    return count;
  }


  /** A restart command retires harnesses; subscriptions stay available for new work. */
  export async function roomRuntimeCoordinatorStopAgentProcesses(ctx: RoomRuntimeCoordinator): Promise<void> {
    await ctx.scheduler.stopAll();
  }


  export function roomRuntimeCoordinatorQuiesceForUpdateIfIdle(ctx: RoomRuntimeCoordinator): boolean {
    if (!ctx.isWorkspaceIdle()) return false;
    // A host restart may be staggered after this idle proof. Keep new
    // commands from starting while the old runtime waits for its update.
    ctx.restartRequested = true;
    for (const room of ctx.running.values()) room.controller.abort();
    return true;
  }


  /** Stop claiming new turns while existing turns drain for a managed update. */
  export function roomRuntimeCoordinatorQuiesceForUpdate(ctx: RoomRuntimeCoordinator): void {
    ctx.restartRequested = true;
  }


  /**
   * Undo `quiesceForUpdateIfIdle` after a managed restart failed: clear the
   * latch and let reconciliation start the Room loops the quiesce stopped.
   */
  export function roomRuntimeCoordinatorResumeServing(ctx: RoomRuntimeCoordinator): void {
    if (ctx.stopped) return;
    ctx.restartRequested = false;
    ctx.wakeDiscovery();
  }


  export async function roomRuntimeCoordinatorPrepareForForcedUpdateRestart(ctx: RoomRuntimeCoordinator): Promise<void> {
    const rooms = [...ctx.running.values()];
    await Promise.allSettled(rooms.filter((room) => room.body.isBusy())
      .map((room) => room.body.prepareForForcedUpdateRestart()));
    for (const room of rooms) room.controller.abort();
  }


  export function roomRuntimeCoordinatorInterruptedTurns(ctx: RoomRuntimeCoordinator): InterruptedTurn[] {
    return [...ctx.running.values()].map((room) => room.body.interruptedTurn()).filter((turn): turn is InterruptedTurn => turn !== undefined);
  }


  export function roomRuntimeCoordinatorInterruptForServerMinimum(ctx: RoomRuntimeCoordinator): InterruptedTurn[] {
    ctx.restartRequested = true;
    const rooms = [...ctx.running.values()];
    const turns = rooms.map((room) => room.body.interruptForServerMinimum())
      .filter((turn): turn is InterruptedTurn => turn !== undefined);
    for (const room of rooms) room.controller.abort();
    return turns;
  }


  export async function roomRuntimeCoordinatorReconcile(ctx: RoomRuntimeCoordinator, onServing?: () => void | Promise<void>): Promise<WorkspaceMembershipStatus> {
    try {
      return await ctx.reconcileRooms(onServing);
    } finally {
      ctx.noteReconciliationStage('idle');
    }
  }


  export async function roomRuntimeCoordinatorReconcileRooms(ctx: RoomRuntimeCoordinator, onServing?: () => void | Promise<void>): Promise<WorkspaceMembershipStatus> {
    if (ctx.stopped) return 'member';
    const existingRooms = new Set(ctx.running.keys());
    ctx.noteReconciliationStage('bootstrap');
    const bootstrap = await ctx.options.daemonApi.execute('getDaemonBootstrap', {
      agentId: ctx.agent.publicKey,
    });
    publishStorageFacts(ctx.runtime.supervisorRoot, bootstrap.storageRooms ?? []);
    if (ctx.stopped) return 'member';
    if (!bootstrap.workspaceIds.includes(ctx.runtime.communityId)) {
      ctx.workspaceRemovalConfirmations += 1;
      if (ctx.workspaceRemovalConfirmations < REMOVAL_CONFIRMATION_READS) {
        ctx.wakeDiscovery();
        return 'unknown';
      }
      return 'not-member';
    }
    ctx.workspaceRemovalConfirmations = 0;
    // Repository repair is scoped to the first fetch of each active cache;
    // archived object stores never delay command intake on helper restart.
    await ctx.yieldReconciliation();
    if (!ctx.stopped) await ctx.reconciliationProgressListener?.();
    const topLevelRooms = bootstrap.rooms.filter((room) => !room.archived);
    // Bind waiting surfaces before any fan-out, cleanup or corner listing.
    // Their intake runs independently while the rest of this sweep continues.
    const pendingRooms = [...(bootstrap.pendingRooms ?? [])].sort((left, right) =>
      Number(Boolean(left.parentRoomId)) - Number(Boolean(right.parentRoomId)));
    ctx.noteReconciliationStage('pending-room-intake');
    await mapWithConcurrency(pendingRooms, ROOM_JOIN_CONCURRENCY, async (room) => {
      if (ctx.stopped) return;
      // A bootstrap can cover several Workspaces; this core serves only its own.
      if (!topLevelRooms.some(top => top.roomId === (room.parentRoomId ?? room.roomId))) return;
      try {
        if (room.parentRoomId) {
          ctx.monolithCornerParents.set(room.roomId, room.parentRoomId);
          ctx.pendingCornerCommands.add(room.roomId);
          await ctx.watchCorner({ cornerId: room.roomId, parentRoomId: room.parentRoomId, openedBy: room.openedBy });
        } else {
          ctx.surfaceHealth.discover(room.roomId, 'room');
          await ctx.startRoom(room.roomId);
        }
      } catch (error) {
        console.error(`[thin-core] pending Room ${room.roomId} start failed:`, error);
      }
    });
    ctx.noteReconciliationStage('repository-revisions');
    for (const room of topLevelRooms) {
      const revision = room.repositoryRevision;
      if (revision === undefined) continue;
      const previous = ctx.repositoryRevisions.get(room.roomId);
      ctx.repositoryRevisions.set(room.roomId, revision);
      if (previous === undefined || previous === revision) continue;
      ctx.invalidateParentRepository(room.roomId);
      const running = ctx.running.get(room.roomId);
      if (running?.body.isBusy()) {
        ctx.deferredRepositoryRestarts.add(room.roomId);
      } else if (running) {
        await ctx.stopRunning(room.roomId, running);
      }
      // A restored App grant can also clear a corner's previous standing
      // checkout fault; those corners retry in this same reconciliation pass.
      for (const [cornerId, parentId] of ctx.monolithCornerParents)
        if (parentId === room.roomId) ctx.standingCornerStartFaults.delete(cornerId);
    }
    const desiredTopRooms = topLevelRooms.map((room) => room.roomId);
    const desired = new Set(desiredTopRooms);
    ctx.noteReconciliationStage('room-intake');
    await mapWithConcurrency(desiredTopRooms, ROOM_JOIN_CONCURRENCY, async (roomId) => {
      if (ctx.stopped) return;
      if (ctx.running.has(roomId)) return;
      try {
        await ctx.startRoom(roomId);
      } catch (error) {
        // One Room's failed start must not block the corner-start pass behind
        // it: a corner opened while a Room cannot materialize its checkout
        // would otherwise never start, while every already-running Room keeps
        // the agent looking healthy. The failed Room retries on the next
        // reconciliation.
        console.error(`[thin-core] failed to start Room ${roomId}:`, error);
      }
    });
    const desiredCorners = new Map<string, DesiredCorner>();
    const archivedCorners = new Map<string, { cornerId: string; parentRoomId: string }>();
    ctx.noteReconciliationStage('corner-listing');
    await mapWithConcurrency(topLevelRooms, ROOM_JOIN_CONCURRENCY, async (room) => {
      if (ctx.stopped) return;
      try {
        const result = await ctx.options.daemonApi.execute('listRoomCorners', {
          roomId: room.roomId,
          activeOnly: true,
        });
        for (const corner of result.corners) {
          // A DM lists corners from the agent's other Rooms too. The corner's
          // own parent decides its repository, never the Room that listed it.
          ctx.monolithCornerParents.set(corner.cornerId, corner.parentRoomId);
          if (corner.archived) {
            archivedCorners.set(corner.cornerId, {
              cornerId: corner.cornerId,
              parentRoomId: corner.parentRoomId,
            });
          } else {
            desired.add(corner.cornerId);
            desiredCorners.set(corner.cornerId, {
              cornerId: corner.cornerId,
              parentRoomId: corner.parentRoomId,
              ...(corner.createdBy ? { openedBy: corner.createdBy } : {}),
            });
          }
        }
      } catch (error) {
        // A failed corner read is uncertainty, never evidence that every
        // running corner vanished. Keep the last successful parent mapping
        // and retry on the next reconciliation.
        for (const [cornerId, parentRoomId] of ctx.monolithCornerParents) {
          if (parentRoomId === room.roomId && ctx.running.has(cornerId)) {
            desired.add(cornerId);
            desiredCorners.set(cornerId, { cornerId, parentRoomId });
          }
        }
        console.error(
          `[thin-core] monolith Room ${room.roomId} corner listing failed; keeping known corners:`,
          error,
        );
      }
    });
    if (ctx.stopped) return 'member';
    for (const roomId of desiredTopRooms) ctx.surfaceHealth.discover(roomId, 'room');
    for (const cornerId of desiredCorners.keys()) ctx.surfaceHealth.discover(cornerId, 'corner');
    for (const channelId of desired) ctx.roomRemovalConfirmations.delete(channelId);
    ctx.noteReconciliationStage('corner-intake');
    await mapWithConcurrency(
      [...desiredCorners.values()],
      ROOM_JOIN_CONCURRENCY,
      async (corner) => {
        if (ctx.stopped) return;
        if (!ctx.running.has(corner.cornerId)) await ctx.watchCorner(corner);
      },
    );
    // Readiness belongs to durable command intake, never local retention work.
    await onServing?.();
    if (ctx.stopped) return 'member';

    for (const cornerId of ctx.idleCornerSubscriptions.keys()) {
      if (desired.has(cornerId)) continue;
      ctx.unwatchCorner(cornerId);
    }
    ctx.noteReconciliationStage('departed-room-shutdown');
    for (const [channelId, running] of [...ctx.running]) {
      if (desired.has(channelId)) continue;
      const confirmations = (ctx.roomRemovalConfirmations.get(channelId) ?? 0) + 1;
      ctx.roomRemovalConfirmations.set(channelId, confirmations);
      if (confirmations < REMOVAL_CONFIRMATION_READS) continue;
      await ctx.stopRunning(channelId, running);
      ctx.roomRemovalConfirmations.delete(channelId);
    }
    // Archived corners are discovered for local cleanup through their exact
    // checkout IDs. Their parent mapping serves only a running intake.
    for (const cornerId of ctx.monolithCornerParents.keys()) {
      if (!desired.has(cornerId) && !ctx.running.has(cornerId) &&
          !ctx.startingCorners.has(cornerId)) ctx.monolithCornerParents.delete(cornerId);
    }
    ctx.surfaceHealth.retain(new Set([...desired, ...ctx.running.keys()]));
    for (const [roomId, running] of ctx.running)
      if (existingRooms.has(roomId)) running.body.requestReconciliation();
    if (ctx.roomRemovalConfirmations.size) ctx.wakeDiscovery();
    ctx.scheduleStorageMaintenance(archivedCorners, desired, bootstrap.storageRooms ?? []);
    return 'member';
  }


  /** Retention cannot hold discovery or its watchdog acknowledgement hostage.
   * One sweep runs at a time; discovery coalesces its latest facts for the next
   * pass and updates the active set immediately, including during a slow reap.
   * Maintenance yields do not acknowledge a blocked foreground discovery. */
  export function roomRuntimeCoordinatorScheduleStorageMaintenance(ctx: RoomRuntimeCoordinator, 
    archived: ReadonlyMap<string, { cornerId: string; parentRoomId: string }>,
    desired: ReadonlySet<string>,
    states: readonly StorageRoomState[],
  ): void {
    ctx.desiredChannels.clear();
    for (const channel of desired) ctx.desiredChannels.add(channel);
    ctx.maintenanceRequest = { archived, states };
    if (ctx.maintenanceFlight) return;
    ctx.maintenanceFlight = (async () => {
      await ctx.yieldReconciliation();
      while (!ctx.stopped && ctx.maintenanceRequest) {
        const request = ctx.maintenanceRequest;
        ctx.maintenanceRequest = undefined;
        const attemptedReaps = new Set([...ctx.desiredChannels, ...ctx.pendingCornerReaps.keys()]);
        await ctx.retryPendingCornerReaps(ctx.desiredChannels);
        if (ctx.stopped) return;
        await ctx.sweepArchivedCornerWorktrees(request.archived, new Set([...attemptedReaps, ...ctx.desiredChannels]));
        if (ctx.stopped) return;
        await ctx.reapClosedCornerEmulators(ctx.desiredChannels);
        if (ctx.stopped) return;
        await ctx.sweepRoomPrivateStorage(request.states);
      }
    })().catch(error => console.error('[thin-core] storage maintenance deferred:', error))
      .finally(() => {
        ctx.maintenanceFlight = undefined;
        // A discovery can queue fresh facts between the final loop check and
        // this promise settling. Do not lose that last coalesced request.
        if (!ctx.stopped && ctx.maintenanceRequest) {
          const { archived, states } = ctx.maintenanceRequest;
          ctx.scheduleStorageMaintenance(archived, new Set(ctx.desiredChannels), states);
        }
      });
  }


  /**
   * Pushed membership changes are applied at the same bound the reconcile pass
   * uses. One `rooms-changed` per row means a single human action (adding an
   * agent to a Room inherits a membership per corner under it) arrives as a
   * burst; unbounded, that burst is exactly the concurrent restore reads and
   * worktree checkouts this change exists to stop.
   */
  export function roomRuntimeCoordinatorQueueMembershipEvent(ctx: RoomRuntimeCoordinator, event: RoomMembershipChange & { roomId: string }): void {
    if (ctx.stopped) return;
    ctx.pendingMembershipEvents.set(event.roomId, event);
    ctx.membershipDrain ??= ctx.drainMembershipEvents().finally(() => {
      ctx.membershipDrain = undefined;
    });
  }


  export async function roomRuntimeCoordinatorDrainMembershipEvents(ctx: RoomRuntimeCoordinator): Promise<void> {
    while (ctx.pendingMembershipEvents.size) {
      const batch = [...ctx.pendingMembershipEvents.values()];
      ctx.pendingMembershipEvents.clear();
      await mapWithConcurrency(batch, ROOM_JOIN_CONCURRENCY, (event) =>
        ctx.applyMembershipEvent(event).catch((error) => {
          console.error('[thin-core] live membership apply failed', error);
          // A failed read resumes at the next registration or membership push.
        }),
      );
    }
  }


  /**
   * Incremental apply of one scoped membership push.
   * An unscoped wake still uses the slow reconcile as recovery.
   */
  export async function roomRuntimeCoordinatorApplyMembershipEvent(ctx: RoomRuntimeCoordinator, event: RoomMembershipChange): Promise<void> {
    if (ctx.stopped) return;
    const roomId = event.roomId;
    if (!roomId) {
      ctx.wakeDiscovery();
      return;
    }
    if (event.removed === true) {
      ctx.unwatchCorner(roomId);
      const running = ctx.running.get(roomId);
      if (running) await ctx.stopRunning(roomId, running);
      ctx.monolithCornerParents.delete(roomId);
      ctx.surfaceHealth.remove(roomId);
      return;
    }
    // Inheriting a Room membership writes one row per corner under it, archived
    // ones included, and the reviewer projection rewrites every row again. An
    // archived Room or corner is nothing to start, so the event is dropped here
    // rather than after a restore read per row.
    if (event.archived === true) {
      ctx.unwatchCorner(roomId);
      ctx.surfaceHealth.remove(roomId);
      if (!ctx.running.has(roomId)) ctx.monolithCornerParents.delete(roomId);
      await stopKeptCornerEmulator(
        ctx.runtime.supervisorRoot, roomId, `corner archived event; stopped by agent ${ctx.agent.publicKey}`,
      ).catch((error) => {
        console.error(`[thin-core] corner ${roomId} emulator stop failed:`, error);
      });
      return;
    }
    ctx.roomRemovalConfirmations.delete(roomId);
    if (ctx.running.has(roomId) || ctx.startingCorners.has(roomId)) return;
    if (event.parentRoomId) {
      ctx.surfaceHealth.discover(roomId, 'corner');
      ctx.monolithCornerParents.set(roomId, event.parentRoomId);
      // The opener rides the same row that announces the corner. Without it
      // nobody is the opener, so the initial `working` state — the only write
      // of `corner_facts.feature_branch`, which every corner GitHub webhook is
      // resolved by — would never happen. Fall back to the reconcile read that
      // carries the corner's recorded opener rather than starting it blind.
      if (!event.openedBy) {
        ctx.wakeDiscovery();
        return;
      }
      await ctx.watchCorner({
        cornerId: roomId,
        parentRoomId: event.parentRoomId,
        openedBy: event.openedBy,
      });
      return;
    }
    ctx.surfaceHealth.discover(roomId, 'room');
    await ctx.startRoom(roomId);
  }


  export async function roomRuntimeCoordinatorApplyCornerComplete(ctx: RoomRuntimeCoordinator, cornerId: string): Promise<void> {
    ctx.running.get(cornerId)?.body.requestClose?.();
  }


  export async function roomRuntimeCoordinatorStopRunning(ctx: RoomRuntimeCoordinator, channelId: string, running: RunningRoom): Promise<void> {
    ctx.deferredRepositoryRestarts.delete(channelId);
    running.controller.abort();
    await running.promise.catch(() => undefined);
    try {
      if (running.worktree) await ctx.reapCornerWorktree(running.worktree);
      else if (running.scratch) await ctx.reapCornerScratch(running.scratch);
    } catch (error) {
      console.error(`[thin-core] corner ${channelId} cleanup failed; will retry:`, error);
    }
    if (running.worktree || running.scratch) await ctx.cleanupArchivedCornerLocalState(channelId);
  }


  export function roomRuntimeCoordinatorRoomRecord(ctx: RoomRuntimeCoordinator, roomId: string): RoomRuntimeRecord | undefined {
    return ctx.runtime.rooms.find((room) => room.channelId === roomId);
  }


  export function roomRuntimeCoordinatorRoomRoot(ctx: RoomRuntimeCoordinator, roomId: string): string {
    return ctx.roomRecord(roomId)?.root ?? resolve(dirname(ctx.configPath), 'rooms', roomId);
  }


  export function roomRuntimeCoordinatorRoomConfig(ctx: RoomRuntimeCoordinator, roomId: string, workspaceRoot = ctx.roomRoot(roomId)): BodyConfig {
    // CommandExecutionContext.enter creates this only after a permitted claim.
    const agentHomeRoot = resolve(workspaceRoot, 'agent-home');
    return {
      ...ctx.baseConfig,
      workspaceRoot,
      agentSharedAssetRoot: workspaceAssetRoot(ctx.runtime.supervisorRoot, ctx.runtime.communityId),
      agentPrivateRoot: resolve(workspaceRoot, 'agent-private'),
      agentMemoryRoot: resolve(dirname(ctx.configPath), 'memory'),
      openRouterRoutingCacheDir: openRouterRoutingCacheDir(dirname(ctx.configPath)),
      turnTraceDir: turnTraceDirectory(dirname(ctx.configPath)),
      agentHomeRoot,
    };
  }


  /** The loopback door for run_granted_command; started once, on first use. */
  export function roomRuntimeCoordinatorGrantRunnerEndpoint(ctx: RoomRuntimeCoordinator): Promise<GrantRunnerEndpoint | undefined> {
    return ctx.grantRunnerServer.start().catch((error) => {
      console.error('[thin-core] grant runner unavailable; run_granted_command is off:', error);
      return undefined;
    });
  }


  export async function roomRuntimeCoordinatorStartRoom(ctx: RoomRuntimeCoordinator, roomId: string): Promise<void> {
    if (ctx.stopped) return;
    if (ctx.running.has(roomId) || ctx.startingRooms.has(roomId)) return;
    // Subscribing does not activate a harness or write its private storage.
    // Keep control commands reachable even while a storage lease blocks turns.
    ctx.surfaceHealth.discover(roomId, 'room');
    ctx.startingRooms.add(roomId);
    try {
      await ctx.startRoomOnce(roomId);
    } catch (error) {
      ctx.surfaceHealth.degraded(roomId, 'Room intake failed to start');
      throw error;
    } finally {
      ctx.startingRooms.delete(roomId);
    }
  }


  export async function roomRuntimeCoordinatorStartRoomOnce(ctx: RoomRuntimeCoordinator, roomId: string): Promise<void> {
    const controller = new AbortController();
    // The turn loop refreshes checkout before activation. Idle Rooms can
    // subscribe to durable commands without fetching a token or running Git.
    const cwd = ctx.roomRoot(roomId);
    // An agent can belong to Rooms outside its helper's pairing Workspace.
    const { workspaceId } = await ctx.options.daemonApi.execute('getRoomAuthority', {
      roomId,
      principalId: ctx.agent.publicKey,
    });
    const grantRunnerEndpoint = await ctx.grantRunnerEndpoint();
    const loop = new MonolithRoomTurnLoop({
      roomId,
      workspaceId,
      cwd,
      refreshCheckout: () => ctx.refreshRoomCheckout(roomId),
      grantRunner: ctx.grantRunner,
      ...(grantRunnerEndpoint ? { grantRunnerEndpoint } : {}),
      runtime: ctx.runtime,
      config: ctx.roomConfig(roomId),
      api: ctx.options.daemonApi,
      scheduler: ctx.scheduler,
      signal: controller.signal,
      health: { poll: () => ctx.notePoll(roomId) },
      onSubscriptionState: (connected) => ctx.surfaceHealth.subscribed(roomId, connected),
      onIntakeError: () => ctx.surfaceHealth.degraded(roomId, 'Room command intake failed'),
      onRestartRequested: () => ctx.stopAgentProcesses(),
      canStartTurn: () => !ctx.restartRequested && !AgentProcesses.hostStoragePaused &&
        !AgentProcesses.roomStoragePaused(roomId) && !ctx.storageMaintenanceRooms.has(roomId),
      supervisor: ctx.supervisor,
    });
    const promise = loop
      .run()
      .catch((error) => {
        if (!controller.signal.aborted) {
          ctx.surfaceHealth.degraded(roomId, 'Room command loop exited');
          console.error(`[thin-core] Room ${roomId} failed:`, error);
        }
      })
      .finally(() => {
        if (ctx.running.get(roomId)?.body === loop) ctx.running.delete(roomId);
      });
    // Shutdown snapshots `running` once. A start that was still in flight then
    // must drop what it just built rather than join the map behind the abort
    // pass, or its live subscription outlives the daemon.
    if (ctx.stopped) {
      controller.abort();
      await promise;
      return;
    }
    ctx.running.set(roomId, { body: loop, controller, promise });
    console.log(`[thin-core] serving monolith Room ${roomId}`);
  }


  /**
   * A Room is a repository inspection surface, so its session cwd must be the
   * current server-bound repository rather than a legacy runtime path (or the
   * otherwise-empty per-Room state directory). The daemon consumes the
   * short-lived GitHub token for checkout and the Room's external GitHub
   * operations. Filesystem writes remain governed by the Room sandbox.
   */
  export async function roomRuntimeCoordinatorMaterializeRoomCheckout(ctx: RoomRuntimeCoordinator, 
    roomId: string,
    repository?: RoomRepositoryStateResult,
  ): Promise<string> {
    repository ??= await ctx.parentRepositoryState(roomId);
    if (repository.resolution !== 'repository' || !repository.remote) return ctx.roomRoot(roomId);

    const remote = roomCheckoutRemote(repository.remote);
    const targetBranch = repository.targetBranch || 'main';
    const checkoutId = createHash('sha256')
      .update(`${roomId}\0${remote}\0${targetBranch}`)
      .digest('hex')
      .slice(0, 24);
    const path = resolve(ctx.runtime.supervisorRoot, 'beeline', 'room-checkouts', checkoutId);
    await rememberStorageOwner(ctx.runtime.supervisorRoot, { workspaceId: ctx.runtime.communityId, roomId, kind: 'room-checkouts', itemId: checkoutId });
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });

    const token = remote.startsWith('https://github.com/')
      ? await ctx.parentRepositoryToken(roomId)
      : undefined;
    const env = token ? githubGitEnv(token.token) : process.env;
    if (!existsSync(resolve(path, '.git'))) {
      await execFileAsync('git', ['clone', '--no-checkout', ...CRASH_SAFE_CLONE_ARGS, remote, path], {
        env,
        maxBuffer: 4 * 1024 * 1024,
      });
    }
    const fetched = await fetchRepositoryCache({
      gitDir: resolve(path, '.git'),
      label: `room-checkouts/${checkoutId}`,
      args: ['--prune', 'origin', `+refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`],
      env,
    }).then(
      () => true,
      (error) => {
        if (isRemoteRefMissing(error)) return false;
        throw error;
      },
    );
    if (!fetched) {
      void ctx.options.daemonApi
        .execute('noteEmptyRoomRepository', { roomId })
        .catch((error) =>
          console.warn(`[thin-core] Room ${roomId} empty-repository notice failed:`, error),
        );
      return ctx.roomRoot(roomId);
    }
    await execFileAsync(
      'git',
      ['-C', path, 'checkout', '--detach', '--force', `origin/${targetBranch}`],
      {
        env,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return path;
  }
