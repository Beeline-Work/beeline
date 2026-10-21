import { beforeEach, expect, it, vi } from 'vitest';
import {
  app,
  alphaTenant,
  startCookie,
  useAuthServerFixture,
  provider,
} from './server-test-fixture.js';
const observe = vi.fn(async () => {});
useAuthServerFixture({ onFunnelAuth: observe });
beforeEach(() => { observe.mockReset(); observe.mockResolvedValue(undefined); });
const context = {
  event: 'provider_tapped',
  installId: '00000000-0000-4000-8000-000000000001',
  attemptId: '00000000-0000-4000-8000-000000000002',
  platform: 'ios',
  version: '0.2.22',
  environment: 'production',
  provider: 'github',
  timestamp: new Date().toISOString(),
};
it('observes only state-bound GitHub starts/callbacks without codes, cookies, tokens or account IDs', async () => {
  const start = await app.inject({
    method: 'GET',
    headers: { host: alphaTenant.host },
    url: `/auth/github/start?funnel=${encodeURIComponent(JSON.stringify(context))}`,
  });
  expect(start.statusCode).toBe(302);
  const state = new URL(start.headers.location!).searchParams.get('state');
  const invalid = await app.inject({
    method: 'GET',
    headers: { host: alphaTenant.host, cookie: startCookie(start.headers['set-cookie']) },
    url: '/auth/github/callback?state=wrong&code=do-not-log',
  });
  expect(invalid.statusCode).toBe(400);
  expect(observe).toHaveBeenCalledTimes(1);
  const result = await app.inject({
    method: 'GET',
    headers: { host: alphaTenant.host, cookie: startCookie(start.headers['set-cookie']) },
    url: `/auth/github/callback?state=${state}&code=do-not-log`,
  });
  expect(result.statusCode).toBe(200);
  expect(observe).toHaveBeenCalledTimes(2);
  expect(observe.mock.calls[0]?.[0]).toMatchObject({ phase: 'start', provider: 'github', context });
  expect(observe.mock.calls[1]?.[0]).toMatchObject({
    phase: 'callback',
    provider: 'github',
    outcome: 'success',
  });
  const serialized = JSON.stringify(observe.mock.calls);
  expect(serialized).not.toContain('do-not-log');
  expect(serialized).not.toContain('github-user-token');
});
it('observes OIDC cancellation and keeps auth working if telemetry is unavailable', async () => {
  const start = await app.inject({
    method: 'GET',
    headers: { host: alphaTenant.host },
    url: `/auth/oidc/start?funnel=${encodeURIComponent(JSON.stringify({ ...context, provider: 'google' }))}`,
  });
  const state = new URL(start.headers.location!).searchParams.get('state');
  const callback = await app.inject({
    method: 'GET',
    headers: { host: alphaTenant.host, cookie: startCookie(start.headers['set-cookie']) },
    url: `/auth/oidc/callback?state=${state}&error=access_denied`,
  });
  expect(callback.statusCode).toBe(401);
  expect(observe.mock.calls.at(-1)?.[0]).toMatchObject({
    provider: 'google',
    outcome: 'cancelled',
  });
  observe.mockRejectedValueOnce(new Error('telemetry unavailable'));
  const next = await app.inject({
    method: 'GET',
    headers: { host: alphaTenant.host },
    url: `/auth/oidc/start?funnel=${encodeURIComponent(JSON.stringify({ ...context, provider: 'google' }))}`,
  });
  expect(next.statusCode).toBe(302);
});
it('uses the verified OIDC exchange result as the callback source', async () => {
  const start = await app.inject({
    method: 'GET',
    headers: { host: alphaTenant.host },
    url: `/auth/oidc/start?funnel=${encodeURIComponent(JSON.stringify({ ...context, provider: 'google' }))}`,
  });
  const auth = await fetch(start.headers.location!, { redirect: 'manual' });
  const target = new URL(auth.headers.get('location')!);
  const result = await app.inject({
    method: 'GET',
    headers: { host: alphaTenant.host, cookie: startCookie(start.headers['set-cookie']) },
    url: target.pathname + target.search,
  });
  expect(result.statusCode).toBe(200);
  expect(provider.tokenRequests).toBe(1);
  expect(observe.mock.calls.at(-1)?.[0]).toMatchObject({ provider: 'google', outcome: 'success' });
});
