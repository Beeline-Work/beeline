import { execFile, type ExecFileOptions } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { BodyConfig } from './config.js';
import { DaemonApiError, type DaemonApiClient, type RoomMembershipChange } from './daemon-api-client.js';
import { isStandingWorkspaceConfigurationFault, type CornerRestoreResult, type RoomGitHubTokenResult, type RoomRepositoryStateResult } from '@beeline/api-contract/daemon';
import { GrantCommandRunner, GrantRunnerServer, type GrantRunnerEndpoint } from './grant-runner.js';
import { ConnectorUsageRecorder } from './connector-runner.js';
import { MonolithCornerTurnLoop } from './monolith-corner-turn.js';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import type { InterruptedTurn } from './force-update-journal.js';
import { agentGitIdentity } from './agent-git-identity.js';
import { removeStoragePath, storageTree, isSquirePath, ordinaryDirectory, type StorageRoomState } from './helper-storage.js';
import { SurfaceHealth, type SurfaceHealthState } from './surface-health.js';
import { RoomSupervisor } from './room-supervisor.js';
import type { AgentRuntimeRecord, RoomRuntimeRecord } from './runtime.js';
import { runtimeIdentity } from './runtime.js';
import { agentCornerCheckoutPaths, materializeAgentCornerCheckout } from './agent-corner-checkout.js';
import { CRASH_SAFE_CLONE_ARGS, fetchRepositoryCache } from './repository-cache-repair.js';
import { resolveSessionIdleMs, AgentProcesses, type AgentProcessSnapshot } from './agent-process.js';
import { roomRuntimeCoordinatorReconciliationDiagnostics, roomRuntimeCoordinatorNoteReconciliationStage, roomRuntimeCoordinatorActiveRoomIds, roomRuntimeCoordinatorSetDiscoveryWakeListener, roomRuntimeCoordinatorSetReconciliationProgressListener, roomRuntimeCoordinatorYieldReconciliation, roomRuntimeCoordinatorSetInteractiveIdleListener, roomRuntimeCoordinatorWakeDiscovery, roomRuntimeCoordinatorActiveRoomCount, roomRuntimeCoordinatorSurfaceHealthSnapshot, roomRuntimeCoordinatorSurfaceHealthSummary, roomRuntimeCoordinatorHasDegradedSurfaces, roomRuntimeCoordinatorSchedulerSnapshot, roomRuntimeCoordinatorIsWorkspaceIdle, roomRuntimeCoordinatorActiveTurnCount, roomRuntimeCoordinatorStopAgentProcesses, roomRuntimeCoordinatorQuiesceForUpdateIfIdle, roomRuntimeCoordinatorQuiesceForUpdate, roomRuntimeCoordinatorResumeServing, roomRuntimeCoordinatorPrepareForForcedUpdateRestart, roomRuntimeCoordinatorInterruptedTurns, roomRuntimeCoordinatorInterruptForServerMinimum, roomRuntimeCoordinatorReconcile, roomRuntimeCoordinatorReconcileRooms, roomRuntimeCoordinatorScheduleStorageMaintenance, roomRuntimeCoordinatorQueueMembershipEvent, roomRuntimeCoordinatorDrainMembershipEvents, roomRuntimeCoordinatorApplyMembershipEvent, roomRuntimeCoordinatorApplyCornerComplete, roomRuntimeCoordinatorStopRunning, roomRuntimeCoordinatorRoomRecord, roomRuntimeCoordinatorRoomRoot, roomRuntimeCoordinatorRoomConfig, roomRuntimeCoordinatorGrantRunnerEndpoint, roomRuntimeCoordinatorStartRoom, roomRuntimeCoordinatorStartRoomOnce, roomRuntimeCoordinatorMaterializeRoomCheckout } from './room-runtime-reconciliation-diagnostics.js';
import { roomRuntimeCoordinatorRefreshRoomCheckout, roomRuntimeCoordinatorStartCorner, roomRuntimeCoordinatorWatchCorner, roomRuntimeCoordinatorUnwatchCorner, roomRuntimeCoordinatorActivateWatchedCorner, roomRuntimeCoordinatorCornerRepositoryToken, roomRuntimeCoordinatorInvalidateParentRepository, roomRuntimeCoordinatorRefreshRoomCorners, roomRuntimeCoordinatorRestartRunningRoomForRepositoryChange, roomRuntimeCoordinatorParentRepositoryState, roomRuntimeCoordinatorParentRepositoryToken, roomRuntimeCoordinatorReportCornerStartFailure, roomRuntimeCoordinatorMaterializeCornerWorktree, roomRuntimeCoordinatorGetLocalWorktreeIds, roomRuntimeCoordinatorArchiveCleanupRefusalPath, roomRuntimeCoordinatorCleanupWasRefused, roomRuntimeCoordinatorRefuseArchiveCleanup, roomRuntimeCoordinatorQueueArchivePreservation, roomRuntimeCoordinatorArchiveCleanupDue, roomRuntimeCoordinatorDeferArchiveCleanup, roomRuntimeCoordinatorRetryPendingCornerReaps, roomRuntimeCoordinatorReapClosedCornerEmulators } from './room-runtime-refresh-room-checkout.js';
import { roomRuntimeCoordinatorSweepArchivedCornerWorktrees, roomRuntimeCoordinatorReapIdleCornerWorktree, roomRuntimeCoordinatorReapCornerWorktree, roomRuntimeCoordinatorReapCornerScratch, roomRuntimeCoordinatorCleanupArchivedCornerLocalState, roomRuntimeCoordinatorReclaimPrivateStorage, roomRuntimeCoordinatorSweepRoomPrivateStorage, roomRuntimeCoordinatorCollectDependencyStores, roomRuntimeCoordinatorNotePoll, roomRuntimeCoordinatorBeginShutdown, roomRuntimeCoordinatorShutdown } from './room-runtime-sweep-archived-corner-worktrees.js';

