export interface PushEventFeedOptions {
  pollIntervalMs: number;
  heartbeatIntervalMs?: number;
  retryMaxMs?: number;
  now?: () => number;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_RETRY_MAX_MS = 30_000;

/**
 * Continuously drains the authoritative Postgres event feed.
 *
 * Polls are self-scheduled so a slow read can never overlap the next tick. A
 * failed read reconnects by issuing a fresh request after bounded exponential
 * backoff; any success restores the ordinary cadence.
 */
export class PushEventFeed {
  private stopped = true;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private consecutiveFailures = 0;
  private successfulPolls = 0;
  private failedPolls = 0;
  private eventsSinceHeartbeat = 0;
  private lastSuccessAt?: number;
  private reportedLive = false;

  private readonly heartbeatIntervalMs: number;
  private readonly retryMaxMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly error: (message: string) => void;

  constructor(
    private readonly poller: { pollNext(): Promise<unknown> },
    private readonly options: PushEventFeedOptions,
  ) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? console.log;
    this.error = options.error ?? console.error;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.log(
      `[push] feed started mode=postgres-tail intervalMs=${this.options.pollIntervalMs} heartbeatMs=${this.heartbeatIntervalMs}`,
    );
    this.heartbeatTimer = setInterval(() => this.reportHeartbeat(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
    void this.pollOnce();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.pollTimer = undefined;
    this.heartbeatTimer = undefined;
  }

  noteEvent(): void {
    this.eventsSinceHeartbeat += 1;
  }

  private async pollOnce(): Promise<void> {
    if (this.stopped) return;
    let delayMs = this.options.pollIntervalMs;
    try {
      const result = await this.poller.pollNext();
      if (result === 'polled') {
        this.successfulPolls += 1;
        this.lastSuccessAt = this.now();
        this.consecutiveFailures = 0;
        if (!this.reportedLive) {
          this.reportedLive = true;
          this.log(
            `[push] feed live mode=postgres-tail firstSuccess=${new Date(this.lastSuccessAt).toISOString()}`,
          );
        }
      }
    } catch (caught) {
      this.failedPolls += 1;
      const exponent = Math.max(0, this.consecutiveFailures);
      delayMs = Math.min(this.options.pollIntervalMs * 2 ** exponent, this.retryMaxMs);
      this.consecutiveFailures += 1;
      this.error(
        `[push] feed database query failed error=${encodeURIComponent(
          caught instanceof Error ? caught.message : String(caught),
        )} retryMs=${delayMs}`,
      );
    }
    if (this.stopped) return;
    this.pollTimer = setTimeout(() => void this.pollOnce(), delayMs);
    this.pollTimer.unref?.();
  }

  private reportHeartbeat(): void {
    const events = this.eventsSinceHeartbeat;
    const eventsPerMinute = Math.round((events * 60_000) / this.heartbeatIntervalMs);
    const lastSuccess = this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : 'never';
    this.log(
      `[push] feed heartbeat mode=postgres-tail eventsPerMinute=${eventsPerMinute} events=${events} successfulPolls=${this.successfulPolls} failedPolls=${this.failedPolls} lastSuccess=${lastSuccess}`,
    );
    this.eventsSinceHeartbeat = 0;
    this.successfulPolls = 0;
    this.failedPolls = 0;
  }
}
