import { createHash, createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { generateKeypair, nip98AuthHeader, signEvent, type Keypair } from '@beeline/nostr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OidcClient } from './oidc.js';
import { GitHubAppClient, GitHubOAuthClient } from './github.js';
import { OIDC_BIND_KIND, OIDC_BIND_MARKER } from './protocol.js';
import { buildAuthServer } from './server.js';
import { AuthStore } from './store.js';
import type { FastifyInstance } from 'fastify';
import {
  DemoOidcProvider,
  PgliteDatabase,
  alphaTenant,
  betaTenant,
  bindEvent,
  startCookie,
  type BindChallenge,
} from './server-test-fixture.js';

describe('NIP-05 handle issuance', () => {
  let provider: DemoOidcProvider;
  let database: PgliteDatabase;
  let store: AuthStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    provider = new DemoOidcProvider();
    await provider.start();
    const pglite = new PGlite();
    await pglite.waitReady;
    database = new PgliteDatabase(pglite);
    store = new AuthStore(database);
    await store.migrate();
    app = buildAuthServer({
      store,
      oidc: new OidcClient({
        issuer: provider.issuer,
        authorizationEndpoint: `${provider.baseUrl}/authorize`,
        tokenEndpoint: `${provider.baseUrl}/token`,
        jwksUri: `${provider.baseUrl}/jwks`,
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
        allowInsecure: true,
      }),
      tenants: [alphaTenant, betaTenant],
    });
  });

  afterEach(async () => {
    await app.close();
    await database.close();
    await provider.close();
  });

  it('stays dark without GitHub config while the existing OIDC route remains live', async () => {
    const capabilities = await app.inject({
      method: 'GET',
      url: '/auth/capabilities',
      headers: { host: alphaTenant.host },
    });
    expect(capabilities.json()).toEqual({ github: false, oidc: true });

    const github = await app.inject({
      method: 'GET',
      url: '/auth/github/start',
      headers: { host: alphaTenant.host },
    });
    expect(github.statusCode).toBe(503);

    const oidc = await app.inject({
      method: 'GET',
      url: '/auth/oidc/start',
      headers: { host: alphaTenant.host },
    });
    expect(oidc.statusCode).toBe(302);
  });

  function claim(name: string, identity: Keypair, tenant = alphaTenant) {
    const url = `${tenant.origin}/nip05/claim`;
    const authorization = nip98AuthHeader(identity.secretKey, identity.publicKey, url, 'POST');
    return app.inject({
      method: 'POST',
      url: '/nip05/claim',
      headers: { host: tenant.host, authorization },
      payload: { name },
    });
  }

  it('claims a handle first-come-first-served, rejects a second claim by another key, and is idempotent for the owner', async () => {
    const alice = generateKeypair();
    const bob = generateKeypair();

    const first = await claim('alice', alice);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      claimed: true,
      idempotent: false,
      name: 'alice',
      pubkey: alice.publicKey,
      identity: {
        handle: 'alice',
        display_name: 'alice',
        nip05: 'alice@usebeeline.app',
        source: 'key',
      },
    });

    const stolen = await claim('alice', bob);
    expect(stolen.statusCode).toBe(409);
    expect(stolen.json().error).toBe('name_taken');

    const reclaimedBySameOwner = await claim('alice', alice);
    expect(reclaimedBySameOwner.statusCode).toBe(200);
    expect(reclaimedBySameOwner.json()).toMatchObject({
      claimed: true,
      idempotent: true,
      name: 'alice',
      pubkey: alice.publicKey,
    });
  });

  it('requires NIP-98 authentication and rejects a replayed claim event', async () => {
    const unauthenticated = await app.inject({
      method: 'POST',
      url: '/nip05/claim',
      headers: { host: alphaTenant.host },
      payload: { name: 'nobody' },
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json().error).toBe('unauthorized');

    const identity = generateKeypair();
    const url = `${alphaTenant.origin}/nip05/claim`;
    const authorization = nip98AuthHeader(identity.secretKey, identity.publicKey, url, 'POST');
    const first = await app.inject({
      method: 'POST',
      url: '/nip05/claim',
      headers: { host: alphaTenant.host, authorization },
      payload: { name: 'once' },
    });
    expect(first.statusCode).toBe(201);
    const replay = await app.inject({
      method: 'POST',
      url: '/nip05/claim',
      headers: { host: alphaTenant.host, authorization },
      payload: { name: 'twice' },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toBe('replayed_auth');
  });

  it('rejects malformed and reserved handle names', async () => {
    const identity = generateKeypair();
    for (const bad of [
      'Alice',
      'a',
      'ab',
      'has space',
      '-leading-dash',
      'has_underscore',
      'x'.repeat(31),
      'admin',
      'beeline',
      '_',
    ]) {
      const response = await claim(bad, identity);
      expect(response.statusCode, bad).toBe(400);
      expect(response.json().error).toBe('invalid_name');
    }
  });

  it('serves the well-known responder with the claimed pubkey and permissive CORS', async () => {
    const alice = generateKeypair();
    await claim('alice', alice);

    const resolved = await app.inject({
      method: 'GET',
      url: '/.well-known/nostr.json?name=alice',
      headers: { host: alphaTenant.host },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.headers['content-type']).toContain('application/json');
    expect(resolved.headers['access-control-allow-origin']).toBe('*');
    expect(resolved.json()).toEqual({ names: { alice: alice.publicKey } });

    const unknown = await app.inject({
      method: 'GET',
      url: '/.well-known/nostr.json?name=ghost',
      headers: { host: alphaTenant.host },
    });
    expect(unknown.json()).toEqual({ names: {} });

    const noFilter = await app.inject({
      method: 'GET',
      url: '/.well-known/nostr.json',
      headers: { host: alphaTenant.host },
    });
    expect(noFilter.json()).toEqual({ names: {} });
  });
});