export class RoomRuntimeCoordinator {

   readonly runtime: AgentRuntimeRecord;

   readonly running = new Map<string, RunningRoom>();

   readonly surfaceHealth = new SurfaceHealth();

  /** Close/reconcile leftovers retried until local and remote refs are gone. */
   readonly pendingCornerReaps = new Map<string, CornerWorktree>();

  /** Last logged emulator reaper decision per corner, so reconcile does not repeat it. */
   readonly emulatorReapDecisions = new Map<string, string>();

  /** Idle corners listen for durable commands without obtaining a token or checkout. */
   readonly idleCornerSubscriptions = new Map<string, () => void>();

   readonly pendingCornerCommands = new Set<string>();

  /** Enumerated once; later materialization and removal keep it current. */
   localWorktreeIds?: Promise<Set<string>>;

  /** Event-driven cleanup retries stay scoped to the failed local corner. */
   readonly archiveCleanupFaults = new Map<string, { failures: number; retryAt: number }>();

  /** Permanent cleanup refusals survive core and helper restarts on disk. */
   readonly archiveCleanupRefused = new Set<string>();

  /**
   * A corner whose branch cleanup found commits no origin ref contains. That
   * is never transient - nothing pushes them later - so retrying it every
   * reconciliation would only slow discovery down forever. Reported once,
   * then left alone; the checkout and its commits are kept, never deleted.
   */
   readonly archiveCleanupAbandoned = new Set<string>();

   preservationFlight?: Promise<void>;

   maintenanceFlight?: Promise<void>;

   maintenanceRequest?: {
    archived: ReadonlyMap<string, { cornerId: string; parentRoomId: string }>;
    states: readonly StorageRoomState[];
  };

   readonly desiredChannels = new Set<string>();

   reconciliationProgressListener?: () => void | Promise<void>;

   reconciliationStage = 'idle';

   reconciliationStageAt = Date.now();
reconciliationDiagnostics() { return roomRuntimeCoordinatorReconciliationDiagnostics(this); }
noteReconciliationStage(stage: string): void { return roomRuntimeCoordinatorNoteReconciliationStage(this, stage); }

   readonly storageMaintenanceRooms = new Set<string>();

   readonly storageDeferredStarts = new Set<string>();

   readonly stopStorageAvailable: () => void;

   readonly startingCorners = new Set<string>();

  /**
   * Rooms whose start is in flight. `running` is not set until the checkout
   * clone finishes, and three callers race for it — the membership push, the
   * reconcile sweep, and the watchdog restart — so without this two checkouts
   * run in the same shared directory and the second start orphans the first
   * loop's AbortController.
   */
   readonly startingRooms = new Set<string>();

  /** Pushed membership changes awaiting a bounded apply, latest per Room. */
   readonly pendingMembershipEvents = new Map<string, RoomMembershipChange>();

   membershipDrain: Promise<void> | undefined;

  /** Set by `shutdown`: a pushed event may no longer start anything. */
   stopped = false;

  /** Runtime refusals wait for a server configuration/sign-in change. */
   readonly standingRuntimeStartFaults = new Set<string>();

  /** Per corner, the requests whose start failure has already been said out loud. */
  /** Standing workspace-configuration faults: the config that failed, and how. */
   readonly standingCornerStartFaults = new Map<string, { configKey: string; error: unknown }>();

   readonly scheduler: AgentProcesses;

   readonly agent: ReturnType<typeof runtimeIdentity>;

  /** Parent ownership retained so a failed corner listing never authorizes removal. */
   readonly monolithCornerParents = new Map<string, string>();

   readonly now: () => number;

   workspaceRemovalConfirmations = 0;

   readonly roomRemovalConfirmations = new Map<string, number>();

   readonly repositoryRevisions = new Map<string, string>();

  /** A revision discovered mid-turn retires the Room only after that turn ends. */
   readonly deferredRepositoryRestarts = new Set<string>();

   readonly repositoryStateCache = new Map<
    string,
    { value: RoomRepositoryStateResult; until: number }
  >();

   readonly repositoryStateFlights = new Map<string, Promise<RoomRepositoryStateResult>>();

   readonly tokenCache = new Map<string, RoomGitHubTokenResult>();

   readonly tokenFlights = new Map<string, Promise<RoomGitHubTokenResult>>();

   restartRequested = false;

  /** Keeps Room and corner intakes alive across failed reads, without polling. */
  readonly supervisor: RoomSupervisor;

   discoveryWakeListener?: () => void;

   interactiveIdleListener?: () => void;

  /** One command-grant runner per daemon; Rooms and corners register their checkouts on it. */
   readonly grantRunner: GrantCommandRunner;

   readonly grantRunnerServer: GrantRunnerServer;

  /** Connection usage capture, batched per agent turn. */
   readonly connectorUsage: ConnectorUsageRecorder;


