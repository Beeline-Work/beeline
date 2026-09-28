import { createHash } from 'node:crypto';

export interface QueryProfile {
  readonly fingerprint: string;
  readonly calls: number;
  readonly totalMs: number;
  readonly maxMs: number;
  readonly errors: number;
  readonly timeouts: number;
  readonly deadlocks: number;
}

const WINDOW_MS = 10 * 60_000;
const MAX_WINDOW_EVENTS = 100_000;
type Observation = { at: number; durationMs: number; waiters: number };

function percentile(values: number[], percentileRank: number): number | null {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return values[Math.ceil(values.length * percentileRank) - 1] ?? null;
}

/** Completed operations only. A bounded process-local window avoids a monitor
 * that changes state because one query happens to be active at read time. */
export class QueryWindow {
  readonly #queries: Observation[] = [];
  readonly #checkouts: Observation[] = [];
  #queryHead = 0;
  #checkoutHead = 0;

  recordQuery(durationMs: number, at = Date.now()): void {
    this.#queries.push({ at, durationMs, waiters: 0 });
    this.#queryHead = this.#prune(this.#queries, this.#queryHead, at);
  }

  recordCheckout(durationMs: number, waiters: number, at = Date.now()): void {
    this.#checkouts.push({ at, durationMs, waiters });
    this.#checkoutHead = this.#prune(this.#checkouts, this.#checkoutHead, at);
  }

  #prune(events: Observation[], head: number, now: number): number {
    while (head < events.length && (events[head]!.at < now - WINDOW_MS || events.length - head > MAX_WINDOW_EVENTS)) head++;
    if (head > 1024 && head > events.length / 2) {
      events.splice(0, head);
      return 0;
    }
    return head;
  }

  snapshot(now = Date.now()) {
    this.#queryHead = this.#prune(this.#queries, this.#queryHead, now);
    this.#checkoutHead = this.#prune(this.#checkouts, this.#checkoutHead, now);
    const queries = this.#queries.slice(this.#queryHead).map((event) => event.durationMs);
    const checkouts = this.#checkouts.slice(this.#checkoutHead);
    return {
      windowMinutes: 10,
      queryCount: queries.length,
      queryP95Ms: percentile(queries, 0.95),
      queryP99Ms: percentile(queries, 0.99),
      checkoutCount: checkouts.length,
      waitP95Ms: percentile(checkouts.map((event) => event.durationMs), 0.95),
      waitP99Ms: percentile(checkouts.map((event) => event.durationMs), 0.99),
      waiterP95: percentile(checkouts.map((event) => event.waiters), 0.95),
      waiterP99: percentile(checkouts.map((event) => event.waiters), 0.99),
    };
  }
}

/** Bounded, parameter-free totals; rank by total DB time, including pool wait. */
export class QueryProfiler {
  readonly #profiles = new Map<string, QueryProfile>();
  readonly #window = new QueryWindow();
  #overflow = 0;

  record(sql: string, durationMs: number, error?: unknown): void {
    this.#window.recordQuery(durationMs);
    const fingerprint = createHash('sha256')
      .update(sql.replace(/\s+/g, ' ').trim())
      .digest('hex')
      .slice(0, 16);
    const previous = this.#profiles.get(fingerprint);
    if (!previous && this.#profiles.size >= 128) {
      this.#overflow++;
      return;
    }
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    const next: QueryProfile = {
      fingerprint,
      calls: (previous?.calls ?? 0) + 1,
      totalMs: (previous?.totalMs ?? 0) + durationMs,
      maxMs: Math.max(previous?.maxMs ?? 0, durationMs),
      errors: (previous?.errors ?? 0) + (error === undefined ? 0 : 1),
      timeouts: (previous?.timeouts ?? 0) + (code === '57014' ? 1 : 0),
      deadlocks: (previous?.deadlocks ?? 0) + (code === '40P01' ? 1 : 0),
    };
    this.#profiles.set(fingerprint, next);
    if (durationMs >= 500)
      console.warn('[database] slow query', { fingerprint, durationMs, code });
  }

  recordCheckout(durationMs: number, waiters: number): void {
    this.#window.recordCheckout(durationMs, waiters);
  }

  window() {
    return this.#window.snapshot();
  }

  snapshot(): { readonly top: readonly QueryProfile[]; readonly overflow: number } {
    return {
      top: [...this.#profiles.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, 10),
      overflow: this.#overflow,
    };
  }
}
