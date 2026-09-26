import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { BodyConfig } from './config.js';
import {
  DaemonApiError,
  type DaemonApiClient,
  type RoomMembershipChange,
} from './daemon-api-client.js';
import {
  isStandingWorkspaceConfigurationFault,
  type CornerRestoreResult,
  type RoomRepositoryStateResult,
} from '@beeline/api-contract/daemon';
import { GrantCommandRunner, GrantRunnerServer, type GrantRunnerEndpoint } from './grant-runner.js';
import { loadManualGoogleCredentials } from './connector-google.js';
import { ConnectorUsageRecorder } from './connector-runner.js';
import { MonolithCornerTurnLoop } from './monolith-corner-turn.js';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import { openRouterRoutingCacheDir } from './openrouter-routing.js';
import { turnTraceDirectory } from './turn-trace.js';
import { distillTurnFailureReason } from './turn-failure-reason.js';
import type { AgentRuntimeRecord, RoomRuntimeRecord } from './runtime.js';
import { runtimeIdentity } from './runtime.js';
import { seedWarmNodeModules, warmNodeModulesStoreDir } from './warm-node-modules.js';
import {
  DEFAULT_WORKSPACE_LIVE_SESSIONS_FLOOR,
  resolveMaxWarmSessions,
  resolvePerRoomLiveSessions,
  resolveSessionIdleMs,
  SessionScheduler,
  type SessionSchedulerSnapshot,
} from './session-scheduler.js';

export type WorkspaceMembershipStatus = 'member' | 'not-member' | 'unknown';
export const REMOVAL_CONFIRMATION_READS = 2;
export const ROOM_JOIN_CONCURRENCY = 4;
export const DEFAULT_ROOM_WATCHDOG_STALE_MS = 90_000;
export const DEFAULT_RECONCILE_HEARTBEAT_MS = 10 * 60_000;
export const DEFAULT_DRAIN_DEADLINE_MS = 30 * 60_000;
export const CORNER_BRANCH_DELETE_ATTEMPTS = 3;

class CornerCredentialLookupError extends Error {
  constructor(cause: unknown) {
    super('corner repository credential lookup failed', { cause });
  }
}

/**
 * The #1369 discovery latch, counted instead of flagged.
 *
 * The unscoped agent-directed `rooms-changed` wake (reconnect, or a membership
 * change that named no Room) re-arms fast reconcile. A scoped membership
 * event applies incrementally and does not use this latch. A boolean cleared
 * unconditionally by the next reconcile swallowed any wake that landed while
 * that reconcile was already running — a reconnect mid-reconcile then waited
 * a heartbeat for a wake the daemon had already received. A reconcile covers
 * exactly the wakes that arrived before it started (its reads happen after
 * that point); anything landing during it re-arms. A reconcile that THROWS
 * covers nothing, so a failed discovery keeps retrying fast.
 */
export class DiscoveryWakes {
  private arrived = 0;
  private served = 0;

  /** Called for every agent-directed `rooms-changed` wake. */
  wake(): void {
    this.arrived += 1;
  }

  needsFastReconcile(): boolean {
    return this.arrived !== this.served;
  }

  /** Snapshot at reconcile entry: the wake count its reads will cover. */
  beginReconcile(): number {
    return this.arrived;
  }

  /** Clear only wakes the completed start pass actually served. */
  completeReconcile(covered: number): void {
    this.served = Math.max(this.served, covered);
  }
}

/**
 * A restarted helper must not overwrite the server's GitHub-owned corner facts,
 * and a helper joining a corner it did not open never announces the opening
 * state at all — the lifecycle facts belong to the corner, and they already
 * exist by the time a second agent is addressed in it.
 */
export function shouldPostInitialCornerWorkingState(
  restore: CornerRestoreResult,
  isOpener = true,
): boolean {
  return isOpener && !restore.featureBranch && !restore.lifecycle?.branch && !restore.lifecycle?.pr;
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
  committer: { name: string; publicKey: string };
}): Promise<{ path: string; gitCommonDir: string }> {
  // Same normalization the Room checkout uses: every real remote is held to
  // the GitHub HTTPS identity, and a `file://` remote stays usable so the
  // shared-branch behaviour can be proved against a real git remote.
  const remote = roomCheckoutRemote(input.remote);
  const gitCommonDir = cornerRepositoryCacheDir(input.supervisorRoot, remote);
  const path = resolve(input.supervisorRoot, 'beeline', 'corners', input.cornerId);
  await mkdir(dirname(gitCommonDir), { recursive: true, mode: 0o700 });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const authEnv = githubGitEnv(input.token);
  if (!existsSync(resolve(gitCommonDir, 'HEAD'))) {
    await execFileAsync('git', ['clone', '--bare', remote, gitCommonDir], {
      env: authEnv,
      maxBuffer: 4 * 1024 * 1024,
    });
  }
  await execFileAsync(
    'git',
    [
      `--git-dir=${gitCommonDir}`,
      'fetch',
      '--prune',
      'origin',
      `+refs/heads/${input.targetBranch}:refs/remotes/origin/${input.targetBranch}`,
    ],
    { env: authEnv, maxBuffer: 4 * 1024 * 1024 },
  );
  const restored = await execFileAsync(
    'git',
    [
      `--git-dir=${gitCommonDir}`,
      'fetch',
      'origin',
      `+refs/heads/${input.featureBranch}:refs/remotes/origin/${input.featureBranch}`,
    ],
    { env: authEnv, maxBuffer: 4 * 1024 * 1024 },
  ).then(
    () => true,
    (error) => {
      if (isRemoteRefMissing(error)) return false;
      throw error;
    },
  );
  if (!existsSync(resolve(path, '.git'))) {
    await rm(path, { recursive: true, force: true });
    await execFileAsync(
      'git',
      [
        `--git-dir=${gitCommonDir}`,
        'worktree',
        'add',
        '-B',
        input.featureBranch,
        path,
        restored
          ? `refs/remotes/origin/${input.featureBranch}`
          : `refs/remotes/origin/${input.targetBranch}`,
      ],
      { env: authEnv, maxBuffer: 4 * 1024 * 1024 },
    );
    // A worktree cut from a bare clone has no `node_modules`, so this is the
    // one moment a warm tree can be hardlinked in before anything reads it.
    // Never fatal: a cold store just means the corner installs as before.
    const seed = await seedWarmNodeModules({
      worktreePath: path,
      storeRoot: warmNodeModulesStoreDir(input.supervisorRoot),
    });
    if (seed.reason !== 'no-lockfile') {
      console.log(
        `[thin-core] corner ${input.cornerId} warm node_modules: ${seed.reason}${
          seed.detail ? ` (${seed.detail})` : ''
        }`,
      );
    }
  }
  await execFileAsync('git', [
    `--git-dir=${gitCommonDir}`,
    'config',
    'extensions.worktreeConfig',
    'true',
  ]);
  // A linked worktree created from a bare canonical clone otherwise inherits
  // core.bare=true and rejects ordinary `git -C <worktree>` commands.
  await execFileAsync('git', ['-C', path, 'config', '--worktree', 'core.bare', 'false']);
  await execFileAsync('git', [
    '-C',
    path,
    'config',
    '--worktree',
    'credential.https://github.com.helper',
    '!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f',
  ]);
  await execFileAsync('git', [
    '-C',
    path,
    'config',
    '--worktree',
    'user.name',
    input.committer.name,
  ]);
  await execFileAsync('git', [
    '-C',
    path,
    'config',
    '--worktree',
    'user.email',
    `${input.committer.publicKey.slice(0, 16)}@users.noreply.github.com`,
  ]);
  const top = await execFileAsync('git', ['-C', path, 'rev-parse', '--show-toplevel']);
  if (resolve(top.stdout.trim()) !== resolve(path)) {
    throw new Error(`corner worktree escaped its isolated root: ${top.stdout.trim()}`);
  }
  return { path, gitCommonDir };
}