  constructor(
    runtime: AgentRuntimeRecord,
     readonly configPath: string,
     readonly baseConfig: BodyConfig,
     readonly options: {
      now?: () => number;
      daemonApi: DaemonApiClient;
      onConfigChanged?: () => void | Promise<void>;
    },
  ) {
    if (!runtime.transport) throw new Error('thin daemon requires monolith transport');
    this.supervisor = new RoomSupervisor(options.daemonApi);
    this.runtime = runtime;
    this.agent = runtimeIdentity(runtime.agent);
    this.now = options.now ?? Date.now;
    this.grantRunner = new GrantCommandRunner({
      api: options.daemonApi,
      agentId: this.agent.publicKey,
    });
    this.grantRunnerServer = new GrantRunnerServer(this.grantRunner);
    this.connectorUsage = new ConnectorUsageRecorder();
    // Optional on purpose: test stubs of the API surface predate the wake.
    this.options.daemonApi.setRoomsChangedListener?.((event) => {
      if (event?.repositoryChanged) {
        if (event.roomId) {
          this.invalidateParentRepository(event.roomId);
          void this.refreshRoomCorners(event.roomId);
          return;
        }
        this.wakeDiscovery();
        return;
      }
      const roomId = event?.roomId;
      if (!roomId) {
        this.wakeDiscovery();
        return;
      }
      this.queueMembershipEvent({ ...event, roomId });
    });
    this.options.daemonApi.setCornerCompleteListener?.((roomId) => {
      void this.applyCornerComplete(roomId).catch((error) =>
        console.error('[thin-core] live corner-complete apply failed', error),
      );
    });
    // Hot-restart on a phone-side model/effort selection change: retire every
    // retained session now so the next turn cold-activates against the saved
    // selection, exactly as session start reads it. A busy session is left to
    // finish and re-checked at its next hand-back; plain reconnects never fire
    // this. Optional like the wake above: a stub API without the listener
    // still reconciles, and the per-turn currency check remains the net.
    this.options.daemonApi.setConfigChangedListener?.(() => {
      const retryStarts = this.standingRuntimeStartFaults.size > 0;
      this.standingRuntimeStartFaults.clear();
      if (retryStarts) this.wakeDiscovery();
      for (const running of this.running.values()) running.body.configurationChanged?.();
      void this.scheduler
        .stopIdle()
        .catch((error) => console.error('[body] config-change session restart failed', error));
      void Promise.resolve(this.options.onConfigChanged?.()).catch((error) =>
        console.error('[body] config-change catalog refresh failed', error),
      );
    });
    this.scheduler = new AgentProcesses({ idleMs: resolveSessionIdleMs(process.env) });
    this.stopStorageAvailable = AgentProcesses.onStorageAvailable(key => {
      if (this.stopped) return;
      // Command intake stays subscribed while storage owns the session paths.
      // Wake it directly: the discovery sweep may still be reaping old checkouts.
      for (const [roomId, running] of this.running)
        if (!key || key === roomId) running.body.requestReconciliation();
      if (!this.storageDeferredStarts.size) return;
      if (key && !this.storageDeferredStarts.delete(key)) return;
      if (!key) this.storageDeferredStarts.clear();
      // Re-read membership/commands after the lease, rather than starting
      // from facts that could have changed while storage was unavailable.
      this.wakeDiscovery();
    });
  }
activeRoomIds(): string[] { return roomRuntimeCoordinatorActiveRoomIds(this); }
setDiscoveryWakeListener(listener: () => void): void { return roomRuntimeCoordinatorSetDiscoveryWakeListener(this, listener); }
setReconciliationProgressListener(listener: () => void | Promise<void>): void { return roomRuntimeCoordinatorSetReconciliationProgressListener(this, listener); }
async yieldReconciliation(): Promise<void> { return roomRuntimeCoordinatorYieldReconciliation(this); }
setInteractiveIdleListener(listener: () => void): void { return roomRuntimeCoordinatorSetInteractiveIdleListener(this, listener); }
wakeDiscovery(): void { return roomRuntimeCoordinatorWakeDiscovery(this); }
activeRoomCount(): number { return roomRuntimeCoordinatorActiveRoomCount(this); }
surfaceHealthSnapshot(): SurfaceHealthState[] { return roomRuntimeCoordinatorSurfaceHealthSnapshot(this); }
surfaceHealthSummary(): string { return roomRuntimeCoordinatorSurfaceHealthSummary(this); }
hasDegradedSurfaces(): boolean { return roomRuntimeCoordinatorHasDegradedSurfaces(this); }
/** Current running processes and ordered work, also recorded in turn traces. */
schedulerSnapshot(): AgentProcessSnapshot { return roomRuntimeCoordinatorSchedulerSnapshot(this); }
isWorkspaceIdle(): boolean { return roomRuntimeCoordinatorIsWorkspaceIdle(this); }
/** Turns executing right now. Serving a Room or corner with no turn in flight is idle. */
activeTurnCount(): number { return roomRuntimeCoordinatorActiveTurnCount(this); }
/** A restart command retires harnesses; subscriptions stay available for new work. */
async stopAgentProcesses(): Promise<void> { return roomRuntimeCoordinatorStopAgentProcesses(this); }
quiesceForUpdateIfIdle(): boolean { return roomRuntimeCoordinatorQuiesceForUpdateIfIdle(this); }
/** Stop claiming new turns while existing turns drain for a managed update. */
quiesceForUpdate(): void { return roomRuntimeCoordinatorQuiesceForUpdate(this); }
/**
 * Undo `quiesceForUpdateIfIdle` after a managed restart failed: clear the
 * latch and let reconciliation start the Room loops the quiesce stopped.
 */
resumeServing(): void { return roomRuntimeCoordinatorResumeServing(this); }
async prepareForForcedUpdateRestart(): Promise<void> { return roomRuntimeCoordinatorPrepareForForcedUpdateRestart(this); }
interruptedTurns(): InterruptedTurn[] { return roomRuntimeCoordinatorInterruptedTurns(this); }
interruptForServerMinimum(): InterruptedTurn[] { return roomRuntimeCoordinatorInterruptForServerMinimum(this); }
async reconcile(onServing?: () => void | Promise<void>): Promise<WorkspaceMembershipStatus> { return roomRuntimeCoordinatorReconcile(this, onServing); }
async reconcileRooms(onServing?: () => void | Promise<void>): Promise<WorkspaceMembershipStatus> { return roomRuntimeCoordinatorReconcileRooms(this, onServing); }
/** Retention cannot hold discovery or its watchdog acknowledgement hostage.
 * One sweep runs at a time; discovery coalesces its latest facts for the next
 * pass and updates the active set immediately, including during a slow reap.
 * Maintenance yields do not acknowledge a blocked foreground discovery. */
scheduleStorageMaintenance(archived: ReadonlyMap<string, {
    cornerId: string;
    parentRoomId: string;
}>, desired: ReadonlySet<string>, states: readonly StorageRoomState[]): void { return roomRuntimeCoordinatorScheduleStorageMaintenance(this, archived, desired, states); }
/**
 * Pushed membership changes are applied at the same bound the reconcile pass
 * uses. One `rooms-changed` per row means a single human action (adding an
 * agent to a Room inherits a membership per corner under it) arrives as a
 * burst; unbounded, that burst is exactly the concurrent restore reads and
 * worktree checkouts this change exists to stop.
 */
queueMembershipEvent(event: RoomMembershipChange & {
    roomId: string;
}): void { return roomRuntimeCoordinatorQueueMembershipEvent(this, event); }
async drainMembershipEvents(): Promise<void> { return roomRuntimeCoordinatorDrainMembershipEvents(this); }
/**
 * Incremental apply of one scoped membership push.
 * An unscoped wake still uses the slow reconcile as recovery.
 */
async applyMembershipEvent(event: RoomMembershipChange): Promise<void> { return roomRuntimeCoordinatorApplyMembershipEvent(this, event); }
async applyCornerComplete(cornerId: string): Promise<void> { return roomRuntimeCoordinatorApplyCornerComplete(this, cornerId); }
async stopRunning(channelId: string, running: RunningRoom): Promise<void> { return roomRuntimeCoordinatorStopRunning(this, channelId, running); }
roomRecord(roomId: string): RoomRuntimeRecord | undefined { return roomRuntimeCoordinatorRoomRecord(this, roomId); }
roomRoot(roomId: string): string { return roomRuntimeCoordinatorRoomRoot(this, roomId); }
roomConfig(roomId: string, workspaceRoot = this.roomRoot(roomId)): BodyConfig { return roomRuntimeCoordinatorRoomConfig(this, roomId, workspaceRoot); }
/** The loopback door for run_granted_command; started once, on first use. */
grantRunnerEndpoint(): Promise<GrantRunnerEndpoint | undefined> { return roomRuntimeCoordinatorGrantRunnerEndpoint(this); }
async startRoom(roomId: string): Promise<void> { return roomRuntimeCoordinatorStartRoom(this, roomId); }
async startRoomOnce(roomId: string): Promise<void> { return roomRuntimeCoordinatorStartRoomOnce(this, roomId); }
/**
 * A Room is a repository inspection surface, so its session cwd must be the
 * current server-bound repository rather than a legacy runtime path (or the
 * otherwise-empty per-Room state directory). The daemon consumes the
 * short-lived GitHub token for checkout and the Room's external GitHub
 * operations. Filesystem writes remain governed by the Room sandbox.
 */
async materializeRoomCheckout(roomId: string, repository?: RoomRepositoryStateResult): Promise<string> { return roomRuntimeCoordinatorMaterializeRoomCheckout(this, roomId, repository); }
async refreshRoomCheckout(roomId: string): Promise<{
    cwd: string;
    branch?: string;
    commit?: string;
    githubToken?: string;
}> { return roomRuntimeCoordinatorRefreshRoomCheckout(this, roomId); }
async startCorner(corner: DesiredCorner): Promise<void> { return roomRuntimeCoordinatorStartCorner(this, corner); }
async watchCorner(corner: DesiredCorner): Promise<void> { return roomRuntimeCoordinatorWatchCorner(this, corner); }
unwatchCorner(cornerId: string): void { return roomRuntimeCoordinatorUnwatchCorner(this, cornerId); }
async activateWatchedCorner(corner: DesiredCorner): Promise<void> { return roomRuntimeCoordinatorActivateWatchedCorner(this, corner); }
async cornerRepositoryToken(roomId: string): Promise<{
    token: string;
    expiresAt: number;
}> { return roomRuntimeCoordinatorCornerRepositoryToken(this, roomId); }
invalidateParentRepository(roomId: string): void { return roomRuntimeCoordinatorInvalidateParentRepository(this, roomId); }
/**
 * A repository-change event names its own Room, so only that Room's
 * corners need a fresh listing; re-listing every Room's corners for one
 * Room's push would repeat that read for every other Room on each push.
 * Only new or newly-unarchived corners are started here - removals and
 * archived-corner cleanup stay on the regular reconcile pass. The named
 * Room itself is restarted the same way a full reconcile would, so a
 * running Room picks up the change (a new GitHub installation, a token) too.
 */
async refreshRoomCorners(roomId: string): Promise<void> { return roomRuntimeCoordinatorRefreshRoomCorners(this, roomId); }
/**
 * Same stop/restart (or, mid-turn, defer-to-`notePoll`) a full reconcile
 * applies to a Room whose `repositoryRevision` changed, for the one Room a
 * live repository-change event names. A no-op when that id names nothing
 * currently running - e.g. a Room whose corners changed but is not itself
 * being served, or a corner id, which this event never actually names.
 */
async restartRunningRoomForRepositoryChange(roomId: string): Promise<void> { return roomRuntimeCoordinatorRestartRunningRoomForRepositoryChange(this, roomId); }
async parentRepositoryState(roomId: string): Promise<RoomRepositoryStateResult> { return roomRuntimeCoordinatorParentRepositoryState(this, roomId); }
async parentRepositoryToken(roomId: string): Promise<RoomGitHubTokenResult> { return roomRuntimeCoordinatorParentRepositoryToken(this, roomId); }
/** A real startup failure is a result of an owned command, never an
 * unclaimed receipt. Terminal commands disappear from the pending queue. */
async reportCornerStartFailure(cornerId: string, error: unknown): Promise<boolean> { return roomRuntimeCoordinatorReportCornerStartFailure(this, cornerId, error); }
async materializeCornerWorktree(input: {
    cornerId: string;
    remote: string;
    targetBranch: string;
    featureBranch: string;
    token: string;
    migrateLegacy?: boolean;
}): Promise<{
    path: string;
    gitCommonDir: string;
}> { return roomRuntimeCoordinatorMaterializeCornerWorktree(this, input); }
getLocalWorktreeIds(): Promise<Set<string>> { return roomRuntimeCoordinatorGetLocalWorktreeIds(this); }
archiveCleanupRefusalPath(cornerId: string): string { return roomRuntimeCoordinatorArchiveCleanupRefusalPath(this, cornerId); }
async cleanupWasRefused(cornerId: string): Promise<boolean> { return roomRuntimeCoordinatorCleanupWasRefused(this, cornerId); }
async refuseArchiveCleanup(cornerId: string, error: DaemonApiError, worktree?: DiscoveredCornerWorktree & {
    branch?: string;
}): Promise<void> { return roomRuntimeCoordinatorRefuseArchiveCleanup(this, cornerId, error, worktree); }
queueArchivePreservation(cornerId: string, worktree: DiscoveredCornerWorktree & {
    branch?: string;
}, reason: string): void { return roomRuntimeCoordinatorQueueArchivePreservation(this, cornerId, worktree, reason); }
archiveCleanupDue(cornerId: string): boolean { return roomRuntimeCoordinatorArchiveCleanupDue(this, cornerId); }
deferArchiveCleanup(cornerId: string): void { return roomRuntimeCoordinatorDeferArchiveCleanup(this, cornerId); }
async retryPendingCornerReaps(desired: ReadonlySet<string>): Promise<void> { return roomRuntimeCoordinatorRetryPendingCornerReaps(this, desired); }
/**
 * Helper start and each reconcile: an emulator whose corner is not open
 * here stays until the server says the corner is archived. Every runtime
 * on the host scans the same records, so any refusal (403, 404, 410) or
 * failed lookup keeps it: one agent's partial view cannot stop another
 * agent's live corner. The server answers a corner the caller cannot
 * reach with 403, never with a deletion signal.
 */
async reapClosedCornerEmulators(liveCornerIds: ReadonlySet<string>): Promise<void> { return roomRuntimeCoordinatorReapClosedCornerEmulators(this, liveCornerIds); }
/**
 * Startup/reconcile recovery for worktrees no current process remembers.
 * Archived server state names the exact corner; local discovery is limited
 * to that exact directory and the host's bare-repository cache.
 */
async sweepArchivedCornerWorktrees(_corners: ReadonlyMap<string, {
    cornerId: string;
    parentRoomId: string;
}>, desired: ReadonlySet<string> = new Set()): Promise<void> { return roomRuntimeCoordinatorSweepArchivedCornerWorktrees(this, _corners, desired); }
async reapIdleCornerWorktree(worktree: CornerWorktree, desired: ReadonlySet<string>): Promise<void> { return roomRuntimeCoordinatorReapIdleCornerWorktree(this, worktree, desired); }
async reapCornerWorktree(worktree: CornerWorktree): Promise<void> { return roomRuntimeCoordinatorReapCornerWorktree(this, worktree); }
async reapCornerScratch(scratch: CornerScratch): Promise<void> { return roomRuntimeCoordinatorReapCornerScratch(this, scratch); }
/** A failed/missing restore read cannot authorize private reclamation. Shared
 * checkouts are reaped separately, under their unpublished-work protections. */
async cleanupArchivedCornerLocalState(cornerId: string): Promise<boolean> { return roomRuntimeCoordinatorCleanupArchivedCornerLocalState(this, cornerId); }
async reclaimPrivateStorage(states: readonly StorageRoomState[]) { return roomRuntimeCoordinatorReclaimPrivateStorage(this, states); }
/** Archive cleanup runs on each authoritative reconciliation. Open private
 * folders are reconsidered every six hours; no file-age decision is made. */
async sweepRoomPrivateStorage(states: readonly StorageRoomState[]): Promise<void> { return roomRuntimeCoordinatorSweepRoomPrivateStorage(this, states); }
async collectDependencyStores(): Promise<void> { return roomRuntimeCoordinatorCollectDependencyStores(this); }
notePoll(roomId: string): void { return roomRuntimeCoordinatorNotePoll(this, roomId); }
beginShutdown(): void { return roomRuntimeCoordinatorBeginShutdown(this); }
async shutdown(): Promise<void> { return roomRuntimeCoordinatorShutdown(this); }
}



