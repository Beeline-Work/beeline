import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import type { CornerRestoreResult } from '@beeline/api-contract/daemon';
import { GrantCommandRunner, GrantRunnerServer, type GrantRunnerEndpoint } from './grant-runner.js';
import { MonolithCornerTurnLoop } from './monolith-corner-turn.js';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import { openRouterRoutingCacheDir } from './openrouter-routing.js';
import { turnTraceDirectory } from './turn-trace.js';
import { distillTurnFailureReason } from './turn-failure-reason.js';
import type { AgentRuntimeRecord, RoomRuntimeRecord } from './runtime.js';
import { runtimeIdentity } from './runtime.js';
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
export const DEFAULT_RECONCILE_HEARTBEAT_MS = 60_000;
export const DEFAULT_DRAIN_DEADLINE_MS = 30 * 60_000;

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
  return (
    isOpener && !restore.featureBranch && !restore.lifecycle?.branch && !restore.lifecycle?.pr
  );
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
  const repositoryHash = createHash('sha256').update(remote).digest('hex').slice(0, 24);
  const gitCommonDir = resolve(
    input.supervisorRoot,
    'beeline',
    'repositories',
    `${repositoryHash}.git`,
  );
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
    () => false,
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
  await execFileAsync('git', ['-C', path, 'config', '--worktree', 'user.name', input.committer.name]);
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
  | 'currentPrincipalCanDrive'
  | 'isBusy'
  | 'prepareForForcedUpdateRestart'
  | 'refreshPersonaForSoulUpdate'
  | 'forceRecoverRoom'
>;

interface RunningRoom {
  body: RoomLeaf;
  controller: AbortController;
  promise: Promise<void>;
  lastPollAt: number;
  backoffUntil: number;
  recovering: boolean;
  worktree?: CornerWorktree;
}

interface CornerWorktree {
  path: string;
  gitCommonDir: string;
  cornerId: string;
  branch: string;
}

interface DesiredCorner {
  cornerId: string;
  parentRoomId: string;
  /** The agent that opened it. History and a start rule, never an access check. */
  openedBy?: string;
}

const execFileAsync = promisify(execFile);

/** Monolith-only Room supervisor. Relay-backed discovery and turn serving are retired. */
export class RoomRuntimeCoordinator {
  private readonly runtime: AgentRuntimeRecord;
  private readonly running = new Map<string, RunningRoom>();
  private readonly startingCorners = new Set<string>();
  /** Corners whose start failure has already been said out loud, once each. */
  private readonly reportedCornerStartFailures = new Set<string>();
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
  /** One command-grant runner per daemon; Rooms and corners register their checkouts on it. */
  private readonly grantRunner: GrantCommandRunner;
  private readonly grantRunnerServer: GrantRunnerServer;

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
    return this.confirmationPending;
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

