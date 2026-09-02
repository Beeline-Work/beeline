import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import type { AgentRuntimeRecord, RoomRuntimeRecord } from './runtime.js';
import { runtimeIdentity } from './runtime.js';
import {
  DEFAULT_WORKSPACE_LIVE_SESSIONS_FLOOR,
  resolvePerRoomLiveSessions,
  SessionScheduler,
} from './session-scheduler.js';

export type WorkspaceMembershipStatus = 'member' | 'not-member' | 'unknown';
export const REMOVAL_CONFIRMATION_READS = 2;
export const ROOM_JOIN_CONCURRENCY = 4;
export const DEFAULT_ROOM_WATCHDOG_STALE_MS = 90_000;
export const DEFAULT_RECONCILE_HEARTBEAT_MS = 60_000;
export const DEFAULT_DRAIN_DEADLINE_MS = 30 * 60_000;

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
  MonolithRoomTurnLoop,
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
}

/** Monolith-only Room supervisor. Relay-backed discovery and turn serving are retired. */
export class RoomRuntimeCoordinator {
  private readonly runtime: AgentRuntimeRecord;
  private readonly running = new Map<string, RunningRoom>();
  private readonly scheduler: SessionScheduler;
  private readonly agent: ReturnType<typeof runtimeIdentity>;
  private readonly now: () => number;
  private readonly watchdogStaleMs: number;
  private readonly reconcileHeartbeatMs: number;
  private readonly drainDeadlineMs: number;
  private drainDeadlineAt: number | undefined;
  private workspaceRemovalConfirmations = 0;
  private readonly roomRemovalConfirmations = new Map<string, number>();
  private confirmationPending = false;

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
      idleMs: Number(process.env.BUZZY_BODY_SESSION_IDLE_MS ?? String(5 * 60_000)),
      reserveInteractiveSlot: true,
    });
  }

  activeRoomIds(): string[] {
    return [...this.running.keys()].sort();
  }

  activeRoomCount(): number {
    return this.running.size;
  }

  needsFastReconcile(): boolean {
    return this.confirmationPending;
  }

  reconcileHeartbeatIntervalMs(): number {
    return this.reconcileHeartbeatMs;
  }

  isWorkspaceIdle(): boolean {
    return [...this.running.values()].every((room) => !room.body.isBusy());
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
      rooms.filter((room) => room.body.isBusy()).map((room) => room.body.prepareForForcedUpdateRestart()),
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
    const desired = new Set(
      bootstrap.rooms.filter((room) => !room.archived).map((room) => room.roomId),
    );
    for (const roomId of desired) this.roomRemovalConfirmations.delete(roomId);
    for (const [roomId, running] of [...this.running]) {
      if (desired.has(roomId)) continue;
      const confirmations = (this.roomRemovalConfirmations.get(roomId) ?? 0) + 1;
      this.roomRemovalConfirmations.set(roomId, confirmations);
      if (confirmations < REMOVAL_CONFIRMATION_READS) {
        this.confirmationPending = true;
        continue;
      }
      running.controller.abort();
      await running.promise.catch(() => undefined);
    }
    await mapWithConcurrency([...desired], ROOM_JOIN_CONCURRENCY, async (roomId) => {
      if (!this.running.has(roomId)) this.startRoom(roomId);
    });
    return 'member';
  }

  private roomRecord(roomId: string): RoomRuntimeRecord | undefined {
    return this.runtime.rooms.find((room) => room.channelId === roomId);
  }

  private roomRoot(roomId: string): string {
    return this.roomRecord(roomId)?.root ?? resolve(dirname(this.configPath), 'rooms', roomId);
  }

  private roomAgentHomeRoot(workspaceRoot: string): string | undefined {
    const flag = process.env.BUZZY_BODY_ROOM_HOME;
    if (flag === '0') return undefined;
    const home = resolve(workspaceRoot, 'agent-home');
    if (flag !== '1' && !existsSync(home) && existsSync(workspaceRoot)) return undefined;
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
    const agentHomeRoot = this.roomAgentHomeRoot(workspaceRoot);
    return {
      ...this.baseConfig,
      workspaceRoot,
      agentPrivateRoot: resolve(workspaceRoot, 'agent-private'),
      agentMemoryRoot: resolve(dirname(this.configPath), 'memory'),
      ...(agentHomeRoot ? { agentHomeRoot } : {}),
    };
  }

  private startRoom(roomId: string): void {
    const controller = new AbortController();
    const record = this.roomRecord(roomId);
    const cwd = record?.repo.root ?? this.roomRoot(roomId);
    const startedAt = this.now();
    const loop = new MonolithRoomTurnLoop({
      roomId,
      workspaceId: this.runtime.communityId,
      cwd,
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
      if (this.now() <= Math.max(room.lastPollAt + this.watchdogStaleMs, room.backoffUntil)) continue;
      room.recovering = true;
      room.controller.abort();
      await room.promise.catch(() => undefined);
      if (!this.running.has(roomId)) this.startRoom(roomId);
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
    await this.scheduler.dispose();
  }
}
