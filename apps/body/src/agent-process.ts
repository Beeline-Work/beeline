import { AcpRuntimeExitedError, AcpResourceLimitError, type AcpClient } from './acp.js';

export function isAgentProcessExit(error: unknown): boolean {
  return error instanceof AcpRuntimeExitedError || error instanceof AcpResourceLimitError;
}

/** All production ACP process starts and stops pass through this module. */
export async function startAgentProcess(client: AcpClient): Promise<void> {
  try {
    await client.startProcess();
  } catch (error) {
    await client.stopProcess().catch(() => undefined);
    throw error;
  }
}
export async function stopAgentProcess(client: AcpClient): Promise<void> {
  await client.stopProcess();
}

export interface AgentProcessLifecycle {
  start(): Promise<string>;
  stop(force?: boolean): Promise<void>;
  isCurrent?(): Promise<boolean>;
  isRunning?(): boolean;
  idleMs?: number;
  hasBackgroundWork?(): boolean;
  /** Process exit and background tool completion are events, never a sweep. */
  onWorkChanged?(listener: () => void): () => void;
}
export interface AgentProcessSnapshot {
  running: number;
  busy: number;
  queuedChannels: number;
  warm: number;
}
export const DEFAULT_SESSION_IDLE_MS = 30 * 60_000;
export function resolveSessionIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.BEELINE_BODY_SESSION_IDLE_MS);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_SESSION_IDLE_MS;
}
interface RunningProcess {
  lifecycle: AgentProcessLifecycle;
  physicalSessionId?: string;
  started?: Promise<string>;
  idleTimer?: NodeJS.Timeout;
  unsubscribe?: () => void;
}
interface QueuedTurn {
  lifecycle: AgentProcessLifecycle;
  task(): Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/** Unlimited processes, one FIFO per conversation, one countdown after its last work. */
export class AgentProcesses {
  private static readonly instances = new Set<AgentProcesses>();
  static hostStoragePaused = false;
  private static readonly hostRoomStorage = new Set<string>();
  private static readonly storageAvailable = new Set<(key?: string) => void>();
  private readonly running = new Map<string, RunningProcess>();
  private readonly busy = new Set<string>();
  private readonly queues = new Map<string, QueuedTurn[]>();
  private readonly drainingKeys = new Set<string>();
  private readonly stopping = new Map<string, Promise<void>>();
  private readonly storageMaintenance = new Set<string>();
  private readonly physicalHistory = new Map<string, string[]>();
  private disposed = false;
  private readonly idleMs: number;

