import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonApiClient } from './daemon-api-client.js';
import { HostReadBudget, ReadBudgetFullError } from './host-read-budget.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('host daemon read budget', () => {
  it('restarts fifteen agents against a six-connection pool without waiters or crashes', async () => {
    const origin = 'http://127.0.0.1:41111';
    let busy = 0;
    let poolWaiters = 0;
    let peak = 0;
    const request: typeof fetch = async () => {
      busy += 1;
      peak = Math.max(peak, busy);
      if (busy > 6) poolWaiters += 1;
      await new Promise((done) => setTimeout(done, 80));
      busy -= 1;
      return Response.json({ workspaceIds: ['workspace'], rooms: [] });
    };
    vi.stubGlobal('fetch', request);
    const agents = Array.from({ length: 15 }, (_, index) => {
      const id = String(index).padStart(64, 'a');
      return new DaemonApiClient(origin, 'token', id);
    });
    await Promise.all(agents.flatMap((agent) => [0, 1, 2].map(() =>
      agent.execute('getDaemonBootstrap', { agentId: agent.agentId }))));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
    expect(poolWaiters).toBe(0);
    expect(busy).toBe(0);
    expect(agents.every((agent) => agent.metrics().inFlight === 0)).toBe(true);
  }, 15_000);

  it('reserves capacity for an urgent command read during saturated background discovery', async () => {
    const budget = new HostReadBudget();
    const releases = await Promise.all(Array.from({ length: 4 }, () =>
      budget.acquire('background', Date.now() + 5_000)));
    try {
      const urgent = await budget.acquire('urgent', Date.now() + 1_000);
      expect(budget.metrics().active).toBe(5);
      await urgent();
    } finally {
      await Promise.all(releases.map((release) => release()));
    }
    expect(budget.metrics().active).toBe(0);
  });

  it('admits bootstrap into reserved capacity so return traffic can bind on demand', async () => {
    const origin = 'http://127.0.0.1:41113';
    const budget = new HostReadBudget();
    const releases = await Promise.all(Array.from({ length: 4 }, () =>
      budget.acquire('background', Date.now() + 5_000)));
    const agentId = 'a'.repeat(64);
    const api = new DaemonApiClient(origin, 'fixture', agentId,
      async () => Response.json({ workspaceIds: [], rooms: [], pendingRooms: [] }), undefined, budget);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(Promise.race([
        api.execute('getDaemonBootstrap', { agentId }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('bootstrap waited for background work')), 1_000); }),
      ])).resolves.toMatchObject({ pendingRooms: [] });
    } finally {
      clearTimeout(timer);
      await Promise.all(releases.map(release => release()));
    }
  });
  it('keeps urgent reads ahead of queued background work and counts wait time', async () => {
    vi.useFakeTimers();
    const budget = new HostReadBudget();
    const releases = await Promise.all(Array.from({ length: 6 }, () => budget.acquire('urgent', Date.now() + 1000)));
    let backgroundStarted = false;
    const background = budget.acquire('background', Date.now() + 1000).then(release => {
      backgroundStarted = true;
      return release;
    });
    const urgent = budget.acquire('urgent', Date.now() + 1000);
    await vi.advanceTimersByTimeAsync(100);
    await releases[0]!();
    const releaseUrgent = await urgent;
    expect(backgroundStarted).toBe(false);
    expect(budget.metrics()).toEqual({ waiting: 1, active: 6, totalWaitMs: 100 });
    await releaseUrgent();
    await (await background)();
    await Promise.all(releases.slice(1).map(release => release()));
    expect(budget.metrics()).toEqual({ waiting: 0, active: 0, totalWaitMs: 200 });
  });

  it('expires and cancels queued reads without consuming a slot', async () => {
    vi.useFakeTimers();
    const budget = new HostReadBudget();
    const releases = await Promise.all(Array.from({ length: 4 }, () => budget.acquire('background', Date.now() + 1000)));
    const controller = new AbortController();
    const cancelled = expect(budget.acquire('background', Date.now() + 1000, controller.signal)).rejects.toBeInstanceOf(ReadBudgetFullError);
    controller.abort();
    await cancelled;
    const expired = expect(budget.acquire('background', Date.now() + 50)).rejects.toBeInstanceOf(ReadBudgetFullError);
    await vi.advanceTimersByTimeAsync(50);
    await expired;
    await expect(budget.acquire('urgent', Date.now())).rejects.toBeInstanceOf(ReadBudgetFullError);
    await expect(budget.acquire('urgent', Date.now() + 1000, controller.signal)).rejects.toBeInstanceOf(ReadBudgetFullError);
    expect(budget.metrics()).toEqual({ waiting: 0, active: 4, totalWaitMs: 0 });
    await Promise.all(releases.map(release => release()));
    await (await budget.acquire('background', Date.now() + 1000))();
    expect(budget.metrics().active).toBe(0);
  });

  it('returns the existing overload response once when the queue is full', async () => {
    const budget = new HostReadBudget();
    const releases = await Promise.all(Array.from({ length: 6 }, () => budget.acquire('urgent', Date.now() + 5000)));
    const controller = new AbortController();
    // Each read belongs to this test; no shared seeded clients or fixtures.
    const queued = Array.from({ length: 256 }, () => budget.acquire('urgent', Date.now() + 5000, controller.signal).catch(error => error));
    const request = vi.fn<typeof fetch>();
    const api = new DaemonApiClient('http://127.0.0.1:41114', 'fixture', 'agent', request, undefined, budget);
    await expect(api.execute('getDaemonBootstrap', { agentId: 'agent' })).rejects.toMatchObject({
      status: 429, code: 'read_budget_full', retryable: true, retryAfterMs: 1000,
    });
    expect(request).not.toHaveBeenCalled();
    expect(api.metrics().requests).toBe(1);
    controller.abort();
    await Promise.all(queued);
    await Promise.all(releases.map(release => release()));
    expect(budget.metrics()).toMatchObject({ waiting: 0, active: 0 });
  });

});
