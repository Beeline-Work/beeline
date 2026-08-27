import { describe, expect, it, vi } from 'vitest';
import { SnapshotSuccessionClient } from './succession.js';

const OLD = 'a'.repeat(64);
const CURRENT = 'b'.repeat(64);
const TENANT = 'e8299f28-f095-472f-941a-80d1195b9a24';

describe('SnapshotSuccessionClient', () => {
  it('coalesces identical lookups and caches the verified current key', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ mappings: { [OLD]: CURRENT } }), { status: 200 });
    });
    const client = new SnapshotSuccessionClient({
      baseUrl: 'http://auth:8789',
      token: 'secret',
      fetch: fetchImpl,
    });
    const first = client.resolve(TENANT, [OLD]);
    const second = client.resolve(TENANT, [OLD]);
    release();
    await expect(first).resolves.toEqual({ mappings: { [OLD]: CURRENT }, stale: false });
    await expect(second).resolves.toEqual({ mappings: { [OLD]: CURRENT }, stale: false });
    await expect(client.resolve(TENANT, [OLD])).resolves.toEqual({
      mappings: { [OLD]: CURRENT },
      stale: false,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('keeps a previous verified mapping on refresh failure and never grants an unseen alias', async () => {
    let now = 0;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ mappings: { [OLD]: CURRENT } }), { status: 200 }),
      )
      .mockRejectedValueOnce(new Error('auth offline'));
    const client = new SnapshotSuccessionClient({
      baseUrl: 'http://auth:8789',
      token: 'secret',
      cacheTtlMs: 1,
      now: () => now,
      fetch: fetchImpl,
    });
    await expect(client.resolve(TENANT, [OLD])).resolves.toMatchObject({ stale: false });
    now = 2;
    const unseen = 'c'.repeat(64);
    await expect(client.resolve(TENANT, [OLD, unseen])).resolves.toEqual({
      mappings: { [OLD]: CURRENT, [unseen]: unseen },
      stale: true,
    });
  });

  it('refreshes every requested key as one succession generation', async () => {
    const newCurrent = 'c'.repeat(64);
    const requests: string[][] = [];
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { pubkeys: string[] };
      requests.push(body.pubkeys);
      return requests.length === 1
        ? new Response(JSON.stringify({ mappings: { [OLD]: OLD } }), { status: 200 })
        : new Response(JSON.stringify({ mappings: { [OLD]: newCurrent, [CURRENT]: newCurrent } }), {
            status: 200,
          });
    });
    const client = new SnapshotSuccessionClient({
      baseUrl: 'http://auth:8789',
      token: 'secret',
      fetch: fetchImpl,
    });

    await expect(client.resolve(TENANT, [OLD])).resolves.toEqual({
      mappings: { [OLD]: OLD },
      stale: false,
    });
    await expect(client.resolve(TENANT, [OLD, CURRENT])).resolves.toEqual({
      mappings: { [OLD]: newCurrent, [CURRENT]: newCurrent },
      stale: false,
    });
    expect(requests).toEqual([[OLD], [OLD, CURRENT]]);
  });
});
