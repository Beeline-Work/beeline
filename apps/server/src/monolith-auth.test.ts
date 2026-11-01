import { randomBytes, createHash, createHmac } from 'node:crypto';
import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthStore, type TransactionalDatabase } from '@beeline/auth/store';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { migrate } from './database.js';
import { compactSigninAttempts, recordSigninAttempt } from './signin-attempts.js';
import * as sentry from './sentry.js';
import { PgliteDatabase, migratedDatabase } from './test-support.js';
import { TokenAuth, verifierFromEnvironment } from './auth.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { createBeelineServer } from './server.js';
import { createMonolithAuth, type MonolithAuthMount } from './monolith-auth.js';
import { postRepositoryOnboarding } from './repository-onboarding.js';
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
  let installationAccess: boolean;
  let availableInstallations: number[];
  let githubSubject: string;
  let installationLogin: string;
  let repositorySelection: 'selected' | 'all';
  let processWebhook: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.stubEnv('PHONE_GITHUB_EXCHANGE_ENDPOINT', '');
    database = await migratedDatabase();
    await new AuthStore(database as unknown as TransactionalDatabase).migrate();
    let mountedForVerification: MonolithAuthMount | undefined;
    const tokenAuth = new TokenAuth(
      database,
      verifierFromEnvironment(async (ticket) => {
        if (!mountedForVerification) throw new Error('monolith auth is not ready');
        return mountedForVerification.verifyGitHubTicket(ticket);
      }),
      () => new Date(),
      async (ticket) => {
        if (!mountedForVerification) throw new Error('monolith auth is not ready');
        return mountedForVerification.verifyGoogleTicket(ticket);
      },
    );
    githubSubject = '42';
    installationLogin = 'owner';
    const githubOauth = {
      config: { clientId: 'github-client', clientSecret: 'github-secret' },
      authorizationUrl: ({ state, redirectUri }: { state: string; redirectUri: string }) =>
        `https://github.test/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      exchangeCode: async () => ({
        issuer: 'https://github.com' as const,
        audience: 'github-client',
        subject: githubSubject,
        login: 'octocat',
        displayName: 'The Octocat',
        accessToken: 'github-user-token',
        refreshToken: 'github-refresh-token',
        tokenExpiresIn: 28800,
      }),
    } as unknown as GitHubOAuthClient;
    installationAccess = true;
    availableInstallations = [77];
    repositorySelection = 'selected';
    const githubApp = {
      installationUrl: (state: string) => `https://github.test/install?state=${state}`,
      userCanAccessInstallation: async () => installationAccess,
      listUserInstallationIds: async () => availableInstallations,
      installationAccount: async () => ({
        id: '42',
        login: installationLogin,
        type: 'User' as const,
        repositorySelection,
      }),
      installationToken: async () => ({ token: 'room-token', expiresAt: Date.now() + 3_600_000 }),
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
      },
      {
        completeRepositoryInstallation: (state, installationId, code, callbackUri) => githubOperations.completeInstallation(state, installationId, code, callbackUri),
        createDaemonExchange: (agentId, transaction) =>
          tokenAuth.createDaemonExchange(agentId, transaction),
        env: {
          NODE_ENV: 'test',
          BEELINE_AUTH_TENANTS_JSON: JSON.stringify([tenant]),
          BEELINE_AUTH_OIDC_ISSUER: 'https://accounts.example',
          BEELINE_AUTH_OIDC_AUTHORIZATION_ENDPOINT: 'https://accounts.example/authorize',
          BEELINE_AUTH_OIDC_TOKEN_ENDPOINT: 'https://accounts.example/token',
          BEELINE_AUTH_OIDC_JWKS_URI: 'https://accounts.example/jwks',
          BEELINE_AUTH_OIDC_CLIENT_ID: 'test-client',
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
      webAppOrigins: ['https://web.usebeeline.app'],
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

  const funnelContext = (provider: 'google' | 'github') => ({
    event: 'provider_tapped', installId: '00000000-0000-4000-8000-000000000001',
    attemptId: '00000000-0000-4000-8000-000000000002', provider,
    platform: 'android', version: '0.2.22', environment: 'production',
    timestamp: new Date().toISOString(),
  });
  const stages = async () => (await database.query(
    'SELECT stage,error_code FROM signin_attempt_events ORDER BY occurred_at,stage',
  )).rows;

  it.each(['google', 'github'] as const)('logs %s start, provider denial and app cancellation without secrets', async provider => {
    const path = provider === 'google' ? 'oidc' : 'github';
    const recoveryToken = 'r'.repeat(43);
    const query = new URLSearchParams({
      funnel: JSON.stringify(funnelContext(provider)), app_state: 's'.repeat(43),
      app_redirect: `beeline://beeline/${provider}-callback`,
      app_recovery_challenge: createHash('sha256').update(recoveryToken).digest('hex'),
    });
    const start = await mountedRequest(`/auth/${path}/start?${query}`);
    expect(start.status).toBe(302);
    const state = new URL(String(start.headers.location)).searchParams.get('state');
    const callback = await mountedRequest(`/auth/${path}/callback?state=${state}&error=access_denied&error_description=private-email@example.com`,
      { cookie: String(start.headers['set-cookie']).split(';', 1)[0]! });
    expect(callback.status).toBe(302);
    expect(await stages()).toEqual([
      { stage: 'started', error_code: null }, { stage: 'provider_returned', error_code: 'access_denied' },
    ]);
    await mountedJsonRequest(`/auth/${path}/completion/cancel`, { recoveryToken });
    expect((await stages()).at(-1)).toMatchObject({ stage: 'cancelled' });
    const rows = (await database.query('SELECT * FROM signin_attempt_events')).rows;
    expect(rows.every(row => row.install_id === funnelContext(provider).installId)).toBe(true);
    expect(rows.every(row => row.funnel_attempt_id === funnelContext(provider).attemptId)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('private-email');
    expect(JSON.stringify(rows)).not.toContain(recoveryToken);
    await compactSigninAttempts(database);
    expect((await stages()).at(-1)).toMatchObject({ stage: 'cancelled' });
  });

  it.each(['denied', 'exchanged'])('R-GITHUB-INSTALL-HANDOFF: retains one attempt when installation is %s', async outcome => {
    availableInstallations = [];
    const context = funnelContext('github');
    const query = new URLSearchParams({ onboarding: '1', funnel: JSON.stringify(context),
      app_state: 's'.repeat(43), app_redirect: 'beeline://beeline/github-callback' });
    const start = await mountedRequest(`/auth/github/start?${query}`);
    const state = new URL(String(start.headers.location)).searchParams.get('state');
    const handoff = await mountedRequest(`/auth/github/callback?state=${state}&code=initial-code`,
      { cookie: String(start.headers['set-cookie']).split(';', 1)[0]! });
    expect(handoff.status).toBe(200);
    const nextState = handoff.body.match(/state=(onboarding_[^"&]+)/)?.[1];
    expect(nextState).toBeTruthy();
    const cookie = handoff.headers['set-cookie']!.filter(c => !c.includes('Max-Age=0')).map(c => c.split(';')[0]).join('; ');
    availableInstallations = [77];
    installationLogin = 'octocat';
    repositorySelection = 'all';
    const callback = await mountedRequest(`/auth/github/callback?state=${nextState}&${outcome === 'denied' ? 'error=access_denied' : 'code=install-code'}`, { cookie });
    expect(callback.status).toBe(302);
    if (outcome === 'exchanged') {
      const ticket = new URL(String(callback.headers.location)).searchParams.get('ticket');
      const response = await fetch(`${origin}/v1/auth/github/exchange`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oidcToken: ticket }),
      });
      expect(response.status).toBe(200);
      expect((await response.json() as { accessToken: string }).accessToken).toBeTruthy();
    } else expect(callback.headers.location).toContain('error=github_denied');
    const rows = (await database.query('SELECT * FROM signin_attempt_events')).rows;
    expect(new Set(rows.map(row => row.attempt_id)).size).toBe(1);
    expect(rows.filter(row => row.stage === 'provider_returned')).toHaveLength(2);
    expect(rows.every(row => row.install_id === context.installId && row.funnel_attempt_id === context.attemptId)).toBe(true);
    const readme = await readFile(new URL('../../auth/README.md', import.meta.url), 'utf8');
    const sql = readme.match(/```sql\n(WITH history AS[\s\S]*?)```/)![1]!;
    const result = (await database.query(sql)).rows;
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ last_stage: outcome === 'denied' ? 'provider_returned' : 'ticket_exchanged',
      error_code: outcome === 'denied' ? 'access_denied' : null });
    await database.query("UPDATE signin_attempt_correlations SET expires_at=now()-interval '1 second'");
    await compactSigninAttempts(database);
    expect((await database.query(sql)).rows).toEqual(result);
  });

  it('logs the full GitHub HTTP session path and survives a log failure', async () => {
    const capture = vi.spyOn(sentry, 'captureServerError').mockImplementation(() => {});
    try {
      for (const breakLog of [false, true]) {
        if (breakLog) await database.query('DROP TABLE signin_attempt_events');
        const query = new URLSearchParams({ funnel: JSON.stringify(funnelContext('github')) });
        const start = await mountedRequest(`/auth/github/start?${query}`);
        expect(start.status).toBe(302);
        const state = new URL(String(start.headers.location)).searchParams.get('state');
        const callback = await mountedRequest(`/auth/github/callback?state=${state}&code=private-code`,
          { cookie: String(start.headers['set-cookie']).split(';', 1)[0]! });
        expect(callback.status).toBe(200);
        const ticket = JSON.parse(callback.body).ticket;
        const response = await fetch(`${origin}/v1/auth/github/exchange`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ oidcToken: ticket }),
        });
        expect(response.status).toBe(200);
        expect((await response.json() as { accessToken: string }).accessToken).toBeTruthy();
        if (!breakLog) {
          expect((await stages()).map(row => row.stage)).toEqual(['started', 'provider_returned', 'ticket_issued', 'ticket_exchanged']);
          await mountedJsonRequest('/auth/github/completion/cancel', { recoveryToken: ticket });
          expect((await stages()).map(row => row.stage)).not.toContain('cancelled');
          const rows = JSON.stringify((await database.query('SELECT * FROM signin_attempt_events')).rows);
          for (const secret of [ticket, 'private-code', 'github-user-token', 'octocat']) expect(rows).not.toContain(secret);
        }
      }
      expect(capture).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ operation: 'signin_attempt_log' }));
    } finally { capture.mockRestore(); }
  });

  it.each([false, true])('records expiry when a GitHub attempt never exchanges (provider returned: %s)', async returned => {
    const start = await mountedRequest('/auth/github/start');
    expect(start.status).toBe(302);
    if (returned) {
      const state = new URL(String(start.headers.location)).searchParams.get('state');
      expect((await mountedRequest(`/auth/github/callback?state=${state}&code=code`,
        { cookie: String(start.headers['set-cookie']).split(';', 1)[0]! })).status).toBe(200);
    }
    await database.query("UPDATE signin_attempt_correlations SET expires_at=now()-interval '1 second'");
    await compactSigninAttempts(database);
    expect((await stages()).map(row => row.stage)).toContain('expired');
    expect((await database.query('SELECT * FROM signin_attempt_correlations')).rows).toEqual([]);
    await compactSigninAttempts(database);
    expect((await stages()).filter(row => row.stage === 'expired')).toHaveLength(1);
    await database.query("UPDATE signin_attempt_events SET occurred_at=now()-interval '91 days'");
    await compactSigninAttempts(database);
    expect(await stages()).toEqual([]);
  });

  it('logs Google session exchange, preserves internal attribution and sanitizes unrecognized errors', async () => {
    const context = funnelContext('google');
    await database.query('INSERT INTO signin_funnel_installs(install_id,internal) VALUES($1,true)', [context.installId]);
    const ticket = randomBytes(32).toString('base64url');
    const ticketHash = createHash('sha256').update(ticket).digest('hex');
    const at = new Date();
    await recordSigninAttempt(database, { stage: 'started', flowHash: 'flow', provider: 'google', context,
      at, expiresAt: new Date(Date.now()+120000) });
    await recordSigninAttempt(database, { stage: 'provider_returned', flowHash: 'flow', at });
    await store.createTicket(ticketHash, {
      challenge: 'challenge', community: tenant.community, issuer: 'https://accounts.google.com',
      audience: 'test-client', subject: 'google-owner', createdAt: at,
      expiresAt: new Date(Date.now()+120000), attemptCount: 0, consumedAt: null, boundPubkey: null,
    });
    await recordSigninAttempt(database, { stage: 'ticket_issued', flowHash: 'flow', ticketHash,
      at, expiresAt: new Date(Date.now()+120000) });
    const response = await fetch(`${origin}/v1/auth/google/exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oidcToken: ticket }),
    });
    expect(response.status).toBe(200);
    expect((await stages()).map(row => row.stage)).toContain('ticket_exchanged');
    expect((await database.query('SELECT internal FROM signin_attempt_events')).rows.every(row => row.internal)).toBe(true);
    await recordSigninAttempt(database, { stage: 'started', flowHash: 'bad', provider: 'google',
      at, expiresAt: new Date(Date.now()+120000) });
    await recordSigninAttempt(database, { stage: 'provider_returned', flowHash: 'bad', at, errorCode: 'private-token@example.com' });
    expect(JSON.stringify(await stages())).not.toContain('private-token');
    expect((await stages()).some(row => row.error_code === 'provider_error')).toBe(true);
  });

  it('R-GOOGLE-WEB-CORS: exposes Google capabilities only to configured browser origins', async () => {
    const allowed = await mountedRequest('/auth/capabilities', {
      origin: 'https://web.usebeeline.app',
    });
    expect(allowed.status).toBe(200);
    expect(JSON.parse(allowed.body)).toMatchObject({ google: true });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://web.usebeeline.app');
    expect(allowed.headers.vary).toContain('Origin');

    const untrusted = await mountedRequest('/auth/capabilities', {
      origin: 'https://attacker.example',
    });
    expect(untrusted.status).toBe(200);
    expect(JSON.parse(untrusted.body)).toMatchObject({ google: true });
    expect(untrusted.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('E1/E3/E14/E16/E23: the Google HTTP exchange creates a session and preserves the returning profile', async () => {
    const exchange = async (subject = 'google-owner') => {
      const ticket = randomBytes(32).toString('base64url');
      await store.createTicket(createHash('sha256').update(ticket).digest('hex'), {
        challenge: 'challenge',
        community: tenant.community,
        issuer: 'https://accounts.google.com',
        audience: 'test-client',
        subject,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 120_000),
        attemptCount: 0,
        consumedAt: null,
        boundPubkey: null,
        providerLogin: 'alex.chen@gmail.com',
        providerDisplayName: 'Alex Chen',
        providerAvatar: 'https://example.com/alex',
      });
      const response = await fetch(`${origin}/v1/auth/google/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oidcToken: ticket }),
      });
      return { response, ticket };
    };
    const { response, ticket } = await exchange();
    expect(response.status).toBe(200);
    const session = (await response.json()) as { identityId: string; accessToken: string };
    expect(session.accessToken).toBeTruthy();
    expect(
      (
        await database.query(
          'SELECT name,handle,avatar,github_subject FROM identities WHERE id=$1',
          [session.identityId],
        )
      ).rows[0],
    ).toEqual({
      name: 'Alex Chen',
      handle: 'alex.chen',
      avatar: 'https://example.com/alex',
      github_subject: null,
    });
    await database.query('UPDATE identities SET name=$2 WHERE id=$1', [
      session.identityId,
      'Edited',
    ]);
    const returning = await exchange();
    expect(returning.response.status).toBe(200);
    expect(((await returning.response.json()) as { identityId: string }).identityId).toBe(
      session.identityId,
    );
    expect(
      (await database.query('SELECT name FROM identities WHERE id=$1', [session.identityId]))
        .rows[0]!.name,
    ).toBe('Edited');
    const replay = await fetch(`${origin}/v1/auth/google/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oidcToken: ticket }),
    });
    expect(replay.status).toBe(401);
    const newcomer = (await exchange('any-google-account')).response;
    expect(newcomer.status).toBe(200);
    expect((await database.query("SELECT 1 FROM identity_external_links WHERE provider='google' AND subject='any-google-account'")).rows).toHaveLength(1);
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

  async function mountedJsonRequest(
    path: string,
    payload: unknown,
  ): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const serialized = JSON.stringify(payload);
      const outgoing = request(
        new URL(path, origin),
        {
          method: 'POST',
          headers: {
            host: tenant.host,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(serialized),
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          incoming.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({
              status: incoming.statusCode ?? 0,
              body: text ? (JSON.parse(text) as unknown) : null,
            });
          });
        },
      );
      outgoing.on('error', reject);
      outgoing.end(serialized);
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

    const retiredLookup = await mountedRequest('/.well-known/nostr.json?name=octocat');
    expect(retiredLookup.status).toBe(404);
  });

  it('E22: web can poll a completed Google ticket when the redirect was lost', async () => {
    const ticket = randomBytes(32).toString('base64url');
    await store.createTicket(createHash('sha256').update(ticket).digest('hex'), {
      challenge:'challenge',community:tenant.community,issuer:'https://accounts.google.com',audience:'test-client',
      subject:'google-owner',createdAt:new Date(),expiresAt:new Date(Date.now()+120000),attemptCount:0,consumedAt:null,boundPubkey:null,
      providerLogin:'alex@gmail.com',providerDisplayName:'Alex',
    });
    const preflight = await fetch(`${origin}/auth/oidc/completion`, {method:'OPTIONS', headers:{origin:'https://web.usebeeline.app','access-control-request-method':'POST'}});
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://web.usebeeline.app');
    const completed = await mountedJsonRequest('/auth/oidc/completion', {recoveryToken:ticket});
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ticket,subject:'google-owner',provider:'https://accounts.google.com'});
    const exchanged = await fetch(`${origin}/v1/auth/google/exchange`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({oidcToken:ticket})});
    expect(exchanged.status).toBe(200);
    expect((await mountedJsonRequest('/auth/oidc/completion', {recoveryToken:ticket})).status).toBe(410);
  });

  it('E13: a signed-in GitHub user links Google without changing identity or profile', async () => {
    const id = 'f'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Chosen Name','chosen')`, [id]);
    await database.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience) VALUES('github','42',$1,'https://github.com','github-client')`, [id]);
    const ticket = randomBytes(32).toString('base64url');
    await store.createTicket(createHash('sha256').update(ticket).digest('hex'), {
      challenge:'challenge', community:tenant.community, issuer:'https://accounts.google.com', audience:'test-client',
      subject:'google-owner', createdAt:new Date(), expiresAt:new Date(Date.now()+120000), attemptCount:0,
      consumedAt:null, boundPubkey:null, providerLogin:'alex@gmail.com', providerDisplayName:'Alex',
    });
    const auth = new TokenAuth(database, verifierFromEnvironment(async () => { throw new Error('unused'); }),
      () => new Date(), token => mount.verifyGoogleTicket(token));
    await auth.linkGoogleOidc(id, ticket);
    expect((await database.query(`SELECT identity_id FROM identity_external_links WHERE provider='google' AND subject='google-owner'`)).rows[0]?.identity_id).toBe(id);
    expect((await database.query(`SELECT name,handle FROM identities WHERE id=$1`, [id])).rows[0]).toEqual({name:'Chosen Name',handle:'chosen'});
  });

  it('E4/E5/E6/E7/E8/E15: binds and installs for a Google identity without changing its profile', async () => {
    const id = 'd'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name,handle,avatar) VALUES($1,'human','Alex Chen','alex.chen','google-photo')`, [id]);
    await database.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience) VALUES('google','google-owner',$1,'https://accounts.google.com','test-client')`, [id]);
    repositorySelection = 'all';
    const phone = new PhoneService(database, tenant.origin, githubOperations);
    const workspace = await phone.execute('createWorkspace', { name:'Google owner' }, id);
    const roomId = workspace.roomId!;
    const agent = 'b'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Beebee','beebee')`, [agent]);
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent,id]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`, [workspace.id,agent,roomId]);
    const before = await postRepositoryOnboarding(database, githubOperations, {roomId,agentId:agent,requesterId:id,kind:'repository'});
    expect(before.state).toBe('install_missing');
    const begin = async () => {
      const started = await githubOperations.beginInstallation(id, { redirectUri: 'beeline://beeline/github-installation', reconnect: true });
      return new URL(started.url).searchParams.get('state')!;
    };
    const canceled = await mountedRequest(`/auth/github/callback?error=access_denied&state=${await begin()}`);
    expect(canceled.headers.location).toContain('error=github_connection_canceled');
    expect((await database.query(`SELECT 1 FROM identity_external_links WHERE provider='github' AND identity_id=$1`, [id])).rows).toHaveLength(0);
    const state = await begin();
    expect(state).toMatch(/^github_bind_/);
    installationAccess = false;
    const callback = (value: string) => `/auth/github/callback?code=bind-code&state=${value}&installation_id=77`;
    expect((await mountedRequest(callback(state))).headers.location).toContain('error=github_connection_failed');
    expect((await database.query(`SELECT 1 FROM identity_external_links WHERE provider='github' AND identity_id=$1`, [id])).rows).toHaveLength(0);
    expect((await database.query(`SELECT 1 FROM github_user_tokens WHERE subject='42'`)).rows).toHaveLength(0);
    installationAccess = true;
    const completed = await mountedRequest(callback(await begin()));
    expect(completed.status, completed.body).toBe(302);
    expect(completed.headers.location).toBe('beeline://beeline/github-installation?installed=1');
    expect((await database.query(`SELECT name,handle,avatar FROM identities WHERE id=$1`, [id])).rows[0]).toEqual({name:'Alex Chen',handle:'alex.chen',avatar:'google-photo'});
    expect((await database.query(`SELECT identity_id FROM identity_external_links WHERE provider='github' AND subject='42'`)).rows[0]?.identity_id).toBe(id);
    const refreshed = await postRepositoryOnboarding(database, githubOperations, {roomId,agentId:agent,requesterId:id,kind:'repository'});
    expect(refreshed.state).toBe('no_repo_linked');
    expect(refreshed.repositories.map(repo => repo.fullName)).toEqual(['owner/widgets']);
    vi.spyOn(githubOperations, 'onboardingSignals').mockResolvedValue({commits:[],failingChecks:[],issues:[],branches:[],files:[]});
    await phone.execute('actOnRepositoryCard', {roomId,cardId:refreshed.id,action:'link',repositoryId:101}, id);
    expect((await phone.readRoom(roomId,id))?.repository?.name).toBe('owner/widgets');
    const corner = await phone.execute('createHumanCorner', {roomId,title:'first-google-owner-work'}, id);
    expect(await phone.readRoom(corner.id,id)).toBeTruthy();
    expect(await githubOperations.roomToken(roomId)).toMatchObject({token:'room-token'});
    const reconnectSameIdentity = await mountedRequest(callback(await begin()));
    expect(reconnectSameIdentity.headers.location).toBe('beeline://beeline/github-installation?installed=1');
    githubSubject = '43';
    const mismatch = await mountedRequest(callback(await begin()));
    expect(mismatch.headers.location).toContain('error=github_account_mismatch');
    expect((await database.query(`SELECT github_subject FROM identities WHERE id=$1`, [id])).rows[0]?.github_subject).toBe('42');
    expect((await database.query(`SELECT 1 FROM github_user_tokens WHERE subject='43'`)).rows).toHaveLength(0);
    githubSubject = '42';
    installationLogin = 'owner';
    const other = 'e'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Other')`, [other]);
    const conflict = await githubOperations.beginInstallation(other, { redirectUri:'beeline://beeline/github-installation' });
    const rejected = await mountedRequest(callback(new URL(conflict.url).searchParams.get('state')!));
    expect(rejected.headers.location).toContain('error=github_account_already_linked');
    expect((await database.query(`SELECT identity_id FROM identity_external_links WHERE provider='github' AND subject='42'`)).rows[0]?.identity_id).toBe(id);
  });

  it('GH-EXIST-1: repo-card OAuth binds an existing installation and returns its repositories', async () => {
    const id = 'd'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Google owner')`, [id]);
    const phone = new PhoneService(database, tenant.origin, githubOperations);
    const workspace = await phone.execute('createWorkspace', { name:'Existing installation' }, id);
    const agent = 'b'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Beebee')`, [agent]);
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent,id]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`, [workspace.id,agent,workspace.roomId]);
    const card = await postRepositoryOnboarding(database, githubOperations, {roomId:workspace.roomId!,agentId:agent,requesterId:id,kind:'repository'});
    expect(card.state).toBe('install_missing');
    const started = await githubOperations.beginInstallation(id, {redirectUri:'https://web.usebeeline.app/beeline/github-installation'});
    const url = new URL(started.url!);
    expect(url.pathname).toBe('/authorize');
    const state = url.searchParams.get('state')!;
    const completed = await mountedRequest(`/auth/github/callback?code=bind-code&state=${state}`);
    expect(completed.headers.location).toBe('https://web.usebeeline.app/beeline/github-installation?installed=1');
    expect((await database.query(`SELECT owner_id FROM github_installations WHERE installation_id=77`)).rows[0]?.owner_id).toBe(id);
    const refreshed = await postRepositoryOnboarding(database, githubOperations, {roomId:workspace.roomId!,agentId:agent,requesterId:id,kind:'repository'});
    expect(refreshed.repositories.map(repo => repo.fullName)).toEqual(['owner/widgets']);
    expect((await mountedRequest(`/auth/github/callback?code=bind-code&state=${state}`)).status).not.toBe(302);
  });

  it('GH-EXIST-1: no installation continues to install with fresh single-use state', async () => {
    const id = 'd'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Google owner')`, [id]);
    availableInstallations = [];
    const started = await githubOperations.beginInstallation(id, {redirectUri:'https://web.usebeeline.app/beeline/github-installation'});
    const state = new URL(started.url).searchParams.get('state')!;
    const first = await mountedRequest(`/auth/github/callback?code=bind-code&state=${state}`);
    const install = new URL(String(first.headers.location));
    expect(install.pathname).toBe('/install');
    const next = install.searchParams.get('state')!;
    expect(next).not.toBe(state);
    expect((await database.query(`SELECT consumed_at FROM github_auth_flows WHERE state_hash=$1`, [createHash('sha256').update(state).digest('hex')])).rows[0]?.consumed_at).toBeTruthy();
    availableInstallations = [77];
    const completed = await mountedRequest(`/auth/github/callback?code=install-code&state=${next}&installation_id=77`);
    expect(completed.headers.location).toBe('https://web.usebeeline.app/beeline/github-installation?installed=1');
  });

  it('completes repo-card installation through the OAuth callback and rejects replay or forged state', async () => {
    const start = await mountedRequest(
      `/auth/github/start?app_redirect=${encodeURIComponent('beeline://beeline/github-callback')}&app_state=${'r'.repeat(43)}`,
    );
    const authState = new URL(String(start.headers.location)).searchParams.get('state');
    const authorized = await mountedRequest(`/auth/github/callback?code=github-code&state=${authState}`, {
      cookie: String(start.headers['set-cookie']).split(';', 1)[0]!,
    });
    const ticket = new URL(String(authorized.headers.location)).searchParams.get('ticket');
    const sessionResponse = await fetch(`${origin}/v1/auth/github/exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oidcToken: ticket }),
    });
    const session = await sessionResponse.json() as { identityId: string };
    const installation = await githubOperations.beginInstallation(session.identityId, {
      redirectUri: 'beeline://beeline/github-installation',
    });
    const state = new URL(installation.url).searchParams.get('state');
    expect(state).toMatch(/^repository_install_/);
    const path = `/auth/github/callback?code=install-code&state=${state}&installation_id=77&setup_action=install`;
    const completion = await mountedRequest(path);
    expect(completion.status, completion.body).toBe(302);
    expect(completion.headers.location).toBe('beeline://beeline/github-installation?installed=1');
    expect((await database.query(`SELECT 1 FROM github_repositories WHERE installation_id=77 AND active`)).rows).toHaveLength(1);
    expect((await mountedRequest(path)).status).toBeGreaterThanOrEqual(400);
    const deniedStart = await githubOperations.beginInstallation(session.identityId, {
      redirectUri: 'beeline://beeline/github-installation',
    });
    const deniedState = new URL(deniedStart.url).searchParams.get('state');
    const discovered = await mountedRequest(`/auth/github/callback?code=install-code&state=${deniedState}`);
    expect(discovered.status, discovered.body).toBe(302);
    const anotherStart = await githubOperations.beginInstallation(session.identityId, {
      redirectUri: 'beeline://beeline/github-installation',
    });
    const anotherState = new URL(anotherStart.url).searchParams.get('state');
    installationAccess = false;
    const denied = await mountedRequest(`/auth/github/callback?state=${anotherState}&installation_id=77`);
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(denied.headers.location).toBeUndefined();
    expect((await mountedRequest('/auth/github/callback?state=repository_install_forged&installation_id=77')).status).toBeGreaterThanOrEqual(400);
    expect((await mountedRequest(`/auth/github/callback?state=${state}&error=access_denied&installation_id=77`)).status).toBe(400);
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

  it('recovers one session when browser authorization completes without a delivered deep link', async () => {
    const appState = 's'.repeat(43);
    const recoveryToken = 'r'.repeat(43);
    const recoveryChallenge = createHash('sha256').update(recoveryToken).digest('hex');
    const start = await mountedRequest(
      `/auth/github/start?app_redirect=${encodeURIComponent('beeline://beeline/github-callback')}&app_state=${appState}&app_recovery_challenge=${recoveryChallenge}`,
    );
    const authorization = new URL(String(start.headers.location));
    const callback = await mountedRequest(
      `/auth/github/callback?code=github-code&state=${authorization.searchParams.get('state')}`,
      { cookie: String(start.headers['set-cookie']).split(';', 1)[0]! },
    );

    expect(callback.status).toBe(302);
    const droppedCompletion = new URL(String(callback.headers.location));
    expect(droppedCompletion.searchParams.get('state')).toBe(appState);
    expect(droppedCompletion.searchParams.get('completed')).toBe('1');
    expect(droppedCompletion.searchParams.has('ticket')).toBe(false);

    expect(
      await mountedJsonRequest('/auth/github/completion', { recoveryToken: 'w'.repeat(43) }),
    ).toEqual({ status: 202, body: { status: 'pending' } });
    const recovered = await mountedJsonRequest('/auth/github/completion', { recoveryToken });
    expect(recovered).toMatchObject({
      status: 200,
      body: {
        ticket: recoveryToken,
        challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        provider: 'https://github.com',
        subject: '42',
      },
    });

    const exchange = await fetch(`${origin}/v1/auth/github/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oidcToken: recoveryToken }),
    });
    expect(exchange.status).toBe(200);
    expect(
      (
        await fetch(`${origin}/v1/auth/github/exchange`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ oidcToken: recoveryToken }),
        })
      ).status,
    ).not.toBe(200);
    expect(await mountedJsonRequest('/auth/github/completion', { recoveryToken })).toMatchObject({
      status: 410,
    });
  });

  it('burns a completed recovery credential on cancel so retry cannot reuse it', async () => {
    const appState = 'c'.repeat(43);
    const recoveryToken = 'z'.repeat(43);
    const recoveryChallenge = createHash('sha256').update(recoveryToken).digest('hex');
    const start = await mountedRequest(
      `/auth/github/start?app_redirect=${encodeURIComponent('beeline://beeline/github-callback')}&app_state=${appState}&app_recovery_challenge=${recoveryChallenge}`,
    );
    const authorization = new URL(String(start.headers.location));

    const callback = await mountedRequest(
      `/auth/github/callback?code=github-code&state=${authorization.searchParams.get('state')}`,
      { cookie: String(start.headers['set-cookie']).split(';', 1)[0]! },
    );
    expect(callback.status).toBe(302);
    expect(await mountedJsonRequest('/auth/github/completion/cancel', { recoveryToken })).toEqual({
      status: 204,
      body: null,
    });
    expect(await mountedJsonRequest('/auth/github/completion', { recoveryToken })).toEqual({
      status: 410,
      body: { error: 'github_completion_expired' },
    });
    const exchange = await fetch(`${origin}/v1/auth/github/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oidcToken: recoveryToken }),
    });
    expect(exchange.status).not.toBe(200);
  });

  it('reconnects through the mounted browser callback, replaces stale credentials and rejects another account', async () => {
    const sessionResponse = await fetch(`${origin}/v1/auth/github/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oidcToken: await issueTicket() }),
    });
    const session = (await sessionResponse.json()) as { accessToken: string; identityId: string };
    await database.query(`INSERT INTO github_user_tokens(subject,encrypted_token,stale_at,updated_at)
      VALUES('42','old',now(),now()-interval '7 days')`);
    const start = await mountedRequest(
      `/auth/github/start?app_redirect=${encodeURIComponent('beeline://beeline/github-callback')}&app_state=${'r'.repeat(43)}`,
    );
    const authorization = new URL(String(start.headers.location));
    const callback = await mountedRequest(
      `/auth/github/callback?code=fresh-code&state=${authorization.searchParams.get('state')}`,
      { cookie: String(start.headers['set-cookie']).split(';', 1)[0]! },
    );
    expect(callback.status).toBe(302);
    const completion = new URL(String(callback.headers.location));
    const saved = await store.githubUserCredential(tenant.community, '42');
    expect(saved?.encryptedRefreshToken).toBeTruthy();
    expect(saved?.encryptedRefreshToken).not.toBe('github-refresh-token');
    expect(new Date(saved!.expiresAt!).getTime()).toBeGreaterThan(Date.now());
    const reconnect = (ticket: string) =>
      fetch(`${origin}/v1/auth/github/reconnect`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({ oidcToken: ticket }),
      });
    expect((await reconnect(completion.searchParams.get('ticket')!)).status).toBe(204);
    const stored = (await database.query(`SELECT * FROM github_user_tokens WHERE subject='42'`))
      .rows[0]!;
    expect(stored.encrypted_token).toBe(saved!.encryptedToken);
    expect(stored.encrypted_refresh_token).toBe(saved!.encryptedRefreshToken);
    expect(stored.stale_at).toBeNull();
    expect(new Date(stored.updated_at as string).getTime()).toBeGreaterThan(Date.now() - 5000);
    expect(new Date(stored.expires_at as string).getTime()).toBeGreaterThan(Date.now());
    const mismatch = await reconnect(await issueTicket('99', 'other'));
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({ error: 'github_account_mismatch' });
    expect(
      (
        await database.query(`SELECT subject FROM identity_external_links WHERE identity_id=$1`, [
          session.identityId,
        ])
      ).rows,
    ).toEqual([{ subject: '42' }]);
    expect(
      (await database.query(`SELECT * FROM github_user_tokens WHERE subject='42'`)).rows[0],
    ).toEqual(stored);
    expect((await reconnect(completion.searchParams.get('ticket')!)).status).not.toBe(204);
  });

  it('does not expose a duplicate GitHub webhook through the auth mount', async () => {
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

    expect(response.status).toBe(404);
    expect(processWebhook).not.toHaveBeenCalled();
    await expect(
      database.query<{ installation_id: number; status: string }>(
        `SELECT installation_id,status FROM github_installations WHERE installation_id=77`,
      ),
    ).resolves.toMatchObject({ rows: [{ installation_id: 77, status: 'active' }] });
    await expect(
      database.query(`SELECT 1 FROM github_repositories WHERE installation_id=77`),
    ).resolves.toMatchObject({ rows: [] });
  });
});
