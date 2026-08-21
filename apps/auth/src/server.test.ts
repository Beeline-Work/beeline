import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { PGlite, type PGliteInterface, type Transaction } from '@electric-sql/pglite';
import { generateKeypair, nip98AuthHeader, signEvent, type Keypair } from '@beeline/nostr';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OidcClient } from './oidc.js';
import { GitHubAppClient, GitHubOAuthClient } from './github.js';
import { OIDC_BIND_KIND, OIDC_BIND_MARKER } from './protocol.js';
import { buildAuthServer, type AuthTenant } from './server.js';
import {
  AuthStore,
  type SqlExecutor,
  type SqlResult,
  type TransactionalDatabase,
} from './store.js';
import type { QueryResultRow } from 'pg';
import type { FastifyInstance } from 'fastify';

class PgliteDatabase implements TransactionalDatabase {
  constructor(readonly client: PGliteInterface) {}

  async query<Row extends QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<SqlResult<Row>> {
    const result = await this.client.query<Row>(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }

  async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    return this.client.transaction(async (transaction) => work(this.executor(transaction)));
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private executor(transaction: Transaction): SqlExecutor {
    return {
      query: async <Row extends QueryResultRow>(sql: string, values: unknown[] = []) => {
        const result = await transaction.query<Row>(sql, values);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
      },
    };
  }
}

interface AuthorizationRecord {
  codeChallenge: string;
  nonce: string;
  redirectUri: string;
}

interface ProviderClaims {
  issuer?: string;
  audience?: string | string[];
  authorizedParty?: string;
  subject?: string;
}

class DemoOidcProvider {
  readonly clientId = 'beeline-test-client';
  readonly clientSecret = 'test-secret';
  readonly kid = 'demo-rsa-1';
  baseUrl = '';
  tokenRequests = 0;
  claims: ProviderClaims = {};
  private server: Server | null = null;
  private privateKey!: KeyLike;
  private publicJwk!: JWK;
  private readonly codes = new Map<string, AuthorizationRecord>();
  private nextCode = 0;

  get issuer(): string {
    return `${this.baseUrl}/issuer`;
  }

  async start(): Promise<void> {
    const pair = await generateKeyPair('RS256');
    this.privateKey = pair.privateKey;
    this.publicJwk = {
      ...(await exportJWK(pair.publicKey)),
      kid: this.kid,
      alg: 'RS256',
      use: 'sig',
    };
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end('{"error":"emulator_failure"}');
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) =>
      this.server!.close((error) => (error ? reject(error) : resolve())),
    );
    this.server = null;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.baseUrl);
    if (request.method === 'GET' && url.pathname === '/authorize') {
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe(this.clientId);
      expect(url.searchParams.get('scope')).toBe('openid');
      expect(url.searchParams.get('prompt')).toBe('select_account');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      const state = url.searchParams.get('state');
      const nonce = url.searchParams.get('nonce');
      const codeChallenge = url.searchParams.get('code_challenge');
      const redirectUri = url.searchParams.get('redirect_uri');
      if (!state || !nonce || !codeChallenge || !redirectUri)
        throw new Error('missing authorize input');
      const code = `demo-code-${++this.nextCode}`;
      this.codes.set(code, { codeChallenge, nonce, redirectUri });
      const callback = new URL(redirectUri);
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', state);
      response.writeHead(302, { location: callback.toString() });
      response.end();
      return;
    }

    if (request.method === 'GET' && url.pathname === '/jwks') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=60',
      });
      response.end(JSON.stringify({ keys: [this.publicJwk] }));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/token') {
      this.tokenRequests += 1;
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const code = body.get('code') ?? '';
      const record = this.codes.get(code);
      if (!record) return this.json(response, 400, { error: 'invalid_grant' });
      this.codes.delete(code);
      const verifier = body.get('code_verifier') ?? '';
      const actualChallenge = createHash('sha256').update(verifier).digest('base64url');
      if (
        body.get('grant_type') !== 'authorization_code' ||
        body.get('client_id') !== this.clientId ||
        body.get('client_secret') !== this.clientSecret ||
        body.get('redirect_uri') !== record.redirectUri ||
        actualChallenge !== record.codeChallenge
      ) {
        return this.json(response, 400, { error: 'invalid_request' });
      }
      const now = Math.floor(Date.now() / 1_000);
      const issuer = this.claims.issuer ?? this.issuer;
      const audience = this.claims.audience ?? this.clientId;
      const subject = this.claims.subject ?? 'google-subject-123';
      const token = new SignJWT({
        nonce: record.nonce,
        ...(this.claims.authorizedParty === undefined ? {} : { azp: this.claims.authorizedParty }),
      })
        .setProtectedHeader({ alg: 'RS256', kid: this.kid, typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject(subject)
        .setIssuedAt(now)
        .setExpirationTime(now + 600);
      return this.json(response, 200, {
        token_type: 'Bearer',
        id_token: await token.sign(this.privateKey),
      });
    }

    this.json(response, 404, { error: 'not_found' });
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }
}