export function reconcileRetryMs(error: unknown, pollMs: number): number {
  const match = String(error).match(/retry in\s+(\d+)s/i);
  return match ? Math.max(pollMs, (Number(match[1]) + 1) * 1_000) : pollMs;
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

type RoomLeaf = Pick<
  MonolithRoomTurnLoop | MonolithCornerTurnLoop,
  | 'isBusy'
  | 'prepareForForcedUpdateRestart'
  | 'requestReconciliation'
  | 'refreshPersonaForSoulUpdate'
  | 'forceRecoverRoom'
> & {
  requestClose?(): void;
};

interface RunningRoom {
  body: RoomLeaf;
  controller: AbortController;
  promise: Promise<void>;
  lastPollAt: number;
  backoffUntil: number;
  recovering: boolean;
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

/**
 * Recover a linked corner checkout left by an older daemon process.
 *
 * Both the corner path and the common git directory are held to the two roots
 * Body itself owns. A repository-controlled `.git` file must never turn a
 * stale-copy sweep into deletion outside the supervisor state directory.
 */
export async function discoverCornerWorktree(
  supervisorRoot: string,
  cornerId: string,
): Promise<DiscoveredCornerWorktree | undefined> {
  const cornersRoot = resolve(supervisorRoot, 'beeline', 'corners');
  const path = resolve(cornersRoot, cornerId);
  if (dirname(path) !== cornersRoot || !existsSync(resolve(path, '.git'))) return undefined;
  const [canonicalRoot, canonicalPath] = await Promise.all([
    realpath(cornersRoot),
    realpath(path).catch(() => undefined),
  ]);
  if (!canonicalPath || relative(canonicalRoot, canonicalPath) !== cornerId) {
    throw new Error(`refusing corner ${cornerId} whose checkout path is not canonical`);
  }
  const common = await execFileAsync('git', ['-C', path, 'rev-parse', '--git-common-dir']).catch(
    () => undefined,
  );
  if (!common) return undefined;
  const gitCommonDir = resolve(path, common.stdout.trim());
  const repositoriesRoot = resolve(supervisorRoot, 'beeline', 'repositories');
  const commonRelative = relative(repositoriesRoot, gitCommonDir);
  if (
    !commonRelative ||
    commonRelative === '..' ||
    commonRelative.startsWith(`..${sep}`) ||
    commonRelative.startsWith(sep)
  ) {
    throw new Error(`refusing corner ${cornerId} with git directory outside repository cache`);
  }
  return { path, gitCommonDir };
}

interface CornerScratch {
  path: string;
  cornerId: string;
}

export async function removeCornerWorktreeAndBranches(
  worktree: CornerWorktree,
  options: { preserveRemoteBranch?: boolean } = {},
): Promise<void> {
  const preserveRemoteBranch = options.preserveRemoteBranch === true;
  const localRef = `refs/heads/${worktree.branch}`;
  const remoteRef = `refs/heads/${worktree.branch}`;
  const worktreeExists = existsSync(worktree.path);
  const localExists = await gitRefExists(worktree.gitCommonDir, localRef);

  if (worktreeExists) {
    const checkedOut = await execFileAsync(
      'git',
      ['-C', worktree.path, 'symbolic-ref', '--quiet', 'HEAD'],
      { maxBuffer: 4 * 1024 * 1024 },
    ).then(
      (result) => result.stdout.trim(),
      () => undefined,
    );
    if (!worktree.recovered && checkedOut !== localRef) {
      throw new Error(`corner worktree branch mismatch: expected ${localRef}`);
    }
    await assertCornerWorktreePublished(worktree);
    await execFileAsync('git', [
      `--git-dir=${worktree.gitCommonDir}`,
      'worktree',
      'remove',
      '--force',
      worktree.path,
    ]);
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
async function assertCornerWorktreePublished(worktree: CornerWorktree): Promise<void> {
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
  if (await status()) throw new Error(`corner ${worktree.cornerId} has unpushed working-tree work`);

  let published = await originContains(worktree.gitCommonDir, originalHead);
  if (!published) {
    await execFileAsync(
      'git',
      [
        `--git-dir=${worktree.gitCommonDir}`,
        'fetch',
        '--prune',
        'origin',
        '+refs/heads/*:refs/remotes/origin/*',
      ],
      { env: githubGitEnv(worktree.token), maxBuffer: 4 * 1024 * 1024 },
    );
    published = await originContains(worktree.gitCommonDir, originalHead);
  }
  if (!published) throw new Error(`corner ${worktree.cornerId} has unpushed commits`);

  const settledHead = (
    await execFileAsync('git', ['-C', worktree.path, 'rev-parse', '--verify', 'HEAD'])
  ).stdout.trim();
  if (settledHead !== originalHead || (await status())) {
    throw new Error(`corner ${worktree.cornerId} changed during cleanup`);
  }
}

async function originContains(gitCommonDir: string, head: string): Promise<boolean> {
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

interface DesiredCorner {
  cornerId: string;
  parentRoomId: string;
  /** The agent that opened it. History and a start rule, never an access check. */
  openedBy?: string;
}

const execFileAsync = promisify(execFile);

/** Delete exactly one chat-only corner's dedicated scratch workspace. */
export async function removeCornerScratchWorkspace(input: {
  cornerId: string;
  roomRoot: string;
  scratchPath: string;
}): Promise<void> {
  const expected = resolve(input.roomRoot, 'scratch');
  if (resolve(input.scratchPath) !== expected) {
    throw new Error(`refusing to remove scratch outside corner ${input.cornerId}`);
  }
  await rm(expected, { recursive: true, force: true });
}

/** Monolith-only Room supervisor. Relay-backed discovery and turn serving are retired. */
export class RoomRuntimeCoordinator {
  private readonly runtime: AgentRuntimeRecord;
  private readonly running = new Map<string, RunningRoom>();
  /** Close/reconcile leftovers retried until local and remote refs are gone. */
  private readonly pendingCornerReaps = new Map<string, CornerWorktree>();
  private readonly startingCorners = new Set<string>();
  /**
   * Rooms whose start is in flight. `running` is not set until the checkout
   * clone finishes, and three callers race for it — the membership push, the
   * reconcile sweep, and the watchdog restart — so without this two checkouts
   * run in the same shared directory and the second start orphans the first
   * loop's AbortController.
   */
  private readonly startingRooms = new Set<string>();
  /** Pushed membership changes awaiting a bounded apply, latest per Room. */
  private readonly pendingMembershipEvents = new Map<string, RoomMembershipChange>();
  private membershipDrain: Promise<void> | undefined;
  /** Set by `shutdown`: a pushed event may no longer start anything. */
  private stopped = false;
  /** Corners whose start failure has already been said out loud, once each. */
  private readonly reportedCornerStartFailures = new Set<string>();
  /** Standing workspace-configuration faults, keyed by the config that failed. */
  private readonly standingCornerStartFaults = new Map<string, string>();
  private readonly scheduler: SessionScheduler;
  private readonly agent: ReturnType<typeof runtimeIdentity>;
  /** Parent ownership retained so a failed corner listing never authorizes removal. */
  private readonly monolithCornerParents = new Map<string, string>();
  private readonly now: () => number;
  private readonly watchdogStaleMs: number;
  private readonly reconcileHeartbeatMs: number;
  private readonly drainDeadlineMs: number;
  private drainDeadlineAt: number | undefined;
  private workspaceRemovalConfirmations = 0;
  private readonly roomRemovalConfirmations = new Map<string, number>();
  private confirmationPending = false;
  private restartRequested = false;
  /** Unscoped agent-directed discovery wakes (#1369), counted instead of
   *  flagged: a wake that arrives while a reconcile is already running must
   *  survive its start-pass clearing, or a reconnect mid-reconcile waits a
   *  heartbeat for a wake the daemon already received. A scoped membership
   *  event applies incrementally and never touches this latch. */
  private readonly discoveryWakes = new DiscoveryWakes();
  /** One command-grant runner per daemon; Rooms and corners register their checkouts on it. */
  private readonly grantRunner: GrantCommandRunner;
  private readonly grantRunnerServer: GrantRunnerServer;
  /** Connection usage capture, batched per agent turn. */
  private readonly connectorUsage: ConnectorUsageRecorder;
  /** Cached local Google grant for the YouTube MCP mount. */
  private youtubeToken: string | null | undefined;

  constructor(
    runtime: AgentRuntimeRecord,
    private readonly configPath: string,
    private readonly baseConfig: BodyConfig,
    private readonly options: {
      now?: () => number;
      watchdogStaleMs?: number;
      reconcileHeartbeatMs?: number;
      drainDeadlineMs?: number;
      daemonApi: DaemonApiClient;
      onHiccupRestart?: (attempt: number) => void;
      onRestartRequested?: () => void;
      onConfigChanged?: () => void | Promise<void>;
    },
  ) {
    if (!runtime.transport) throw new Error('thin daemon requires monolith transport');
    this.runtime = runtime;
    this.agent = runtimeIdentity(runtime.agent);
    this.now = options.now ?? Date.now;
    this.grantRunner = new GrantCommandRunner({
      api: options.daemonApi,
      agentId: this.agent.publicKey,
    });
    this.grantRunnerServer = new GrantRunnerServer(this.grantRunner);
    this.connectorUsage = new ConnectorUsageRecorder();
    // Optional on purpose: test stubs of the API surface predate the wake, and
    // a daemon whose transport cannot deliver it still reconciles on the
    // heartbeat as before.
    this.options.daemonApi.setRoomsChangedListener?.((event) => {
      const roomId = event?.roomId;
      if (!roomId) {
        this.discoveryWakes.wake();
        return;
      }
      this.queueMembershipEvent({ ...event, roomId });
    });
    this.options.daemonApi.setCornerCompleteListener?.((roomId) => {
      void this.applyCornerComplete(roomId).catch((error) =>
        console.error('[thin-core] live corner-complete apply failed', error),
      );
    });
    this.options.daemonApi.setCornerRestartListener?.((roomId) => {
      void this.applyCornerRestart(roomId).catch((error) =>
        console.error('[thin-core] live corner-restart apply failed', error),
      );
    });
    // Hot-restart on a phone-side model/effort selection change: retire every
    // retained session now so the next turn cold-activates against the saved
    // selection, exactly as session start reads it. A busy session is left to
    // finish and re-checked at its next hand-back; plain reconnects never fire
    // this. Optional like the wake above: a stub API without the listener
    // still reconciles, and the per-turn currency check remains the net.
    this.options.daemonApi.setConfigChangedListener?.(() => {
      void this.scheduler
        .suspendIdle()
        .catch((error) => console.error('[body] config-change session restart failed', error));
      void Promise.resolve(this.options.onConfigChanged?.()).catch((error) =>
        console.error('[body] config-change catalog refresh failed', error),
      );
    });
    this.options.daemonApi.setHiccupRestartListener?.((attempt) => {
      this.options.onHiccupRestart?.(attempt);
    });
    this.watchdogStaleMs = options.watchdogStaleMs ?? DEFAULT_ROOM_WATCHDOG_STALE_MS;
    this.reconcileHeartbeatMs = options.reconcileHeartbeatMs ?? DEFAULT_RECONCILE_HEARTBEAT_MS;
    this.drainDeadlineMs = options.drainDeadlineMs ?? DEFAULT_DRAIN_DEADLINE_MS;
    const fixedWorkspaceCeiling = process.env.BUZZY_BODY_MAX_SESSIONS;
    this.scheduler = new SessionScheduler({
      ...(fixedWorkspaceCeiling ? { maxLiveSessions: Number(fixedWorkspaceCeiling) } : {}),
      perRoomLiveSessions: resolvePerRoomLiveSessions(process.env),
      workspaceFloor: Number(
        process.env.BUZZY_BODY_MAX_SESSIONS_FLOOR ?? String(DEFAULT_WORKSPACE_LIVE_SESSIONS_FLOOR),
      ),
      activeRoomCount: () => this.running.size,
      idleMs: resolveSessionIdleMs(process.env),
      maxWarmSessions: resolveMaxWarmSessions(process.env),
      reserveInteractiveSlot: true,
    });
  }

  activeRoomIds(): string[] {
    return [...this.running.keys()].sort();
  }

  activeRoomCount(): number {
    return this.running.size;
  }

  /**
   * The session scheduler's capacity, read-only, beside the turn traces
   * (`turn-trace.ts` embeds the same snapshot in every record). A turn that
   * sat in `queue-wait` while this was at its ceiling waited on capacity, not
   * on a model.
   */
  schedulerSnapshot(): SessionSchedulerSnapshot {
    return this.scheduler.snapshot();
  }

  needsFastReconcile(): boolean {
    return this.confirmationPending || this.discoveryWakes.needsFastReconcile();
  }

  reconcileHeartbeatIntervalMs(): number {
    return this.reconcileHeartbeatMs;
  }

  isWorkspaceIdle(): boolean {
    return this.activeTurnCount() === 0;
  }

  /** Turns executing right now. Serving a Room or corner with no turn in flight is idle. */
  activeTurnCount(): number {
    let count = 0;
    for (const room of this.running.values()) if (room.body.isBusy()) count += 1;
    return count;
  }

  private requestLifecycleRestart(): void {
    if (this.restartRequested) return;
    this.restartRequested = true;
    this.options.onRestartRequested?.();
  }

  quiesceForUpdateIfIdle(): boolean {
    if (!this.isWorkspaceIdle()) return false;
    for (const room of this.running.values()) room.controller.abort();
    return true;
  }

  setDrainDeadlineAt(deadlineAt: number): void {
    if (Number.isFinite(deadlineAt)) {
      this.drainDeadlineAt = Math.min(this.drainDeadlineAt ?? Number.POSITIVE_INFINITY, deadlineAt);
    }
  }

  async prepareForForcedUpdateRestart(): Promise<void> {
    const rooms = [...this.running.values()];
    await Promise.allSettled(
      rooms
        .filter((room) => room.body.isBusy())
        .map((room) => room.body.prepareForForcedUpdateRestart()),
    );
    for (const room of rooms) room.controller.abort();
  }

  async reconcile(): Promise<WorkspaceMembershipStatus> {
    this.confirmationPending = false;
    // Everything this reconcile reads happens after this point, so every wake
    // that has arrived by now is covered by its start pass. Wakes landing
    // DURING the reconcile re-arm fast reconcile instead of being swallowed.
    const coveredWakes = this.discoveryWakes.beginReconcile();
    const bootstrap = await this.options.daemonApi.execute('getDaemonBootstrap', {
      agentId: this.agent.publicKey,
    });
    if (!bootstrap.workspaceIds.includes(this.runtime.communityId)) {
      this.workspaceRemovalConfirmations += 1;
      if (this.workspaceRemovalConfirmations < REMOVAL_CONFIRMATION_READS) {
        this.confirmationPending = true;
        return 'unknown';
      }
      return 'not-member';
    }
    this.workspaceRemovalConfirmations = 0;
    const topLevelRooms = bootstrap.rooms.filter((room) => !room.archived);
    const desiredTopRooms = topLevelRooms.map((room) => room.roomId);
    const desired = new Set(desiredTopRooms);
    const desiredCorners = new Map<string, DesiredCorner>();
    const archivedCorners = new Map<string, { cornerId: string; parentRoomId: string }>();
    await mapWithConcurrency(topLevelRooms, ROOM_JOIN_CONCURRENCY, async (room) => {
      try {
        const result = await this.options.daemonApi.execute('listRoomCorners', {
          roomId: room.roomId,
        });
        for (const corner of result.corners) {
          this.monolithCornerParents.set(corner.cornerId, room.roomId);
          if (corner.archived) {
            archivedCorners.set(corner.cornerId, {
              cornerId: corner.cornerId,
              parentRoomId: room.roomId,
            });
          } else {
            desired.add(corner.cornerId);
            desiredCorners.set(corner.cornerId, {
              cornerId: corner.cornerId,
              parentRoomId: room.roomId,
              ...(corner.createdBy ? { openedBy: corner.createdBy } : {}),
            });
          }
        }
      } catch (error) {
        // A failed corner read is uncertainty, never evidence that every
        // running corner vanished. Keep the last successful parent mapping
        // and retry on the next reconciliation heartbeat.
        for (const [cornerId, parentRoomId] of this.monolithCornerParents) {
          if (parentRoomId === room.roomId && this.running.has(cornerId)) {
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
    for (const channelId of desired) this.roomRemovalConfirmations.delete(channelId);
    await this.retryPendingCornerReaps(desired);
    await this.sweepArchivedCornerWorktrees(archivedCorners);
    for (const [channelId, running] of [...this.running]) {
      if (desired.has(channelId)) continue;
      const confirmations = (this.roomRemovalConfirmations.get(channelId) ?? 0) + 1;
      this.roomRemovalConfirmations.set(channelId, confirmations);
      if (confirmations < REMOVAL_CONFIRMATION_READS) {
        this.confirmationPending = true;
        continue;
      }
      await this.stopRunning(channelId, running);
    }
    await mapWithConcurrency(desiredTopRooms, ROOM_JOIN_CONCURRENCY, async (roomId) => {
      if (this.running.has(roomId)) return;
      try {
        await this.startRoom(roomId);
      } catch (error) {
        // One Room's failed start must not block the corner-start pass behind
        // it: a corner opened while a Room cannot materialize its checkout
        // would otherwise never start, while every already-running Room keeps
        // the agent looking healthy. The failed Room retries on the next
        // reconciliation heartbeat.
        console.error(`[thin-core] failed to start Room ${roomId}:`, error);
      }
    });
    await mapWithConcurrency(
      [...desiredCorners.values()],
      ROOM_JOIN_CONCURRENCY,
      async (corner) => {
        if (!this.running.has(corner.cornerId)) await this.startCorner(corner);
      },
    );
    for (const running of this.running.values()) running.body.requestReconciliation();
    this.discoveryWakes.completeReconcile(coveredWakes);
    return 'member';
  }

  /**
   * Pushed membership changes are applied at the same bound the reconcile pass
   * uses. One `rooms-changed` per row means a single human action (adding an
   * agent to a Room inherits a membership per corner under it) arrives as a
   * burst; unbounded, that burst is exactly the concurrent restore reads and
   * worktree checkouts this change exists to stop.
   */
  private queueMembershipEvent(event: RoomMembershipChange & { roomId: string }): void {
    if (this.stopped) return;
    this.pendingMembershipEvents.set(event.roomId, event);
    this.membershipDrain ??= this.drainMembershipEvents().finally(() => {
      this.membershipDrain = undefined;
    });
  }

  private async drainMembershipEvents(): Promise<void> {
    while (this.pendingMembershipEvents.size) {
      const batch = [...this.pendingMembershipEvents.values()];
      this.pendingMembershipEvents.clear();
      await mapWithConcurrency(batch, ROOM_JOIN_CONCURRENCY, (event) =>
        this.applyMembershipEvent(event).catch((error) => {
          console.error('[thin-core] live membership apply failed', error);
          this.discoveryWakes.wake();
        }),
      );
    }
  }

  /**
   * Incremental apply of one scoped membership push.
   * An unscoped wake still uses the slow reconcile as recovery.
   */
  async applyMembershipEvent(event: RoomMembershipChange): Promise<void> {
    const roomId = event.roomId;
    if (!roomId) {
      this.discoveryWakes.wake();
      return;
    }
    if (event.removed === true) {
      const running = this.running.get(roomId);
      if (running) await this.stopRunning(roomId, running);
      this.monolithCornerParents.delete(roomId);
      return;
    }
    // Inheriting a Room membership writes one row per corner under it, archived
    // ones included, and the reviewer projection rewrites every row again. An
    // archived Room or corner is nothing to start, so the event is dropped here
    // rather than after a restore read per row.
    if (event.archived === true) return;
    this.roomRemovalConfirmations.delete(roomId);
    if (this.running.has(roomId) || this.startingCorners.has(roomId)) return;
    if (event.parentRoomId) {
      this.monolithCornerParents.set(roomId, event.parentRoomId);
      // The opener rides the same row that announces the corner. Without it
      // nobody is the opener, so the initial `working` state — the only write
      // of `corner_facts.feature_branch`, which every corner GitHub webhook is
      // resolved by — would never happen. Fall back to the reconcile read that
      // carries the corner's recorded opener rather than starting it blind.
      if (!event.openedBy) {
        this.discoveryWakes.wake();
        return;
      }
      await this.startCorner({
        cornerId: roomId,
        parentRoomId: event.parentRoomId,
        openedBy: event.openedBy,
      });
      // `startCorner` reports its own failures and resolves either way, so a
      // transient token or clone fault leaves nothing running and nothing
      // scheduled. Arm the fast reconcile the pushed Room path already gets
      // from its throw, so the retry is now rather than a heartbeat away.
      if (!this.running.has(roomId)) this.discoveryWakes.wake();
      return;
    }
    await this.startRoom(roomId);
  }

  async applyCornerComplete(cornerId: string): Promise<void> {
    this.running.get(cornerId)?.body.requestClose?.();
  }

  /** Retire the scratch runtime. Ordinary desired-state reconciliation starts
   * the same corner id again and re-reads its now-code lane. */
  async applyCornerRestart(cornerId: string): Promise<void> {
    const running = this.running.get(cornerId);
    if (!running) {
      this.discoveryWakes.wake();
      return;
    }
    await this.stopRunning(cornerId, running);
    this.discoveryWakes.wake();
  }

  private async stopRunning(channelId: string, running: RunningRoom): Promise<void> {
    running.controller.abort();
    await running.promise.catch(() => undefined);
    try {
      if (running.worktree) await this.reapCornerWorktree(running.worktree);
      else if (running.scratch) await this.reapCornerScratch(running.scratch);
    } catch (error) {
      console.error(`[thin-core] corner ${channelId} cleanup failed; will retry:`, error);
      this.confirmationPending = true;
    }
  }

  private roomRecord(roomId: string): RoomRuntimeRecord | undefined {
    return this.runtime.rooms.find((room) => room.channelId === roomId);
  }

  private roomRoot(roomId: string): string {
    return this.roomRecord(roomId)?.root ?? resolve(dirname(this.configPath), 'rooms', roomId);
  }

  private roomAgentHomeRoot(workspaceRoot: string, required = false): string | undefined {
    const flag = process.env.BUZZY_BODY_ROOM_HOME;
    if (!required && flag === '0') return undefined;
    const home = resolve(workspaceRoot, 'agent-home');
    if (!required && flag !== '1' && !existsSync(home) && existsSync(workspaceRoot))
      return undefined;
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      return home;
    } catch (error) {
      console.error(`[thin-core] per-room agent home unavailable at ${home}:`, error);
      return undefined;
    }
  }

  private roomConfig(roomId: string, workspaceRoot = this.roomRoot(roomId)): BodyConfig {
    const agentHomeRoot = this.roomAgentHomeRoot(workspaceRoot, true);
    return {
      ...this.baseConfig,
      workspaceRoot,
      agentPrivateRoot: resolve(workspaceRoot, 'agent-private'),
      agentMemoryRoot: resolve(dirname(this.configPath), 'memory'),
      openRouterRoutingCacheDir: openRouterRoutingCacheDir(dirname(this.configPath)),
      turnTraceDir: turnTraceDirectory(dirname(this.configPath)),
      ...(agentHomeRoot ? { agentHomeRoot } : {}),
    };
  }

  /** Local Google grant for the YouTube MCP. File/env only — never spawns
   *  Squire at session start. Connect persists the grant onto this path. */
  private youtubeAccessToken(): string | undefined {
    if (this.youtubeToken === undefined) {
      const home = process.env.BEELINE_AGENT_HOME ?? process.cwd();
      const resolved = loadManualGoogleCredentials(home);
      this.youtubeToken = resolved.source === 'manual' ? resolved.credentials.accessToken : null;
    }
    return this.youtubeToken ?? undefined;
  }

  /** The loopback door for run_granted_command; started once, on first use. */
  private grantRunnerEndpoint(): Promise<GrantRunnerEndpoint | undefined> {
    return this.grantRunnerServer.start().catch((error) => {
      console.error('[thin-core] grant runner unavailable; run_granted_command is off:', error);
      return undefined;
    });
  }

  private async startRoom(roomId: string): Promise<void> {
    if (this.running.has(roomId) || this.startingRooms.has(roomId)) return;
    this.startingRooms.add(roomId);
    try {
      await this.startRoomOnce(roomId);
    } finally {
      this.startingRooms.delete(roomId);
    }
  }

  private async startRoomOnce(roomId: string): Promise<void> {
    const controller = new AbortController();
    const cwd = await this.materializeRoomCheckout(roomId);
    const grantRunnerEndpoint = await this.grantRunnerEndpoint();
    const startedAt = this.now();
    const loop = new MonolithRoomTurnLoop({
      roomId,
      workspaceId: this.runtime.communityId,
      cwd,
      refreshCheckout: () => this.refreshRoomCheckout(roomId),
      grantRunner: this.grantRunner,
      ...(grantRunnerEndpoint ? { grantRunnerEndpoint } : {}),
      ...(this.youtubeAccessToken() ? { youtubeAccessToken: this.youtubeAccessToken() } : {}),
      runtime: this.runtime,
      config: this.roomConfig(roomId),
      api: this.options.daemonApi,
      scheduler: this.scheduler,
      signal: controller.signal,
      health: {
        poll: () => this.notePoll(roomId),
        failure: (retryInMs) => this.noteFailure(roomId, retryInMs),
        presence: () => undefined,
      },
      onCornerOpened: () => {
        this.confirmationPending = true;
      },
      onRestartRequested: () => this.requestLifecycleRestart(),
      canStartTurn: () => !this.restartRequested,
    });
    const promise = loop
      .run()
      .catch((error) => {
        if (!controller.signal.aborted) console.error(`[thin-core] Room ${roomId} failed:`, error);
      })
      .finally(() => {
        if (this.running.get(roomId)?.body === loop) this.running.delete(roomId);
      });
    // Shutdown snapshots `running` once. A start that was still in flight then
    // must drop what it just built rather than join the map behind the abort
    // pass, or its live subscription outlives the daemon.
    if (this.stopped) {
      controller.abort();
      await promise;
      return;
    }
    this.running.set(roomId, {
      body: loop,
      controller,
      promise,
      lastPollAt: startedAt,
      backoffUntil: 0,
      recovering: false,
    });
    console.log(`[thin-core] serving monolith Room ${roomId}`);
  }

  /**
   * A Room is a repository inspection surface, so its session cwd must be the
   * current server-bound repository rather than a legacy runtime path (or the
   * otherwise-empty per-Room state directory). The daemon consumes the
   * short-lived GitHub token itself; it is never included in the Room MCP or
   * harness environment.
   */
  private async materializeRoomCheckout(
    roomId: string,
    repository?: RoomRepositoryStateResult,
  ): Promise<string> {
    repository ??= await this.options.daemonApi.execute('getRoomRepositoryState', { roomId });
    if (repository.resolution !== 'repository' || !repository.remote) return this.roomRoot(roomId);

    const remote = roomCheckoutRemote(repository.remote);
    const targetBranch = repository.targetBranch || 'main';
    const checkoutId = createHash('sha256')
      .update(`${roomId}\0${remote}\0${targetBranch}`)
      .digest('hex')
      .slice(0, 24);
    const path = resolve(this.runtime.supervisorRoot, 'beeline', 'room-checkouts', checkoutId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });

    const token = remote.startsWith('https://github.com/')
      ? await this.options.daemonApi.execute('getRoomGitHubToken', { roomId })
      : undefined;
    const env = token ? githubGitEnv(token.token) : process.env;
    if (!existsSync(resolve(path, '.git'))) {
      await execFileAsync('git', ['clone', '--no-checkout', remote, path], {
        env,
        maxBuffer: 4 * 1024 * 1024,
      });
    }
    await execFileAsync(
      'git',
      [
        '-C',
        path,
        'fetch',
        '--prune',
        'origin',
        `+refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`,
      ],
      { env, maxBuffer: 4 * 1024 * 1024 },
    );
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

  private async refreshRoomCheckout(
    roomId: string,
  ): Promise<{ cwd: string; branch?: string; commit?: string }> {
    const repository = await this.options.daemonApi.execute('getRoomRepositoryState', { roomId });
    if (repository.resolution !== 'repository' || !repository.remote)
      return { cwd: this.roomRoot(roomId) };
    const branch = repository.targetBranch || 'main';
    const cwd = await this.materializeRoomCheckout(roomId, repository);
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--verify', 'HEAD']);
    return { cwd, branch, commit: stdout.trim() };
  }

  private async startCorner(corner: DesiredCorner): Promise<void> {
    if (this.running.has(corner.cornerId) || this.startingCorners.has(corner.cornerId)) return;
    this.startingCorners.add(corner.cornerId);
    let configKey: string | undefined;
    try {
      const [restore, repository] = await Promise.all([
        this.options.daemonApi.execute('getCornerRestoreState', { cornerId: corner.cornerId }),
        this.options.daemonApi.execute('getRoomRepositoryState', {
          roomId: corner.parentRoomId,
        }),
      ]);
      const objective =
        (restore.objective ?? '').trim() ||
        (restore.kind === 'human' ? (restore.title ?? '').trim() : '');
      configKey = cornerStartConfigKey(repository, objective);
      const previousStanding = this.standingCornerStartFaults.get(corner.cornerId);
      if (previousStanding === configKey) return;
      if (previousStanding) {
        this.standingCornerStartFaults.delete(corner.cornerId);
        this.reportedCornerStartFailures.delete(corner.cornerId);
      }
      if (repository.resolution === 'unverified') {
        throw new Error('corner parent Room repository state is not verified yet');
      }
      if (repository.resolution === 'repository' && (!repository.remote || !repository.key)) {
        throw new Error('corner parent Room has an incomplete repository binding');
      }
      if (!objective) throw new Error('corner has no authoritative objective fact');
      // The lane is the corner's own durable fact, so a no-code corner in a
      // repository Room takes the same scratch workspace a chat-only corner
      // does: no worktree is cut, no feature branch is named, and no GitHub
      // token is minted for it.
      const repositoryBacked = repository.resolution === 'repository' && restore.lane !== 'no_code';
      const targetBranch = repositoryBacked ? repository.targetBranch || 'main' : undefined;
      const featureBranch = repositoryBacked
        ? (restore.featureBranch ??
          `feature/corner-${corner.cornerId.replaceAll('-', '').slice(0, 12)}`)
        : undefined;
      const granted = repositoryBacked
        ? await this.cornerRepositoryToken(corner.parentRoomId)
        : undefined;
      const worktree = repositoryBacked
        ? await this.materializeCornerWorktree({
            cornerId: corner.cornerId,
            remote: repository.remote!,
            targetBranch: targetBranch!,
            featureBranch: featureBranch!,
            token: granted!.token,
          })
        : undefined;
      const workspacePath = worktree?.path ?? resolve(this.roomRoot(corner.cornerId), 'scratch');
      if (!worktree) await mkdir(workspacePath, { recursive: true, mode: 0o700 });
      const isOpener = corner.openedBy === this.agent.publicKey;
      if (worktree && shouldPostInitialCornerWorkingState(restore, isOpener)) {
        await this.options.daemonApi.execute('postCornerRemoteState', {
          cornerId: corner.cornerId,
          branch: featureBranch!,
          state: 'working',
          checks: 'unknown',
        });
      }
      const controller = new AbortController();
      const grantRunnerEndpoint = await this.grantRunnerEndpoint();
      const startedAt = this.now();
      const loop = new MonolithCornerTurnLoop({
        cornerId: corner.cornerId,
        grantRunner: this.grantRunner,
        ...(grantRunnerEndpoint ? { grantRunnerEndpoint } : {}),
        connectorUsage: this.connectorUsage,
        ...(this.youtubeAccessToken() ? { youtubeAccessToken: this.youtubeAccessToken() } : {}),
        parentRoomId: corner.parentRoomId,
        workspaceId: this.runtime.communityId,
        ...(corner.openedBy ? { openedBy: corner.openedBy } : {}),
        objective,
        worktreePath: workspacePath,
        lane: restore.lane,
        agentMayUpgradeCorner: repository.resolution === 'repository' && restore.lane === 'no_code',
        ...(restore.requesterHandle ? { requesterHandle: restore.requesterHandle } : {}),
        ...(worktree
          ? {
              repository: {
                featureBranch: featureBranch!,
                targetBranch: targetBranch!,
                gitCommonDir: worktree.gitCommonDir,
                githubToken: granted!.token,
              },
            }
          : {}),
        runtime: this.runtime,
        config: this.roomConfig(corner.cornerId, worktree ? undefined : workspacePath),
        api: this.options.daemonApi,
        scheduler: this.scheduler,
        signal: controller.signal,
        onPoll: () => this.notePoll(corner.cornerId),
        onFailure: (retryInMs) => this.noteFailure(corner.cornerId, retryInMs),
        onCloseRequested: () =>
          worktree
            ? this.reapCornerWorktree({
                ...worktree,
                cornerId: corner.cornerId,
                branch: featureBranch!,
                parentRoomId: corner.parentRoomId,
                token: '',
              })
            : this.reapCornerScratch({ path: workspacePath, cornerId: corner.cornerId }),
        onLaneChanged: () =>
          void this.applyCornerRestart(corner.cornerId).catch((error) =>
            console.error('[thin-core] corner lane-change restart failed', error),
          ),
        onRestartRequested: () => this.requestLifecycleRestart(),
        canStartTurn: () => !this.restartRequested,
      });
      const promise = loop
        .run()
        .catch((error) => {
          if (!controller.signal.aborted) {
            console.error(`[thin-core] corner ${corner.cornerId} failed:`, error);
          }
        })
        .finally(() => {
          if (this.running.get(corner.cornerId)?.body === loop) {
            this.running.delete(corner.cornerId);
          }
        });
      if (this.stopped) {
        controller.abort();
        await promise;
        return;
      }
      this.running.set(corner.cornerId, {
        body: loop,
        controller,
        promise,
        lastPollAt: startedAt,
        backoffUntil: 0,
        recovering: false,
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
        ...(!worktree ? { scratch: { path: workspacePath, cornerId: corner.cornerId } } : {}),
      });
      this.standingCornerStartFaults.delete(corner.cornerId);
      this.reportedCornerStartFailures.delete(corner.cornerId);
      console.log(
        worktree
          ? `[thin-core] serving corner ${corner.cornerId} on ${featureBranch} at ${workspacePath}`
          : `[thin-core] serving no-code corner ${corner.cornerId} at ${workspacePath}`,
      );
    } catch (error) {
      console.error(`[thin-core] failed to start corner ${corner.cornerId}:`, error);
      // Keep the pending command available for the next reconciliation. A
      // temporary token lookup must not turn into a human repair request.
      if (error instanceof CornerCredentialLookupError) return;
      const reported = await this.reportCornerStartFailure(corner.cornerId, error);
      if (reported && isStandingCornerStartFault(error) && configKey) {
        this.standingCornerStartFaults.set(corner.cornerId, configKey);
      }
    } finally {
      this.startingCorners.delete(corner.cornerId);
    }
  }

  private async cornerRepositoryToken(
    roomId: string,
  ): Promise<{ token: string; expiresAt: number }> {
    try {
      return await this.options.daemonApi.execute('getRoomGitHubToken', { roomId });
    } catch (error) {
      if (error instanceof DaemonApiError && !error.retryable) throw error;
      throw new CornerCredentialLookupError(error);
    }
  }

  /**
   * An agent addressed in a corner it then could not restore must not be
   * silent about it.
   *
   * The corner never starts, so no turn ever runs. Report against the actual
   * pending command — never a fabricated generation — so the server can
   * authorize the failed receipt and inscribe the Room line. Standing
   * workspace-configuration faults are said once and suppressed until that
   * configuration changes; clone/network failures keep retrying.
   */
  private async reportCornerStartFailure(cornerId: string, error: unknown): Promise<boolean> {
    if (this.reportedCornerStartFailures.has(cornerId)) return true;
    try {
      const { commands } = await this.options.daemonApi.execute('getAgentCommands', {
        roomId: cornerId,
      });
      const pending = commands.find(
        (command) => command.action === 'input' || command.action === 'resume',
      );
      if (!pending) return false;
      const reason = distillTurnFailureReason(error);
      await this.options.daemonApi.execute('postAgentTurnReceipt', {
        agentId: this.agent.publicKey,
        roomId: cornerId,
        requestId: pending.turnRequestId,
        status: 'failed',
        reason: reason.text,
        ...(reason.kind ? { reasonKind: reason.kind } : {}),
      });
      this.reportedCornerStartFailures.add(cornerId);
      return true;
    } catch (reportError) {
      console.error(`[thin-core] corner ${cornerId} start-failure report failed:`, reportError);
      return false;
    }
  }

  private async materializeCornerWorktree(input: {
    cornerId: string;
    remote: string;
    targetBranch: string;
    featureBranch: string;
    token: string;
  }): Promise<{ path: string; gitCommonDir: string }> {
    return materializeCornerWorktree({
      ...input,
      supervisorRoot: this.runtime.supervisorRoot,
      committer: { name: this.agent.name, publicKey: this.agent.publicKey },
    });
  }

  private async retryPendingCornerReaps(desired: ReadonlySet<string>): Promise<void> {
    for (const [cornerId, worktree] of [...this.pendingCornerReaps]) {
      if (desired.has(cornerId)) {
        this.pendingCornerReaps.delete(cornerId);
        continue;
      }
      try {
        await this.reapCornerWorktree(worktree);
      } catch (error) {
        console.error(`[thin-core] corner ${cornerId} branch cleanup retry failed:`, error);
        this.confirmationPending = true;
      }
    }
  }

  /**
   * Startup/reconcile recovery for worktrees no current process remembers.
   * Archived server state names the exact corner; local discovery is limited
   * to that exact directory and the host's bare-repository cache.
   */
  private async sweepArchivedCornerWorktrees(
    corners: ReadonlyMap<string, { cornerId: string; parentRoomId: string }>,
  ): Promise<void> {
    for (const corner of corners.values()) {
      if (this.running.has(corner.cornerId) || this.pendingCornerReaps.has(corner.cornerId)) {
        continue;
      }
      let discovered: DiscoveredCornerWorktree | undefined;
      try {
        discovered = await discoverCornerWorktree(this.runtime.supervisorRoot, corner.cornerId);
        if (!discovered) continue;
        const [restore, repository] = await Promise.all([
          this.options.daemonApi.execute('getCornerRestoreState', {
            cornerId: corner.cornerId,
          }),
          this.options.daemonApi.execute('getRoomRepositoryState', {
            roomId: corner.parentRoomId,
          }),
        ]);
        if (repository.resolution !== 'repository' || !repository.remote) {
          throw new Error(`archived corner ${corner.cornerId} has no authoritative repository`);
        }
        const expectedCommonDir = cornerRepositoryCacheDir(
          this.runtime.supervisorRoot,
          repository.remote,
        );
        if (resolve(discovered.gitCommonDir) !== expectedCommonDir) {
          throw new Error(`archived corner ${corner.cornerId} repository cache does not match`);
        }
        if (!restore.featureBranch) {
          throw new Error(`archived corner ${corner.cornerId} has no authoritative feature branch`);
        }
        await this.reapCornerWorktree({
          ...discovered,
          cornerId: corner.cornerId,
          branch: restore.featureBranch,
          parentRoomId: corner.parentRoomId,
          token: '',
          recovered: true,
        });
        console.log(`[thin-core] swept archived corner worktree ${corner.cornerId}`);
      } catch (error) {
        console.error(`[thin-core] archived corner ${corner.cornerId} cleanup deferred:`, error);
        if (discovered) {
          // Keep retrying only a path that discovery proved belongs to the
          // managed corner/repository roots. Missing metadata is uncertainty,
          // never permission to invent a branch name.
          this.confirmationPending = true;
        }
      }
    }
  }

  private async reapCornerWorktree(worktree: CornerWorktree): Promise<void> {
    // The exact local ref is the deletion authority. It was created for this
    // corner's worktree and survives a failed remote deletion so reconcile can
    // retry the same exact ref. A missing local ref plus a missing remote ref
    // is success, so a later pass cannot turn an untrusted branch string into
    // a guessed deletion.
    try {
      // A corner closed with an open pull request keeps its branch: the
      // worktree goes, the shared artifact does not. An unreadable corner is
      // never proof its pull request is gone, so it is preserved too.
      const preserveRemoteBranch = !(await this.cornerBranchMayBeDeleted(worktree.cornerId));
      const parentRoomId = worktree.parentRoomId;
      if (!parentRoomId) {
        throw new Error(`corner ${worktree.cornerId} has no parent Room for GitHub token`);
      }
      const token = (
        await this.options.daemonApi.execute('getRoomGitHubToken', {
          roomId: parentRoomId,
        })
      ).token;
      await removeCornerWorktreeAndBranches({ ...worktree, token }, { preserveRemoteBranch });
      this.pendingCornerReaps.delete(worktree.cornerId);
      // `gone` asserts the remote branch is gone, so a preserved branch must
      // not post it: the corner's own GitHub facts still own its lifecycle.
      if (!preserveRemoteBranch) {
        await this.options.daemonApi.execute('postCornerRemoteState', {
          cornerId: worktree.cornerId,
          branch: worktree.branch,
          state: 'gone',
          checks: 'unknown',
        });
      }
    } catch (error) {
      this.pendingCornerReaps.set(worktree.cornerId, { ...worktree, token: '' });
      this.confirmationPending = true;
      throw error;
    }
  }

  /**
   * Whether a corner's feature branch is safe to delete on teardown. A read
   * that fails — an agent removed from the corner, or a corner a helper can no
   * longer reach — is not proof its pull request is gone, so the branch is
   * kept.
   */
  private async cornerBranchMayBeDeleted(cornerId: string): Promise<boolean> {
    try {
      const state = await this.options.daemonApi.execute('getCornerRestoreState', { cornerId });
      return cornerBranchIsSafeToDelete(state.lifecycle);
    } catch {
      return false;
    }
  }

  private async reapCornerScratch(scratch: CornerScratch): Promise<void> {
    await removeCornerScratchWorkspace({
      cornerId: scratch.cornerId,
      roomRoot: this.roomRoot(scratch.cornerId),
      scratchPath: scratch.path,
    });
  }

  private notePoll(roomId: string): void {
    const room = this.running.get(roomId);
    if (!room) return;
    room.lastPollAt = this.now();
    room.backoffUntil = 0;
  }

  private noteFailure(roomId: string, retryInMs: number): void {
    const room = this.running.get(roomId);
    if (room) room.backoffUntil = Math.max(room.backoffUntil, this.now() + retryInMs);
  }

  async watchdogTick(): Promise<void> {
    for (const [roomId, room] of [...this.running]) {
      if (room.recovering || room.body.isBusy()) continue;
      if (this.now() <= Math.max(room.lastPollAt + this.watchdogStaleMs, room.backoffUntil))
        continue;
      room.recovering = true;
      room.controller.abort();
      await room.promise.catch(() => undefined);
      if (room.worktree) {
        this.confirmationPending = true;
      } else if (!this.running.has(roomId)) {
        this.startRoom(roomId);
      }
    }
  }

  async shutdown(): Promise<void> {
    // A pushed membership apply runs outside the run loop's signal, so a Room
    // whose start is in flight here would land in `running` after the abort
    // pass and never be stopped — its live subscription outlives the daemon.
    // Refuse further pushes, then wait — to the deadline, never past it — for
    // the in-flight apply, so whatever it started is in the snapshot below.
    this.stopped = true;
    this.pendingMembershipEvents.clear();
    const deadlineAt = Math.min(
      this.now() + this.drainDeadlineMs,
      this.drainDeadlineAt ?? Number.POSITIVE_INFINITY,
    );
    // A checkout can clone for minutes or stall on a black-holed fetch, so the
    // wait for it rides the same deadline the Room drain does — the managed
    // update's absolute convergence contract owns this process. Past the
    // deadline the apply is on its own: `startRoomOnce`/`startCorner` see
    // `stopped` and abort what they built instead of joining `running`.
    const untilDeadline = async <T>(work: Promise<T>): Promise<T | 'deadline'> => {
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<'deadline'>((resolveDeadline) => {
        timer = setTimeout(() => resolveDeadline('deadline'), Math.max(0, deadlineAt - this.now()));
      });
      try {
        return await Promise.race([work, deadline]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    if (this.membershipDrain) await untilDeadline(this.membershipDrain);
    const rooms = [...this.running.values()];
    for (const room of rooms) room.controller.abort();
    const drained = Promise.all(rooms.map((room) => room.promise.catch(() => undefined)));
    const result = await untilDeadline(drained.then(() => 'drained' as const));
    if (result === 'deadline') {
      await Promise.allSettled(rooms.map((room) => room.body.forceRecoverRoom()));
      await drained;
    }
    await this.grantRunnerServer.close();
    await this.scheduler.dispose();
  }
}

function githubHttpsRemote(remote: string): string {
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
function roomCheckoutRemote(remote: string): string {
  if (remote.startsWith('file://')) return remote;
  return githubHttpsRemote(remote);
}

function githubGitEnv(token: string): NodeJS.ProcessEnv {
  const authorization = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`,
    GIT_TERMINAL_PROMPT: '0',
  };
}

async function gitRefExists(gitCommonDir: string, ref: string): Promise<boolean> {
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

async function repositoryHeadRef(gitCommonDir: string): Promise<string | undefined> {
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

function gitStderr(error: unknown): string {
  return typeof error === 'object' && error && 'stderr' in error
    ? String((error as { stderr?: unknown }).stderr ?? '')
    : '';
}

function isRemoteRefMissing(error: unknown): boolean {
  return /remote ref does not exist|remote reference does not exist|couldn't find remote ref/i.test(
    `${error instanceof Error ? error.message : String(error)}\n${gitStderr(error)}`,
  );
}

async function deleteExactRemoteBranch(
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
