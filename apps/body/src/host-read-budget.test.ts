import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonApiClient } from './daemon-api-client.js';
import { HostReadBudget } from './host-read-budget.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('host daemon read budget', () => {
  it('restarts fifteen agents against a six-connection pool without waiters or crashes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-load-budget-'));
    roots.push(root);
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
    const agents = Array.from({ length: 15 }, (_, index) => {
      const id = String(index).padStart(64, 'a');
      return new DaemonApiClient(origin, 'token', id, request, undefined, new HostReadBudget(origin, root));
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
    const root = await mkdtemp(join(tmpdir(), 'beeline-priority-budget-'));
    roots.push(root);
    const budget = new HostReadBudget('http://127.0.0.1:41112', root);
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
});
