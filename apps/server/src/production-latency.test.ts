import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { TokenAuth } from './auth.js';
import type { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import type { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';

// The elected background leader retains one configured client. Nine active
// helpers can reconnect together after a deployment, so every helper must be
// able to record evidence without starving public requests behind that burst.
const productionConfig = readFileSync(
  new URL('../../../fly.beeline-server.toml', import.meta.url),
  'utf8',
);
const PRODUCTION_DATABASE_POOL_MAX = Number(
  process.env.TEST_DATABASE_POOL_MAX ??
    productionConfig.match(/DATABASE_POOL_MAX = "(\d+)"/)?.[1] ??
    0,
);
const POOL_SIZE = PRODUCTION_DATABASE_POOL_MAX - 1;
const ACTIVE_HELPERS = 9;
const LOCAL_LIVE_LISTENERS = 1;
const LOAD_WINDOW_MS = 1_000;
// Production's bounded direct SELECT probe measured 74 ms at p95.
const DATABASE_ROUND_TRIP_MS = 75;

class BoundedPool {
  readonly waits: number[] = [];
  #available = POOL_SIZE;
  readonly #queue: Array<() => void> = [];

  async run<T>(work: () => Promise<T>): Promise<T> {
    const queuedAt = performance.now();
    await this.#acquire();
    this.waits.push(performance.now() - queuedAt);
    try {
      return await work();
    } finally {
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#queue.push(resolve));
  }

  #release(): void {
    const next = this.#queue.shift();
    if (next) next();
    else this.#available += 1;
  }
}

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

function scheduled(delayMs: number, work: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    setTimeout(() => void work().then(resolve, reject), delayMs);
  });
}

describe('production database-pool latency boundary', () => {
  it('keeps linear presence work and real HTTP route probes within budget', async () => {
    const pool = new BoundedPool();
    const routeDurations = { ready: [] as number[], completion: [] as number[] };
    let presenceReads = 0;
    let reconciliations = 0;
    const database = {
      query: vi.fn(() =>
        pool.run(async () => delay(DATABASE_ROUND_TRIP_MS)).then(() => ({ rows: [], rowCount: 0 })),
      ),
      transaction: vi.fn(),
    };
    const server = createBeelineServer({
      database,
      auth: {} as TokenAuth,
      phone: {} as PhoneService,
      daemon: {} as DaemonService,
      live: new LiveHub(),
      mediaMaximumBytes: 1,
      authHandler: (_request, response) => {
        // An unknown completion ticket is one short pooled lookup and a 202.
        void pool
          .run(async () => delay(DATABASE_ROUND_TRIP_MS))
          .then(() => {
            response.writeHead(202, { 'content-type': 'application/json' });
            response.end('{"status":"pending"}\n');
          });
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const jobs: Promise<void>[] = [];
    const daemonOperationsInWindow = ACTIVE_HELPERS;

    try {
      // All nine production helpers may reconnect together after promotion.
      // Evidence holds one client for its transaction, changes one canonical
      // row, and causes one joined presence read on each server listener.
      for (let index = 0; index < daemonOperationsInWindow; index += 1) {
        jobs.push(
          scheduled(0, async () => {
            reconciliations += 1;
            await pool.run(() => delay(DATABASE_ROUND_TRIP_MS * 5));
            await Promise.all(
              Array.from({ length: LOCAL_LIVE_LISTENERS }, () =>
                pool.run(async () => {
                  presenceReads += 1;
                  await delay(DATABASE_ROUND_TRIP_MS);
                }),
              ),
            );
            // Representative scoped operation: access plus the operation read.
            await pool.run(() => delay(DATABASE_ROUND_TRIP_MS));
            await pool.run(() => delay(DATABASE_ROUND_TRIP_MS));
          }),
        );
      }

      for (let startsAt = 0; startsAt < LOAD_WINDOW_MS; startsAt += 50) {
        for (const [route, path] of [
          ['ready', '/readyz'],
          ['completion', '/auth/github/completion'],
        ] as const) {
          jobs.push(
            scheduled(startsAt, async () => {
              const beganAt = performance.now();
              const response = await fetch(origin + path, {
                ...(route === 'completion'
                  ? { method: 'POST', body: '{"recoveryToken":"unknown"}' }
                  : {}),
              });
              expect(response.status).toBe(route === 'ready' ? 200 : 202);
              await response.arrayBuffer();
              routeDurations[route].push(performance.now() - beganAt);
            }),
          );
        }
      }

      await Promise.all(jobs);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    console.info('[latency-regression]', {
      configuredPoolMax: PRODUCTION_DATABASE_POOL_MAX,
      requestPoolSize: POOL_SIZE,
      poolWaitP95Ms: Math.round(percentile(pool.waits, 0.95)),
      poolWaitP99Ms: Math.round(percentile(pool.waits, 0.99)),
      readyP95Ms: Math.round(percentile(routeDurations.ready, 0.95)),
      readyP99Ms: Math.round(percentile(routeDurations.ready, 0.99)),
      completionP95Ms: Math.round(percentile(routeDurations.completion, 0.95)),
      completionP99Ms: Math.round(percentile(routeDurations.completion, 0.99)),
      maximumRouteMs: Math.round(Math.max(...routeDurations.ready, ...routeDurations.completion)),
      reconciliations,
      presenceReads,
    });
    expect(PRODUCTION_DATABASE_POOL_MAX).toBe(10);
    expect(reconciliations).toBe(daemonOperationsInWindow);
    expect(presenceReads).toBe(daemonOperationsInWindow * LOCAL_LIVE_LISTENERS);
    expect(percentile(pool.waits, 0.95)).toBeLessThan(500);
    expect(percentile(pool.waits, 0.99)).toBeLessThan(500);
    for (const durations of Object.values(routeDurations)) {
      expect(percentile(durations, 0.95)).toBeLessThan(500);
      expect(percentile(durations, 0.99)).toBeLessThan(1_000);
      expect(Math.max(...durations)).toBeLessThanOrEqual(2_000);
    }
  }, 10_000);
});
