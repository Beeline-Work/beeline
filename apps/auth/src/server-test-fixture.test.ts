
import { createHash as m4_createHash } from 'node:crypto';

import type { SigninAttemptObservation as m4_SigninAttemptObservation } from '@beeline/api-contract/signin-funnel';

import { beforeEach as m4_beforeEach, describe as m4_describe, expect as m4_expect, it as m4_it, vi as m4_vi } from 'vitest';

import { alphaTenant as m4_alphaTenant, betaTenant as m4_betaTenant, app as m4_app, provider as m4_provider, store as m4_store, useAuthServerFixture as m4_useAuthServerFixture } from "../../../tests/helpers/server.js";
import { describe as mergedDescribe4 } from 'vitest';
mergedDescribe4("server-native-google.test.ts", () => {


const recoveryToken = 'r'.repeat(43);

const recoveryChallenge = m4_createHash('sha256').update(recoveryToken).digest('hex');

const post = (url: string, payload: unknown, host = m4_alphaTenant.host) =>
  m4_app.inject({ method: 'POST', url, payload, headers: { host } });


m4_describe('Native Android Google sign-in', () => {
  const observe = m4_vi.fn(async (_input: m4_SigninAttemptObservation) => {});
  m4_useAuthServerFixture({ nativeGoogle: true, onSigninAttempt: observe });
  m4_beforeEach(() => { observe.mockReset(); observe.mockResolvedValue(undefined); });

  const start = async () => {
    const response = await post('/auth/oidc/native/start', { recoveryChallenge });
    m4_expect(response.statusCode).toBe(200);
    return response.json() as { state: string; nonce: string; serverClientId: string };
  };

  m4_it('R-signin-native: validates the nonce-bound token, issues a recoverable ticket and rejects replay', async () => {
    const config = await start();
    m4_expect(config.serverClientId).toBe(m4_provider.clientId);
    const payload = { state: config.state, recoveryToken, idToken: await m4_provider.nativeIdToken(config.nonce) };
    const response = await post('/auth/oidc/native/complete', payload);
    m4_expect(response.statusCode).toBe(200);
    m4_expect(response.json()).toEqual({ completed: true });
    m4_expect(observe.mock.calls.map(([input]) => input.stage)).toEqual(['started','provider_returned','ticket_issued']);
    m4_expect(response.headers.location).toBeUndefined();
    const recovered = await post('/auth/oidc/completion', { recoveryToken });
    m4_expect(recovered.statusCode).toBe(200);
    m4_expect(recovered.json()).toMatchObject({ ticket: recoveryToken, provider: 'https://accounts.google.com' });
    m4_expect((await post('/auth/oidc/native/complete', payload)).statusCode).toBe(400);
    const otherTenant = await post('/auth/oidc/completion', { recoveryToken }, m4_betaTenant.host);
    m4_expect(otherTenant.statusCode).toBe(202);
    await post('/auth/oidc/completion/cancel', { recoveryToken });
    m4_expect(observe.mock.calls.at(-1)?.[0]).toMatchObject({ stage: 'cancelled' });
    m4_expect((await post('/auth/oidc/completion', { recoveryToken })).statusCode).toBe(410);
  });

  m4_it.each(['nonce', 'issuer', 'audience', 'authorizedParty'])('rejects an incorrect %s without issuing a ticket', async field => {
    const config = await start();
    if (field === 'issuer') m4_provider.claims.issuer = 'https://attacker.example';
    if (field === 'audience') m4_provider.claims.audience = 'other-client';
    if (field === 'authorizedParty') m4_provider.claims.authorizedParty = 'other-android-client';
    const idToken = await m4_provider.nativeIdToken(field === 'nonce' ? 'wrong' : config.nonce);
    m4_expect((await post('/auth/oidc/native/complete', { state: config.state, recoveryToken, idToken })).statusCode).toBe(401);
    m4_expect(await m4_store.findTicket(recoveryChallenge)).toBeNull();
    m4_expect(observe.mock.calls.at(-1)?.[0]).toMatchObject({ stage: 'failed', errorCode: 'invalid_oidc_proof' });
  });

  m4_it('completes native sign-in even when all attempt observations fail', async () => {
    observe.mockRejectedValue(new Error('log unavailable'));
    const config = await start();
    m4_expect((await post('/auth/oidc/native/complete', {
      state: config.state, recoveryToken, idToken: await m4_provider.nativeIdToken(config.nonce),
    })).statusCode).toBe(200);
    m4_expect((await post('/auth/oidc/completion', { recoveryToken })).statusCode).toBe(200);
  });

  m4_it('requires the app-held recovery secret to complete its flow', async () => {
    const config = await start();
    const idToken = await m4_provider.nativeIdToken(config.nonce);
    m4_expect((await post('/auth/oidc/native/complete', {
      state: config.state, recoveryToken: 'x'.repeat(43), idToken,
    })).statusCode).toBe(400);
    m4_expect((await post('/auth/oidc/native/complete', { state: config.state, recoveryToken, idToken })).statusCode).toBe(200);
  });

  m4_it('R-signin-fallback: starts browser sign-in while a canceled native recovery row still exists', async () => {
    await start();
    await post('/auth/oidc/completion/cancel', { recoveryToken });
    const browserSecret = 'b'.repeat(43);
    const query = new URLSearchParams({
      app_redirect: `${m4_alphaTenant.origin}/auth/oidc/mobile-callback`,
      app_state: 's'.repeat(43),
      app_recovery_challenge: m4_createHash('sha256').update(browserSecret).digest('hex'),
    });
    const response = await m4_app.inject({ method: 'GET', url: `/auth/oidc/start?${query}`, headers: { host: m4_alphaTenant.host } });
    m4_expect(response.statusCode).toBe(302);
    m4_expect(response.headers.location).toContain('/authorize');
  });
});
});

