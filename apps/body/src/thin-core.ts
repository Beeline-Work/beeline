import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import type { AgentRuntimeRecord } from './runtime.js';
import { RoomRuntimeCoordinator, reconcileRetryMs } from './room-runtime.js';

export {
  DEFAULT_DRAIN_DEADLINE_MS,
  DEFAULT_RECONCILE_HEARTBEAT_MS,
  DEFAULT_ROOM_WATCHDOG_STALE_MS,
  REMOVAL_CONFIRMATION_READS,
  ROOM_JOIN_CONCURRENCY,
  mapWithConcurrency,
  type WorkspaceMembershipStatus,
} from './room-runtime.js';

async function waitForNextTick(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolveWait) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolveWait();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/** Process supervision for the monolith Room client. */
export class ThinDaemonCore {
  private readonly roomRuntime: RoomRuntimeCoordinator;
  private readonly now: () => number;

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
    },
  ) {
    if (!runtime.transport) throw new Error('thin daemon requires monolith transport');
    this.now = options.now ?? Date.now;
    this.roomRuntime = new RoomRuntimeCoordinator(runtime, configPath, baseConfig, options);
  }

  activeRoomIds(): string[] {
    return this.roomRuntime.activeRoomIds();
  }
  isWorkspaceIdle(): boolean {
    return this.roomRuntime.isWorkspaceIdle();
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
    const watchdogTickMs = opts.pollMs ?? 5_000;
    let nextReconcileAt = 0;
    let degraded = 'starting';
    await opts.onEstablished?.();
    try {
      while (!opts.signal?.aborted) {
        let waitMs = watchdogTickMs;
        if (this.now() >= nextReconcileAt) {
          try {
            const membership = await this.roomRuntime.reconcile();
            if (membership === 'not-member') return 'agent-removed';
            degraded = membership === 'unknown' ? 'monolith membership degraded' : '';
            nextReconcileAt =
              this.now() +
              (membership === 'unknown' || this.roomRuntime.needsFastReconcile()
                ? watchdogTickMs
                : this.roomRuntime.reconcileHeartbeatIntervalMs());
          } catch (error) {
            const retryMs = reconcileRetryMs(error, watchdogTickMs);
            nextReconcileAt = this.now() + retryMs;
            waitMs = Math.min(waitMs, retryMs);
            console.error(`[thin-core] discovery failed; retrying in ${retryMs}ms:`, error);
            degraded = `monolith discovery degraded: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        await this.roomRuntime.watchdogTick();
        await opts.onProgress?.(
          degraded ||
            `healthy; ${this.roomRuntime.activeRoomCount()} ` +
              `Room${this.roomRuntime.activeRoomCount() === 1 ? '' : 's'} active`,
        );
        await waitForNextTick(waitMs, opts.signal);
      }
      return 'aborted';
    } finally {
      await this.roomRuntime.shutdown();
    }
  }
}
