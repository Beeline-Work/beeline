import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { describe, expect, it } from 'vitest';
import { normalizeIssuer } from './protocol.js';
import { OidcClient, RotatingJwksCache } from './oidc.js';

async function rsaJwk(kid: string): Promise<JWK> {
  const pair = await generateKeyPair('RS256');
  return { ...(await exportJWK(pair.publicKey)), kid, alg: 'RS256', use: 'sig' };
}

describe('OIDC provider hardening', () => {
  it('normalizes issuer URLs without weakening their origin', () => {
    expect(normalizeIssuer('https://ACCOUNTS.EXAMPLE:443/')).toBe('https://accounts.example');
    expect(() => normalizeIssuer('http://accounts.example')).toThrow('must use https');
    expect(() => normalizeIssuer('https://accounts.example?tenant=other')).toThrow();
  });

  it('honors provider cache lifetime and refreshes on key rotation', async () => {
    const first = await rsaJwk('first');
    const second = await rsaJwk('second');
    let now = 100_000;
    let keys = [first];
    let requests = 0;
    const cache = new RotatingJwksCache('https://issuer.example/jwks', {
      now: () => now,
      refreshCooldownMs: 0,
      fetch: async () => {
        requests += 1;
        return new Response(JSON.stringify({ keys }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'max-age=10' },
        });
      },
    });

    await expect(cache.key('first')).resolves.toBeDefined();
    await expect(cache.key('first')).resolves.toBeDefined();
    expect(requests).toBe(1);
    keys = [second];
    now += 11_000;
    await expect(cache.key('second')).resolves.toBeDefined();
    expect(requests).toBe(2);
    await expect(cache.key('first')).rejects.toThrow('usable provider JWKS');
  });

  it('uses a known stale key only for a bounded provider outage', async () => {
    const first = await rsaJwk('first');
    let now = 100_000;
    let fail = false;
    const cache = new RotatingJwksCache('https://issuer.example/jwks', {
      now: () => now,
      defaultMaxAgeMs: 1_000,
      maximumMaxAgeMs: 1_000,
      staleIfErrorMs: 2_000,
      refreshCooldownMs: 0,
      fetch: async () => {
        if (fail) throw new Error('provider unavailable');
        return new Response(JSON.stringify({ keys: [first] }), { status: 200 });
      },
    });

    await expect(cache.key('first')).resolves.toBeDefined();
    fail = true;
    now += 1_500;
    await expect(cache.key('first')).resolves.toBeDefined();
    now += 2_000;
    await expect(cache.key('first')).rejects.toThrow('JWKS refresh failed');
    await expect(cache.key('unknown')).rejects.toThrow('JWKS refresh failed');
  });

  it('has no HS256 configuration path', async () => {
    const client = new OidcClient({
      issuer: 'https://issuer.example',
      authorizationEndpoint: 'https://issuer.example/authorize',
      tokenEndpoint: 'https://issuer.example/token',
      jwksUri: 'https://issuer.example/jwks',
      clientId: 'client',
    });
    const now = Math.floor(Date.now() / 1_000);
    const token = await new SignJWT({ nonce: 'nonce' })
      .setProtectedHeader({ alg: 'HS256', kid: 'symmetric-key' })
      .setIssuer('https://issuer.example')
      .setAudience('client')
      .setSubject('subject')
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(new TextEncoder().encode('a symmetric key that production must never accept'));
    await expect(client.verifyIdToken(token, 'nonce')).rejects.toThrow('must be RS256');
  });
});