  async currentPrincipalCanDrive(
    roomId: string,
    workspaceId: string,
    principalId: string,
  ): Promise<boolean | undefined> {
    return this.running.get(roomId)?.body.currentPrincipalCanDrive(workspaceId, principalId);
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
    await mapWithConcurrency(topLevelRooms, ROOM_JOIN_CONCURRENCY, async (room) => {
      try {
        const result = await this.options.daemonApi.execute('listRoomCorners', {
          roomId: room.roomId,
        });
        for (const corner of result.corners) {
          this.monolithCornerParents.set(corner.cornerId, room.roomId);
          if (!corner.archived) {
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
    for (const [channelId, running] of [...this.running]) {
      if (desired.has(channelId)) continue;
      const confirmations = (this.roomRemovalConfirmations.get(channelId) ?? 0) + 1;
      this.roomRemovalConfirmations.set(channelId, confirmations);
      if (confirmations < REMOVAL_CONFIRMATION_READS) {
        this.confirmationPending = true;
        continue;
      }
      running.controller.abort();
      await running.promise.catch(() => undefined);
      if (running.worktree) await this.reapCornerWorktree(running.worktree);
    }
    await mapWithConcurrency(desiredTopRooms, ROOM_JOIN_CONCURRENCY, async (roomId) => {
      if (!this.running.has(roomId)) await this.startRoom(roomId);
    });
    await mapWithConcurrency(
      [...desiredCorners.values()],
      ROOM_JOIN_CONCURRENCY,
      async (corner) => {
        if (!this.running.has(corner.cornerId)) await this.startCorner(corner);
      },
    );
    return 'member';
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

  private roomConfig(roomId: string): BodyConfig {
    const workspaceRoot = this.roomRoot(roomId);
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
    const controller = new AbortController();
    const cwd = await this.materializeRoomCheckout(roomId);
    const grantRunnerEndpoint = await this.grantRunnerEndpoint();
    const startedAt = this.now();
    const loop = new MonolithRoomTurnLoop({
      roomId,
      workspaceId: this.runtime.communityId,
      cwd,
      grantRunner: this.grantRunner,
      ...(grantRunnerEndpoint ? { grantRunnerEndpoint } : {}),
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
    });
    const promise = loop
      .run()
      .catch((error) => {
        if (!controller.signal.aborted) console.error(`[thin-core] Room ${roomId} failed:`, error);
      })
      .finally(() => {
        if (this.running.get(roomId)?.body === loop) this.running.delete(roomId);
      });
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
  private async materializeRoomCheckout(roomId: string): Promise<string> {
    const repository = await this.options.daemonApi.execute('getRoomRepositoryState', { roomId });
    if (repository.resolution !== 'repository' || !repository.remote) return this.roomRoot(roomId);

    const remote = roomCheckoutRemote(repository.remote);
    const targetBranch = repository.targetBranch || 'main';
    const checkoutId = createHash('sha256')
      .update(`${remote}\0${targetBranch}`)
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
    await execFileAsync('git', ['-C', path, 'checkout', '--detach', '--force', `origin/${targetBranch}`], {
      env,
      maxBuffer: 4 * 1024 * 1024,
    });
    return path;
  }

  private async startCorner(corner: DesiredCorner): Promise<void> {
    if (this.running.has(corner.cornerId) || this.startingCorners.has(corner.cornerId)) return;
    this.startingCorners.add(corner.cornerId);
    try {
      const [restore, repository, conversation, granted] = await Promise.all([
        this.options.daemonApi.execute('getCornerRestoreState', { cornerId: corner.cornerId }),
        this.options.daemonApi.execute('getRoomRepositoryState', {
          roomId: corner.parentRoomId,
        }),
        // Startup recovers the objective from the corner's FIRST durable
        // message, so this is the one conversation read that wants the oldest
        // end of the Room. Every other read defaults to the newest page.
        this.options.daemonApi.execute('getRoomConversation', {
          roomId: corner.cornerId,
          limit: 200,
          window: 'earliest',
        }),
        this.options.daemonApi.execute('getRoomGitHubToken', {
          roomId: corner.parentRoomId,
        }),
      ]);
      if (repository.resolution !== 'repository' || !repository.remote || !repository.key) {
        throw new Error('corner parent Room has no verified repository binding');
      }
      const objective = conversation.items.find((item) => item.type === 'message')?.body.trim();
      if (!objective) throw new Error('corner has no durable objective post');
      const targetBranch = repository.targetBranch || 'main';
      const featureBranch =
        restore.featureBranch ??
        `feature/corner-${corner.cornerId.replaceAll('-', '').slice(0, 12)}`;
      const worktree = await this.materializeCornerWorktree({
        cornerId: corner.cornerId,
        remote: repository.remote,
        targetBranch,
        featureBranch,
        token: granted.token,
      });
      const isOpener = !corner.openedBy || corner.openedBy === this.agent.publicKey;
      if (shouldPostInitialCornerWorkingState(restore, isOpener)) {
        await this.options.daemonApi.execute('postCornerRemoteState', {
          cornerId: corner.cornerId,
          branch: featureBranch,
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
        parentRoomId: corner.parentRoomId,
        workspaceId: this.runtime.communityId,
        ...(corner.openedBy ? { openedBy: corner.openedBy } : {}),
        objective,
        featureBranch,
        targetBranch,
        worktreePath: worktree.path,
        gitCommonDir: worktree.gitCommonDir,
        githubToken: granted.token,
        runtime: this.runtime,
        config: this.roomConfig(corner.cornerId),
        api: this.options.daemonApi,
        scheduler: this.scheduler,
        signal: controller.signal,
        onPoll: () => this.notePoll(corner.cornerId),
        onFailure: (retryInMs) => this.noteFailure(corner.cornerId, retryInMs),
        onCloseRequested: () =>
          this.reapCornerWorktree({
            ...worktree,
            cornerId: corner.cornerId,
            branch: featureBranch,
          }),
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
      this.running.set(corner.cornerId, {
        body: loop,
        controller,
        promise,
        lastPollAt: startedAt,
        backoffUntil: 0,
        recovering: false,
        worktree: {
          ...worktree,
          cornerId: corner.cornerId,
          branch: featureBranch,
        },
      });
      this.reportedCornerStartFailures.delete(corner.cornerId);
      console.log(
        `[thin-core] serving corner ${corner.cornerId} on ${featureBranch} at ${worktree.path}`,
      );
    } catch (error) {
      console.error(`[thin-core] failed to start corner ${corner.cornerId}:`, error);
      await this.reportCornerStartFailure(corner.cornerId, error);
    } finally {
      this.startingCorners.delete(corner.cornerId);
    }
  }

  /**
   * An agent addressed in a corner it then could not restore must not be
   * silent about it.
   *
   * The corner never starts, so no turn ever runs and nothing else in the
   * daemon has a Room to say it in. This posts a FAILED receipt against the
   * message that asked, which the server inscribes as `<agent> could not
   * answer · <reason>` in the corner itself. Once per corner per process: the
   * reconciliation heartbeat retries the start for as long as it keeps
   * failing, and the fact is worth saying once, not once a minute.
   */
  private async reportCornerStartFailure(cornerId: string, error: unknown): Promise<void> {
    if (this.reportedCornerStartFailures.has(cornerId)) return;
    this.reportedCornerStartFailures.add(cornerId);
    try {
      const conversation = await this.options.daemonApi.execute('getRoomConversation', {
        roomId: cornerId,
        limit: 50,
      });
      const asked = [...conversation.items]
        .reverse()
        .find(
          (item) => item.type === 'message' && item.mentionIds.includes(this.agent.publicKey),
        );
      if (!asked) return;
      await this.options.daemonApi.execute('postAgentTurnReceipt', {
        agentId: this.agent.publicKey,
        roomId: cornerId,
        requestId: asked.id,
        status: 'failed',
        generationId: `${this.agent.publicKey}:${cornerId}`,
        reason: distillTurnFailureReason(error),
      });
    } catch (reportError) {
      console.error(`[thin-core] corner ${cornerId} start-failure report failed:`, reportError);
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

  private async reapCornerWorktree(worktree: CornerWorktree): Promise<void> {
    if (existsSync(worktree.path)) {
      await execFileAsync('git', [
        `--git-dir=${worktree.gitCommonDir}`,
        'worktree',
        'remove',
        '--force',
        worktree.path,
      ]);
    }
    await this.options.daemonApi.execute('postCornerRemoteState', {
      cornerId: worktree.cornerId,
      branch: worktree.branch,
      state: 'gone',
      checks: 'unknown',
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
    const rooms = [...this.running.values()];
    for (const room of rooms) room.controller.abort();
    const drained = Promise.all(rooms.map((room) => room.promise.catch(() => undefined)));
    const deadlineAt = Math.min(
      this.now() + this.drainDeadlineMs,
      this.drainDeadlineAt ?? Number.POSITIVE_INFINITY,
    );
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'deadline'>((resolveDeadline) => {
      timer = setTimeout(() => resolveDeadline('deadline'), Math.max(0, deadlineAt - this.now()));
    });
    const result = await Promise.race([drained.then(() => 'drained' as const), deadline]);
    if (timer) clearTimeout(timer);
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
