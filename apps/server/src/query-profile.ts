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

/** Bounded, parameter-free totals; rank by total DB time, including pool wait. */
export class QueryProfiler {
  readonly #profiles = new Map<string, QueryProfile>();
  #overflow = 0;

  record(sql: string, durationMs: number, error?: unknown): void {
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

  snapshot(): { readonly top: readonly QueryProfile[]; readonly overflow: number } {
    return {
      top: [...this.#profiles.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, 10),
      overflow: this.#overflow,
    };
  }
}
