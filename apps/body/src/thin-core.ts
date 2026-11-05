import type { BodyConfig } from './config.js';
import { isAgentRemovedError, type DaemonApiClient } from './daemon-api-client.js';
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

  workLoopDiagnostics() {
    return this.roomRuntime.reconciliationDiagnostics();
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
      let discover = true;
      let established = false;
      while (!opts.signal?.aborted) {
        const shouldDiscover = discover || this.pendingDiscovery;
        if (shouldDiscover) this.pendingDiscovery = false;
        try {
          if (shouldDiscover) {
            const membership = await this.roomRuntime.reconcile(async () => {
              if (!established) { await opts.onEstablished?.(); established = true; }
            });
            if (membership === 'not-member') return 'agent-removed';
            if (membership === 'member' && !established) { await opts.onEstablished?.(); established = true; }
            this.discoveryStatus = membership === 'unknown' ? 'monolith membership degraded' : '';
            lastFault = undefined;
          }
        } catch (error) {
          if (isAgentRemovedError(error)) return 'agent-removed';
          lastFault = error;
          console.error(
            '[thin-core] discovery failed:',
            error,
          );
          this.discoveryStatus = `monolith discovery degraded: ${error instanceof Error ? error.message : String(error)}`;
          this.roomRuntime.reconnectAfterDiscoveryFailure(error);
        }
        if (opts.signal?.aborted) break;
        await acknowledgeProgress();
        // Discovery and recovery share the same interruptible idle wait. A
        // watchdog wake proves local progress without authorizing a read;
        // a new socket or discovery event supplies the next read boundary.
        await this.waitForDiscovery(opts.signal);
        discover = this.pendingDiscovery;
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
