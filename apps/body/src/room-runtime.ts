import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, readdir, realpath, rm } from 'node:fs/promises';
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
  type RoomGitHubTokenResult,
  type RoomRepositoryStateResult,
} from '@beeline/api-contract/daemon';
import { GrantCommandRunner, GrantRunnerServer, type GrantRunnerEndpoint } from './grant-runner.js';
import { ConnectorUsageRecorder } from './connector-runner.js';
import { MonolithCornerTurnLoop } from './monolith-corner-turn.js';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import type { InterruptedTurn } from './force-update-journal.js';
import { openRouterRoutingCacheDir } from './openrouter-routing.js';
import { turnTraceDirectory } from './turn-trace.js';
import { distillTurnFailureReason } from './turn-failure-reason.js';
import { SurfaceHealth, type SurfaceHealthState } from './surface-health.js';
import { RoomSupervisor } from './room-supervisor.js';
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
export const DEFAULT_DRAIN_DEADLINE_MS = 30 * 60_000;
export const CORNER_BRANCH_DELETE_ATTEMPTS = 3;

class CornerCredentialLookupError extends Error {
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
  const top = (
    await execFileAsync('git', ['-C', path, 'rev-parse', '--show-toplevel'])
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

type RoomLeaf = Pick<
  MonolithRoomTurnLoop | MonolithCornerTurnLoop,
  | 'isBusy'
  | 'prepareForForcedUpdateRestart'
  | 'interruptForServerMinimum'
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
  private readonly surfaceHealth = new SurfaceHealth();
  /** Close/reconcile leftovers retried until local and remote refs are gone. */
  private readonly pendingCornerReaps = new Map<string, CornerWorktree>();
  /** Idle corners listen for durable commands without obtaining a token or checkout. */
  private readonly idleCornerSubscriptions = new Map<string, () => void>();
  private readonly pendingCornerCommands = new Set<string>();
  /** Enumerated once; later materialization and removal keep it current. */
  private localWorktreeIds?: Promise<Set<string>>;
  /** Event-driven cleanup retries stay scoped to the failed local corner. */
  private readonly archiveCleanupFaults = new Map<string, { failures: number; retryAt: number }>();
  /** A refused local checkout is kept until a later Room listing proves membership again. */
  private readonly archiveCleanupAccessDenied = new Set<string>();
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
  /** Per corner, the requests whose start failure has already been said out loud. */
  private readonly reportedCornerStartFailures = new Map<string, Set<string>>();
  /** Standing workspace-configuration faults: the config that failed, and how. */
  private readonly standingCornerStartFaults = new Map<string, { configKey: string; error: unknown }>();
  private readonly scheduler: SessionScheduler;
  private readonly agent: ReturnType<typeof runtimeIdentity>;
  /** Parent ownership retained so a failed corner listing never authorizes removal. */
  private readonly monolithCornerParents = new Map<string, string>();
  private readonly now: () => number;
  private readonly drainDeadlineMs: number;
  private drainDeadlineAt: number | undefined;
  private workspaceRemovalConfirmations = 0;
  private readonly roomRemovalConfirmations = new Map<string, number>();
  private readonly repositoryRevisions = new Map<string, string>();
  /** A revision discovered mid-turn retires the Room only after that turn ends. */
  private readonly deferredRepositoryRestarts = new Set<string>();
  private readonly repositoryStateCache = new Map<
    string,
    { value: RoomRepositoryStateResult; until: number }
  >();
  private readonly repositoryStateFlights = new Map<string, Promise<RoomRepositoryStateResult>>();
  private readonly tokenCache = new Map<string, RoomGitHubTokenResult>();
  private readonly tokenFlights = new Map<string, Promise<RoomGitHubTokenResult>>();
  private restartRequested = false;
  /** Keeps Room and corner intakes alive across failed reads, without polling. */
  readonly supervisor = new RoomSupervisor();
  private discoveryWakeListener?: () => void;
  private interactiveIdleListener?: () => void;
  /** One command-grant runner per daemon; Rooms and corners register their checkouts on it. */
  private readonly grantRunner: GrantCommandRunner;
  private readonly grantRunnerServer: GrantRunnerServer;
  /** Connection usage capture, batched per agent turn. */
  private readonly connectorUsage: ConnectorUsageRecorder;

  constructor(
    runtime: AgentRuntimeRecord,
    private readonly configPath: string,
    private readonly baseConfig: BodyConfig,
    private readonly options: {
      now?: () => number;
      drainDeadlineMs?: number;
      daemonApi: DaemonApiClient;
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
    // Optional on purpose: test stubs of the API surface predate the wake.
    this.options.daemonApi.setRoomsChangedListener?.((event) => {
      if (event?.repositoryChanged) {
        if (event.roomId) this.invalidateParentRepository(event.roomId);
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

  setDiscoveryWakeListener(listener: () => void): void {
    this.discoveryWakeListener = listener;
  }

  setInteractiveIdleListener(listener: () => void): void {
    this.interactiveIdleListener = listener;
  }

  /**
   * A failed reconcile makes the live socket suspect: it is pinged, and a
   * silent one is replaced, which works with any server version. A response
   * the server actually sent (or a full local read budget) says nothing about
   * the socket.
   */
  suspectLink(error: unknown): void {
    if (!(error instanceof DaemonApiError)) this.options.daemonApi.link?.suspect();
  }

  private wakeDiscovery(): void {
    this.supervisor.wake();
    this.discoveryWakeListener?.();
  }

  activeRoomCount(): number {
    return this.running.size;
  }

  surfaceHealthSnapshot(): SurfaceHealthState[] {
    return this.surfaceHealth.snapshot();
  }

  surfaceHealthSummary(): string {
    return this.surfaceHealth.summary();
  }

  hasUnreadySurfaces(): boolean {
    return this.surfaceHealth.hasUnready();
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
    // A host restart may be staggered after this idle proof. Keep new
    // commands from starting while the old process waits for its slot.
    this.restartRequested = true;
    for (const room of this.running.values()) room.controller.abort();
    return true;
  }

  /**
   * Undo `quiesceForUpdateIfIdle` after a managed restart failed: clear the
   * latch and let reconciliation start the Room loops the quiesce stopped.
   */
  resumeServing(): void {
    if (this.stopped) return;
    this.restartRequested = false;
    this.wakeDiscovery();
  }

  setDrainDeadlineAt(deadlineAt: number): void {
    if (Number.isFinite(deadlineAt)) {
      this.drainDeadlineAt = Math.min(this.drainDeadlineAt ?? Number.POSITIVE_INFINITY, deadlineAt);
    }
  }

  async prepareForForcedUpdateRestart(): Promise<void> {
    const rooms = [...this.running.values()];
    await Promise.allSettled(rooms.filter((room) => room.body.isBusy())
      .map((room) => room.body.prepareForForcedUpdateRestart()));
    for (const room of rooms) room.controller.abort();
  }

  interruptForServerMinimum(): InterruptedTurn[] {
    this.restartRequested = true;
    const rooms = [...this.running.values()];
    const turns = rooms.map((room) => room.body.interruptForServerMinimum())
      .filter((turn): turn is InterruptedTurn => turn !== undefined);
    for (const room of rooms) room.controller.abort();
    return turns;
  }

  async reconcile(): Promise<WorkspaceMembershipStatus> {
    if (this.stopped) return 'member';
    const existingRooms = new Set(this.running.keys());
    const bootstrap = await this.options.daemonApi.execute('getDaemonBootstrap', {
      agentId: this.agent.publicKey,
    });
    if (this.stopped) return 'member';
    if (!bootstrap.workspaceIds.includes(this.runtime.communityId)) {
      this.workspaceRemovalConfirmations += 1;
      if (this.workspaceRemovalConfirmations < REMOVAL_CONFIRMATION_READS) {
        this.wakeDiscovery();
        return 'unknown';
      }
      return 'not-member';
    }
    this.workspaceRemovalConfirmations = 0;
    const topLevelRooms = bootstrap.rooms.filter((room) => !room.archived);
    for (const room of topLevelRooms) {
      const revision = room.repositoryRevision;
      if (revision === undefined) continue;
      const previous = this.repositoryRevisions.get(room.roomId);
      this.repositoryRevisions.set(room.roomId, revision);
      if (previous === undefined || previous === revision) continue;
      this.invalidateParentRepository(room.roomId);
      const running = this.running.get(room.roomId);
      if (running?.body.isBusy()) {
        this.deferredRepositoryRestarts.add(room.roomId);
      } else if (running) {
        await this.stopRunning(room.roomId, running);
      }
      // A restored App grant can also clear a corner's previous standing
      // checkout fault; those corners retry in this same reconciliation pass.
      for (const [cornerId, parentId] of this.monolithCornerParents)
        if (parentId === room.roomId) this.standingCornerStartFaults.delete(cornerId);
    }
    const desiredTopRooms = topLevelRooms.map((room) => room.roomId);
    const desired = new Set(desiredTopRooms);
    const desiredCorners = new Map<string, DesiredCorner>();
    const archivedCorners = new Map<string, { cornerId: string; parentRoomId: string }>();
    await mapWithConcurrency(topLevelRooms, ROOM_JOIN_CONCURRENCY, async (room) => {
      if (this.stopped) return;
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
        // and retry on the next reconciliation.
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
    if (this.stopped) return 'member';
    for (const roomId of desiredTopRooms) this.surfaceHealth.discover(roomId, 'room');
    for (const cornerId of desiredCorners.keys()) this.surfaceHealth.discover(cornerId, 'corner');
    for (const channelId of desired) this.roomRemovalConfirmations.delete(channelId);
    await this.retryPendingCornerReaps(desired);
    if (this.stopped) return 'member';
    await this.sweepArchivedCornerWorktrees(archivedCorners, desired);
    if (this.stopped) return 'member';
    for (const cornerId of this.idleCornerSubscriptions.keys()) {
      if (desired.has(cornerId)) continue;
      this.unwatchCorner(cornerId);
    }
    for (const [channelId, running] of [...this.running]) {
      if (desired.has(channelId)) continue;
      const confirmations = (this.roomRemovalConfirmations.get(channelId) ?? 0) + 1;
      this.roomRemovalConfirmations.set(channelId, confirmations);
      if (confirmations < REMOVAL_CONFIRMATION_READS) continue;
      await this.stopRunning(channelId, running);
      this.roomRemovalConfirmations.delete(channelId);
    }
    this.surfaceHealth.retain(new Set([...desired, ...this.running.keys()]));
    await mapWithConcurrency(desiredTopRooms, ROOM_JOIN_CONCURRENCY, async (roomId) => {
      if (this.stopped) return;
      if (this.running.has(roomId)) return;
      try {
        await this.startRoom(roomId);
      } catch (error) {
        // One Room's failed start must not block the corner-start pass behind
        // it: a corner opened while a Room cannot materialize its checkout
        // would otherwise never start, while every already-running Room keeps
        // the agent looking healthy. The failed Room retries on the next
        // reconciliation.
        console.error(`[thin-core] failed to start Room ${roomId}:`, error);
      }
    });
    await mapWithConcurrency(
      [...desiredCorners.values()],
      ROOM_JOIN_CONCURRENCY,
      async (corner) => {
        if (this.stopped) return;
        if (!this.running.has(corner.cornerId)) await this.watchCorner(corner);
      },
    );
    for (const [roomId, running] of this.running)
      if (existingRooms.has(roomId)) running.body.requestReconciliation();
    if (this.roomRemovalConfirmations.size) this.wakeDiscovery();
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
          this.wakeDiscovery();
        }),
      );
    }
  }

  /**
   * Incremental apply of one scoped membership push.
   * An unscoped wake still uses the slow reconcile as recovery.
   */
  async applyMembershipEvent(event: RoomMembershipChange): Promise<void> {
    if (this.stopped) return;
    const roomId = event.roomId;
    if (!roomId) {
      this.wakeDiscovery();
      return;
    }
    if (event.removed === true) {
      this.unwatchCorner(roomId);
      const running = this.running.get(roomId);
      if (running) await this.stopRunning(roomId, running);
      this.monolithCornerParents.delete(roomId);
      this.surfaceHealth.remove(roomId);
      return;
    }
    // Inheriting a Room membership writes one row per corner under it, archived
    // ones included, and the reviewer projection rewrites every row again. An
    // archived Room or corner is nothing to start, so the event is dropped here
    // rather than after a restore read per row.
    if (event.archived === true) {
      this.unwatchCorner(roomId);
      this.surfaceHealth.remove(roomId);
      return;
    }
    this.roomRemovalConfirmations.delete(roomId);
    if (this.running.has(roomId) || this.startingCorners.has(roomId)) return;
    if (event.parentRoomId) {
      this.surfaceHealth.discover(roomId, 'corner');
      this.monolithCornerParents.set(roomId, event.parentRoomId);
      // The opener rides the same row that announces the corner. Without it
      // nobody is the opener, so the initial `working` state — the only write
      // of `corner_facts.feature_branch`, which every corner GitHub webhook is
      // resolved by — would never happen. Fall back to the reconcile read that
      // carries the corner's recorded opener rather than starting it blind.
      if (!event.openedBy) {
        this.wakeDiscovery();
        return;
      }
      await this.watchCorner({
        cornerId: roomId,
        parentRoomId: event.parentRoomId,
        openedBy: event.openedBy,
      });
      return;
    }
    this.surfaceHealth.discover(roomId, 'room');
    await this.startRoom(roomId);
  }

  async applyCornerComplete(cornerId: string): Promise<void> {
    this.running.get(cornerId)?.body.requestClose?.();
  }

  /** Retire the scratch runtime. Ordinary desired-state reconciliation starts
   * the same corner id again and re-reads its now-code lane. */
  async applyCornerRestart(cornerId: string): Promise<void> {
    if (this.stopped) return;
    const running = this.running.get(cornerId);
    if (!running) {
      this.wakeDiscovery();
      return;
    }
    await this.stopRunning(cornerId, running, true);
    this.wakeDiscovery();
  }

  private async stopRunning(
    channelId: string,
    running: RunningRoom,
    preserveScratch = false,
  ): Promise<void> {
    this.deferredRepositoryRestarts.delete(channelId);
    running.controller.abort();
    await running.promise.catch(() => undefined);
    try {
      if (running.worktree) await this.reapCornerWorktree(running.worktree);
      else if (running.scratch && !preserveScratch) await this.reapCornerScratch(running.scratch);
    } catch (error) {
      console.error(`[thin-core] corner ${channelId} cleanup failed; will retry:`, error);
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

  /** The loopback door for run_granted_command; started once, on first use. */
  private grantRunnerEndpoint(): Promise<GrantRunnerEndpoint | undefined> {
    return this.grantRunnerServer.start().catch((error) => {
      console.error('[thin-core] grant runner unavailable; run_granted_command is off:', error);
      return undefined;
    });
  }

  private async startRoom(roomId: string): Promise<void> {
    if (this.stopped) return;
    if (this.running.has(roomId) || this.startingRooms.has(roomId)) return;
    this.surfaceHealth.discover(roomId, 'room');
    this.startingRooms.add(roomId);
    try {
      await this.startRoomOnce(roomId);
    } catch (error) {
      this.surfaceHealth.degraded(roomId, 'Room intake failed to start');
      throw error;
    } finally {
      this.startingRooms.delete(roomId);
    }
  }

  private async startRoomOnce(roomId: string): Promise<void> {
    const controller = new AbortController();
    // The turn loop refreshes checkout before activation. Idle Rooms can
    // subscribe to durable commands without fetching a token or running Git.
    const cwd = this.roomRoot(roomId);
    const grantRunnerEndpoint = await this.grantRunnerEndpoint();
    const loop = new MonolithRoomTurnLoop({
      roomId,
      workspaceId: this.runtime.communityId,
      cwd,
      refreshCheckout: () => this.refreshRoomCheckout(roomId),
      grantRunner: this.grantRunner,
      ...(grantRunnerEndpoint ? { grantRunnerEndpoint } : {}),
      runtime: this.runtime,
      config: this.roomConfig(roomId),
      api: this.options.daemonApi,
      scheduler: this.scheduler,
      signal: controller.signal,
      health: { poll: () => this.notePoll(roomId) },
      onSubscriptionState: (connected) => this.surfaceHealth.subscribed(roomId, connected),
      onIntakeError: () => this.surfaceHealth.degraded(roomId, 'Room command intake failed'),
      onRestartRequested: () => this.requestLifecycleRestart(),
      canStartTurn: () => !this.restartRequested,
      supervisor: this.supervisor,
    });
    const promise = loop
      .run()
      .catch((error) => {
        if (!controller.signal.aborted) {
          this.surfaceHealth.degraded(roomId, 'Room command loop exited');
          console.error(`[thin-core] Room ${roomId} failed:`, error);
        }
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
    this.running.set(roomId, { body: loop, controller, promise });
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
    repository ??= await this.parentRepositoryState(roomId);
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
      ? await this.parentRepositoryToken(roomId)
      : undefined;
    const env = token ? githubGitEnv(token.token) : process.env;
    if (!existsSync(resolve(path, '.git'))) {
      await execFileAsync('git', ['clone', '--no-checkout', remote, path], {
        env,
        maxBuffer: 4 * 1024 * 1024,
      });
    }
    const fetched = await execFileAsync(
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
    ).then(
      () => true,
      (error) => {
        if (isRemoteRefMissing(error)) return false;
        throw error;
      },
    );
    if (!fetched) {
      void this.options.daemonApi
        .execute('noteEmptyRoomRepository', { roomId })
        .catch((error) =>
          console.warn(`[thin-core] Room ${roomId} empty-repository notice failed:`, error),
        );
      return this.roomRoot(roomId);
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

  private async refreshRoomCheckout(
    roomId: string,
  ): Promise<{ cwd: string; branch?: string; commit?: string }> {
    try {
      const repository = await this.parentRepositoryState(roomId);
      if (repository.resolution !== 'repository' || !repository.remote)
        return { cwd: this.roomRoot(roomId) };
      const branch = repository.targetBranch || 'main';
      const cwd = await this.materializeRoomCheckout(roomId, repository);
      if (cwd === this.roomRoot(roomId)) return { cwd };
      const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--verify', 'HEAD']);
      return { cwd, branch, commit: stdout.trim() };
    } catch (error) {
      console.warn(`[thin-core] Room ${roomId} checkout refresh unavailable:`, error);
      return { cwd: this.roomRoot(roomId) };
    }
  }

  private async startCorner(corner: DesiredCorner): Promise<void> {
    if (this.stopped) return;
    if (this.running.has(corner.cornerId) || this.startingCorners.has(corner.cornerId)) return;
    this.surfaceHealth.discover(corner.cornerId, 'corner');
    this.startingCorners.add(corner.cornerId);
    let configKey: string | undefined;
    try {
      const [restore, repository] = await Promise.all([
        this.options.daemonApi.execute('getCornerRestoreState', { cornerId: corner.cornerId }),
        this.parentRepositoryState(corner.parentRoomId),
      ]);
      const objective =
        (restore.objective ?? '').trim() ||
        (restore.kind === 'human' ? (restore.title ?? '').trim() : '');
      configKey = cornerStartConfigKey(repository, objective);
      const previousStanding = this.standingCornerStartFaults.get(corner.cornerId);
      if (previousStanding?.configKey === configKey) {
        // Not retried, but a request made since is still told why.
        await this.reportCornerStartFailure(corner.cornerId, previousStanding.error);
        return;
      }
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
      const scratchPath = resolve(this.roomRoot(corner.cornerId), 'scratch');
      if (repositoryBacked && existsSync(scratchPath) && !restore.featureBranch)
        throw new Error('promoted corner has no server-assigned feature branch');
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
      // A no-code corner's scratch is that session's own workspace, with its
      // harness home inside it. None of it becomes the code branch: the code
      // session starts from the target branch alone, and the scratch is reaped.
      if (worktree && existsSync(scratchPath))
        await this.reapCornerScratch({ path: scratchPath, cornerId: corner.cornerId });
      const workspacePath = worktree?.path ?? resolve(this.roomRoot(corner.cornerId), 'scratch');
      if (!worktree) await mkdir(workspacePath, { recursive: true, mode: 0o700 });
      if (worktree && shouldPostInitialCornerWorkingState(restore)) {
        await this.options.daemonApi.execute('postCornerRemoteState', {
          cornerId: corner.cornerId,
          branch: featureBranch!,
          state: 'working',
          checks: 'unknown',
        });
      }
      const controller = new AbortController();
      const grantRunnerEndpoint = await this.grantRunnerEndpoint();
      const loop = new MonolithCornerTurnLoop({
        cornerId: corner.cornerId,
        grantRunner: this.grantRunner,
        ...(grantRunnerEndpoint ? { grantRunnerEndpoint } : {}),
        connectorUsage: this.connectorUsage,
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
        onSubscriptionState: (connected) => this.surfaceHealth.subscribed(corner.cornerId, connected),
        onIntakeError: () => this.surfaceHealth.degraded(corner.cornerId, 'corner command intake failed'),
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
        supervisor: this.supervisor,
      });
      const promise = loop
        .run()
        .catch((error) => {
          if (!controller.signal.aborted) {
            this.surfaceHealth.degraded(corner.cornerId, 'corner command loop exited');
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
      this.surfaceHealth.degraded(corner.cornerId, 'corner failed to start');
      console.error(`[thin-core] failed to start corner ${corner.cornerId}:`, error);
      // Keep the pending command available for the next reconciliation. A
      // temporary token lookup must not turn into a human repair request.
      if (error instanceof CornerCredentialLookupError) return;
      const reported = await this.reportCornerStartFailure(corner.cornerId, error);
      if (reported && isStandingCornerStartFault(error) && configKey) {
        this.standingCornerStartFaults.set(corner.cornerId, { configKey, error });
      }
    } finally {
      this.startingCorners.delete(corner.cornerId);
    }
  }

  private async watchCorner(corner: DesiredCorner): Promise<void> {
    if (this.stopped) return;
    const cornerId = corner.cornerId;
    if (this.running.has(cornerId)) return;
    if (this.idleCornerSubscriptions.has(cornerId)) {
      if (this.pendingCornerCommands.has(cornerId)) await this.activateWatchedCorner(corner);
      return;
    }
    if (!this.options.daemonApi.liveSubscribe) {
      await this.startCorner(corner);
      if (!this.running.has(cornerId)) this.wakeDiscovery();
      return;
    }
    this.idleCornerSubscriptions.set(cornerId, () => undefined);
    const release = this.options.daemonApi.liveSubscribe(
      cornerId,
      undefined,
      undefined,
      (connected, capabilities) => {
        if (connected && capabilities?.pushIntake !== true) {
          // A rolling old server cannot deliver command snapshots; retain
          // the pre-lazy startup path until it can.
          this.pendingCornerCommands.add(cornerId);
          void this.activateWatchedCorner(corner, true);
        }
      },
      undefined,
      (commands) => {
        if (!commands.length) return;
        this.pendingCornerCommands.add(cornerId);
        void this.activateWatchedCorner(corner, true);
      },
    );
    this.idleCornerSubscriptions.set(cornerId, release);
    if (this.pendingCornerCommands.has(cornerId)) await this.activateWatchedCorner(corner);
  }

  private unwatchCorner(cornerId: string): void {
    this.idleCornerSubscriptions.get(cornerId)?.();
    this.idleCornerSubscriptions.delete(cornerId);
    this.pendingCornerCommands.delete(cornerId);
  }

  private async activateWatchedCorner(corner: DesiredCorner, wakeOnFailure = false): Promise<void> {
    if (this.stopped || !this.idleCornerSubscriptions.has(corner.cornerId)) return;
    await this.startCorner(corner);
    if (this.running.has(corner.cornerId)) {
      this.unwatchCorner(corner.cornerId);
    } else if (wakeOnFailure) {
      this.wakeDiscovery();
    }
  }

  private async cornerRepositoryToken(
    roomId: string,
  ): Promise<{ token: string; expiresAt: number }> {
    try {
      return await this.parentRepositoryToken(roomId);
    } catch (error) {
      if (error instanceof DaemonApiError && !error.retryable) throw error;
      throw new CornerCredentialLookupError(error);
    }
  }

  private invalidateParentRepository(roomId: string): void {
    this.repositoryStateCache.delete(roomId);
    this.repositoryStateFlights.delete(roomId);
    this.tokenCache.delete(roomId);
    this.tokenFlights.delete(roomId);
  }

  private async parentRepositoryState(roomId: string): Promise<RoomRepositoryStateResult> {
    const cached = this.repositoryStateCache.get(roomId);
    if (cached && cached.until > this.now()) return cached.value;
    const existing = this.repositoryStateFlights.get(roomId);
    if (existing) return existing;
    const flight = this.options.daemonApi.execute('getRoomRepositoryState', { roomId });
    this.repositoryStateFlights.set(roomId, flight);
    try {
      const value = await flight;
      if (this.repositoryStateFlights.get(roomId) === flight)
        this.repositoryStateCache.set(roomId, { value, until: this.now() + 5_000 });
      return value;
    } finally {
      if (this.repositoryStateFlights.get(roomId) === flight)
        this.repositoryStateFlights.delete(roomId);
    }
  }

  private async parentRepositoryToken(roomId: string): Promise<RoomGitHubTokenResult> {
    const cached = this.tokenCache.get(roomId);
    if (cached && cached.expiresAt - 10_000 > this.now()) return cached;
    const existing = this.tokenFlights.get(roomId);
    if (existing) return existing;
    const flight = this.options.daemonApi.execute('getRoomGitHubToken', { roomId });
    this.tokenFlights.set(roomId, flight);
    try {
      const value = await flight;
      if (this.tokenFlights.get(roomId) === flight && value.expiresAt - 10_000 > this.now())
        this.tokenCache.set(roomId, value);
      return value;
    } finally {
      if (this.tokenFlights.get(roomId) === flight) this.tokenFlights.delete(roomId);
    }
  }

  /**
   * An agent addressed in a corner it then could not restore must not be
   * silent about it.
   *
   * The corner never starts, so no turn ever runs. Report against the actual
   * pending command — never a fabricated generation — so the server can
   * authorize the failed receipt and inscribe the Room line. Every pending
   * request is told once, so a person who asks again while the corner still
   * cannot start sees the failure under the new message too. Standing
   * workspace-configuration faults are not retried until that configuration
   * changes; clone/network failures keep retrying.
   */
  private async reportCornerStartFailure(cornerId: string, error: unknown): Promise<boolean> {
    try {
      const { commands } = await this.options.daemonApi.execute('getAgentCommands', {
        roomId: cornerId,
      });
      const requests = new Set(
        commands
          .filter((command) => command.action === 'input' || command.action === 'resume')
          .map((command) => command.turnRequestId),
      );
      if (!requests.size) return false;
      const reported = this.reportedCornerStartFailures.get(cornerId) ?? new Set<string>();
      this.reportedCornerStartFailures.set(cornerId, reported);
      const reason = distillTurnFailureReason(error);
      for (const requestId of requests) {
        if (reported.has(requestId)) continue;
        await this.options.daemonApi.execute('postAgentTurnReceipt', {
          agentId: this.agent.publicKey,
          roomId: cornerId,
          requestId,
          status: 'failed',
          reason: reason.text,
          ...(reason.kind ? { reasonKind: reason.kind } : {}),
        });
        reported.add(requestId);
      }
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
    const worktree = await materializeCornerWorktree({
      ...input,
      supervisorRoot: this.runtime.supervisorRoot,
      committer: { name: this.agent.name, publicKey: this.agent.publicKey },
    });
    (await this.getLocalWorktreeIds()).add(input.cornerId);
    return worktree;
  }

  private getLocalWorktreeIds(): Promise<Set<string>> {
    return (this.localWorktreeIds ??= localCornerWorktreeIds(this.runtime.supervisorRoot));
  }

  private archiveCleanupDue(cornerId: string): boolean {
    return (this.archiveCleanupFaults.get(cornerId)?.retryAt ?? 0) <= this.now();
  }

  private deferArchiveCleanup(cornerId: string): void {
    const failures = Math.min((this.archiveCleanupFaults.get(cornerId)?.failures ?? 0) + 1, 9);
    this.archiveCleanupFaults.set(cornerId, {
      failures,
      retryAt: this.now() + Math.min(1_000 * 2 ** failures, 5 * 60_000),
    });
  }

  private async retryPendingCornerReaps(desired: ReadonlySet<string>): Promise<void> {
    for (const [cornerId, worktree] of [...this.pendingCornerReaps]) {
      if (desired.has(cornerId)) {
        this.pendingCornerReaps.delete(cornerId);
        continue;
      }
      if (!this.archiveCleanupDue(cornerId)) continue;
      try {
        await this.reapCornerWorktree(worktree);
      } catch (error) {
        this.deferArchiveCleanup(cornerId);
        console.error(`[thin-core] corner ${cornerId} branch cleanup retry failed:`, error);
        // Cleanup retries ride the next reconciliation. Waking discovery
        // here would repeat every Room and archived-corner read.
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
    desired: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const localIds = await this.getLocalWorktreeIds();
    for (const cornerId of [...localIds]) {
      if (
        desired.has(cornerId) ||
        this.running.has(cornerId) ||
        this.pendingCornerReaps.has(cornerId)
      )
        continue;
      if (!this.archiveCleanupDue(cornerId)) continue;
      if (this.archiveCleanupAccessDenied.has(cornerId) && !corners.has(cornerId)) continue;
      this.archiveCleanupAccessDenied.delete(cornerId);
      let corner = corners.get(cornerId);
      let discovered: DiscoveredCornerWorktree | undefined;
      try {
        discovered = await discoverCornerWorktree(this.runtime.supervisorRoot, cornerId);
        if (!discovered) {
          localIds.delete(cornerId);
          continue;
        }
        const restore = (await this.options.daemonApi.execute('getCornerRestoreState', {
          cornerId,
        })) as CornerRestoreResult & { archived?: boolean; parentRoomId?: string };
        // An old server names archived corners in listRoomCorners but omits
        // these restore fields. A new server can omit them from the active-only
        // list; cleanup then requires its explicit archive and parent facts.
        if (restore.archived === false) continue;
        if (!corner) {
          if (restore.archived !== true || !restore.parentRoomId) continue;
          corner = { cornerId, parentRoomId: restore.parentRoomId };
        } else if (restore.parentRoomId && restore.parentRoomId !== corner.parentRoomId) {
          throw new Error(`archived corner ${cornerId} parent Room changed during cleanup`);
        }
        const repository = await this.options.daemonApi.execute('getRoomRepositoryState', {
          roomId: corner.parentRoomId,
        });
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
        console.log(`[thin-core] swept archived corner worktree ${cornerId}`);
      } catch (error) {
        if (error instanceof DaemonApiError && error.status === 403)
          this.archiveCleanupAccessDenied.add(cornerId);
        else this.deferArchiveCleanup(cornerId);
        console.error(`[thin-core] archived corner ${cornerId} cleanup deferred:`, error);
        // The checkout remains for the next reconciliation. A stale or unsafe
        // checkout cannot require another full discovery immediately.
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
      this.archiveCleanupFaults.delete(worktree.cornerId);
      (await this.getLocalWorktreeIds()).delete(worktree.cornerId);
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
    this.surfaceHealth.intakeReady(roomId);
    const room = this.running.get(roomId);
    if (!room) return;
    if (this.deferredRepositoryRestarts.has(roomId) && !room.body.isBusy()) {
      this.deferredRepositoryRestarts.delete(roomId);
      void this.stopRunning(roomId, room)
        .then(() => this.stopped ? undefined : this.startRoom(roomId))
        .catch((error) => {
          console.error(`[thin-core] failed to restart Room ${roomId} after repository change:`, error);
          this.wakeDiscovery();
        });
    }
    if (this.isWorkspaceIdle()) this.interactiveIdleListener?.();
  }

  beginShutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.restartRequested = true;
    for (const cornerId of this.idleCornerSubscriptions.keys()) this.unwatchCorner(cornerId);
    this.options.daemonApi.closeLive?.();
    this.pendingMembershipEvents.clear();
    for (const room of this.running.values()) room.controller.abort();
  }

  async shutdown(): Promise<void> {
    // A pushed membership apply runs outside the run loop's signal, so a Room
    // whose start is in flight here would land in `running` after the abort
    // pass and never be stopped — its live subscription outlives the daemon.
    // Refuse further pushes, then wait — to the deadline, never past it — for
    // the in-flight apply, so whatever it started is in the snapshot below.
    this.beginShutdown();
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