interface BindChallenge {
  protocol: number;
  kind: number;
  marker: string;
  ticket: string;
  challenge: string;
  provider: string;
  audience: string;
  subject: string;
  community: string;
  issued_at: number;
  expires_at: number;
}

const alphaTenant: AuthTenant = {
  host: 'alpha.example',
  community: 'community-alpha',
  origin: 'https://alpha.example',
};
const betaTenant: AuthTenant = {
  host: 'beta.example',
  community: 'community-beta',
  origin: 'https://beta.example',
};

function startCookie(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error('OIDC start response did not set its browser-session cookie');
  return value.split(';', 1)[0]!;
}

function bindEvent(challenge: BindChallenge, identity: Keypair) {
  return signEvent(
    {
      pubkey: identity.publicKey,
      created_at: Math.floor(Date.now() / 1_000),
      kind: OIDC_BIND_KIND,
      tags: [
        ['t', OIDC_BIND_MARKER],
        ['protocol', String(challenge.protocol)],
        ['ticket', challenge.ticket],
        ['challenge', challenge.challenge],
        ['provider', challenge.provider],
        ['audience', challenge.audience],
        ['subject', challenge.subject],
        ['community', challenge.community],
        ['issued_at', String(challenge.issued_at)],
        ['expires_at', String(challenge.expires_at)],
      ],
      content: '',
    },
    identity.secretKey,
  );
}

