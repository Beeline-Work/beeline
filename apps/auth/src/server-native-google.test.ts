import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { alphaTenant, betaTenant, app, provider, store, useAuthServerFixture } from './server-test-fixture.js';

const recoveryToken = 'r'.repeat(43);
const recoveryChallenge = createHash('sha256').update(recoveryToken).digest('hex');
const post = (url: string, payload: unknown, host = alphaTenant.host) =>
  app.inject({ method: 'POST', url, payload, headers: { host } });

describe('Native Android Google sign-in', () => {
  useAuthServerFixture({ nativeGoogle: true });

  const start = async () => {
    const response = await post('/auth/oidc/native/start', { recoveryChallenge });
    expect(response.statusCode).toBe(200);
    return response.json() as { state: string; nonce: string; serverClientId: string };
  };

  it('R-signin-native: validates the nonce-bound token, issues a recoverable ticket and rejects replay', async () => {
    const config = await start();
    expect(config.serverClientId).toBe(provider.clientId);
    const payload = { state: config.state, recoveryToken, idToken: await provider.nativeIdToken(config.nonce) };
    const response = await post('/auth/oidc/native/complete', payload);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ completed: true });
    expect(response.headers.location).toBeUndefined();
    const recovered = await post('/auth/oidc/completion', { recoveryToken });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ ticket: recoveryToken, provider: 'https://accounts.google.com' });
    expect((await post('/auth/oidc/native/complete', payload)).statusCode).toBe(400);
    const otherTenant = await post('/auth/oidc/completion', { recoveryToken }, betaTenant.host);
    expect(otherTenant.statusCode).toBe(202);
    await post('/auth/oidc/completion/cancel', { recoveryToken });
    expect((await post('/auth/oidc/completion', { recoveryToken })).statusCode).toBe(410);
  });

  it.each(['nonce', 'issuer', 'audience', 'authorizedParty'])('rejects an incorrect %s without issuing a ticket', async field => {
    const config = await start();
    if (field === 'issuer') provider.claims.issuer = 'https://attacker.example';
    if (field === 'audience') provider.claims.audience = 'other-client';
    if (field === 'authorizedParty') provider.claims.authorizedParty = 'other-android-client';
    const idToken = await provider.nativeIdToken(field === 'nonce' ? 'wrong' : config.nonce);
    expect((await post('/auth/oidc/native/complete', { state: config.state, recoveryToken, idToken })).statusCode).toBe(401);
    expect(await store.findTicket(recoveryChallenge)).toBeNull();
  });

  it('requires the app-held recovery secret to complete its flow', async () => {
    const config = await start();
    const idToken = await provider.nativeIdToken(config.nonce);
    expect((await post('/auth/oidc/native/complete', {
      state: config.state, recoveryToken: 'x'.repeat(43), idToken,
    })).statusCode).toBe(400);
    expect((await post('/auth/oidc/native/complete', { state: config.state, recoveryToken, idToken })).statusCode).toBe(200);
  });

  it('R-signin-fallback: starts browser sign-in while a canceled native recovery row still exists', async () => {
    await start();
    await post('/auth/oidc/completion/cancel', { recoveryToken });
    const browserSecret = 'b'.repeat(43);
    const query = new URLSearchParams({
      app_redirect: `${alphaTenant.origin}/auth/oidc/mobile-callback`,
      app_state: 's'.repeat(43),
      app_recovery_challenge: createHash('sha256').update(browserSecret).digest('hex'),
    });
    const response = await app.inject({ method: 'GET', url: `/auth/oidc/start?${query}`, headers: { host: alphaTenant.host } });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('/authorize');
  });
});
