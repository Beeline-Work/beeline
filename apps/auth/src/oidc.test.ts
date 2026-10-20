import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { describe, expect, it } from 'vitest';
import { normalizeIssuer } from './protocol.js';
import { OidcClient, RotatingJwksCache } from './oidc.js';

async function rsaJwk(kid: string): Promise<JWK> {
  const pair = await generateKeyPair('RS256');
  return { ...(await exportJWK(pair.publicKey)), kid, alg: 'RS256', use: 'sig' };
}

describe('OIDC provider hardening', () => {
  it('accepts both Google issuers, keeps verified profile fields, and rejects another issuer', async () => {
    const pair = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'google', alg: 'RS256' };
    const client = new OidcClient(
      {
        issuer: 'https://accounts.google.com',
        authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenEndpoint: 'https://oauth2.googleapis.com/token',
        jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
        clientId: 'client',
      },
      { fetch: async () => new Response(JSON.stringify({ keys: [jwk] })) },
    );
    const authorization = new URL(
      client.authorizationUrl({
        state: 'state',
        nonce: 'nonce',
        codeChallenge: 'challenge',
        redirectUri: 'https://auth.example/callback',
      }),
    );
    expect(authorization.searchParams.get('scope')).toBe('openid email profile');
    const token = (issuer: string, nonce = 'nonce', audience = 'client') =>
      new SignJWT({
        nonce,
        name: 'Google Person',
        email: 'Alex.Chen@gmail.com',
        email_verified: true,
        picture: 'https://example.com/photo',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'google' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject('google-sub')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(pair.privateKey);
    for (const issuer of ['https://accounts.google.com', 'accounts.google.com']) {
      await expect(client.verifyIdToken(await token(issuer), 'nonce')).resolves.toEqual({
        issuer: 'https://accounts.google.com',
        audience: 'client',
        subject: 'google-sub',
        name: 'Google Person',
        email: 'Alex.Chen@gmail.com',
        picture: 'https://example.com/photo',
      });
    }
    await expect(
      client.verifyIdToken(await token('https://attacker.example'), 'nonce'),
    ).rejects.toThrow();
    await expect(
      client.verifyIdToken(await token('accounts.google.com', 'wrong'), 'nonce'),
    ).rejects.toThrow();
    await expect(
      client.verifyIdToken(await token('accounts.google.com', 'nonce', 'other'), 'nonce'),
    ).rejects.toThrow();
  });
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