describe('hardened OIDC to Nostr-key binding HTTP protocol', () => {
  let provider: DemoOidcProvider;
  let database: PgliteDatabase;
  let store: AuthStore;
  let app: FastifyInstance;
  let githubState = '';

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
      github: {
        oauth: {
          config: { clientId: 'github-client', clientSecret: 'github-secret' },
          authorizationUrl: ({ state, redirectUri }: { state: string; redirectUri: string }) => {
            githubState = state;
            return `https://github.test/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
          },
          exchangeCode: async () => ({
            issuer: 'https://github.com' as const,
            audience: 'github-client',
            subject: '123',
            login: 'octocat',
            accessToken: 'github-user-token',
          }),
        } as unknown as GitHubOAuthClient,
        app: {
          installationUrl: (state: string) =>
            `https://github.test/apps/beeline/installations/new?state=${state}`,
          installationAccount: async (installationId: number) => ({
            id: installationId === 77 ? '123' : '456',
            login: installationId === 77 ? 'octocat' : 'acme',
            type: installationId === 77 ? ('User' as const) : ('Organization' as const),
            repositorySelection: 'all' as const,
          }),
          userCanAccessInstallation: async () => true,
          listRepositories: async (installationId: number) => [
            {
              id: 42,
              installationId,
              name: 'widget',
              fullName: installationId === 77 ? 'octocat/widget' : 'acme/widget',
              remote:
                installationId === 77
                  ? 'https://github.com/octocat/widget.git'
                  : 'https://github.com/acme/widget.git',
              defaultBranch: 'main',
            },
          ],
        } as unknown as GitHubAppClient,
        webhookSecret: 'webhook-secret',
      },
      tenants: [alphaTenant, betaTenant],
      nativeRedirectUris: [
        'buzzy-dev://buzz/oidc-callback',
        'buzzy-preview://buzz/oidc-callback',
        'buzzy://buzz/oidc-callback',
      ],
    });
  });

  afterEach(async () => {
    await app.close();
    await database.close();
    await provider.close();
  });

  async function ceremony(tenant = alphaTenant): Promise<BindChallenge> {
    const start = await app.inject({
      method: 'GET',
      url: '/auth/oidc/start',
      headers: { host: tenant.host },
    });
    expect(start.statusCode).toBe(302);
    expect(String(start.headers['set-cookie'])).toContain('__Host-beeline_oidc_flow=');
    expect(String(start.headers['set-cookie'])).toContain('Secure');
    const cookie = startCookie(start.headers['set-cookie']);
    const authorization = await fetch(start.headers.location!, { redirect: 'manual' });
    expect(authorization.status).toBe(302);
    const callback = new URL(authorization.headers.get('location')!);
    const result = await app.inject({
      method: 'GET',
      url: `${callback.pathname}${callback.search}`,
      headers: { host: tenant.host, cookie },
    });
    expect(result.statusCode).toBe(200);
    return result.json<BindChallenge>();
  }

  it('advertises GitHub only when its complete configuration is present', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/capabilities',
      headers: { host: alphaTenant.host },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ github: true, oidc: true });
  });

  it('completes GitHub sign-in directly into the app deep link', async () => {
    const appState = 'g'.repeat(43);
    const redirectUri = 'buzzy://buzz/github-callback';
    const start = await app.inject({
      method: 'GET',
      url: `/auth/github/start?app_redirect=${encodeURIComponent(redirectUri)}&app_state=${appState}`,
      headers: { host: alphaTenant.host },
    });
    expect(start.statusCode).toBe(302);

    const callback = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=github-code&state=${githubState}`,
      headers: { host: alphaTenant.host, cookie: startCookie(start.headers['set-cookie']) },
    });
    expect(callback.statusCode).toBe(302);
    const completion = new URL(callback.headers.location!);
    expect(`${completion.protocol}//${completion.host}${completion.pathname}`).toBe(redirectUri);
    expect(completion.searchParams.get('state')).toBe(appState);
    expect(completion.searchParams.get('ticket')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(completion.searchParams.get('provider')).toBe('https://github.com');
  });

  it('serves the legacy GitHub mobile callback as a human app handoff, never a 404', async () => {
    const appState = 'h'.repeat(43);
    const associatedRedirect = `${alphaTenant.origin}/auth/github/mobile-callback`;
    const start = await app.inject({
      method: 'GET',
      url: `/auth/github/start?app_redirect=${encodeURIComponent(associatedRedirect)}&app_state=${appState}`,
      headers: { host: alphaTenant.host },
    });
    const callback = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=github-code&state=${githubState}`,
      headers: { host: alphaTenant.host, cookie: startCookie(start.headers['set-cookie']) },
    });
    const completion = new URL(callback.headers.location!);
    const handoff = await app.inject({
      method: 'GET',
      url: `${completion.pathname}${completion.search}`,
      headers: { host: alphaTenant.host },
    });

    expect(handoff.statusCode).toBe(200);
    expect(handoff.headers['content-type']).toContain('text/html');
    expect(handoff.body).toContain('Return to Beeline');
    expect(handoff.body).toContain('buzzy://buzz/github-callback?state=');
    expect(handoff.body).toContain(`state=${appState}`);
    expect(handoff.body).not.toContain('Route GET:');

    const installationHandoff = await app.inject({
      method: 'GET',
      url: '/auth/github/mobile-callback?installed=1',
      headers: { host: alphaTenant.host },
    });
    expect(installationHandoff.statusCode).toBe(200);
    expect(installationHandoff.body).toContain('buzzy://buzz/github-installation?installed=1');
  });

  it('groups multiple installations, applies repository webhooks, and preserves revoked bindings', async () => {
    const identity = generateKeypair();
    const appState = 'a'.repeat(43);
    const start = await app.inject({
      method: 'GET',
      url: `/auth/github/start?app_redirect=${encodeURIComponent('https://alpha.example/auth/github/mobile-callback')}&app_state=${appState}`,
      headers: { host: alphaTenant.host },
    });
    expect(start.statusCode).toBe(302);
    const callback = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=github-code&state=${githubState}`,
      headers: { host: alphaTenant.host, cookie: startCookie(start.headers['set-cookie']) },
    });
    expect(callback.statusCode).toBe(302);
    const completion = new URL(callback.headers.location!);
    const challenge = Object.fromEntries(completion.searchParams) as unknown as BindChallenge;
    for (const key of ['protocol', 'kind', 'issued_at', 'expires_at'] as const) {
      (challenge as unknown as Record<string, unknown>)[key] = Number(
        completion.searchParams.get(key),
      );
    }
    const bind = await app.inject({
      method: 'POST',
      url: '/auth/oidc/bind',
      headers: { host: alphaTenant.host },
      payload: { ticket: challenge.ticket, event: bindEvent(challenge, identity) },
    });
    expect(bind.statusCode).toBe(201);

    const installStartUrl = 'https://alpha.example/auth/github/install/start';
    const installStart = await app.inject({
      method: 'POST',
      url: '/auth/github/install/start',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          identity.secretKey,
          identity.publicKey,
          installStartUrl,
          'POST',
        ),
      },
      payload: {
        pubkey: identity.publicKey,
        redirect_uri: 'buzzy://buzz/github-installation',
      },
    });
    expect(installStart.statusCode).toBe(200);
    const installUrl = new URL(installStart.json().authorization_url);
    const installed = await app.inject({
      method: 'GET',
      url: `/auth/github/install/callback?installation_id=77&state=${installUrl.searchParams.get('state')}`,
      headers: { host: alphaTenant.host },
    });
    expect(installed.statusCode).toBe(302);
    expect(installed.headers.location).toBe('buzzy://buzz/github-installation?installed=1');

    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const secondStart = await app.inject({
      method: 'POST',
      url: '/auth/github/install/start',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          identity.secretKey,
          identity.publicKey,
          installStartUrl,
          'POST',
        ),
      },
      payload: {
        pubkey: identity.publicKey,
        redirect_uri: 'https://alpha.example/auth/github/mobile-callback',
      },
    });
    const secondUrl = new URL(secondStart.json().authorization_url);
    const secondInstalled = await app.inject({
      method: 'GET',
      url: `/auth/github/installed?installation_id=78&state=${secondUrl.searchParams.get('state')}`,
      headers: { host: alphaTenant.host },
    });
    expect(secondInstalled.statusCode).toBe(302);

    const reposUrl = `https://alpha.example/auth/github/repos/${identity.publicKey}`;
    const repos = await app.inject({
      method: 'GET',
      url: `/auth/github/repos/${identity.publicKey}`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, reposUrl, 'GET'),
      },
    });
    expect(repos.statusCode).toBe(200);
    expect(repos.json()).toMatchObject({
      installed: true,
      installations: [
        { installationId: 78, accountLogin: 'acme', repositoryCount: 1 },
        { installationId: 77, accountLogin: 'octocat', repositoryCount: 1 },
      ],
      repositories: [
        { installationId: 78, fullName: 'acme/widget' },
        { installationId: 77, fullName: 'octocat/widget' },
      ],
    });

    const repositoryPayload = JSON.stringify({
      action: 'removed',
      installation: { id: 77 },
      repositories_added: [
        {
          id: 43,
          name: 'fresh',
          full_name: 'octocat/fresh',
          clone_url: 'https://github.com/octocat/fresh.git',
          default_branch: 'trunk',
        },
      ],
      repositories_removed: [{ id: 42, full_name: 'octocat/widget' }],
    });
    const webhook = await app.inject({
      method: 'POST',
      url: '/auth/github/webhook',
      headers: {
        host: alphaTenant.host,
        'content-type': 'application/json',
        'x-github-event': 'installation_repositories',
        'x-github-delivery': 'delivery-repositories-1',
        'x-hub-signature-256': `sha256=${createHmac('sha256', 'webhook-secret').update(repositoryPayload).digest('hex')}`,
      },
      payload: repositoryPayload,
    });
    expect(webhook.statusCode).toBe(202);
    const duplicateWebhook = await app.inject({
      method: 'POST',
      url: '/auth/github/webhook',
      headers: {
        host: alphaTenant.host,
        'content-type': 'application/json',
        'x-github-event': 'installation_repositories',
        'x-github-delivery': 'delivery-repositories-1',
        'x-hub-signature-256': `sha256=${createHmac('sha256', 'webhook-secret').update(repositoryPayload).digest('hex')}`,
      },
      payload: repositoryPayload,
    });
    expect(duplicateWebhook.json()).toMatchObject({ accepted: true, duplicate: true });
    expect(
      await store.githubRepositoriesForPubkey(alphaTenant.community, identity.publicKey),
    ).toEqual([
      expect.objectContaining({ installationId: 78, fullName: 'acme/widget' }),
      expect.objectContaining({ installationId: 77, fullName: 'octocat/fresh' }),
    ]);

    const deletedPayload = JSON.stringify({ action: 'deleted', installation: { id: 77 } });
    const deleted = await app.inject({
      method: 'POST',
      url: '/auth/github/webhook',
      headers: {
        host: alphaTenant.host,
        'content-type': 'application/json',
        'x-github-event': 'installation',
        'x-github-delivery': 'delivery-installation-2',
        'x-hub-signature-256': `sha256=${createHmac('sha256', 'webhook-secret').update(deletedPayload).digest('hex')}`,
      },
      payload: deletedPayload,
    });
    expect(deleted.statusCode).toBe(202);
    await expect(
      store.githubRepositoryAccess(alphaTenant.community, identity.publicKey, 'octocat/widget'),
    ).resolves.toMatchObject({ accessible: false, installationId: 77, reason: 'revoked' });
  });

  async function bind(
    challenge: BindChallenge,
    identity: Keypair,
    extra: Record<string, unknown> = {},
  ) {
    return app.inject({
      method: 'POST',
      url: '/auth/oidc/bind',
      headers: { host: alphaTenant.host },
      payload: { ticket: challenge.ticket, event: bindEvent(challenge, identity), ...extra },
    });
  }

  it('completes code + PKCE + nonce, persists the mapping, and authenticates private lookup with NIP-98', async () => {
    const challenge = await ceremony();
    const identity = generateKeypair();
    const result = await bind(challenge, identity);
    expect(result.statusCode).toBe(201);
    expect(result.json()).toEqual({ linked: true, idempotent: false, pubkey: identity.publicKey });
    const replayedBind = await bind(challenge, identity);
    expect(replayedBind.statusCode).toBe(200);
    expect(replayedBind.json()).toEqual({
      linked: true,
      idempotent: true,
      pubkey: identity.publicKey,
    });
    expect(provider.tokenRequests).toBe(1);

    const unauthenticated = await app.inject({
      method: 'GET',
      url: `/auth/oidc/links/${identity.publicKey}`,
      headers: { host: alphaTenant.host },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const url = `${alphaTenant.origin}/auth/oidc/links/${identity.publicKey}`;
    const authorization = nip98AuthHeader(identity.secretKey, identity.publicKey, url, 'GET');
    const lookup = await app.inject({
      method: 'GET',
      url: `/auth/oidc/links/${identity.publicKey}`,
      headers: { host: alphaTenant.host, authorization },
    });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json().links).toEqual([
      expect.objectContaining({
        community: alphaTenant.community,
        provider: provider.issuer,
        audience: provider.clientId,
        subject: 'google-subject-123',
        pubkey: identity.publicKey,
      }),
    ]);
    expect(lookup.body).not.toContain('email');

    const replay = await app.inject({
      method: 'GET',
      url: `/auth/oidc/links/${identity.publicKey}`,
      headers: { host: alphaTenant.host, authorization },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toBe('replayed_auth');
  });

  it('returns a native bind challenge only through an allowlisted state-bound app callback', async () => {
    const appState = 's'.repeat(43);
    const associatedRedirect = `${alphaTenant.origin}/auth/oidc/mobile-callback`;
    const start = await app.inject({
      method: 'GET',
      url: `/auth/oidc/start?app_redirect=${encodeURIComponent(associatedRedirect)}&app_state=${appState}`,
      headers: { host: alphaTenant.host },
    });
    expect(start.statusCode).toBe(302);
    const cookie = startCookie(start.headers['set-cookie']);
    const authorization = await fetch(start.headers.location!, { redirect: 'manual' });
    const callback = new URL(authorization.headers.get('location')!);
    const result = await app.inject({
      method: 'GET',
      url: `${callback.pathname}${callback.search}`,
      headers: { host: alphaTenant.host, cookie },
    });
    expect(result.statusCode).toBe(302);
    const completion = new URL(result.headers.location!);
    expect(`${completion.origin}${completion.pathname}`).toBe(associatedRedirect);
    expect(completion.searchParams.get('state')).toBe(appState);
    expect(completion.searchParams.get('ticket')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(completion.searchParams.has('code')).toBe(false);
    expect(completion.searchParams.has('id_token')).toBe(false);
  });

  it('accepts one callback slash but rejects any wider redirect variation', async () => {
    const appState = 's'.repeat(43);
    for (const [providerName, appRedirect] of [
      ['oidc', `${alphaTenant.origin}/auth/oidc/mobile-callback/`],
      ['github', 'buzzy://buzz/github-callback/'],
    ] as const) {
      const result = await app.inject({
        method: 'GET',
        url: `/auth/${providerName}/start?app_redirect=${encodeURIComponent(appRedirect)}&app_state=${appState}`,
        headers: { host: alphaTenant.host },
      });
      expect(result.statusCode).toBe(302);
    }

    for (const [providerName, appRedirect] of [
      ['oidc', `${alphaTenant.origin}/auth/oidc/mobile-callback//`],
      ['oidc', `${alphaTenant.origin}/auth/oidc/mobile-callback?next=evil`],
      ['github', 'buzzy://buzz/github-callback//'],
      ['github', 'buzzy://buzz/github-callback#evil'],
    ] as const) {
      const result = await app.inject({
        method: 'GET',
        url: `/auth/${providerName}/start?app_redirect=${encodeURIComponent(appRedirect)}&app_state=${appState}`,
        headers: { host: alphaTenant.host },
      });
      expect(result.statusCode).toBe(400);
      expect(result.json().error).toBe('invalid_request');
    }
  });

  it('allowlists every shipped native scheme and no caller-selected scheme', async () => {
    const appState = 's'.repeat(43);
    const pubkey = 'a'.repeat(64);
    for (const scheme of ['buzzy-dev', 'buzzy-preview', 'buzzy']) {
      const signInRedirect = `${scheme}://buzz/github-callback`;
      const signIn = await app.inject({
        method: 'GET',
        url: `/auth/github/start?app_redirect=${encodeURIComponent(signInRedirect)}&app_state=${appState}`,
        headers: { host: alphaTenant.host },
      });
      expect(signIn.statusCode, signInRedirect).toBe(302);

      const installationRedirect = `${scheme}://buzz/github-installation`;
      const installation = await app.inject({
        method: 'POST',
        url: '/auth/github/install/start',
        headers: { host: alphaTenant.host },
        payload: { pubkey, redirect_uri: installationRedirect },
      });
      expect(installation.statusCode, installationRedirect).toBe(401);
    }

    for (const path of ['github-callback', 'github-installation']) {
      const redirectUri = `buzzy-nightly://buzz/${path}`;
      const result =
        path === 'github-callback'
          ? await app.inject({
              method: 'GET',
              url: `/auth/github/start?app_redirect=${encodeURIComponent(redirectUri)}&app_state=${appState}`,
              headers: { host: alphaTenant.host },
            })
          : await app.inject({
              method: 'POST',
              url: '/auth/github/install/start',
              headers: { host: alphaTenant.host },
              payload: { pubkey, redirect_uri: redirectUri },
            });
      expect(result.statusCode, redirectUri).toBe(400);
    }
  });

  it('refuses arbitrary native completion redirects', async () => {
    const result = await app.inject({
      method: 'GET',
      url: `/auth/oidc/start?app_redirect=${encodeURIComponent('https://attacker.example/callback')}&app_state=${'s'.repeat(43)}`,
      headers: { host: alphaTenant.host },
    });
    expect(result.statusCode).toBe(400);
    expect(result.json().error).toBe('invalid_request');
  });

  it('cannot replay the OAuth proof to mint another bind ticket and exposes no bearer-token verify endpoint', async () => {
    const start = await app.inject({
      method: 'GET',
      url: '/auth/oidc/start',
      headers: { host: alphaTenant.host },
    });
    const cookie = startCookie(start.headers['set-cookie']);
    const authorization = await fetch(start.headers.location!, { redirect: 'manual' });
    const callback = new URL(authorization.headers.get('location')!);
    const callbackUrl = `${callback.pathname}${callback.search}`;
    const first = await app.inject({
      method: 'GET',
      url: callbackUrl,
      headers: { host: alphaTenant.host, cookie },
    });
    expect(first.statusCode).toBe(200);
    const replay = await app.inject({
      method: 'GET',
      url: callbackUrl,
      headers: { host: alphaTenant.host, cookie },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe('invalid_oidc_flow');
    expect(provider.tokenRequests).toBe(1);

    const bearerPocPath = await app.inject({
      method: 'POST',
      url: '/auth/oidc/verify',
      headers: { host: alphaTenant.host },
      payload: { id_token: first.json<BindChallenge>().ticket },
    });
    expect(bearerPocPath.statusCode).toBe(404);
  });

  it('binds the callback to the browser session that initiated the flow', async () => {
    const start = await app.inject({
      method: 'GET',
      url: '/auth/oidc/start',
      headers: { host: alphaTenant.host },
    });
    const cookie = startCookie(start.headers['set-cookie']);
    const authorization = await fetch(start.headers.location!, { redirect: 'manual' });
    const callback = new URL(authorization.headers.get('location')!);
    const callbackUrl = `${callback.pathname}${callback.search}`;
    const intercepted = await app.inject({
      method: 'GET',
      url: callbackUrl,
      headers: { host: alphaTenant.host },
    });
    expect(intercepted.statusCode).toBe(400);
    expect(intercepted.json().error).toBe('invalid_oidc_flow');
    expect(provider.tokenRequests).toBe(0);

    const owningBrowser = await app.inject({
      method: 'GET',
      url: callbackUrl,
      headers: { host: alphaTenant.host, cookie },
    });
    expect(owningBrowser.statusCode).toBe(200);
    expect(provider.tokenRequests).toBe(1);
  });

  it('does not expose OIDC authorization paths for relay, membership, roles, or merge', async () => {
    for (const url of ['/events', '/query', '/membership', '/roles', '/merge']) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { host: alphaTenant.host, authorization: 'Bearer reusable-id-token' },
        payload: {},
      });
      expect(response.statusCode, url).toBe(404);
    }
  });

  it('rejects a tampered bind signature without consuming the ticket', async () => {
    const challenge = await ceremony();
    const identity = generateKeypair();
    const event = bindEvent(challenge, identity);
    const tampered = { ...event, content: 'tampered after signing' };
    const rejected = await app.inject({
      method: 'POST',
      url: '/auth/oidc/bind',
      headers: { host: alphaTenant.host },
      payload: { ticket: challenge.ticket, event: tampered },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toBe('invalid_bind_event');
    expect((await bind(challenge, identity)).statusCode).toBe(201);
  });

  it('durably burns a ticket after five invalid signed-event attempts', async () => {
    const challenge = await ceremony();
    const identity = generateKeypair();
    const event = bindEvent(challenge, identity);
    const invalid = signEvent(
      {
        ...event,
        tags: event.tags.map((tag) =>
          tag[0] === 'challenge' ? ['challenge', 'wrong-challenge'] : tag,
        ),
      },
      identity.secretKey,
    );
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/oidc/bind',
        headers: { host: alphaTenant.host },
        payload: { ticket: challenge.ticket, event: invalid },
      });
      expect(response.statusCode).toBe(400);
    }
    const burned = await bind(challenge, identity);
    expect(burned.statusCode).toBe(409);
    expect(burned.json().error).toBe('ticket_used');
  });

  it.each([
    ['empty subject', { subject: '' }],
    ['wrong issuer', { issuer: 'http://wrong-issuer.invalid' }],
    ['wrong audience', { audience: 'another-client' }],
    ['multi-audience without azp', { audience: ['beeline-test-client', 'another-client'] }],
    [
      'multi-audience with wrong azp',
      { audience: ['beeline-test-client', 'another-client'], authorizedParty: 'another-client' },
    ],
  ])('rejects %s ID tokens', async (_name, claims) => {
    provider.claims = claims;
    const start = await app.inject({
      method: 'GET',
      url: '/auth/oidc/start',
      headers: { host: alphaTenant.host },
    });
    const cookie = startCookie(start.headers['set-cookie']);
    const authorization = await fetch(start.headers.location!, { redirect: 'manual' });
    const callback = new URL(authorization.headers.get('location')!);
    const result = await app.inject({
      method: 'GET',
      url: `${callback.pathname}${callback.search}`,
      headers: { host: alphaTenant.host, cookie },
    });
    expect(result.statusCode).toBe(401);
    expect(result.json().error).toBe('invalid_oidc_proof');
  });

  it('ignores a body-supplied community and uses the resolved Host tenant', async () => {
    const challenge = await ceremony(alphaTenant);
    const identity = generateKeypair();
    const result = await bind(challenge, identity, { community: betaTenant.community });
    expect(result.statusCode).toBe(201);

    const alphaLinks = await store.linksForPubkey(alphaTenant.community, identity.publicKey);
    const betaLinks = await store.linksForPubkey(betaTenant.community, identity.publicKey);
    expect(alphaLinks).toHaveLength(1);
    expect(betaLinks).toHaveLength(0);
  });

  it('atomically rejects a normal-login takeover while preserving the original public key', async () => {
    const original = generateKeypair();
    expect((await bind(await ceremony(), original)).statusCode).toBe(201);

    const attacker = generateKeypair();
    const conflict = await bind(await ceremony(), attacker);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: 'identity_conflict',
      message: 'identity is already bound to another public key',
    });
    expect(await store.linksForPubkey(alphaTenant.community, original.publicKey)).toHaveLength(1);
    expect(await store.linksForPubkey(alphaTenant.community, attacker.publicKey)).toHaveLength(0);
  });

  it('allows exactly one winner when different keys race first bind', async () => {
    const firstChallenge = await ceremony();
    const secondChallenge = await ceremony();
    const firstKey = generateKeypair();
    const secondKey = generateKeypair();
    const responses = await Promise.all([
      bind(firstChallenge, firstKey),
      bind(secondChallenge, secondKey),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const linkedPubkeys = (
      await Promise.all([
        store.linksForPubkey(alphaTenant.community, firstKey.publicKey),
        store.linksForPubkey(alphaTenant.community, secondKey.publicKey),
      ])
    )
      .flat()
      .map((link) => link.pubkey);
    expect(linkedPubkeys).toHaveLength(1);
  });

  it('rejects duplicate or mismatched signed identity tags', async () => {
    const challenge = await ceremony();
    const identity = generateKeypair();
    const valid = bindEvent(challenge, identity);
    const duplicate = signEvent(
      { ...valid, tags: [...valid.tags, ['community', challenge.community]] },
      identity.secretKey,
    );
    const duplicateResponse = await app.inject({
      method: 'POST',
      url: '/auth/oidc/bind',
      headers: { host: alphaTenant.host },
      payload: { ticket: challenge.ticket, event: duplicate },
    });
    expect(duplicateResponse.statusCode).toBe(400);

    const wrongProvider = signEvent(
      {
        ...valid,
        tags: valid.tags.map((tag) =>
          tag[0] === 'provider' ? ['provider', 'https://evil.invalid'] : tag,
        ),
      },
      identity.secretKey,
    );
    const mismatchResponse = await app.inject({
      method: 'POST',
      url: '/auth/oidc/bind',
      headers: { host: alphaTenant.host },
      payload: { ticket: challenge.ticket, event: wrongProvider },
    });
    expect(mismatchResponse.statusCode).toBe(400);
  });
});

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
    expect(first.json()).toEqual({
      claimed: true,
      idempotent: false,
      name: 'alice',
      pubkey: alice.publicKey,
    });

    const stolen = await claim('alice', bob);
    expect(stolen.statusCode).toBe(409);
    expect(stolen.json().error).toBe('name_taken');

    const reclaimedBySameOwner = await claim('alice', alice);
    expect(reclaimedBySameOwner.statusCode).toBe(200);
    expect(reclaimedBySameOwner.json()).toEqual({
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
      'has space',
      '-leading-dash',
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
