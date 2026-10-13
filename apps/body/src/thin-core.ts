import type { BodyConfig } from './config.js';
import { DaemonApiError, isAgentRemovedError, type DaemonApiClient } from './daemon-api-client.js';
import type { AgentRuntimeRecord } from './runtime.js';
import { RoomRuntimeCoordinator } from './room-runtime.js';
import type { InterruptedTurn } from './force-update-journal.js';

export {
  DEFAULT_DRAIN_DEADLINE_MS,
  REMOVAL_CONFIRMATION_READS,
  ROOM_JOIN_CONCURRENCY,
  mapWithConcurrency,
  type WorkspaceMembershipStatus,
} from './room-runtime.js';

/** Process supervision for the monolith Room client. */
export class ThinDaemonCore {
  private readonly roomRuntime: RoomRuntimeCoordinator;
  private pendingDiscovery = false;
  private discoveryWaiter?: () => void;
  private discoveryStatus = 'starting';
  private readonly progressWaiters = new Set<() => void>();

  constructor(
    runtime: AgentRuntimeRecord,
    configPath: string,
    baseConfig: BodyConfig,
    options: {
      now?: () => number;
      drainDeadlineMs?: number;
      daemonApi: DaemonApiClient;
      onRestartRequested?: () => void;
      onConfigChanged?: () => void | Promise<void>;
    },
  ) {
    if (!runtime.transport) throw new Error('thin daemon requires monolith transport');
    this.roomRuntime = new RoomRuntimeCoordinator(runtime, configPath, baseConfig, options);
    this.roomRuntime.setDiscoveryWakeListener(() => {
      this.pendingDiscovery = true;
      this.discoveryWaiter?.();
    });
  }

  private async waitForDiscovery(signal?: AbortSignal): Promise<void> {
    if (this.pendingDiscovery || this.progressWaiters.size || signal?.aborted) return;
    await new Promise<void>((resolveWait) => {
      const done = () => {
        signal?.removeEventListener('abort', done);
        this.discoveryWaiter = undefined;
        resolveWait();
      };
      this.discoveryWaiter = done;
      signal?.addEventListener('abort', done, { once: true });
      if (this.pendingDiscovery || this.progressWaiters.size) done();
    });
  }

  /** The existing machine watchdog tick wakes this loop without discovering Rooms. */
  requestWorkLoopProgress(): Promise<void> {
    return new Promise<void>((resolveProgress) => {
      this.progressWaiters.add(resolveProgress);
      this.discoveryWaiter?.();
    });
  }

  activeRoomIds(): string[] {
    return this.roomRuntime.activeRoomIds();
  }
  surfaceHealthSnapshot() {
    return this.roomRuntime.surfaceHealthSnapshot();
  }
  healthStatus(): string {
    const count = this.roomRuntime.activeRoomCount();
    return `${this.discoveryStatus || (this.roomRuntime.hasDegradedSurfaces() ? 'degraded' : 'healthy')}; ` +
      `${count} Room${count === 1 ? '' : 's'} active; ${this.roomRuntime.surfaceHealthSummary()}`;
  }
  setInteractiveIdleListener(listener: () => void): void {
    this.roomRuntime.setInteractiveIdleListener(listener);
  }
  isWorkspaceIdle(): boolean {
    return this.roomRuntime.isWorkspaceIdle();
  }
  activeTurnCount(): number {
    return this.roomRuntime.activeTurnCount();
  }
  quiesceForUpdateIfIdle(): boolean {
    return this.roomRuntime.quiesceForUpdateIfIdle();
  }
  quiesceForUpdate(): void {
    this.roomRuntime.quiesceForUpdate();
  }
  /** A managed restart failed after intake closed: take turns again. */
  resumeServing(): void {
    this.roomRuntime.resumeServing();
  }
  async prepareForForcedUpdateRestart(): Promise<void> {
    await this.roomRuntime.prepareForForcedUpdateRestart();
  }
  interruptedTurns(): InterruptedTurn[] { return this.roomRuntime.interruptedTurns(); }
  interruptForServerMinimum(): InterruptedTurn[] {
    return this.roomRuntime.interruptForServerMinimum();
  }
  setDrainDeadlineAt(deadlineAt: number): void {
    this.roomRuntime.setDrainDeadlineAt(deadlineAt);
  }
  /**
   * `/restart` cancels active work instead of draining it: shutdown reaches its
   * deadline at once and force-cancels every busy session. Returns whether any
   * turn was running.
   */
  async cancelActiveWorkForRestart(): Promise<boolean> {
    this.roomRuntime.setDrainDeadlineAt(Date.now());
    if (this.roomRuntime.quiesceForUpdateIfIdle()) return false;
    await this.roomRuntime.prepareForForcedUpdateRestart();
    return true;
  }