export type WorkspaceMembershipStatus = 'member' | 'not-member' | 'unknown';

export const REMOVAL_CONFIRMATION_READS = 2;

export const ROOM_JOIN_CONCURRENCY = 4;

export const CORNER_BRANCH_DELETE_ATTEMPTS = 3;


export class CornerCredentialLookupError extends Error {
  constructor(cause: unknown) {
    super('corner repository credential lookup failed', { cause });
  }
}


/**
 * A restarted helper must not overwrite the server's GitHub-owned corner facts.
 * A promoted corner may first get a code runtime from someone other than its
 * original opener; branch state depends on the lifecycle, not that identity.
 */
export function shouldPostInitialCornerWorkingState(restore: CornerRestoreResult): boolean {
  return !restore.lifecycle?.branch && !restore.lifecycle?.pr;
}


/**
 * Whether a closed corner's feature branch is debris or recoverable work.
 *
 * The branch IS the shared artifact: an open pull request's head branch must
 * never be deleted by close cleanup, because deleting it closes the pull
 * request and the commits survive only through `refs/pull/<n>/head`. Only a
 * merged pull request (whose server-side merge handler already deleted the
 * branch) or the absence of any pull request makes the branch safe to remove.
 */
export function cornerBranchIsSafeToDelete(lifecycle?: CornerRestoreResult['lifecycle']): boolean {
  const pr = lifecycle?.pr;
  return !pr || Boolean(pr.mergedAt);
}


