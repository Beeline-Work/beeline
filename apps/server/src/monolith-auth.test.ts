import { randomBytes, createHash, createHmac } from 'node:crypto';
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
import { GitHubOperations } from './github-operations.js';

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
  let githubOperations: GitHubOperations;
  let processWebhook: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.stubEnv('PHONE_GITHUB_EXCHANGE_ENDPOINT', '');
    database = new PgliteDatabase();
    await migrate(database);
    let mountedForVerification: MonolithAuthMount | undefined;
    const tokenAuth = new TokenAuth(
      database,
      verifierFromEnvironment(async (ticket) => {
        if (!mountedForVerification) throw new Error('monolith auth is not ready');
        return mountedForVerification.verifyGitHubTicket(ticket);
      }),
    );
    const githubOauth = {
      config: { clientId: 'github-client', clientSecret: 'github-secret' },
      authorizationUrl: ({ state, redirectUri }: { state: string; redirectUri: string }) =>
        `https://github.test/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      exchangeCode: async () => ({
        issuer: 'https://github.com' as const,
        audience: 'github-client',
        subject: '42',
        login: 'octocat',
        displayName: 'The Octocat',
        accessToken: 'github-user-token',
      }),
    } as unknown as GitHubOAuthClient;
    const githubApp = {
      installationAccount: async () => ({
        id: '42',
        login: 'owner',
        type: 'User' as const,
        repositorySelection: 'selected' as const,
      }),
      listRepositories: async () => [
        { id: 101, installationId: 77, fullName: 'owner/widgets', defaultBranch: 'trunk' },
      ],
    } as unknown as GitHubAppClient;
    mount = await createMonolithAuth(
      database,
      tenant.origin,
      {
        oauth: githubOauth,
        app: githubApp,
        webhookSecret: 'webhook-secret',
        onWebhook: async (event, payload) => processWebhook(event, payload),
      },
      {
        createDaemonExchange: (agentId, transaction) =>
          tokenAuth.createDaemonExchange(agentId, transaction),
        env: {
          NODE_ENV: 'test',
          BUZZY_AUTH_TENANTS_JSON: JSON.stringify([tenant]),
          BUZZY_AUTH_OIDC_ISSUER: 'https://accounts.example',
          BUZZY_AUTH_OIDC_AUTHORIZATION_ENDPOINT: 'https://accounts.example/authorize',
          BUZZY_AUTH_OIDC_TOKEN_ENDPOINT: 'https://accounts.example/token',
          BUZZY_AUTH_OIDC_JWKS_URI: 'https://accounts.example/jwks',
          BUZZY_AUTH_OIDC_CLIENT_ID: 'test-client',
        },
      },
    );
    mountedForVerification = mount;
    githubOperations = new GitHubOperations(
      database,
      githubOauth,
      githubApp,
      'github-secret',
      mount.sealedGitHubUserToken,
    );
    processWebhook = vi.fn(async (event: string, payload: unknown) =>
      githubOperations.processWebhook(event, payload),
    );
    store = new AuthStore(database as unknown as TransactionalDatabase);
    const live = new LiveHub();
    server = createBeelineServer({
      database,
      auth: tokenAuth,
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
    const audiences = await database.query<{ audience: string }>(
      `SELECT audience FROM identity_external_links WHERE provider='github' AND subject='42'`,
    );
    expect(audiences.rows).toEqual([{ audience: 'github' }]);
  });

  it('reconciles the monolith GitHub catalog from a signed mounted auth webhook', async () => {
    const owner = 'a'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')`, [
      owner,
    ]);
    await database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status) VALUES(77,$1,'42','owner','User','selected','active')`,
      [owner],
    );
    const payload = JSON.stringify({
      action: 'added',
      installation: { id: 77 },
      repositories_added: [
        {
          id: 101,
          name: 'widgets',
          full_name: 'owner/widgets',
          clone_url: 'https://github.com/owner/widgets.git',
          default_branch: 'trunk',
        },
      ],
      repositories_removed: [],
    });
    const response = await new Promise<{ status: number }>((resolve, reject) => {
      const outgoing = request(
        new URL('/auth/github/webhook', origin),
        {
          method: 'POST',
          headers: {
            host: tenant.host,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            'x-github-delivery': 'mounted-delivery-1',
            'x-github-event': 'installation_repositories',
            'x-hub-signature-256': `sha256=${createHmac('sha256', 'webhook-secret').update(payload).digest('hex')}`,
          },
        },
        (incoming) => {
          incoming.resume();
          incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0 }));
        },
      );
      outgoing.on('error', reject);
      outgoing.end(payload);
    });

    expect(response.status).toBe(202);
    expect(processWebhook).toHaveBeenCalledWith(
      'installation_repositories',
      expect.objectContaining({ installation: { id: 77 } }),
    );
    await expect(
      database.query<{ installation_id: number; status: string }>(
        `SELECT installation_id,status FROM github_installations WHERE installation_id=77`,
      ),
    ).resolves.toMatchObject({ rows: [{ installation_id: 77, status: 'active' }] });
    await expect(
      database.query<{ repository_id: number; full_name: string; active: boolean }>(
        `SELECT repository_id,full_name,active FROM github_repositories WHERE installation_id=77`,
      ),
    ).resolves.toMatchObject({
      rows: [{ repository_id: 101, full_name: 'owner/widgets', active: true }],
    });
  });
});
