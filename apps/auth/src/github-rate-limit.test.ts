import { exportPKCS8, generateKeyPair } from 'jose';
import { afterEach, expect, it, vi } from 'vitest';
import { GitHubAppClient } from './github.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('WAKE-STORM: coalesces mass token mints with identical grants, preserves grant boundaries', async () => {
  const { privateKey } = await generateKeyPair('RS256');
  const app = new GitHubAppClient({ appId: '42', slug: 'test', privateKey: await exportPKCS8(privateKey) });
  const fetcher = vi.fn(async () => Response.json({ token: 'test-token', expires_at: new Date(Date.now() + 3600_000).toISOString() }));
  vi.stubGlobal('fetch', fetcher);
  await Promise.all(Array.from({ length: 100 }, () => app.installationToken(42, { repositoryIds: [1] })));
  expect(fetcher).toHaveBeenCalledTimes(1);
  await app.installationToken(42, { repositoryIds: [2] });
  await app.installationToken(42, { repositoryIds: [1], permissions: { contents: 'read' } });
  await app.installationToken(42, { repositoryIds: [1], permissions: {} });
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it('WAKE-STORM: one installation reset stops queued corners, other repositories, and another server replica', async () => {
  const { privateKey } = await generateKeyPair('RS256');
  const config = { appId: '42', slug: 'test', privateKey: await exportPKCS8(privateKey) };
  const app = new GitHubAppClient(config);
  const replica = new GitHubAppClient(config);
  let shared = 0;
  const store = { get: async () => shared, set: async (_id: number, reset: number) => { shared = Math.max(shared, reset); } };
  app.setRateLimitStore(store);
  replica.setRateLimitStore(store);
  vi.useFakeTimers();
  const now = Date.now();
  const fetcher = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith('/access_tokens')) return Response.json({ token: url.includes('/43/') ? 'other-installation' : 'installation-42', expires_at: new Date(now + 3600_000).toISOString() });
    return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(now / 1000) + 600) } });
  });
  vi.stubGlobal('fetch', fetcher);
  const token = await app.installationToken(42, { repositoryIds: [1] });
  await replica.installationToken(42, { repositoryIds: [2] });
  fetcher.mockClear();
  const storm = await Promise.allSettled(Array.from({ length: 100 }, (_, number) =>
    app.readPullRequest(token.token, number % 2 ? 'owner/one' : 'owner/two', number + 1)));
  expect(storm.every(result => result.status === 'rejected')).toBe(true);
  expect(fetcher.mock.calls.length).toBeLessThanOrEqual(4);
  expect(fetcher.mock.calls.length).toBeGreaterThan(0);
  const calls = fetcher.mock.calls.length;
  await expect(app.installationToken(42, { repositoryIds: [3] })).rejects.toMatchObject({ rateLimited: true });
  await expect(replica.readPullRequest('installation-42', 'owner/two', 7)).rejects.toMatchObject({ rateLimited: true });
  expect(fetcher).toHaveBeenCalledTimes(calls);
  vi.setSystemTime(shared + 1);
  fetcher.mockImplementation(async () => Response.json({ head: { sha: 'a'.repeat(40) }, state: 'open' }));
  await expect(replica.readPullRequest('installation-42', 'owner/two', 7)).resolves.toMatchObject({ state: 'open' });
  expect(fetcher).toHaveBeenCalledTimes(calls + 1);
});
