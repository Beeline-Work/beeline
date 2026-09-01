import { randomBytes, createHash } from 'node:crypto';
import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthStore, type TransactionalDatabase } from '@beeline/auth/store';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { TokenAuth, verifierFromEnvironment } from './auth.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { createBeelineServer } from './server.js';
import { createMonolithAuth, type MonolithAuthMount } from './monolith-auth.js';

const tenant = {
  host: 'server.usebeeline.app',
  community: 'stable-identity-namespace',
  roomCommunityIds: ['relay-community-id'],
  origin: 'https://server.usebeeline.app',
};

describe('mounted monolith auth', () => {
  let database: PgliteDatabase;
  let store: AuthStore;
  let mount: MonolithAuthMount;
  let server: ReturnType<typeof createBeelineServer>;
  let origin: string;

  beforeEach(async () => {
    vi.stubEnv('PHONE_GITHUB_EXCHANGE_ENDPOINT', '');
    database = new PgliteDatabase();
    await migrate(database);
    mount = await createMonolithAuth(
      database,
      tenant.origin,
      {
        oauth: {
          config: { clientId: 'github-client', clientSecret: 'github-secret' },
          authorizationUrl: ({ state, redirectUri }) =>
            `https://github.test/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
          exchangeCode: async () => ({
            issuer: 'https://github.com' as const,
            audience: 'github-client',
            subject: '42',
            login: 'octocat',
            displayName: 'The Octocat',
            accessToken: 'github-user-token',
          }),
        } as unknown as GitHubOAuthClient,
        app: {} as GitHubAppClient,
      },
      {
        NODE_ENV: 'test',
        BUZZY_AUTH_TENANTS_JSON: JSON.stringify([tenant]),
        BUZZY_AUTH_OIDC_ISSUER: 'https://accounts.example',
        BUZZY_AUTH_OIDC_AUTHORIZATION_ENDPOINT: 'https://accounts.example/authorize',
        BUZZY_AUTH_OIDC_TOKEN_ENDPOINT: 'https://accounts.example/token',
        BUZZY_AUTH_OIDC_JWKS_URI: 'https://accounts.example/jwks',
        BUZZY_AUTH_OIDC_CLIENT_ID: 'test-client',
      },
    );
    store = new AuthStore(database as unknown as TransactionalDatabase);
    const auth = new TokenAuth(database, verifierFromEnvironment(mount.verifyGitHubTicket));
    const live = new LiveHub();
    server = createBeelineServer({
      database,
      auth,
      phone: new PhoneService(database, 'http://placeholder'),
      daemon: new DaemonService(database, live),
      live,
      mediaMaximumBytes: 1024,
      authHandler: mount.handle,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (mount) await mount.close();
    if (database) await database.close();
  });

  async function issueTicket(subject = '42', login = 'octocat'): Promise<string> {
    const ticket = randomBytes(32).toString('base64url');
    await store.createTicket(createHash('sha256').update(ticket).digest('hex'), {
      challenge: randomBytes(32).toString('base64url'),
      community: tenant.community,
      issuer: 'https://github.com',
      audience: 'github',
      subject,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 120_000),
      attemptCount: 0,
      consumedAt: null,
      boundPubkey: null,
      providerLogin: login,
      providerDisplayName: 'The Octocat',
    });
    return ticket;
  }

  async function authRequest(ticket: string): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const target = new URL('/auth/github/phone-exchange', origin);
      const payload = JSON.stringify({ ticket });
      const outgoing = request(
        target,
        {
          method: 'POST',
          headers: {
            host: tenant.host,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          incoming.on('end', () =>
            resolve({
              status: incoming.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
            }),
          );
        },
      );
      outgoing.on('error', reject);
      outgoing.end(payload);
    });
  }

  async function mountedRequest(
    path: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const outgoing = request(
        new URL(path, origin),
        { headers: { host: tenant.host, ...headers } },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          incoming.on('end', () =>
            resolve({
              status: incoming.statusCode ?? 0,
              headers: incoming.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      outgoing.on('error', reject);
      outgoing.end();
    });
  }

  it('serves the auth verifier route and rejects malformed tickets', async () => {
    const bad = await authRequest('bad');
    expect(bad.status).toBe(400);

    const ticket = await issueTicket();
    const verified = await authRequest(ticket);
    expect(verified.status).toBe(200);
    expect(verified.body).toEqual({
      subject: '42',
      login: 'octocat',
      name: 'The Octocat',
    });
  });

  it('turns an in-process GitHub ticket into a phone session with subject and login', async () => {
    const response = await fetch(`${origin}/v1/auth/github/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oidcToken: await issueTicket() }),
    });
    expect(response.status).toBe(200);
    const session = (await response.json()) as { accessToken: string; identityId: string };
    expect(session.accessToken).toMatch(/^bat_/);
    const identity = await database.query<{ github_subject: string; handle: string; name: string }>(
      `SELECT github_subject, handle, name FROM identities WHERE id = $1`,
      [session.identityId],
    );
    expect(identity.rows[0]).toEqual({
      github_subject: '42',
      handle: 'octocat',
      name: 'The Octocat',
    });
  });

  it('returns GitHub OAuth straight to the app and exchanges its ticket for a session', async () => {
    const appState = 's'.repeat(43);
    const start = await mountedRequest(
      `/auth/github/start?app_redirect=${encodeURIComponent('beeline://buzz/github-callback')}&app_state=${appState}`,
    );
    expect(start.status).toBe(302);
    const authorization = new URL(String(start.headers.location));
    expect(authorization.origin).toBe('https://github.test');
    expect(authorization.searchParams.get('redirect_uri')).toBe(
      `${tenant.origin}/auth/github/callback`,
    );

    const callback = await mountedRequest(
      `/auth/github/callback?code=github-code&state=${authorization.searchParams.get('state')}`,
      { cookie: String(start.headers['set-cookie']).split(';', 1)[0]! },
    );
    expect(callback.status, callback.body).toBe(302);
    const completion = new URL(String(callback.headers.location));
    expect(`${completion.protocol}//${completion.host}${completion.pathname}`).toBe(
      'beeline://buzz/github-callback',
    );
    expect(completion.searchParams.get('state')).toBe(appState);

    const exchange = await fetch(`${origin}/v1/auth/github/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oidcToken: completion.searchParams.get('ticket') }),
    });
    expect(exchange.status).toBe(200);
    await expect(exchange.json()).resolves.toMatchObject({
      accessToken: expect.stringMatching(/^bat_/),
      identityId: expect.any(String),
    });
  });
});