export function cornerStartConfigKey(
  repository: Pick<RoomRepositoryStateResult, 'resolution' | 'key' | 'remote'>,
  objective: string,
): string {
  return JSON.stringify({
    resolution: repository.resolution,
    key: repository.key ?? null,
    remote: repository.remote ?? null,
    objective: objective.trim(),
  });
}


export function cornerRepositoryCacheDir(supervisorRoot: string, remote: string): string {
  const normalizedRemote = roomCheckoutRemote(remote);
  const repositoryHash = createHash('sha256').update(normalizedRemote).digest('hex').slice(0, 24);
  return resolve(supervisorRoot, 'beeline', 'repositories', `${repositoryHash}.git`);
}


/** How a plain failure line names a corner repo cache: `repositories/<hash>.git`. */
export function repositoryCacheLabel(gitCommonDir: string): string {
  return `${basename(dirname(gitCommonDir))}/${basename(gitCommonDir)}`;
}


export function isStandingCornerStartFault(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return isStandingWorkspaceConfigurationFault(text);
}


/**
 * The checkout a corner turn runs in, on the corner's own branch.
 *
 * A corner is carried by its MEMBERS, so this also serves an agent's first
 * touch of work it did not open: the branch on GitHub is the corner, and the
 * fresh worktree starts from `origin/<featureBranch>` whenever GitHub has one.
 * Only a corner that has never pushed starts from the target branch, which is
 * every corner's first moment and was the only case before helpers could join.
 * An existing worktree is left where it is — the branch is caught up per turn
 * by `syncCornerBranch`, never by re-cutting the checkout underneath it.
 */
