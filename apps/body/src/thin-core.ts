import type { BodyConfig } from './config.js';
import { isAgentRemovedError, type DaemonApiClient } from './daemon-api-client.js';
import type { AgentRuntimeRecord } from './runtime.js';
import { RoomRuntimeCoordinator } from './room-runtime.js';
import type { InterruptedTurn } from './force-update-journal.js';

export {
  DEFAULT_DRAIN_DEADLINE_MS,
  DEFAULT_RECONCILE_HEARTBEAT_MS,
  DEFAULT_ROOM_WATCHDOG_STALE_MS,
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

  constructor(
    runtime: AgentRuntimeRecord,
    configPath: string,
    baseConfig: BodyConfig,
    options: {
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
    this.roomRuntime = new RoomRuntimeCoordinator(runtime, configPath, baseConfig, options);
    this.roomRuntime.setDiscoveryWakeListener(() => {
      this.pendingDiscovery = true;
      this.discoveryWaiter?.();
    });
  }

  private async waitForDiscovery(signal?: AbortSignal): Promise<void> {
    if (this.pendingDiscovery || signal?.aborted) return;
    await new Promise<void>((resolveWait) => {
      const done = () => {
        signal?.removeEventListener('abort', done);
        this.discoveryWaiter = undefined;
        resolveWait();
      };
      this.discoveryWaiter = done;
      signal?.addEventListener('abort', done, { once: true });
      if (this.pendingDiscovery) done();
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
    return `${this.discoveryStatus || (this.roomRuntime.hasUnreadySurfaces() ? 'degraded' : 'healthy')}; ` +
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
  async prepareForForcedUpdateRestart(): Promise<void> {
    await this.roomRuntime.prepareForForcedUpdateRestart();
  }
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
      onProgress?: (status: string) => void | Promise<void>;
    } = {},
  ): Promise<'aborted' | 'agent-removed'> {
    const stop = () => {
      this.roomRuntime.setDrainDeadlineAt(Date.now() + 45_000);
      this.roomRuntime.beginShutdown();
    };
    opts.signal?.addEventListener('abort', stop, { once: true });
    if (opts.signal?.aborted) stop();
    try {
      if (!opts.signal?.aborted) await opts.onEstablished?.();
      while (!opts.signal?.aborted) {
        this.pendingDiscovery = false;
        try {
          const membership = await this.roomRuntime.reconcile();
          if (membership === 'not-member') return 'agent-removed';
          this.discoveryStatus = membership === 'unknown' ? 'monolith membership degraded' : '';
        } catch (error) {
          if (isAgentRemovedError(error)) return 'agent-removed';
          console.error('[thin-core] discovery failed; waiting for live recovery:', error);
          this.discoveryStatus = `monolith discovery degraded: ${error instanceof Error ? error.message : String(error)}`;
          this.roomRuntime.reconnectAfterFailure();
        }
        if (opts.signal?.aborted) break;
        await opts.onProgress?.(this.healthStatus());
        if (!this.pendingDiscovery) await this.waitForDiscovery(opts.signal);
      }
      return 'aborted';
    } finally {
      opts.signal?.removeEventListener('abort', stop);
      await this.roomRuntime.shutdown();
    }
  }
}