import { beforeEach as m5_beforeEach, expect as m5_expect, it as m5_it, vi as m5_vi } from 'vitest';

import {
  app as m5_app,
  alphaTenant as m5_alphaTenant,
  startCookie as m5_startCookie,
  useAuthServerFixture as m5_useAuthServerFixture,
  provider as m5_provider,
} from "../../../tests/helpers/server.js";
import { describe as mergedDescribe5 } from 'vitest';
mergedDescribe5("server-signin-funnel.test.ts", () => {

const observe = m5_vi.fn(async () => {});

m5_useAuthServerFixture({ onFunnelAuth: observe });

m5_beforeEach(() => { observe.mockReset(); observe.mockResolvedValue(undefined); });

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

m5_it('observes only state-bound GitHub starts/callbacks without codes, cookies, tokens or account IDs', async () => {
  const start = await m5_app.inject({
    method: 'GET',
    headers: { host: m5_alphaTenant.host },
    url: `/auth/github/start?funnel=${encodeURIComponent(JSON.stringify(context))}`,
  });
  m5_expect(start.statusCode).toBe(302);
  const state = new URL(start.headers.location!).searchParams.get('state');
  const invalid = await m5_app.inject({
    method: 'GET',
    headers: { host: m5_alphaTenant.host, cookie: m5_startCookie(start.headers['set-cookie']) },
    url: '/auth/github/callback?state=wrong&code=do-not-log',
  });
  m5_expect(invalid.statusCode).toBe(400);
  m5_expect(observe).toHaveBeenCalledTimes(1);
  const result = await m5_app.inject({
    method: 'GET',
    headers: { host: m5_alphaTenant.host, cookie: m5_startCookie(start.headers['set-cookie']) },
    url: `/auth/github/callback?state=${state}&code=do-not-log`,
  });
  m5_expect(result.statusCode).toBe(200);
  m5_expect(observe).toHaveBeenCalledTimes(2);
  m5_expect(observe.mock.calls[0]?.[0]).toMatchObject({ phase: 'start', provider: 'github', context });
  m5_expect(observe.mock.calls[1]?.[0]).toMatchObject({
    phase: 'callback',
    provider: 'github',
    outcome: 'success',
  });
  const serialized = JSON.stringify(observe.mock.calls);
  m5_expect(serialized).not.toContain('do-not-log');
  m5_expect(serialized).not.toContain('github-user-token');
});

m5_it('observes OIDC cancellation and keeps auth working if telemetry is unavailable', async () => {
  const start = await m5_app.inject({
    method: 'GET',
    headers: { host: m5_alphaTenant.host },
    url: `/auth/oidc/start?funnel=${encodeURIComponent(JSON.stringify({ ...context, provider: 'google' }))}`,
  });
  const state = new URL(start.headers.location!).searchParams.get('state');
  const callback = await m5_app.inject({
    method: 'GET',
    headers: { host: m5_alphaTenant.host, cookie: m5_startCookie(start.headers['set-cookie']) },
    url: `/auth/oidc/callback?state=${state}&error=access_denied`,
  });
  m5_expect(callback.statusCode).toBe(401);
  m5_expect(observe.mock.calls.at(-1)?.[0]).toMatchObject({
    provider: 'google',
    outcome: 'cancelled',
  });
  observe.mockRejectedValueOnce(new Error('telemetry unavailable'));
  const next = await m5_app.inject({
    method: 'GET',
    headers: { host: m5_alphaTenant.host },
    url: `/auth/oidc/start?funnel=${encodeURIComponent(JSON.stringify({ ...context, provider: 'google' }))}`,
  });
  m5_expect(next.statusCode).toBe(302);
});

m5_it('uses the verified OIDC exchange result as the callback source', async () => {
  const start = await m5_app.inject({
    method: 'GET',
    headers: { host: m5_alphaTenant.host },
    url: `/auth/oidc/start?funnel=${encodeURIComponent(JSON.stringify({ ...context, provider: 'google' }))}`,
  });
  const auth = await fetch(start.headers.location!, { redirect: 'manual' });
  const target = new URL(auth.headers.get('location')!);
  const result = await m5_app.inject({
    method: 'GET',
    headers: { host: m5_alphaTenant.host, cookie: m5_startCookie(start.headers['set-cookie']) },
    url: target.pathname + target.search,
  });
  m5_expect(result.statusCode).toBe(200);
  m5_expect(m5_provider.tokenRequests).toBe(1);
  m5_expect(observe.mock.calls.at(-1)?.[0]).toMatchObject({ provider: 'google', outcome: 'success' });
});
});