export async function materializeCornerWorktree(input: {
  cornerId: string;
  remote: string;
  targetBranch: string;
  featureBranch: string;
  token: string;
  supervisorRoot: string;
  /** New Workspace layout skips the ABI-unsafe legacy host-wide warm store. */
  workspaceId?: string;
  committer: { name: string; publicKey: string };
  migrateLegacy?: boolean;
}): Promise<{ path: string; gitCommonDir: string }> {
  const boundedGit = (file: string, args: string[], options: ExecFileOptions = {}) => execFileAsync(file, args, { ...options, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL' });
  // Same normalization the Room checkout uses: every real remote is held to
  // the GitHub HTTPS identity, and a `file://` remote stays usable so the
  // shared-branch behaviour can be proved against a real git remote.
  const remote = roomCheckoutRemote(input.remote);
  const sourceGitDir = cornerRepositoryCacheDir(input.supervisorRoot, remote);
  const { path, gitCommonDir } = agentCornerCheckoutPaths(input.supervisorRoot, input.cornerId, input.committer.publicKey);
  await mkdir(dirname(sourceGitDir), { recursive: true, mode: 0o700 });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Publish an immutable seed atomically. Racing first starts may clone in
  // parallel, then use the winner. All future fetches go to private refs;
  // there is no repository or checkout lock on the corner setup/turn path.
  if (!existsSync(resolve(sourceGitDir, 'HEAD'))) {
    const staging = `${sourceGitDir}.creating-${randomUUID()}`;
    try {
      await boundedGit('git', ['clone', '--bare', ...CRASH_SAFE_CLONE_ARGS, remote, staging], {
        env: githubGitEnv(input.token), maxBuffer: 4 * 1024 * 1024,
      });
      await rename(staging, sourceGitDir).catch((error: NodeJS.ErrnoException) => {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code ?? '') || !existsSync(resolve(sourceGitDir, 'HEAD'))) throw error;
      });
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  await materializeAgentCornerCheckout({ root: input.supervisorRoot, cornerId: input.cornerId,
    agentId: input.committer.publicKey, sourceGitDir, remote, branch: input.featureBranch,
    startRef: `refs/heads/${input.targetBranch}`, targetBranch: input.targetBranch, env: githubGitEnv(input.token),
    ...(input.migrateLegacy ? { legacyPath: resolve(input.supervisorRoot, 'beeline/corners', input.cornerId) } : {}),
  });
  // Dependencies are linked only at activation, when sandbox mounts seal them.
  await boundedGit('git', [
    `--git-dir=${gitCommonDir}`,
    'config',
    'extensions.worktreeConfig',
    'true',
  ]);
  // A linked worktree created from a bare canonical clone otherwise inherits
  // core.bare=true and rejects ordinary `git -C <worktree>` commands.
  await boundedGit('git', ['-C', path, 'config', '--worktree', 'core.bare', 'false']);
  await boundedGit('git', [
    '-C',
    path,
    'config',
    '--worktree',
    'credential.https://github.com.helper',
    '!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f',
  ]);
  const identity = agentGitIdentity(input.committer);
  await boundedGit('git', [
    '-C',
    path,
    'config',
    '--worktree',
    'user.name',
    identity.name,
  ]);
  await boundedGit('git', [
    '-C',
    path,
    'config',
    '--worktree',
    'user.email',
    identity.email,
  ]);
  const top = (
    await boundedGit('git', ['-C', path, 'rev-parse', '--show-toplevel'])
  ).stdout.trim();
  // git reports the physical path. On macOS /var is /private/var, and a
  // supervisor root reached through a symlink otherwise looks like an escape.
  if ((await realpath(top)) !== (await realpath(path))) {
    throw new Error(`corner worktree escaped its isolated root: ${top}`);
  }
  return { path, gitCommonDir };
}


export async function mapWithConcurrency<T>(
  values: readonly T[],
  limit: number,
  visit: (value: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        await visit(values[index]!, index);
      }
    }),
  );
}


export type RoomLeaf = Pick<
  MonolithRoomTurnLoop | MonolithCornerTurnLoop,
  | 'isBusy'
  | 'prepareForForcedUpdateRestart'
  | 'interruptForServerMinimum'
  | 'interruptedTurn'
  | 'requestReconciliation'
  | 'configurationChanged'
  | 'refreshPersonaForSoulUpdate'
  | 'forceRecoverRoom'
