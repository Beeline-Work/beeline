import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { DaemonApiError } from './daemon-api-client.js';
import { redactReplayError, type RoomGitHubTokenResult, type RoomRepositoryStateResult } from '@beeline/api-contract/daemon';
import { MonolithCornerTurnLoop } from './monolith-corner-turn.js';
import { cornerHasRepositoryWork } from './prompt-assembly.js';
import { distillTurnFailureReason } from './turn-failure-reason.js';
import { writePrivateFileAtomically } from './atomic-private-file.js';
import { rememberStorageOwner, readStorageOwners } from './storage-owners.js';
import { isStandingRuntimeFault } from './runtime-start-fault.js';
import { agentCornerCheckoutPaths } from './agent-corner-checkout.js';
import { AgentProcesses } from './agent-process.js';
import { RoomRuntimeCoordinator, roomCheckoutRemote, execFileAsync, DesiredCorner, cornerStartConfigKey, materializeCornerWorktree, shouldPostInitialCornerWorkingState, CornerCredentialLookupError, isStandingCornerStartFault, localCornerWorktreeIds } from './room-runtime.js';



  export async function roomRuntimeCoordinatorRefreshRoomCheckout(ctx: RoomRuntimeCoordinator,
    roomId: string,
  ): Promise<{ cwd: string; branch?: string; commit?: string; githubToken?: string }> {
    try {
      const repository = await ctx.parentRepositoryState(roomId);
      if (repository.resolution !== 'repository' || !repository.remote)
        return { cwd: ctx.roomRoot(roomId) };
      const branch = repository.targetBranch || 'main';
      const cwd = await ctx.materializeRoomCheckout(roomId, repository);
      const githubToken = roomCheckoutRemote(repository.remote).startsWith('https://github.com/')
        ? (await ctx.parentRepositoryToken(roomId)).token
        : undefined;
      if (cwd === ctx.roomRoot(roomId)) return { cwd, ...(githubToken ? { githubToken } : {}) };
      const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--verify', 'HEAD']);
      return { cwd, branch, commit: stdout.trim(), ...(githubToken ? { githubToken } : {}) };
    } catch (error) {
      console.warn(`[thin-core] Room ${roomId} checkout refresh unavailable:`, error);
      return { cwd: ctx.roomRoot(roomId) };
    }
  }


  export async function roomRuntimeCoordinatorStartCorner(ctx: RoomRuntimeCoordinator, corner: DesiredCorner): Promise<void> {
    if (ctx.stopped) return;
    if (ctx.running.has(corner.cornerId) || ctx.startingCorners.has(corner.cornerId)) return;
    if (AgentProcesses.hostStoragePaused || AgentProcesses.roomStoragePaused(corner.cornerId) || ctx.storageMaintenanceRooms.has(corner.cornerId)) {
      ctx.storageDeferredStarts.add(corner.cornerId);
      return;
    }
    if (ctx.standingRuntimeStartFaults.has(corner.cornerId)) return;
    ctx.surfaceHealth.discover(corner.cornerId, 'corner');
    ctx.startingCorners.add(corner.cornerId);
    let configKey: string | undefined;
    try {
      if (ctx.stopped) return;
      const [restore, repository] = await Promise.all([
        ctx.options.daemonApi.execute('getCornerRestoreState', { cornerId: corner.cornerId }),
        ctx.parentRepositoryState(corner.parentRoomId),
      ]);
      const objective =
        (restore.objective ?? '').trim() ||
        (restore.kind === 'human' ? (restore.title ?? '').trim() : '');
      configKey = cornerStartConfigKey(repository, objective);
      const previousStanding = ctx.standingCornerStartFaults.get(corner.cornerId);
      if (previousStanding?.configKey === configKey) {
        // Not retried, but a request made since is still told why.
        await ctx.reportCornerStartFailure(corner.cornerId, previousStanding.error);
        return;
      }
      if (previousStanding) {
        ctx.standingCornerStartFaults.delete(corner.cornerId);
      }
      if (repository.resolution === 'unverified') {
        throw new Error('corner parent Room repository state is not verified yet');
      }
      if (repository.resolution === 'repository' && (!repository.remote || !repository.key)) {
        throw new Error('corner parent Room has an incomplete repository binding');
      }
      // A human-opened corner may carry no objective at all: its first turn
      // writes the brief from the human's request.
      if (!objective && restore.kind !== 'human')
        throw new Error('corner has no authoritative objective fact');
      // A corner is a code corner exactly when its parent Room has a
      // repository; any other corner works in a scratch workspace.
      const repositoryBacked = repository.resolution === 'repository';
      const targetBranch = repositoryBacked ? repository.targetBranch || 'main' : undefined;
      const featureBranch = repositoryBacked
        ? (restore.featureBranch ??
          `feature/corner-${corner.cornerId.replaceAll('-', '').slice(0, 12)}`)
        : undefined;
      const granted = repositoryBacked
        ? await ctx.cornerRepositoryToken(corner.parentRoomId)
        : undefined;
      let worktree: { path: string; gitCommonDir: string } | undefined;
      let readCheckout: { path: string; gitCommonDir: string } | undefined;
      const ownCheckout = repositoryBacked
        ? agentCornerCheckoutPaths(ctx.runtime.supervisorRoot, corner.cornerId, ctx.agent.publicKey)
        : undefined;
      // Only a writer gets a private copy: the implementer, an agent given
      // work here, or one that already holds a copy with its own edits. Other
      // turns read the Room's checkout and never clone.
      const prepareCheckout = async (repositoryWork: boolean, implementerAgentId = restore.implementerAgentId, assigned = false) => {
        const writable = repositoryWork && (assigned || !implementerAgentId ||
          implementerAgentId === ctx.agent.publicKey || existsSync(resolve(ownCheckout!.path, '.git')));
        if (!writable) {
          if (!readCheckout) {
            const path = await ctx.materializeRoomCheckout(corner.parentRoomId, repository);
            const common = (await execFileAsync('git', ['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim();
            readCheckout = { path, gitCommonDir: common };
          }
          return { ...readCheckout, writable };
        }
        if (!worktree || !existsSync(resolve(worktree.path, '.git'))) {
          worktree = await ctx.materializeCornerWorktree({
            cornerId: corner.cornerId, remote: repository.remote!, targetBranch: targetBranch!,
            featureBranch: featureBranch!, token: granted!.token,
            migrateLegacy: implementerAgentId === ctx.agent.publicKey,
          });
          await rememberStorageOwner(ctx.runtime.supervisorRoot, { workspaceId: ctx.runtime.communityId,
            roomId: corner.cornerId, kind: 'corners', itemId: basename(worktree.path), agentId: ctx.agent.publicKey, ended: false });
          const running = ctx.running.get(corner.cornerId);
          if (running) running.worktree = { ...worktree, cornerId: corner.cornerId,
            branch: featureBranch!, parentRoomId: corner.parentRoomId, token: '' };
        }
        return { ...worktree, writable };
      };
      const repositoryReadOnly = Boolean(restore.brief) && !cornerHasRepositoryWork(restore.brief);
      const checkout = repositoryBacked ? await prepareCheckout(!repositoryReadOnly) : undefined;
      const activatedReadOnly = checkout ? !checkout.writable : repositoryReadOnly;
      const workspacePath = checkout?.path ?? resolve(ctx.roomRoot(corner.cornerId), 'scratch');
      if (!checkout) await mkdir(workspacePath, { recursive: true, mode: 0o700 });
      await writePrivateFileAtomically(
        resolve(ctx.roomRoot(corner.cornerId), '.beeline-corner.json'),
        `${JSON.stringify({ cornerId: corner.cornerId, parentRoomId: corner.parentRoomId })}\n`,
      );
      if (worktree && shouldPostInitialCornerWorkingState(restore)) {
        await ctx.options.daemonApi.execute('postCornerRemoteState', {
          cornerId: corner.cornerId,
          branch: featureBranch!,
          state: 'working',
          checks: 'unknown',
        });
      }
      const controller = new AbortController();
      const grantRunnerEndpoint = await ctx.grantRunnerEndpoint();
      const loop = new MonolithCornerTurnLoop({
        cornerId: corner.cornerId,
        grantRunner: ctx.grantRunner,
        ...(grantRunnerEndpoint ? { grantRunnerEndpoint } : {}),
        connectorUsage: ctx.connectorUsage,
        parentRoomId: corner.parentRoomId,
        workspaceId: ctx.runtime.communityId,
        ...(corner.openedBy ? { openedBy: corner.openedBy } : {}),
        objective,
        worktreePath: workspacePath,
        ...(checkout
          ? {
              prepareCheckout,
              repository: {
                featureBranch: featureBranch!,
                targetBranch: targetBranch!,
                gitCommonDir: checkout.gitCommonDir,
                readOnly: activatedReadOnly,
                githubToken: granted!.token,
              },
            }
          : {}),
        runtime: ctx.runtime,
        config: ctx.roomConfig(corner.cornerId, repositoryBacked ? undefined : workspacePath),
        api: ctx.options.daemonApi,
        scheduler: ctx.scheduler,
        signal: controller.signal,
        onPoll: () => ctx.notePoll(corner.cornerId),
        onSubscriptionState: (connected) => ctx.surfaceHealth.subscribed(corner.cornerId, connected),
        onIntakeError: () => ctx.surfaceHealth.degraded(corner.cornerId, 'corner command intake failed'),
        onCloseRequested: () =>
          worktree
            ? ctx.reapCornerWorktree({
                ...worktree,
                cornerId: corner.cornerId,
                branch: featureBranch!,
                parentRoomId: corner.parentRoomId,
                token: '',
              })
            : repositoryBacked ? ctx.cleanupArchivedCornerLocalState(corner.cornerId).then(() => undefined) : ctx.reapCornerScratch({ path: workspacePath, cornerId: corner.cornerId }),
        onRestartRequested: () => ctx.stopAgentProcesses(),
        canStartTurn: () => !ctx.restartRequested && !AgentProcesses.hostStoragePaused &&
          !AgentProcesses.roomStoragePaused(corner.cornerId) && !ctx.storageMaintenanceRooms.has(corner.cornerId),
        supervisor: ctx.supervisor,
      });
      const promise = loop
        .run()
        .catch((error) => {
          if (!controller.signal.aborted) {
            ctx.surfaceHealth.degraded(corner.cornerId, 'corner command loop exited');
            console.error(`[thin-core] corner ${corner.cornerId} failed:`, error);
          }
        })
        .finally(async () => {
          if (ctx.running.get(corner.cornerId)?.body === loop) {
            ctx.running.delete(corner.cornerId);
          }
          await ctx.cleanupArchivedCornerLocalState(corner.cornerId).catch((error) =>
            console.error(`[thin-core] corner ${corner.cornerId} local cleanup deferred:`, error),
          );
        });
      if (ctx.stopped) {
        controller.abort();
        await promise;
        return;
      }
      ctx.running.set(corner.cornerId, {
        body: loop,
        controller,
        promise,
        ...(worktree
          ? {
              worktree: {
                ...worktree,
                cornerId: corner.cornerId,
                branch: featureBranch!,
                parentRoomId: corner.parentRoomId,
                token: '',
              },
            }
          : {}),
        ...(!repositoryBacked ? { scratch: { path: workspacePath, cornerId: corner.cornerId } } : {}),
      });
      ctx.standingCornerStartFaults.delete(corner.cornerId);
      console.log(
        worktree
          ? `[thin-core] serving corner ${corner.cornerId} on ${featureBranch} at ${workspacePath}`
          : repositoryBacked
            ? `[thin-core] serving corner ${corner.cornerId} read-only at ${workspacePath}`
            : `[thin-core] serving repo-less corner ${corner.cornerId} at ${workspacePath}`,
      );
    } catch (error) {
      ctx.surfaceHealth.degraded(corner.cornerId, 'corner failed to start');
      console.error(`[thin-core] failed to start corner ${corner.cornerId}:`, error);
      // Keep the pending command available for the next reconciliation. A
      // temporary token lookup must not turn into a human repair request.
      if (error instanceof CornerCredentialLookupError) return;
      if (isStandingRuntimeFault(error) || error instanceof DaemonApiError && !error.retryable && [401,403].includes(error.status))
        ctx.standingRuntimeStartFaults.add(corner.cornerId);
      const reported = await ctx.reportCornerStartFailure(corner.cornerId, error);
      if (reported && isStandingCornerStartFault(error) && configKey) {
        ctx.standingCornerStartFaults.set(corner.cornerId, { configKey, error });
      }
    } finally {
      ctx.startingCorners.delete(corner.cornerId);
    }
  }


  export async function roomRuntimeCoordinatorWatchCorner(ctx: RoomRuntimeCoordinator, corner: DesiredCorner): Promise<void> {
    if (ctx.stopped) return;
    const cornerId = corner.cornerId;
    if (ctx.running.has(cornerId)) return;
    if (ctx.idleCornerSubscriptions.has(cornerId)) {
      if (ctx.pendingCornerCommands.has(cornerId)) void ctx.activateWatchedCorner(corner);
      return;
    }
    if (!ctx.options.daemonApi.liveSubscribe) {
      await ctx.startCorner(corner);
      return;
    }
    ctx.idleCornerSubscriptions.set(cornerId, () => undefined);
    const release = ctx.options.daemonApi.liveSubscribe(
      cornerId,
      undefined,
      undefined,
      (connected, capabilities) => {
        if (connected && capabilities?.pushIntake !== true) {
          // A rolling old server cannot deliver command snapshots; retain
          // the pre-lazy startup path until it can.
          ctx.pendingCornerCommands.add(cornerId);
          void ctx.activateWatchedCorner(corner);
        }
      },
      undefined,
      (commands) => {
        if (!commands.length) return;
        ctx.pendingCornerCommands.add(cornerId);
        void ctx.activateWatchedCorner(corner);
      },
    );
    ctx.idleCornerSubscriptions.set(cornerId, release);
    // Migration can copy a large legacy tree. Intake for every other Room and
    // the local watchdog must remain available while this bounded start runs.
    if (ctx.pendingCornerCommands.has(cornerId)) void ctx.activateWatchedCorner(corner);
  }


  export function roomRuntimeCoordinatorUnwatchCorner(ctx: RoomRuntimeCoordinator, cornerId: string): void {
    ctx.idleCornerSubscriptions.get(cornerId)?.();
    ctx.idleCornerSubscriptions.delete(cornerId);
    ctx.pendingCornerCommands.delete(cornerId);
  }


  export async function roomRuntimeCoordinatorActivateWatchedCorner(ctx: RoomRuntimeCoordinator, corner: DesiredCorner): Promise<void> {
    if (ctx.stopped || !ctx.idleCornerSubscriptions.has(corner.cornerId)) return;
    await ctx.startCorner(corner);
    if (ctx.running.has(corner.cornerId)) {
      ctx.unwatchCorner(corner.cornerId);
    }
  }


  export async function roomRuntimeCoordinatorCornerRepositoryToken(ctx: RoomRuntimeCoordinator,
    roomId: string,
  ): Promise<{ token: string; expiresAt: number }> {
    try {
      return await ctx.parentRepositoryToken(roomId);
    } catch (error) {
      if (error instanceof DaemonApiError && !error.retryable) throw error;
      throw new CornerCredentialLookupError(error);
    }
  }


  export function roomRuntimeCoordinatorInvalidateParentRepository(ctx: RoomRuntimeCoordinator, roomId: string): void {
    ctx.repositoryStateCache.delete(roomId);
    ctx.repositoryStateFlights.delete(roomId);
    ctx.tokenCache.delete(roomId);
    ctx.tokenFlights.delete(roomId);
  }


  /**
   * A repository-change event names its own Room, so only that Room's
   * corners need a fresh listing; re-listing every Room's corners for one
   * Room's push would repeat that read for every other Room on each push.
   * Only new or newly-unarchived corners are started here - removals and
   * archived-corner cleanup stay on the regular reconcile pass. The named
   * Room itself is restarted the same way a full reconcile would, so a
   * running Room picks up the change (a new GitHub installation, a token) too.
   */
  export async function roomRuntimeCoordinatorRefreshRoomCorners(ctx: RoomRuntimeCoordinator, roomId: string): Promise<void> {
    if (ctx.stopped) return;
    try {
      await ctx.restartRunningRoomForRepositoryChange(roomId);
      if (ctx.stopped) return;
      const result = await ctx.options.daemonApi.execute('listRoomCorners', { roomId, activeOnly: true });
      for (const corner of result.corners) {
        ctx.monolithCornerParents.set(corner.cornerId, corner.parentRoomId);
        if (corner.archived) continue;
        ctx.surfaceHealth.discover(corner.cornerId, 'corner');
        ctx.roomRemovalConfirmations.delete(corner.cornerId);
        if (AgentProcesses.hostStoragePaused || AgentProcesses.roomStoragePaused(corner.cornerId) || ctx.running.has(corner.cornerId) || ctx.startingCorners.has(corner.cornerId)) continue;
        await ctx.watchCorner({
          cornerId: corner.cornerId,
          parentRoomId: corner.parentRoomId,
          ...(corner.createdBy ? { openedBy: corner.createdBy } : {}),
        });
      }
    } catch (error) {
      console.error(`[thin-core] scoped corner refresh failed for Room ${roomId}:`, error);
    }
  }


  /**
   * Same stop/restart (or, mid-turn, defer-to-`notePoll`) a full reconcile
   * applies to a Room whose `repositoryRevision` changed, for the one Room a
   * live repository-change event names. A no-op when that id names nothing
   * currently running - e.g. a Room whose corners changed but is not itself
   * being served, or a corner id, which this event never actually names.
   */
  export async function roomRuntimeCoordinatorRestartRunningRoomForRepositoryChange(ctx: RoomRuntimeCoordinator, roomId: string): Promise<void> {
    const running = ctx.running.get(roomId);
    if (!running) return;
    if (running.body.isBusy()) {
      ctx.deferredRepositoryRestarts.add(roomId);
      return;
    }
    await ctx.stopRunning(roomId, running);
    if (!ctx.stopped) await ctx.startRoom(roomId);
  }


  export async function roomRuntimeCoordinatorParentRepositoryState(ctx: RoomRuntimeCoordinator, roomId: string): Promise<RoomRepositoryStateResult> {
    const cached = ctx.repositoryStateCache.get(roomId);
    if (cached && cached.until > ctx.now()) return cached.value;
    const existing = ctx.repositoryStateFlights.get(roomId);
    if (existing) return existing;
    const flight = ctx.options.daemonApi.execute('getRoomRepositoryState', { roomId });
    ctx.repositoryStateFlights.set(roomId, flight);
    try {
      const value = await flight;
      if (ctx.repositoryStateFlights.get(roomId) === flight)
        ctx.repositoryStateCache.set(roomId, { value, until: ctx.now() + 5_000 });
      return value;
    } finally {
      if (ctx.repositoryStateFlights.get(roomId) === flight)
        ctx.repositoryStateFlights.delete(roomId);
    }
  }


  export async function roomRuntimeCoordinatorParentRepositoryToken(ctx: RoomRuntimeCoordinator, roomId: string): Promise<RoomGitHubTokenResult> {
    const cached = ctx.tokenCache.get(roomId);
    if (cached && cached.expiresAt - 10_000 > ctx.now()) return cached;
    const existing = ctx.tokenFlights.get(roomId);
    if (existing) return existing;
    const flight = ctx.options.daemonApi.execute('getRoomGitHubToken', { roomId });
    ctx.tokenFlights.set(roomId, flight);
    try {
      const value = await flight;
      if (ctx.tokenFlights.get(roomId) === flight && value.expiresAt - 10_000 > ctx.now())
        ctx.tokenCache.set(roomId, value);
      return value;
    } finally {
      if (ctx.tokenFlights.get(roomId) === flight) ctx.tokenFlights.delete(roomId);
    }
  }


  /** A real startup failure is a result of an owned command, never an
   * unclaimed receipt. Terminal commands disappear from the pending queue. */
  export async function roomRuntimeCoordinatorReportCornerStartFailure(ctx: RoomRuntimeCoordinator, cornerId: string, error: unknown): Promise<boolean> {
    const api = ctx.options.daemonApi;
    const generationId = randomUUID();
    let claimed = false;
    try {
      const pending = (await api.execute('getAgentCommands', {roomId:cornerId})).commands
        .find(command => command.action === 'input' || command.action === 'resume');
      if (!pending) return false;
      const result = await api.execute('claimAgentTurn', {
        roomId:cornerId,commandId:pending.id,generationId,
      });
      claimed = true;
      const diagnostic = error && typeof error === 'object' && 'stderr' in error &&
        typeof error.stderr === 'string' && error.stderr.trim() ? error.stderr : error;
      const reason = distillTurnFailureReason(diagnostic);
      for (const command of result.commands) await api.execute('postAgentTurnReceipt', {
        agentId:ctx.agent.publicKey,roomId:cornerId,requestId:command.turnRequestId,generationId,
        status:'failed',reason:reason.text,reasonKind:'workspace-failure',
        trace:{totalMs:0,attempts:[],reason:redactReplayError(reason.text),reasonKind:'workspace-failure'},
      });
      return true;
    } catch (reportError) {
      console.error(`[thin-core] corner ${cornerId} start-failure report failed:`, reportError);
      return false;
    } finally {
      if (claimed) await api.execute('releaseAgentTurn', {roomId:cornerId,generationId})
        .catch(reportError => console.error(`[thin-core] corner ${cornerId} claim release failed:`,reportError));
    }
  }


  export async function roomRuntimeCoordinatorMaterializeCornerWorktree(ctx: RoomRuntimeCoordinator, input: {
    cornerId: string;
    remote: string;
    targetBranch: string;
    featureBranch: string;
    token: string;
    migrateLegacy?: boolean;
  }): Promise<{ path: string; gitCommonDir: string }> {
    const worktree = await materializeCornerWorktree({
      ...input,
      supervisorRoot: ctx.runtime.supervisorRoot,
      workspaceId: ctx.runtime.communityId,
      committer: { name: ctx.agent.name, publicKey: ctx.agent.publicKey },
    });
    (await ctx.getLocalWorktreeIds()).add(input.cornerId);
    return worktree;
  }


  export function roomRuntimeCoordinatorGetLocalWorktreeIds(ctx: RoomRuntimeCoordinator): Promise<Set<string>> {
    return (ctx.localWorktreeIds ??= Promise.all([
      localCornerWorktreeIds(ctx.runtime.supervisorRoot), readStorageOwners(ctx.runtime.supervisorRoot),
    ]).then(([ids, owners]) => new Set([
      ...[...ids].filter(id => !/^[a-f0-9]{64}$/.test(id)),
      ...owners.filter(owner => owner.kind === 'corners' && owner.agentId === ctx.agent.publicKey).map(owner => owner.roomId),
    ])));
  }


  export function roomRuntimeCoordinatorArchiveCleanupRefusalPath(ctx: RoomRuntimeCoordinator, cornerId: string): string {
    return resolve(dirname(ctx.configPath), 'corner-cleanup-refusals',
      `${createHash('sha256').update(cornerId).digest('hex')}.json`);
  }


  export async function roomRuntimeCoordinatorCleanupWasRefused(ctx: RoomRuntimeCoordinator, cornerId: string): Promise<boolean> {
    if (ctx.archiveCleanupRefused.has(cornerId)) return true;
    if (await lstat(ctx.archiveCleanupRefusalPath(cornerId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    })) {
      ctx.archiveCleanupRefused.add(cornerId);
      return true;
    }
    return false;
  }


  export async function roomRuntimeCoordinatorRefuseArchiveCleanup(ctx: RoomRuntimeCoordinator,
    cornerId: string,
    error: DaemonApiError,
  ): Promise<void> {
    ctx.archiveCleanupRefused.add(cornerId);
    await writePrivateFileAtomically(ctx.archiveCleanupRefusalPath(cornerId),
      `${JSON.stringify({ cornerId, status: error.status, code: error.code })}\n`);
    console.warn(`[thin-core] corner ${cornerId} cleanup refused; local work kept`);
  }
