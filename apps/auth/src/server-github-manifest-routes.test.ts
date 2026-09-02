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

describe('GitHub App manifest setup + drift endpoints', () => {
  let provider: DemoOidcProvider;
  let database: PgliteDatabase;
  let store: AuthStore;
  let app: FastifyInstance;
  let liveApp: { slug: string; events?: unknown; permissions?: unknown } | Error;
  const SETUP_TOKEN = 'operator-setup-secret';

  beforeEach(async () => {
    provider = new DemoOidcProvider();
    await provider.start();
    const pglite = new PGlite();
    await pglite.waitReady;
    database = new PgliteDatabase(pglite);
    store = new AuthStore(database);
    await store.migrate();
    liveApp = { slug: 'beeline', events: [], permissions: {} };
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
      github: {
        oauth: {
          config: { clientId: 'github-client', clientSecret: 'github-secret' },
        } as unknown as GitHubOAuthClient,
        app: {
          async fetchApp() {
            if (liveApp instanceof Error) throw liveApp;
            return typeof liveApp === 'string' ? JSON.parse(liveApp) : liveApp;
          },
        } as unknown as GitHubAppClient,
      },
      githubSetupToken: SETUP_TOKEN,
      tenants: [alphaTenant],
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
    await database.close();
    await provider.close();
  });

  it('is operator-gated: dark without a token, refused with a wrong token', async () => {
    const ungatedApp = buildAuthServer({
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
      tenants: [alphaTenant],
    });
    try {
      for (const url of ['/auth/github/app-setup', '/auth/github/app-drift']) {
        expect(
          (await ungatedApp.inject({ method: 'GET', url, headers: { host: alphaTenant.host } }))
            .statusCode,
        ).toBe(503);
      }
    } finally {
      await ungatedApp.close();
    }
    for (const url of [
      '/auth/github/app-setup?token=wrong',
      '/auth/github/app-drift?token=wrong',
      '/auth/github/app-setup',
      '/auth/github/app-drift',
    ]) {
      expect(
        (await app.inject({ method: 'GET', url, headers: { host: alphaTenant.host } })).statusCode,
      ).toBe(403);
    }
  });

  it('serves the manifest form preconfigured with webhook URL, events, and permissions', async () => {
    const result = await app.inject({
      method: 'GET',
      url: `/auth/github/app-setup?token=${SETUP_TOKEN}`,
      headers: { host: alphaTenant.host },
    });
    expect(result.statusCode).toBe(200);
    expect(result.headers['content-type']).toContain('text/html');
    const match = result.body.match(/name="manifest" value="([^"]+)"/);
    expect(match).toBeDefined();
    const manifest = JSON.parse(match![1]!.replaceAll('&quot;', '"').replaceAll('&#39;', "'"));
    expect(manifest.hook_attributes).toEqual({
      url: 'https://alpha.example/auth/github/webhook',
      active: true,
    });
    expect(manifest.default_events).toEqual([
      'star',
      'issues',
      'pull_request',
      'push',
      'check_run',
      'check_suite',
      'status',
    ]);
    expect(manifest.default_permissions.contents).toBe('write');
    expect(manifest.redirect_url).toBe(
      `https://alpha.example/auth/github/app-setup?token=${encodeURIComponent(SETUP_TOKEN)}`,
    );
  });

  it('exchanges the redirect code once and renders the env block without logging the private key', async () => {
    const logLines: string[] = [];
    app.log.info = ((message: unknown) => {
      logLines.push(typeof message === 'string' ? message : JSON.stringify(message));
    }) as typeof app.log.info;
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 42,
              slug: 'beeline-fresh',
              html_url: 'https://github.com/apps/beeline-fresh',
              client_id: 'Iv1.fresh',
              client_secret: 'fresh-secret',
              webhook_secret: 'fresh-webhook-secret',
              pem,
            }),
            { status: 201 },
          ),
      ),
    );
    const result = await app.inject({
      method: 'GET',
      url: `/auth/github/app-setup?token=${SETUP_TOKEN}&code=one-time-code`,
      headers: { host: alphaTenant.host },
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain('BEELINE_GITHUB_APP_ID=42');
    expect(result.body).toContain('BEELINE_GITHUB_APP_SLUG=beeline-fresh');
    expect(result.body).toContain('BEELINE_GITHUB_WEBHOOK_SECRET=fresh-webhook-secret');
    // The PEM is newline-escaped exactly as github.ts unescapes it.
    expect(result.body).toContain(pem.replaceAll('\n', '\\n'));
    // The private key never reaches the log — only its slug summary.
    expect(logLines.some((line) => line.includes('RSA PRIVATE KEY'))).toBe(false);
    expect(logLines.join('\n')).toContain('beeline-fresh');
  });

  it('renders an honest failure page when the conversion code is spent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })),
    );
    const result = await app.inject({
      method: 'GET',
      url: `/auth/github/app-setup?token=${SETUP_TOKEN}&code=spent-code`,
      headers: { host: alphaTenant.host },
    });
    expect(result.statusCode).toBe(502);
    expect(result.body).toContain('single-use');
  });

  it('reports drift on demand and logs one actionable line', async () => {
    const logLines: string[] = [];
    app.log.info = ((message: unknown) => {
      logLines.push(typeof message === 'string' ? message : JSON.stringify(message));
    }) as typeof app.log.info;
    const result = await app.inject({
      method: 'GET',
      url: `/auth/github/app-drift?token=${SETUP_TOKEN}`,
      headers: { host: alphaTenant.host },
    });
    expect(result.statusCode).toBe(200);
    const body = result.json<{ drift: { ok: boolean; missingEvents: string[] } | null }>();
    expect(body.drift?.ok).toBe(false);
    expect(body.drift?.missingEvents).toEqual([
      'star',
      'issues',
      'pull_request',
      'push',
      'check_run',
      'check_suite',
      'status',
    ]);
    expect(logLines.filter((line) => line.includes('/permissions'))).toHaveLength(1);
  });
});