> & {
  requestClose?(): void;
};


export interface RunningRoom {
  body: RoomLeaf;
  controller: AbortController;
  promise: Promise<void>;
  worktree?: CornerWorktree;
  scratch?: CornerScratch;
}


export interface CornerWorktree {
  path: string;
  gitCommonDir: string;
  cornerId: string;
  branch: string;
  /** Parent Room used to mint a short-lived GitHub token at cleanup. */
  parentRoomId?: string;
  token: string;
  /** Recovery of a checkout left by an older process may find detached HEAD. */
  recovered?: true;
}


export interface DiscoveredCornerWorktree {
  path: string;
  gitCommonDir: string;
}


/** The local worktree root is small even when the server has years of archived corners. */
export async function localCornerWorktreeIds(supervisorRoot: string): Promise<Set<string>> {
  const root = resolve(supervisorRoot, 'beeline', 'corners');
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
}


export interface CornerScratch {
  path: string;
  cornerId: string;
}


export async function removeCornerWorktreeAndBranches(
  worktree: CornerWorktree,
  options: { preserveRemoteBranch?: boolean } = {},
): Promise<void> {
  if (existsSync(worktree.path) && !await ordinaryDirectory(worktree.path)) throw new Error('refusing noncanonical checkout');
  if (!existsSync(worktree.path) && !existsSync(worktree.gitCommonDir) && /^agent-corner-[a-f0-9]{64}\.git$/.test(basename(worktree.gitCommonDir))) return;
  const contents = await storageTree(worktree.path).catch(() => undefined);
  if (!contents && existsSync(worktree.path)) throw new Error('checkout inventory unavailable');
  if (contents && [...contents.keys()].some(isSquirePath)) throw new Error('refusing checkout containing Trusty Squire storage');
  const preserveRemoteBranch = options.preserveRemoteBranch === true;
  const localRef = `refs/heads/${worktree.branch}`;
  const remoteRef = `refs/heads/${worktree.branch}`;
  const worktreeExists = existsSync(worktree.path);
  const localExists = await gitRefExists(worktree.gitCommonDir, localRef);
  if (!worktreeExists && /^agent-corner-[a-f0-9]{64}\.git$/.test(basename(worktree.gitCommonDir))) {
    if (localExists) await assertLocalBranchPublished(worktree);
    await removeStoragePath(worktree.gitCommonDir);
    return;
  }

  if (worktreeExists) {
    const checkedOut = await execFileAsync(
      'git',
      ['-C', worktree.path, 'symbolic-ref', '--quiet', 'HEAD'],
      { maxBuffer: 4 * 1024 * 1024 },
    ).then(
      (result) => result.stdout.trim(),
      () => undefined,
    );
    if (!worktree.recovered && !/^agent-corner-[a-f0-9]{64}\.git$/.test(basename(worktree.gitCommonDir)) && checkedOut !== localRef) {
      throw new Error(`corner worktree branch mismatch: expected ${localRef}`);
    }
    await assertCornerWorktreePublished(worktree);
    await removeStoragePath(worktree.path);
    if (/^agent-corner-[a-f0-9]{64}\.git$/.test(basename(worktree.gitCommonDir))) {
      await removeStoragePath(worktree.gitCommonDir);
      return; // Private copies never delete another agent's remote branch.
    }
    await execFileAsync('git', [`--git-dir=${worktree.gitCommonDir}`, 'worktree', 'prune', '--expire=now']);
  } else if (!localExists) {
    // Idempotent retry after a successful close: nothing local remains to
    // prove ownership, so the remote ref must already be gone.
    if (preserveRemoteBranch) return;
    await deleteExactRemoteBranch(worktree.gitCommonDir, remoteRef, worktree.token, {
      requireAbsent: true,
    });
    return;
  } else {
    const head = await repositoryHeadRef(worktree.gitCommonDir);
    if (head === localRef) {
      throw new Error(`refusing to delete repository HEAD ${localRef}`);
    }
    await assertLocalBranchPublished(worktree);
  }

  // An open pull request's head branch is recoverable work, not debris. Its
  // worktree still goes; only the remote ref (and the pull request it closes)
  // is preserved. The local ref is deleted in both cases so nothing outlives
  // the worktree that owned it.
  if (!preserveRemoteBranch) {
    await deleteExactRemoteBranch(worktree.gitCommonDir, remoteRef, worktree.token);
  }
  if (await gitRefExists(worktree.gitCommonDir, localRef)) {
    await execFileAsync('git', [
      `--git-dir=${worktree.gitCommonDir}`,
      'branch',
      '--delete',
      '--force',
      '--',
      worktree.branch,
    ]);
  }
}


/**
 * Refuse destructive cleanup while a checkout contains work not known to an
 * origin ref. Ignored build output is intentionally absent from porcelain
 * status; it is the disk waste cleanup is meant to reclaim.
 */
export async function assertCornerWorktreePublished(worktree: CornerWorktree): Promise<void> {
  const status = async () =>
    (
      await execFileAsync(
        'git',
        ['-C', worktree.path, 'status', '--porcelain=v1', '--untracked-files=all'],
        { maxBuffer: 4 * 1024 * 1024 },
      )
    ).stdout.trim();
  const originalHead = (
    await execFileAsync('git', ['-C', worktree.path, 'rev-parse', '--verify', 'HEAD'])
  ).stdout.trim();
  if (await execFileAsync('git', ['-C', worktree.path, 'rev-parse', '--verify', 'refs/stash']).then(() => true, () => false)) throw new Error(`corner ${worktree.cornerId} has unpushed stashed work`);
  if (await status()) throw new Error(`corner ${worktree.cornerId} has unpushed working-tree work`);

  await assertPublishedOnOrigin(worktree.gitCommonDir, originalHead, worktree.cornerId, worktree.token);
  if (/^agent-corner-[a-f0-9]{64}\.git$/.test(basename(worktree.gitCommonDir)) &&
      (await execFileAsync('git', [`--git-dir=${worktree.gitCommonDir}`, 'rev-list', '--branches', '--not', '--remotes=origin'])).stdout.trim())
    throw new Error(`corner ${worktree.cornerId} has unpushed commits`);


  const settledHead = (
    await execFileAsync('git', ['-C', worktree.path, 'rev-parse', '--verify', 'HEAD'])
  ).stdout.trim();
  if (settledHead !== originalHead || (await status())) {
    throw new Error(`corner ${worktree.cornerId} changed during cleanup`);
  }
}


