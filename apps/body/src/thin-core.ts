import type { BodyConfig } from './config.js';
import { isAgentRemovedError, type DaemonApiClient } from './daemon-api-client.js';
import type { AgentRuntimeRecord } from './runtime.js';
import { RoomRuntimeCoordinator } from './room-runtime.js';

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
    let degraded = 'starting';
    await opts.onEstablished?.();
    try {
      while (!opts.signal?.aborted) {
        this.pendingDiscovery = false;
        try {
          const membership = await this.roomRuntime.reconcile();
          if (membership === 'not-member') return 'agent-removed';
          degraded = membership === 'unknown' ? 'monolith membership degraded' : '';
        } catch (error) {
          if (isAgentRemovedError(error)) return 'agent-removed';
          console.error('[thin-core] discovery failed; waiting for socket reconnect:', error);
          degraded = `monolith discovery degraded: ${error instanceof Error ? error.message : String(error)}`;
          this.roomRuntime.reconnectAfterFailure();
        }
        await opts.onProgress?.(
          degraded ||
            `healthy; ${this.roomRuntime.activeRoomCount()} ` +
              `Room${this.roomRuntime.activeRoomCount() === 1 ? '' : 's'} active`,
        );
        if (!this.pendingDiscovery) await this.waitForDiscovery(opts.signal);
      }
      return 'aborted';
    } finally {
      await this.roomRuntime.shutdown();
    }
  }
}