  constructor(options: { idleMs?: number } = {}) {
    this.idleMs = options.idleMs ?? DEFAULT_SESSION_IDLE_MS;
    if (!Number.isSafeInteger(this.idleMs) || this.idleMs < 1)
      throw new Error('idleMs must be a positive integer');
    AgentProcesses.instances.add(this);
  }
  static onStorageAvailable(listener: (key?: string) => void): () => void {
    this.storageAvailable.add(listener);
    return () => {
      this.storageAvailable.delete(listener);
    };
  }
  private static notifyStorageAvailable(key?: string): void {
    for (const listener of this.storageAvailable) listener(key);
  }
  static roomStoragePaused(key: string): boolean {
    return this.hostRoomStorage.has(key);
  }
  private holds(key: string): boolean {
    return (
      this.running.has(key) ||
      this.busy.has(key) ||
      this.queues.has(key) ||
      this.drainingKeys.has(key) ||
      this.stopping.has(key) ||
      this.storageMaintenance.has(key)
    );
  }
  static async withIdleHostRoom(key: string, task: () => Promise<void>): Promise<boolean> {
    if (
      this.hostStoragePaused ||
      this.hostRoomStorage.has(key) ||
      [...this.instances].some((owner) => owner.holds(key))
    )
      return false;
    this.hostRoomStorage.add(key);
    try {
      await task();
      return true;
    } finally {
      this.hostRoomStorage.delete(key);
      for (const owner of this.instances) void owner.drainKey(key);
      this.notifyStorageAvailable(key);
    }
  }
  static async withIdleHostStorage(
    task: () => Promise<void>,
    options: { allowLiveSessions?: boolean } = {},
  ): Promise<boolean> {
    if (
      this.hostStoragePaused ||
      this.hostRoomStorage.size ||
      [...this.instances].some(
        (owner) =>
          (!options.allowLiveSessions &&
            (owner.running.size ||
              owner.busy.size ||
              owner.queues.size ||
              owner.drainingKeys.size)) ||
          owner.stopping.size ||
          owner.storageMaintenance.size,
      )
    )
      return false;
    this.hostStoragePaused = true;
    try {
      await task();
      return true;
    } finally {
      this.hostStoragePaused = false;
      for (const owner of this.instances)
        for (const key of owner.queues.keys()) void owner.drainKey(key);
      this.notifyStorageAvailable();
    }
  }
  async withIdleStorage(key: string, task: () => Promise<void>): Promise<boolean> {
    if (
      AgentProcesses.hostStoragePaused ||
      AgentProcesses.roomStoragePaused(key) ||
      this.holds(key)
    )
      return false;
    this.storageMaintenance.add(key);
    try {
      await task();
      return true;
    } finally {
      this.storageMaintenance.delete(key);
      void this.drainKey(key);
      AgentProcesses.notifyStorageAvailable(key);
    }
  }
  run<T>(key: string, lifecycle: AgentProcessLifecycle, task: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('agent processes disposed'));
    this.clearWarmTimer(this.running.get(key));
    return new Promise<T>((resolve, reject) => {
      const turn: QueuedTurn = { lifecycle, task, resolve: (value) => resolve(value as T), reject };
      const queue = this.queues.get(key) ?? [];
      queue.push(turn);
      this.queues.set(key, queue);
      void this.drainKey(key);
    });
  }
  private async drainKey(key: string): Promise<void> {
    if (
      this.disposed ||
      AgentProcesses.hostStoragePaused ||
      AgentProcesses.roomStoragePaused(key) ||
      this.storageMaintenance.has(key) ||
      this.drainingKeys.has(key)
    )
      return;
    this.drainingKeys.add(key);
    try {
      while (
        !this.disposed &&
        !AgentProcesses.hostStoragePaused &&
        !AgentProcesses.roomStoragePaused(key)
      ) {
        const turn = this.queues.get(key)?.shift();
        if (!this.queues.get(key)?.length) this.queues.delete(key);
        if (!turn) break;
        this.busy.add(key);
        try {
          await this.ensureRunning(key, turn.lifecycle);
          turn.resolve(await turn.task());
        } catch (error) {
          turn.reject(error);
        } finally {
          this.busy.delete(key);
          const process = this.running.get(key);
          if (process) {
            process.unsubscribe?.();
            process.unsubscribe = process.lifecycle.onWorkChanged?.(() => this.workChanged(key));
          }
        }
      }
    } finally {
      this.drainingKeys.delete(key);
      this.workChanged(key);
    }
  }
  private async ensureRunning(key: string, lifecycle: AgentProcessLifecycle): Promise<void> {
    await this.stopping.get(key);
    const retained = this.running.get(key);
    if (retained) {
      let current = true;
      try {
        current = (await lifecycle.isCurrent?.()) ?? true;
      } catch (error) {
        console.warn('[body] retained process currency check failed:', error);
      }
      if (current) return;
      await this.retire(key);
    }
    if (this.disposed) throw new Error('agent processes disposed');
    const process: RunningProcess = { lifecycle };
    this.running.set(key, process);
    try {
      const idleMs = lifecycle.idleMs ?? this.idleMs;
      if (!Number.isSafeInteger(idleMs) || idleMs < 1)
        throw new Error('idleMs must be a positive integer');
      process.started = lifecycle.start();
      const id = await process.started;
      if (this.running.get(key) !== process) {
        await lifecycle.stop(true);
        throw new Error(`agent process ${key} stopped during start`);
      }
      process.physicalSessionId = id;
      process.unsubscribe = lifecycle.onWorkChanged?.(() => this.workChanged(key));
      const history = this.physicalHistory.get(key) ?? [];
      this.physicalHistory.set(key, [...history, id].slice(-4));
    } catch (error) {
      if (this.running.get(key) === process) await this.stop(key, true);
      throw error;
    }
  }
  /** Event-driven background completion starts the same single warm countdown. */
  workChanged(key: string): void {
    const process = this.running.get(key);
    if (!process) return;
    if (this.busy.has(key) || this.drainingKeys.has(key)) return;
    if (process.lifecycle.isRunning?.() === false) {
      void this.stop(key, true).catch((error) =>
        console.error('[body] exited process cleanup failed:', error),
      );
      return;
    }
    if (this.queues.has(key) || process.lifecycle.hasBackgroundWork?.()) {
      this.clearWarmTimer(process);
      return;
    }
    if (process.idleTimer) return;
    process.idleTimer = setTimeout(() => {
      process.idleTimer = undefined;
      void this.stop(key).catch((error) =>
        console.error('[body] agent process stop failed:', error),
      );
    }, process.lifecycle.idleMs ?? this.idleMs);
    process.idleTimer.unref?.();
  }
  private clearWarmTimer(process?: RunningProcess): void {
    if (process?.idleTimer) clearTimeout(process.idleTimer);
    if (process) process.idleTimer = undefined;
  }
  async stop(key: string, force = false): Promise<void> {
    if (
      !force &&
      (this.busy.has(key) ||
        this.drainingKeys.has(key) ||
        this.queues.has(key) ||
        this.running.get(key)?.lifecycle.hasBackgroundWork?.())
    )
      return;
    await this.retire(key, force);
  }
  private async retire(key: string, force = false): Promise<void> {
    const pending = this.stopping.get(key);
    if (pending) return pending;
    const process = this.running.get(key);
    if (!process) return;
    this.clearWarmTimer(process);
    process.unsubscribe?.();
    this.running.delete(key);
    const stopped = Promise.resolve()
      .then(async () => {
        await process.lifecycle.stop(force);
        if (process.started && !process.physicalSessionId) {
          await process.started.catch(() => undefined);
          await process.lifecycle.stop(force);
        }
      })
      .finally(() => {
        this.stopping.delete(key);
        AgentProcesses.notifyStorageAvailable(key);
      });
    this.stopping.set(key, stopped);
    await stopped;
  }
  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((key) => this.stop(key, true)));
  }
  async stopIdle(): Promise<void> {
    await Promise.all([...this.running.keys()].map((key) => this.stop(key)));
  }
  physicalSessionId(key: string): string | undefined {
    return this.running.get(key)?.physicalSessionId;
  }
  generations(key: string): readonly string[] {
    return this.physicalHistory.get(key) ?? [];
  }
  forget(key: string): void {
    this.physicalHistory.delete(key);
  }
  snapshot(): AgentProcessSnapshot {
    return {
      running: this.running.size,
      busy: this.busy.size,
      queuedChannels: new Set([...this.queues.keys(), ...this.drainingKeys]).size,
      warm: [...this.running.keys()].filter(
        (key) => !this.busy.has(key) && !this.drainingKeys.has(key) && !this.queues.has(key),
      ).length,
    };
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const queue of this.queues.values())
      for (const turn of queue) turn.reject(new Error('agent processes disposed'));
    this.queues.clear();
    await Promise.all([...this.running.keys()].map((key) => this.stop(key, true)));
    await Promise.all(this.stopping.values());
    this.physicalHistory.clear();
    AgentProcesses.instances.delete(this);
  }
}