import { createHash as move0_createHash } from 'node:crypto';

import { afterEach as move0_afterEach, beforeEach as move0_beforeEach, describe as move0_describe, expect as move0_expect, it as move0_it, vi as move0_vi } from 'vitest';

import { app as move0_app, database as move0_database, store as move0_store, alphaTenant as move0_alphaTenant, useAuthServerFixture as move0_useAuthServerFixture } from "../../../tests/helpers/server.js";
import { describe as movedDescribe0 } from 'vitest';
movedDescribe0("server-held-completion.test.ts", () => {

const listeners = new Map<string, Set<() => void>>();

move0_useAuthServerFixture({ subscribeCompletion: (hash, wake) => {
  const group = listeners.get(hash) ?? new Set(); listeners.set(hash, group); group.add(wake);
  return () => { group.delete(wake); if (!group.size) listeners.delete(hash); };
} });

let stop: () => Promise<void>;

move0_beforeEach(async () => {
  stop = await move0_database.client.listen('beeline_command_completion', raw => {
    const event = JSON.parse(raw);
    if (event.principal === 'auth' && event.operation === 'ticket') for (const wake of listeners.get(event.commandId) ?? []) wake();
  });
});

move0_afterEach(async () => { await stop().catch(() => undefined); listeners.clear(); });

const token = 'r'.repeat(43), hash = move0_createHash('sha256').update(token).digest('hex');

move0_describe('F11 held provider completion over committed PostgreSQL capture', () => {
  move0_it.each([['github','https://github.com'],['oidc','https://accounts.google.com']])('%s waits once and completes on its actual committed ticket', async (path, issuer) => {
    const find = move0_vi.spyOn(move0_store, 'findTicket');
    const waiting = move0_app.inject({ method: 'POST', url: `/auth/${path}/completion`, headers: { host: move0_alphaTenant.host }, payload: { recoveryToken: token, waitMs: 1000 } });
    // Fastify inject is a thenable; begin the actual request now.
    const response = Promise.resolve(waiting);
    await move0_vi.waitFor(() => move0_expect(find).toHaveBeenCalledTimes(1));
    const now = new Date();
    await move0_store.createTicket(hash, { challenge: 'c'.repeat(43), community: move0_alphaTenant.community,
      issuer, audience: 'test', subject: 'synthetic-person', createdAt: now, expiresAt: new Date(now.getTime()+120_000),
      attemptCount: 0, consumedAt: null, boundPubkey: null });
    const result = await response;
    move0_expect(result.statusCode).toBe(200); move0_expect(result.json()).toMatchObject({ ticket: token, provider: issuer });
    move0_expect(find).toHaveBeenCalledTimes(2); move0_expect(listeners.size).toBe(0);
  });
});
});