/**
 * Same publish proof as `assertCornerWorktreePublished`, for the folder-gone
 * path where only the local branch ref remains to prove ownership: nothing
 * checks its commits against origin before this is called.
 */
export async function assertLocalBranchPublished(worktree: CornerWorktree): Promise<void> {
  const head = (
    await execFileAsync('git', [
      `--git-dir=${worktree.gitCommonDir}`,
      'rev-parse',
      '--verify',
      `refs/heads/${worktree.branch}`,
    ])
  ).stdout.trim();
  await assertPublishedOnOrigin(worktree.gitCommonDir, head, worktree.cornerId, worktree.token);
}


export async function assertPublishedOnOrigin(
  gitCommonDir: string,
  head: string,
  cornerId: string,
  token: string,
): Promise<void> {
  let published = await originContains(gitCommonDir, head);
  if (!published) {
    await fetchRepositoryCache({
      gitDir: gitCommonDir,
      label: repositoryCacheLabel(gitCommonDir),
      args: ['--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'],
      env: githubGitEnv(token),
    });
    published = await originContains(gitCommonDir, head);
  }
  if (!published) throw new Error(`corner ${cornerId} has unpushed commits`);
}


/** The exact, permanent faults cleanup throws for work nothing will ever push. */
export function hasUnpublishedWork(error: unknown): boolean {
  return error instanceof Error && / has unpushed (?:commits|working-tree work)$/.test(error.message);
}


export async function originContains(gitCommonDir: string, head: string): Promise<boolean> {
  const result = await execFileAsync('git', [
    `--git-dir=${gitCommonDir}`,
    'for-each-ref',
    '--format=%(refname)',
    '--contains',
    head,
    'refs/remotes/origin',
  ]);
  return Boolean(result.stdout.trim());
}


export interface DesiredCorner {
  cornerId: string;
  parentRoomId: string;
  /** The agent that opened it. History and a start rule, never an access check. */
  openedBy?: string;
}


export const execFileAsync = promisify(execFile);


export function githubHttpsRemote(remote: string): string {
  const normalized = remote
    .replace(/^git:\/\/github\.com\//i, 'https://github.com/')
    .replace(/^git@github\.com:/i, 'https://github.com/');
  const url = new URL(normalized);
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
    throw new Error('corner repository must be a GitHub HTTPS identity');
  }
  url.username = '';
  url.password = '';
  return (
    url
      .toString()
      .replace(/\/$/, '')
      .replace(/\.git$/i, '') + '.git'
  );
}


/** Repository remotes are server-stamped; local file remotes support isolated proofs. */
export function roomCheckoutRemote(remote: string): string {
  if (remote.startsWith('file://')) return remote;
  return githubHttpsRemote(remote);
}


export function githubGitEnv(token: string): NodeJS.ProcessEnv {
  const authorization = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`,
    GIT_TERMINAL_PROMPT: '0',
  };
}


export async function gitRefExists(gitCommonDir: string, ref: string): Promise<boolean> {
  try {
    await execFileAsync('git', [
      `--git-dir=${gitCommonDir}`,
      'show-ref',
      '--verify',
      '--quiet',
      ref,
    ]);
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === 1) return false;
    throw error;
  }
}


export async function repositoryHeadRef(gitCommonDir: string): Promise<string | undefined> {
  try {
    const head = await execFileAsync('git', [
      `--git-dir=${gitCommonDir}`,
      'symbolic-ref',
      '--quiet',
      'HEAD',
    ]);
    return head.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}


export function gitStderr(error: unknown): string {
  return typeof error === 'object' && error && 'stderr' in error
    ? String((error as { stderr?: unknown }).stderr ?? '')
    : '';
}


export function isRemoteRefMissing(error: unknown): boolean {
  return /remote ref does not exist|remote reference does not exist|couldn't find remote ref/i.test(
    `${error instanceof Error ? error.message : String(error)}\n${gitStderr(error)}`,
  );
}


export async function deleteExactRemoteBranch(
  gitCommonDir: string,
  remoteRef: string,
  token: string,
  options: { requireAbsent?: boolean } = {},
): Promise<void> {
  const authEnv = githubGitEnv(token);
  const listRemote = () =>
    execFileAsync(
      'git',
      [`--git-dir=${gitCommonDir}`, 'ls-remote', '--heads', 'origin', remoteRef],
      {
        env: authEnv,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  if (options.requireAbsent) {
    const remote = await listRemote();
    if (remote.stdout.trim()) {
      throw new Error(
        `cannot delete ${remoteRef} without the local ref that proves this corner owns it`,
      );
    }
    return;
  }
  let remoteError: unknown;
  for (let attempt = 1; attempt <= CORNER_BRANCH_DELETE_ATTEMPTS; attempt += 1) {
    try {
      const remote = await listRemote();
      if (remote.stdout.trim()) {
        await execFileAsync(
          'git',
          [`--git-dir=${gitCommonDir}`, 'push', 'origin', `:${remoteRef}`],
          {
            env: authEnv,
            maxBuffer: 4 * 1024 * 1024,
          },
        );
      }
      return;
    } catch (error) {
      if (isRemoteRefMissing(error)) return;
      remoteError = error;
    }
  }
  throw remoteError;
}
