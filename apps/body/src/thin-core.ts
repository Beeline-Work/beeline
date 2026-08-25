import WebSocket from 'ws';
import { KIND_PUT_USER, KIND_REMOVE_USER } from '@beeline/buzz-client';
import type { BodyConfig } from './config.js';
import { SharedRelaySocket } from './relay-socket.js';
import { runtimeIdentity, type AgentRuntimeRecord } from './runtime.js';
import { RoomRuntimeCoordinator, reconcileRetryMs } from './room-runtime.js';
import { createDaemonWorkCalendar } from './daemon-work-calendar.js';
import type { WorkCalendar } from './work-calendar.js';

type WorkCalendarLifecycle = Pick<WorkCalendar, 'start' | 'dispose' | 'refreshNow'>;

export {
  DEFAULT_DRAIN_DEADLINE_MS,
  DEFAULT_RECONCILE_HEARTBEAT_MS,
  DEFAULT_ROOM_DISCOVERY_RETRY_MS,
  DEFAULT_ROOM_DISCOVERY_TRANSIENT_RETRY_MS,
  DEFAULT_ROOM_WATCHDOG_STALE_MS,
  REMOVAL_CONFIRMATION_READS,
  ROOM_JOIN_CONCURRENCY,
  ROOM_RECONCILE_DEADLINE_MS,
  isArchivedChannelError,
  isDurableRoomJoinFailure,
  isOwnerGrantNeededFailure,
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

/**
 * Foreground daemon core with exactly seven responsibilities:
 *
 * 1. own one authenticated relay socket;
 * 2. route Workspace wake events into bounded Room reconciliation;
 * 3. drive killable Room/corner children through the Room runtime leaf;
 * 4. keep deterministic approval/review leaves reachable through those Bodies;
 * 5. publish local progress state to the supervision callback; and
 * 6. own one bounded WorkCalendar wake source, separate from process capacity; and
 * 7. keep out-of-turn Git behind the Room runtime's JSON worker boundary.
 *
 * It contains no repository materialization, ACP protocol, approval policy,
 * self-update installer, or durable corner implementation. Those stay leaf
 * modules. The core is only the progress loop and its lifecycle contract.
 */
export class ThinDaemonCore {
  private readonly agent: ReturnType<typeof runtimeIdentity>;
  private readonly relaySocket: SharedRelaySocket;
  private readonly roomRuntime: RoomRuntimeCoordinator;
  private readonly workCalendar: WorkCalendarLifecycle;
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
      /** Test seam; production owns exactly one daemon-level WorkCalendar. */
      workCalendar?: WorkCalendarLifecycle;
    } = {},
  ) {
    this.agent = runtimeIdentity(runtime.agent);
    this.now = options.now ?? Date.now;
    this.relaySocket = new SharedRelaySocket({
      baseUrl: runtime.relayBaseUrl,
      ...(runtime.relayHost ? { host: runtime.relayHost } : {}),
      ...(baseConfig.relayWsUrl ? { wsUrl: baseConfig.relayWsUrl } : {}),
      identity: this.agent,
      WebSocketImpl: WebSocket,
    });
    this.roomRuntime = new RoomRuntimeCoordinator(runtime, configPath, baseConfig, {
      ...options,
      relaySocket: this.relaySocket,
    });
    this.workCalendar =
      options.workCalendar ??
      createDaemonWorkCalendar({
        runtime,
        configPath,
        roomRuntime: this.roomRuntime,
        nowMs: this.now,
      });
  }

  activeRoomIds(): string[] {
    return this.roomRuntime.activeRoomIds();
  }

  isWorkspaceIdle(): boolean {
    return this.roomRuntime.isWorkspaceIdle();
  }

  /** Apply the persisted update handoff deadline before abort starts draining. */
  setDrainDeadlineAt(deadlineAt: number): void {
    this.roomRuntime.setDrainDeadlineAt(deadlineAt);
  }

  /**
   * READY is requested before any relay attempt. WATCHDOG/STATUS is requested
   * only after both bounded reconciliation and the local Room watchdog finish.
   * Network success never controls the heartbeat.
   */
  async run(
    opts: {
      pollMs?: number;
      signal?: AbortSignal;
      onEstablished?: () => void | Promise<void>;
      onProgress?: (status: string) => void | Promise<void>;
    } = {},
  ): Promise<'aborted' | 'agent-removed'> {
    const watchdogTickMs = opts.pollMs ?? 5_000;
    let wake = true;
    let nextReconcileAt = 0;
    let unsubscribeControl: (() => void) | undefined;
    let degraded = 'starting';
    let calendarStarted = false;

    await opts.onEstablished?.();
    try {
      const client = await this.relaySocket.connected();
      const socket = client.socket;
      if (!socket) throw new Error('control-plane WS connected but exposed no socket');
      unsubscribeControl = socket.subscribe(
        [
          {
            kinds: [KIND_PUT_USER, KIND_REMOVE_USER],
            '#p': [this.agent.publicKey],
            since: Math.floor(this.now() / 1_000),
          },
        ],
        () => {
          wake = true;
        },
      );
      degraded = '';
    } catch (error) {
      degraded = `relay control socket degraded: ${error instanceof Error ? error.message : String(error)}`;
      console.error(
        `[thin-core] control-plane WS unavailable; relying on the ` +
          `${this.roomRuntime.reconcileHeartbeatIntervalMs()}ms heartbeat poll:`,
        error,
      );
    }

    try {
      while (!opts.signal?.aborted) {
        let waitMs = watchdogTickMs;
        if (wake || this.now() >= nextReconcileAt) {
          wake = false;
          try {
            const membership = await this.roomRuntime.reconcile();
            if (membership === 'not-member') return 'agent-removed';
            // Reconciliation starts the active Room Bodies used for the
            // calendar's fresh principal-access check. Starting sooner would
            // incorrectly discard valid schedules for not-yet-served Rooms.
            if (membership === 'member' && !calendarStarted) {
              calendarStarted = true;
              // Calendar relay reads have their own bounded retry/timer. They
              // must never delay this core tick's watchdog progress.
              void this.workCalendar
                .start()
                .catch((error) => console.error('[thin-core] work calendar start failed:', error));
            }
            degraded = membership === 'unknown' ? 'relay membership degraded' : '';
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
            degraded = `relay discovery degraded: ${error instanceof Error ? error.message : String(error)}`;
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
      unsubscribeControl?.();
      await this.workCalendar.dispose();
      await this.roomRuntime.shutdown();
      this.relaySocket.disconnect();
    }
  }
}