  async run(
    opts: {
      pollMs?: number;
      signal?: AbortSignal;
      onEstablished?: () => void | Promise<void>;
      onProgress?: (status: string, fault?: unknown) => void | Promise<void>;
    } = {},
  ): Promise<'aborted' | 'agent-removed'> {
    const stop = () => {
      this.roomRuntime.setDrainDeadlineAt(Date.now() + 45_000);
      this.roomRuntime.beginShutdown();
    };
    opts.signal?.addEventListener('abort', stop, { once: true });
    if (opts.signal?.aborted) stop();
    const acknowledgeProgress = async () => {
      await opts.onProgress?.(this.healthStatus(), lastFault);
      for (const done of this.progressWaiters) {
        this.progressWaiters.delete(done);
        done();
      }
    };
    let lastFault: unknown;
    this.roomRuntime.setReconciliationProgressListener(() => {
      if (this.progressWaiters.size) return acknowledgeProgress();
    });
    try {
      const supervisor = this.roomRuntime.supervisor;
      let failures = 0;
      let discover = true;
      let established = false;
      while (!opts.signal?.aborted) {
        const shouldDiscover = discover || this.pendingDiscovery;
        if (shouldDiscover) this.pendingDiscovery = false;
        const wakesBefore = supervisor.wakes;
        try {
          if (shouldDiscover) {
            const membership = await this.roomRuntime.reconcile();
            if (membership === 'not-member') return 'agent-removed';
            if (membership === 'member' && !established) { await opts.onEstablished?.(); established = true; }
            this.discoveryStatus = membership === 'unknown' ? 'monolith membership degraded' : '';
            failures = 0;
            lastFault = undefined;
          }
        } catch (error) {
          if (isAgentRemovedError(error)) return 'agent-removed';
          lastFault = error;
          failures = error instanceof DaemonApiError && !error.retryable
            ? supervisor.retries + 1 : failures + 1;
          console.error(
            failures > supervisor.retries
              ? '[thin-core] discovery failed; waiting for the next live open or discovery wake:'
              : `[thin-core] discovery failed; retry ${failures} of ${supervisor.retries}:`,
            error,
          );
          this.discoveryStatus = `monolith discovery degraded: ${error instanceof Error ? error.message : String(error)}`;
          this.roomRuntime.suspectLink(error);
        }
        if (opts.signal?.aborted) break;
        await acknowledgeProgress();
        const authorityRefused = lastFault instanceof DaemonApiError && !lastFault.retryable && lastFault.status >= 400 && lastFault.status < 500;
        if (failures > 0 && !authorityRefused) {
          await supervisor.retryDelay(Math.min(failures, supervisor.retries), opts.signal, wakesBefore);
          discover = true;
        } else {
          // Healthy idle reads and authority refusals wait for a real discovery event. Local
          // health ticks still run here, without replaying the refused request.
          failures = 0;
          await this.waitForDiscovery(opts.signal);
          discover = this.pendingDiscovery;
        }
      }
      return 'aborted';
    } finally {
      for (const done of this.progressWaiters) done();
      this.progressWaiters.clear();
      opts.signal?.removeEventListener('abort', stop);
      await this.roomRuntime.shutdown();
    }
  }
}
