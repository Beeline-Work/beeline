import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { PGlite, type PGliteInterface, type Transaction } from '@electric-sql/pglite';
import { generateKeypair, nip98AuthHeader, signEvent, type Keypair } from '@beeline/nostr';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  roomCommunityIds: ['11111111-1111-4111-8111-111111111111'],
  origin: 'https://alpha.example',
};
const betaTenant: AuthTenant = {
  host: 'beta.example',
  community: 'community-beta',
  roomCommunityIds: ['22222222-2222-4222-8222-222222222222'],
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
  let githubSubject: string;
  let githubUserInstallations: number[] | Error;
  let githubAppInstallations: number[] | Error;
  // Optional per-test detail for the App-JWT enumeration; when unset the
  // default octocat/acme mapping above keeps older tests unchanged.
  let githubAppInstallationDetail:
    | Array<{ installationId: number; accountId: string; login: string; type: 'User' | 'Organization' }>
    | undefined;
  let githubAppRepositoryDetail:
    | Record<number, Array<{ id: number; name: string; fullName: string }>>
    | undefined;
  let githubInstallationListCalls: number;
  let githubRepositoryListError: Error | undefined;
  let githubInstallationAccess: boolean | Error;
  let githubRepositoryLookup: { id: number; fullName: string } | undefined;
  let roomTokenAuthority: NonNullable<
    Parameters<typeof buildAuthServer>[0]['authorizeGitHubRoomToken']
  >;
  let roomTokenMint:
    | {
        installationId: number;
        repositoryIds?: readonly number[];
        permissions?: Readonly<Record<string, string>>;
      }
    | undefined;
  let logLines: string[];

  beforeEach(async () => {
    provider = new DemoOidcProvider();
    await provider.start();
    const pglite = new PGlite();
    await pglite.waitReady;
    database = new PgliteDatabase(pglite);
    store = new AuthStore(database);
    await store.migrate();
    githubSubject = '123';
    githubUserInstallations = [];
    githubAppInstallations = [];
    githubAppInstallationDetail = undefined;
    githubAppRepositoryDetail = undefined;
    githubInstallationListCalls = 0;
    githubRepositoryListError = undefined;
    githubInstallationAccess = true;
    githubRepositoryLookup = undefined;
    roomTokenAuthority = async () => ({
      authorized: false,
      reason: 'agent_not_room_member',
    });
    roomTokenMint = undefined;
    logLines = [];
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
            subject: githubSubject,
            login: 'octocat',
            accessToken: 'github-user-token',
          }),
        } as unknown as GitHubOAuthClient,
        app: {
          publicInstallUrl: 'https://github.test/apps/beeline/installations/new',
          installationUrl: (state: string) =>
            `https://github.test/apps/beeline/installations/new?state=${state}`,
          installationAccount: async (installationId: number) => ({
            id: installationId === 77 ? '123' : '456',
            login: installationId === 77 ? 'octocat' : 'acme',
            type: installationId === 77 ? ('User' as const) : ('Organization' as const),
            repositorySelection: 'all' as const,
          }),
          listUserInstallationIds: async () => {
            if (githubUserInstallations instanceof Error) throw githubUserInstallations;
            return githubUserInstallations;
          },
          // The App JWT enumeration the server-side reconcile relies on.
          listInstallations: async () => {
            githubInstallationListCalls += 1;
            if (githubAppInstallations instanceof Error) throw githubAppInstallations;
            if (githubAppInstallationDetail) {
              return githubAppInstallationDetail.map(({ installationId, accountId, login, type }) => ({
                installationId,
                account: {
                  id: accountId,
                  login,
                  type,
                  repositorySelection: 'all' as const,
                },
              }));
            }
            return githubAppInstallations.map((installationId) => ({
              installationId,
              account: {
                id: installationId === 77 ? '123' : '456',
                login: installationId === 77 ? 'octocat' : 'acme',
                type: installationId === 77 ? ('User' as const) : ('Organization' as const),
                repositorySelection: 'all' as const,
              },
            }));
          },
          userCanAccessInstallation: async () => {
            if (githubInstallationAccess instanceof Error) throw githubInstallationAccess;
            return githubInstallationAccess;
          },
          repositoryByFullName: async () => githubRepositoryLookup,
          listRepositories: async (installationId: number) => {
            if (githubRepositoryListError) throw githubRepositoryListError;
            if (githubAppRepositoryDetail) {
              return (githubAppRepositoryDetail[installationId] ?? []).map((repo) => ({
                ...repo,
                installationId,
                remote: `https://github.com/${repo.fullName}.git`,
                defaultBranch: 'main',
              }));
            }
            return [
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
            ];
          },
          installationToken: async (
            installationId: number,
            options: {
              repositoryIds?: readonly number[];
              permissions?: Readonly<Record<string, string>>;
            } = {},
          ) => {
            roomTokenMint = { installationId, ...options };
            return { token: 'room-installation-token', expiresAt: '2030-01-01T00:00:00Z' };
          },
        } as unknown as GitHubAppClient,
        webhookSecret: 'webhook-secret',
      },
      tenants: [alphaTenant, betaTenant],
      authorizeGitHubRoomToken: (tenant, input) => roomTokenAuthority(tenant, input),
      logger: {
        level: 'warn',
        stream: { write: (line: string) => logLines.push(line) },
      },
      nativeRedirectUris: ['beeline://buzz/oidc-callback'],
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

  async function bindGitHubIdentity(identity: Keypair, appState: string): Promise<void> {
    const redirectUri = 'beeline://buzz/github-callback';
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
    expect(callback.statusCode).toBe(200);
    const completionHref = callback.body.match(/<a href="([^"]+)">Return to Beeline<\/a>/)?.[1];
    expect(completionHref).toBeDefined();
    const completion = new URL(completionHref!.replaceAll('&amp;', '&'));
    const challenge = Object.fromEntries(completion.searchParams) as unknown as BindChallenge;
    for (const key of ['protocol', 'kind', 'issued_at', 'expires_at'] as const) {
      (challenge as unknown as Record<string, unknown>)[key] = Number(
        completion.searchParams.get(key),
      );
    }
    const bound = await app.inject({
      method: 'POST',
      url: '/auth/oidc/bind',
      headers: { host: alphaTenant.host },
      payload: { ticket: challenge.ticket, event: bindEvent(challenge, identity) },
    });
    expect(bound.statusCode).toBe(201);
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

  it('mints an exact-repository token only after Room authority accepts the agent', async () => {
    const owner = generateKeypair();
    const agent = generateKeypair();
    await store.saveGitHubInstallation(
      {
        community: alphaTenant.community,
        pubkey: owner.publicKey,
        authorizedSubject: 'owner-subject',
        accountId: '123',
        accountLogin: 'octocat',
        accountType: 'User',
        installationId: 77,
        repositorySelection: 'selected',
        status: 'active',
        repositoryCount: 1,
      },
      new Date(),
    );
    await store.replaceGitHubRepositories(
      alphaTenant.community,
      77,
      [
        {
          id: 42,
          installationId: 77,
          name: 'widget',
          fullName: 'octocat/widget',
          remote: 'https://github.com/octocat/widget.git',
          defaultBranch: 'main',
        },
      ],
      new Date(),
    );
    roomTokenAuthority = async (_tenant, input) =>
      input.agentPubkey === agent.publicKey && input.roomId === 'room-1'
        ? {
            authorized: true,
            authorizedBy: owner.publicKey,
            fullName: 'octocat/widget',
            githubInstallationId: 77,
          }
        : { authorized: false, reason: 'agent_not_room_member' };
    const url = `${alphaTenant.origin}/auth/github/room-token`;
    const relayAuthorizations = Array.from({ length: 16 }, () =>
      nip98AuthHeader(agent.secretKey, agent.publicKey, `${alphaTenant.origin}/query`, 'POST'),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/auth/github/room-token',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(agent.secretKey, agent.publicKey, url, 'POST'),
      },
      payload: {
        pubkey: agent.publicKey,
        room_id: 'room-1',
        relay_authorizations: relayAuthorizations,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      token: 'room-installation-token',
      installation_id: 77,
      full_name: 'octocat/widget',
    });
    expect(roomTokenMint).toEqual({ installationId: 77, repositoryIds: [42] });

    const refusalCases = [
      {
        reason: 'tenant_room_community_mismatch',
        response: {
          error: 'room_repository_unauthorized',
          message: 'agent is not authorized for this Room repository',
        },
      },
      {
        reason: 'agent_not_room_member',
        response: {
          error: 'room_membership_required',
          message: 'agent is not a member of this Room',
        },
      },
      {
        reason: 'room_repository_missing',
        response: {
          error: 'room_repository_unresolvable',
          message: 'Room repository could not be resolved',
        },
      },
      {
        reason: 'room_repository_remote_malformed',
        response: {
          error: 'room_repository_unresolvable',
          message: 'Room repository could not be resolved',
        },
      },
      {
        reason: 'room_repository_authority_missing',
        response: {
          error: 'room_repository_unauthorized',
          message: 'agent is not authorized for this Room repository',
        },
      },
    ] as const;

    for (const refusalCase of refusalCases) {
      roomTokenAuthority = async () => ({
        authorized: false,
        reason: refusalCase.reason,
      });
      const refusedAgent = generateKeypair();
      const refusedRoom = `private-${refusalCase.reason}`;
      const refused = await app.inject({
        method: 'POST',
        url: '/auth/github/room-token',
        headers: {
          host: alphaTenant.host,
          authorization: nip98AuthHeader(
            refusedAgent.secretKey,
            refusedAgent.publicKey,
            url,
            'POST',
          ),
        },
        payload: {
          pubkey: refusedAgent.publicKey,
          room_id: refusedRoom,
          relay_authorizations: Array.from({ length: 16 }, () =>
            nip98AuthHeader(
              refusedAgent.secretKey,
              refusedAgent.publicKey,
              `${alphaTenant.origin}/query`,
              'POST',
            ),
          ),
        },
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toEqual(refusalCase.response);
      expect(refused.body).not.toContain(refusedAgent.publicKey);
      expect(refused.body).not.toContain(refusedRoom);
    }

    const ungrantedAgent = generateKeypair();
    const ungrantedOwner = generateKeypair();
    roomTokenAuthority = async () => ({
      authorized: true,
      authorizedBy: ungrantedOwner.publicKey,
      fullName: 'octocat/widget',
    });
    const ungranted = await app.inject({
      method: 'POST',
      url: '/auth/github/room-token',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          ungrantedAgent.secretKey,
          ungrantedAgent.publicKey,
          url,
          'POST',
        ),
      },
      payload: {
        pubkey: ungrantedAgent.publicKey,
        room_id: 'room-with-ungranted-repository',
        relay_authorizations: Array.from({ length: 16 }, () =>
          nip98AuthHeader(
            ungrantedAgent.secretKey,
            ungrantedAgent.publicKey,
            `${alphaTenant.origin}/query`,
            'POST',
          ),
        ),
      },
    });
    expect(ungranted.statusCode).toBe(403);
    expect(ungranted.json()).toEqual({
      error: 'owner_grant_needed',
      message:
        'octocat/widget is waiting for its owner to grant Beeline access. Ask the repository owner to install the Beeline GitHub App: https://github.test/apps/beeline/installations/new',
      install_url: 'https://github.test/apps/beeline/installations/new',
      repository: 'octocat/widget',
    });

    const refusalLogs = logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === 'GitHub Room token authority refused request');
    expect(refusalLogs.map((line) => line.authorityReason)).toEqual([
      ...refusalCases.map(({ reason }) => reason),
      'owner_grant_needed',
    ]);
    expect(refusalLogs.every((line) => line.agentPubkey && line.roomId)).toBe(true);
    expect(refusalLogs.at(-1)).toMatchObject({
      authorityReason: 'owner_grant_needed',
      authorizedBy: ungrantedOwner.publicKey,
      repository: 'octocat/widget',
    });
  });

  it('mints a read-only token when the Room token request asks for read_only', async () => {
    const owner = generateKeypair();
    const agent = generateKeypair();
    await store.saveGitHubInstallation(
      {
        community: alphaTenant.community,
        pubkey: owner.publicKey,
        authorizedSubject: 'owner-subject',
        accountId: '123',
        accountLogin: 'octocat',
        accountType: 'User',
        installationId: 77,
        repositorySelection: 'selected',
        status: 'active',
        repositoryCount: 1,
      },
      new Date(),
    );
    await store.replaceGitHubRepositories(
      alphaTenant.community,
      77,
      [
        {
          id: 42,
          installationId: 77,
          name: 'widget',
          fullName: 'octocat/widget',
          remote: 'https://github.com/octocat/widget.git',
          defaultBranch: 'main',
        },
      ],
      new Date(),
    );
    roomTokenAuthority = async (_tenant, input) =>
      input.agentPubkey === agent.publicKey && input.roomId === 'room-1'
        ? {
            authorized: true,
            authorizedBy: owner.publicKey,
            fullName: 'octocat/widget',
            githubInstallationId: 77,
          }
        : { authorized: false, reason: 'agent_not_room_member' };
    const url = `${alphaTenant.origin}/auth/github/room-token`;
    const mint = async (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/auth/github/room-token',
        headers: {
          host: alphaTenant.host,
          authorization: nip98AuthHeader(agent.secretKey, agent.publicKey, url, 'POST'),
        },
        payload: {
          pubkey: agent.publicKey,
          room_id: 'room-1',
          relay_authorizations: Array.from({ length: 16 }, () =>
            nip98AuthHeader(agent.secretKey, agent.publicKey, `${alphaTenant.origin}/query`, 'POST'),
          ),
          ...payload,
        },
      });

    // The read-only session variant: the mint must pin GitHub permissions to
    // exactly contents:read + metadata:read alongside the pinned repository —
    // structurally incapable of pushing or writing anything on any ref.
    const readOnly = await mint({ read_only: true });
    expect(readOnly.statusCode).toBe(200);
    expect(roomTokenMint).toEqual({
      installationId: 77,
      repositoryIds: [42],
      permissions: { contents: 'read', metadata: 'read' },
    });

    // A non-boolean read_only is a bad request, never silently truthy.
    const invalid = await mint({ read_only: 'yes' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('completes an organization installation even when the user-token listing cannot verify it', async () => {
    const identity = generateKeypair();
    await bindGitHubIdentity(identity, 'v'.repeat(43));
    // An unscoped OAuth lookup token cannot list organization installations;
    // production saw this surface as GET /user/installations failing outright.
    githubInstallationAccess = new Error('GitHub user installations failed: HTTP 404');

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
        redirect_uri: 'beeline://buzz/github-installation',
      },
    });
    expect(installStart.statusCode).toBe(200);
    const installUrl = new URL(installStart.json().authorization_url);
    const installed = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?installation_id=78&setup_action=install&state=${installUrl.searchParams.get('state')}`,
      headers: { host: alphaTenant.host },
    });

    // The state-bound GitHub redirect from the installing org admin is the
    // authority; the unavailable listing is logged, never fatal.
    expect(installed.statusCode).toBe(302);
    expect(installed.headers.location).toBe('beeline://buzz/github-installation?installed=1');
    await expect(
      store.githubInstallationsForPubkey(alphaTenant.community, identity.publicKey),
    ).resolves.toEqual([
      expect.objectContaining({
        installationId: 78,
        accountLogin: 'acme',
        accountType: 'Organization',
        status: 'active',
      }),
    ]);
    const warnings = logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === 'GitHub installation listing unavailable for organization verification');
    expect(warnings).toHaveLength(1);
  });

  it('logs unexpected installation-callback failures with their request id instead of a silent 500', async () => {
    const identity = generateKeypair();
    await bindGitHubIdentity(identity, 'v'.repeat(43));
    githubRepositoryListError = new Error('GitHub installation repositories failed: HTTP 502');

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
        redirect_uri: 'beeline://buzz/github-installation',
      },
    });
    const installUrl = new URL(installStart.json().authorization_url);
    const installed = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?installation_id=77&setup_action=install&state=${installUrl.searchParams.get('state')}`,
      headers: { host: alphaTenant.host },
    });

    expect(installed.statusCode).toBe(500);
    const body = installed.json() as Record<string, unknown>;
    expect(body.error).toBe('internal_error');
    expect(String(body.message)).toContain('GitHub installation repositories failed: HTTP 502');
    expect(typeof body.reqId).toBe('string');
    expect(String(body.message)).toContain(String(body.reqId));
    const logged = logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.reqId === body.reqId && line.level === 50);
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged[0])).toContain('HTTP 502');
  });

  it('answers a stateless (share-link/marketplace) install return with a friendly landing and no side effects', async () => {
    // A foreign install carries installation_id/setup_action but NO state
    // marker minted by an in-app flow. The install itself succeeded on
    // GitHub's side; the return must be a human-readable confirmation, never
    // raw JSON, and must bind no session and mint no token.
    const response = await app.inject({
      method: 'GET',
      url: '/auth/github/callback?installation_id=77&setup_action=install',
      headers: { host: alphaTenant.host },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('GitHub connected');
    expect(response.body).not.toContain('"error"');
    // Purely informational: no session binding, no token minting, no flow
    // cookie, no installation persisted under any identity.
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(roomTokenMint).toBeUndefined();
    await expect(
      store.githubInstallation(alphaTenant.community, 77),
    ).resolves.toBeNull();
  });

  it('answers a stateless install return on the legacy alias routes too', async () => {
    const installed = await app.inject({
      method: 'GET',
      url: '/auth/github/installed?installation_id=77&setup_action=install',
      headers: { host: alphaTenant.host },
    });
    expect(installed.statusCode).toBe(200);
    expect(installed.headers['content-type']).toContain('text/html');
    expect(installed.body).toContain('GitHub connected');

    const viaCallbackAlias = await app.inject({
      method: 'GET',
      url: '/auth/github/install/callback?installation_id=90&setup_action=install',
      headers: { host: alphaTenant.host },
    });
    expect(viaCallbackAlias.statusCode).toBe(200);
    expect(viaCallbackAlias.body).toContain('GitHub connected');
  });

  it('answers a present-but-invalid install state with a readable error page, not raw JSON', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/github/callback?installation_id=77&setup_action=install&state=wrongstate',
      headers: { host: alphaTenant.host },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('connection link');
    expect(response.body).not.toContain('invalid_request');
    expect(() => JSON.parse(response.body)).toThrow();
    // Still no session or token side effects on the failed path.
    expect(roomTokenMint).toBeUndefined();
    await expect(
      store.githubInstallation(alphaTenant.community, 77),
    ).resolves.toBeNull();
  });

  it('re-mints Room tokens for a repository that transferred after its Room binding was written', async () => {
    const owner = generateKeypair();
    const agent = generateKeypair();
    // History of one transferred repository: the personal installation listed
    // it under the old owner/name, then the transfer moved the same immutable
    // id to the org installation and it disappeared from the old one.
    await store.saveGitHubInstallation(
      {
        community: alphaTenant.community,
        pubkey: owner.publicKey,
        authorizedSubject: 'owner-subject',
        accountId: '123',
        accountLogin: 'lunchboxfortwo',
        accountType: 'User',
        installationId: 77,
        repositorySelection: 'selected',
        status: 'active',
        repositoryCount: 0,
      },
      new Date(),
    );
    await store.replaceGitHubRepositories(
      alphaTenant.community,
      77,
      [
        {
          id: 42,
          installationId: 77,
          name: 'beeline',
          fullName: 'lunchboxfortwo/beeline',
          remote: 'https://github.com/lunchboxfortwo/beeline.git',
          defaultBranch: 'main',
        },
      ],
      new Date(),
    );
    await store.saveGitHubInstallation(
      {
        community: alphaTenant.community,
        pubkey: owner.publicKey,
        authorizedSubject: 'owner-subject',
        accountId: '456',
        accountLogin: 'Beeline-Work',
        accountType: 'Organization',
        installationId: 90,
        repositorySelection: 'all',
        status: 'active',
        repositoryCount: 1,
      },
      new Date(),
    );
    await store.replaceGitHubRepositories(
      alphaTenant.community,
      90,
      [
        {
          id: 42,
          installationId: 90,
          name: 'beeline',
          fullName: 'Beeline-Work/beeline',
          remote: 'https://github.com/Beeline-Work/beeline.git',
          defaultBranch: 'main',
        },
      ],
      new Date(),
    );
    // The transfer removed the repository from the personal installation.
    await store.replaceGitHubRepositories(alphaTenant.community, 77, [], new Date());
    roomTokenAuthority = async (_tenant, input) =>
      input.agentPubkey === agent.publicKey && input.roomId === 'room-1'
        ? { authorized: true, authorizedBy: owner.publicKey, fullName: 'lunchboxfortwo/beeline' }
        : { authorized: false, reason: 'agent_not_room_member' };
    const url = `${alphaTenant.origin}/auth/github/room-token`;
    const relayAuthorizations = Array.from({ length: 16 }, () =>
      nip98AuthHeader(agent.secretKey, agent.publicKey, `${alphaTenant.origin}/query`, 'POST'),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/auth/github/room-token',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(agent.secretKey, agent.publicKey, url, 'POST'),
      },
      payload: {
        pubkey: agent.publicKey,
        room_id: 'room-1',
        relay_authorizations: relayAuthorizations,
      },
    });

    // The stale binding self-heals onto the transferred repo's current name.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      token: 'room-installation-token',
      installation_id: 90,
      full_name: 'Beeline-Work/beeline',
    });
    expect(roomTokenMint).toEqual({ installationId: 90, repositoryIds: [42] });
  });

  it('follows GitHub\'s rename redirect once, persists it, and names the uncovered destination', async () => {
    const owner = generateKeypair();
    const agent = generateKeypair();
    await store.saveGitHubInstallation(
      {
        community: alphaTenant.community,
        pubkey: owner.publicKey,
        authorizedSubject: 'owner-subject',
        accountId: '456',
        accountLogin: 'Beeline-Work',
        accountType: 'Organization',
        installationId: 91,
        repositorySelection: 'all',
        status: 'active',
        repositoryCount: 0,
      },
      new Date(),
    );
    roomTokenAuthority = async () => ({
      authorized: true,
      authorizedBy: owner.publicKey,
      fullName: 'lunchboxfortwo/beeline',
    });
    githubRepositoryLookup = { id: 42, fullName: 'Beeline-Work/beeline' };
    const url = `${alphaTenant.origin}/auth/github/room-token`;
    const injectRoomToken = async (pubkey: Keypair) =>
      app.inject({
        method: 'POST',
        url: '/auth/github/room-token',
        headers: {
          host: alphaTenant.host,
          authorization: nip98AuthHeader(pubkey.secretKey, pubkey.publicKey, url, 'POST'),
        },
        payload: {
          pubkey: pubkey.publicKey,
          room_id: 'room-1',
          relay_authorizations: Array.from({ length: 16 }, () =>
            nip98AuthHeader(pubkey.secretKey, pubkey.publicKey, `${alphaTenant.origin}/query`, 'POST'),
          ),
        },
      });

    // The new location exists but no installation covers it: say exactly that.
    const uncovered = await injectRoomToken(agent);
    expect(uncovered.statusCode).toBe(403);
    expect(uncovered.json()).toEqual({
      error: 'repository_not_granted',
      message: 'repository moved to Beeline-Work/beeline; grant the App access there',
    });

    // The org install lands and grants the new location: the same request now
    // resolves through the redirect AND persists the learned alias.
    await store.replaceGitHubRepositories(
      alphaTenant.community,
      91,
      [
        {
          id: 42,
          installationId: 91,
          name: 'beeline',
          fullName: 'Beeline-Work/beeline',
          remote: 'https://github.com/Beeline-Work/beeline.git',
          defaultBranch: 'main',
        },
      ],
      new Date(),
    );
    const healed = await injectRoomToken(agent);
    expect(healed.statusCode).toBe(200);
    expect(healed.json()).toMatchObject({ full_name: 'Beeline-Work/beeline' });

    // The alias is durable: with GitHub's redirect gone entirely, the old
    // binding still resolves without any lookup.
    githubRepositoryLookup = undefined;
    const viaAlias = await injectRoomToken(agent);
    expect(viaAlias.statusCode).toBe(200);
    expect(viaAlias.json()).toMatchObject({ full_name: 'Beeline-Work/beeline' });
  });

  it('reconciles an unrecorded installation when a transfer refuses under a stale active install', async () => {
    const owner = generateKeypair();
    const agent = generateKeypair();
    await bindGitHubIdentity(owner, 'p'.repeat(43));
    // Production shape (2026-08): the personal installation is still recorded
    // ACTIVE against the OLD owner, but the repository has transferred away
    // from it — its snapshot rows are deactivated, not deleted.
    await store.saveGitHubInstallation(
      {
        community: alphaTenant.community,
        pubkey: owner.publicKey,
        authorizedSubject: '123',
        accountId: '123',
        accountLogin: 'lunchboxfortwo',
        accountType: 'User',
        installationId: 77,
        repositorySelection: 'selected',
        status: 'active',
        repositoryCount: 0,
      },
      new Date(),
    );
    await store.replaceGitHubRepositories(
      alphaTenant.community,
      77,
      [
        {
          id: 42,
          installationId: 77,
          name: 'beeline',
          fullName: 'lunchboxfortwo/beeline',
          remote: 'https://github.com/lunchboxfortwo/beeline.git',
          defaultBranch: 'main',
        },
      ],
      new Date(),
    );
    await store.replaceGitHubRepositories(alphaTenant.community, 77, [], new Date());
    // Meanwhile the org installation exists on GitHub but was never recorded,
    // and the private repository's rename redirect is invisible to the App
    // JWT alone — so movedTo stays empty and the refusal reads plain
    // not_granted.
    githubRepositoryLookup = undefined;
    githubAppInstallations = [90];
    githubAppInstallationDetail = [
      { installationId: 90, accountId: '789', login: 'Beeline-Work', type: 'Organization' },
    ];
    githubAppRepositoryDetail = {
      90: [{ id: 42, name: 'beeline', fullName: 'Beeline-Work/beeline' }],
    };
    // The user-token listing cannot verify organization installs (#355).
    githubUserInstallations = new Error('GitHub user installations failed: HTTP 404');
    roomTokenAuthority = async (_tenant, input) =>
      input.agentPubkey === agent.publicKey && input.roomId === 'room-1'
        ? { authorized: true, authorizedBy: owner.publicKey, fullName: 'lunchboxfortwo/beeline' }
        : { authorized: false, reason: 'agent_not_room_member' };

    const response = await app.inject({
      method: 'POST',
      url: '/auth/github/room-token',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(agent.secretKey, agent.publicKey, `${alphaTenant.origin}/auth/github/room-token`, 'POST'),
      },
      payload: {
        pubkey: agent.publicKey,
        room_id: 'room-1',
        relay_authorizations: Array.from({ length: 16 }, () =>
          nip98AuthHeader(agent.secretKey, agent.publicKey, `${alphaTenant.origin}/query`, 'POST'),
        ),
      },
    });

    // Reconcile records the org install, then immutable-id healing resolves
    // the stale binding onto the transferred repository under its new name.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      token: 'room-installation-token',
      installation_id: 90,
      full_name: 'Beeline-Work/beeline',
    });
    expect(roomTokenMint).toEqual({ installationId: 90, repositoryIds: [42] });
  });

  it('heals a Room binding pinned to the old installation when a transfer moves the repo to a reconciled org installation behind a stale user token', async () => {
    const owner = generateKeypair();
    const agent = generateKeypair();
    await bindGitHubIdentity(owner, 'r'.repeat(43));
    // Production shape (2026-08, live trace): the personal installation is
    // still recorded ACTIVE against the old owner, its snapshot rows for the
    // transferred repository are deactivated, and the Room binding on the
    // relay pins THAT OLD installation id. The org installation was never
    // recorded, and the owner's STORED OAuth user token is stale — every
    // user-token listing answers HTTP 401.
    await store.saveGitHubInstallation(
      {
        community: alphaTenant.community,
        pubkey: owner.publicKey,
        authorizedSubject: '123',
        accountId: '123',
        accountLogin: 'lunchboxfortwo',
        accountType: 'User',
        installationId: 77,
        repositorySelection: 'selected',
        status: 'active',
        repositoryCount: 0,
      },
      new Date(),
    );
    await store.replaceGitHubRepositories(
      alphaTenant.community,
      77,
      [
        {
          id: 42,
          installationId: 77,
          name: 'beeline',
          fullName: 'lunchboxfortwo/beeline',
          remote: 'https://github.com/lunchboxfortwo/beeline.git',
          defaultBranch: 'main',
        },
      ],
      new Date(),
    );
    await store.replaceGitHubRepositories(alphaTenant.community, 77, [], new Date());
    githubRepositoryLookup = undefined;
    githubAppInstallations = [90];
    githubAppInstallationDetail = [
      { installationId: 90, accountId: '789', login: 'Beeline-Work', type: 'Organization' },
    ];
    githubAppRepositoryDetail = {
      90: [{ id: 42, name: 'beeline', fullName: 'Beeline-Work/beeline' }],
    };
    githubUserInstallations = new Error('GitHub user installations failed: HTTP 401');
    roomTokenAuthority = async (_tenant, input) =>
      input.agentPubkey === agent.publicKey && input.roomId === 'room-1'
        ? {
            authorized: true,
            authorizedBy: owner.publicKey,
            fullName: 'lunchboxfortwo/beeline',
            // The relay's room-config binding still names the OLD install.
            githubInstallationId: 77,
          }
        : { authorized: false, reason: 'agent_not_room_member' };

    const url = `${alphaTenant.origin}/auth/github/room-token`;
    const response = await app.inject({
      method: 'POST',
      url: '/auth/github/room-token',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          agent.secretKey,
          agent.publicKey,
          url,
          'POST',
        ),
      },
      payload: {
        pubkey: agent.publicKey,
        room_id: 'room-1',
        relay_authorizations: Array.from({ length: 16 }, () =>
          nip98AuthHeader(agent.secretKey, agent.publicKey, `${alphaTenant.origin}/query`, 'POST'),
        ),
      },
    });

    // The unavailable listing proceeds for the Organization account (#359),
    // reconcile claims the org install, and immutable-id healing resolves the
    // stale binding onto the transferred repository under its new name — the
    // binding's old installation pin is a hint from bind time, never a veto.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      token: 'room-installation-token',
      installation_id: 90,
      full_name: 'Beeline-Work/beeline',
    });
    expect(roomTokenMint).toEqual({ installationId: 90, repositoryIds: [42] });
  });

  it('still refuses a discovered organization installation when the user-token listing definitively denies it', async () => {
    const owner = generateKeypair();
    const agent = generateKeypair();
    await bindGitHubIdentity(owner, 's'.repeat(43));
    await store.saveGitHubInstallation(
      {
        community: alphaTenant.community,
        pubkey: owner.publicKey,
        authorizedSubject: '123',
        accountId: '123',
        accountLogin: 'lunchboxfortwo',
        accountType: 'User',
        installationId: 77,
        repositorySelection: 'selected',
        status: 'active',
        repositoryCount: 0,
      },
      new Date(),
    );
    githubRepositoryLookup = undefined;
    githubAppInstallations = [90];
    githubAppInstallationDetail = [
      { installationId: 90, accountId: '789', login: 'Beeline-Work', type: 'Organization' },
    ];
    githubUserInstallations = [77];
    roomTokenAuthority = async (_tenant, input) =>
      input.agentPubkey === agent.publicKey && input.roomId === 'room-1'
        ? { authorized: true, authorizedBy: owner.publicKey, fullName: 'acme/widget' }
        : { authorized: false, reason: 'agent_not_room_member' };

    const url = `${alphaTenant.origin}/auth/github/room-token`;
    const response = await app.inject({
      method: 'POST',
      url: '/auth/github/room-token',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(agent.secretKey, agent.publicKey, url, 'POST'),
      },
      payload: {
        pubkey: agent.publicKey,
        room_id: 'room-1',
        relay_authorizations: Array.from({ length: 16 }, () =>
          nip98AuthHeader(agent.secretKey, agent.publicKey, `${alphaTenant.origin}/query`, 'POST'),
        ),
      },
    });

    // A SUCCESSFUL listing that does not contain the installation is a
    // definitive negative: the claim is refused and nothing is recorded.
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: 'owner_grant_needed',
      message: expect.stringContaining('is waiting for its owner to grant Beeline access'),
      install_url: 'https://github.test/apps/beeline/installations/new',
      repository: expect.any(String),
    });
    await expect(
      store.githubInstallation(alphaTenant.community, 90),
    ).resolves.toBeNull();
  });

  it('marks the stored user token stale when GitHub rejects it and clears that on a fresh bind', async () => {
    const owner = generateKeypair();
    await bindGitHubIdentity(owner, 't'.repeat(43));
    githubRepositoryLookup = undefined;
    githubAppInstallations = [90];
    githubAppInstallationDetail = [
      { installationId: 90, accountId: '789', login: 'Beeline-Work', type: 'Organization' },
    ];
    githubUserInstallations = new Error('GitHub user installations failed: HTTP 401');

    const reposUrl = `https://alpha.example/auth/github/repos/${owner.publicKey}`;
    const injectRepos = async () =>
      app.inject({
        method: 'GET',
        url: `/auth/github/repos/${owner.publicKey}`,
        headers: {
          host: alphaTenant.host,
          authorization: nip98AuthHeader(owner.secretKey, owner.publicKey, reposUrl, 'GET'),
        },
      });

    // First request triggers reconcile; its stale-marking is fire-and-forget,
    // so let the microtask land before reading the response surface.
    await injectRepos();
    await new Promise((resolve) => setImmediate(resolve));
    const marked = await injectRepos();
    expect(marked.statusCode).toBe(200);
    expect(marked.json()).toMatchObject({ installed: true, user_token_stale: true });

    // A fresh OAuth bind replaces the credential and the staleness clears.
    await store.saveGitHubUserToken(alphaTenant.community, '123', 'sealed', new Date());
    const refreshed = await injectRepos();
    expect(refreshed.json()).toMatchObject({ installed: true });
    expect((refreshed.json() as Record<string, unknown>).user_token_stale).toBeUndefined();
  }, 20000);

  it('rate-limits the failing-path reconciliation so repeated refusals cannot storm GitHub', async () => {
    const owner = generateKeypair();
    const agent = generateKeypair();
    await bindGitHubIdentity(owner, 'q'.repeat(43));
    // Same stale-active-install shape, but GitHub holds NO undiscovered
    // installation: every request still refuses, and the App-JWT enumeration
    // must run exactly once per rate-limit window.
    await store.saveGitHubInstallation(
      {
        community: alphaTenant.community,
        pubkey: owner.publicKey,
        authorizedSubject: '123',
        accountId: '123',
        accountLogin: 'lunchboxfortwo',
        accountType: 'User',
        installationId: 77,
        repositorySelection: 'selected',
        status: 'active',
        repositoryCount: 0,
      },
      new Date(),
    );
    await store.replaceGitHubRepositories(
      alphaTenant.community,
      77,
      [
        {
          id: 42,
          installationId: 77,
          name: 'beeline',
          fullName: 'lunchboxfortwo/beeline',
          remote: 'https://github.com/lunchboxfortwo/beeline.git',
          defaultBranch: 'main',
        },
      ],
      new Date(),
    );
    await store.replaceGitHubRepositories(alphaTenant.community, 77, [], new Date());
    githubRepositoryLookup = undefined;
    roomTokenAuthority = async (_tenant, input) =>
      input.agentPubkey === agent.publicKey && input.roomId === 'room-1'
        ? { authorized: true, authorizedBy: owner.publicKey, fullName: 'lunchboxfortwo/beeline' }
        : { authorized: false, reason: 'agent_not_room_member' };
    const injectRoomToken = () =>
      app.inject({
        method: 'POST',
        url: '/auth/github/room-token',
        headers: {
          host: alphaTenant.host,
          authorization: nip98AuthHeader(agent.secretKey, agent.publicKey, `${alphaTenant.origin}/auth/github/room-token`, 'POST'),
        },
        payload: {
          pubkey: agent.publicKey,
          room_id: 'room-1',
          relay_authorizations: Array.from({ length: 16 }, () =>
            nip98AuthHeader(agent.secretKey, agent.publicKey, `${alphaTenant.origin}/query`, 'POST'),
          ),
        },
      });

    const first = await injectRoomToken();
    expect(first.statusCode).toBe(403);
    expect(first.json()).toMatchObject({ error: 'owner_grant_needed' });
    const second = await injectRoomToken();
    expect(second.statusCode).toBe(403);
    expect(githubInstallationListCalls).toBe(1);
    const refusalLogs = logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === 'GitHub Room token authority refused request');
    expect(refusalLogs.length).toBe(2);
    expect(refusalLogs.every((line) => line.authorityReason === 'owner_grant_needed')).toBe(true);
    // No GitHub credential material ever reaches the log.
    expect(logLines.join('\n')).not.toMatch(/Bearer ey|PRIVATE KEY|github-user-token/);
  });

  it('completes GitHub sign-in through a visible immediate app handoff', async () => {
    const appState = 'g'.repeat(43);
    const redirectUri = 'beeline://buzz/github-callback';
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
    expect(callback.statusCode).toBe(200);
    expect(callback.headers['content-type']).toContain('text/html');
    expect(callback.body).toContain('Beeline sign-in complete');
    expect(callback.body).toContain('http-equiv="refresh" content="0;url=beeline://');
    const completionHref = callback.body.match(/<a href="([^"]+)">Return to Beeline<\/a>/)?.[1];
    expect(completionHref).toBeDefined();
    const completion = new URL(completionHref!.replaceAll('&amp;', '&'));
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
    expect(handoff.body).toContain('beeline://buzz/github-callback?state=');
    expect(handoff.body).toContain(`state=${appState}`);
    expect(handoff.body).not.toContain('Route GET:');

    const installationHandoff = await app.inject({
      method: 'GET',
      url: '/auth/github/mobile-callback?installed=1',
      headers: { host: alphaTenant.host },
    });
    expect(installationHandoff.statusCode).toBe(200);
    expect(installationHandoff.body).toContain('beeline://buzz/github-installation?installed=1');
  });

  it('reconciles a missed GitHub installation callback onto the current identity after pubkey churn', async () => {
    githubAppInstallations = [77];
    githubUserInstallations = [77];
    const oldIdentity = generateKeypair();
    await bindGitHubIdentity(oldIdentity, 'o'.repeat(43));
    await database.query(
      `DELETE FROM beeline_identity_links
       WHERE community = $1 AND issuer = 'https://github.com' AND subject = $2`,
      [alphaTenant.community, '123'],
    );
    const currentIdentity = generateKeypair();
    await bindGitHubIdentity(currentIdentity, 'n'.repeat(43));

    const reposUrl = `https://alpha.example/auth/github/repos/${currentIdentity.publicKey}`;
    const response = await app.inject({
      method: 'GET',
      url: `/auth/github/repos/${currentIdentity.publicKey}`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          currentIdentity.secretKey,
          currentIdentity.publicKey,
          reposUrl,
          'GET',
        ),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      installed: true,
      installations: [{ installationId: 77, accountId: '123' }],
      repositories: [{ installationId: 77, fullName: 'octocat/widget' }],
    });
    expect(githubInstallationListCalls).toBe(1);
    await expect(
      store.githubInstallationsForPubkey(alphaTenant.community, oldIdentity.publicKey),
    ).resolves.toEqual([]);
    await expect(
      store.githubInstallationsForPubkey(alphaTenant.community, currentIdentity.publicKey),
    ).resolves.toEqual([
      expect.objectContaining({
        installationId: 77,
        authorizedSubject: '123',
        accountId: '123',
      }),
    ]);
  });

  it('moves an orphaned installation row only when the stable GitHub subject matches', async () => {
    githubAppInstallations = [77];
    const oldIdentity = generateKeypair();
    await bindGitHubIdentity(oldIdentity, '3'.repeat(43));
    await expect(
      store.saveGitHubInstallation(
        {
          community: alphaTenant.community,
          pubkey: oldIdentity.publicKey,
          authorizedSubject: '123',
          accountId: '123',
          accountLogin: 'octocat',
          accountType: 'User',
          installationId: 77,
          repositorySelection: 'all',
          status: 'active',
          repositoryCount: 0,
        },
        new Date(),
      ),
    ).resolves.toBe(true);
    await database.query(
      `DELETE FROM beeline_identity_links
       WHERE community = $1 AND issuer = 'https://github.com' AND subject = $2`,
      [alphaTenant.community, '123'],
    );
    const currentIdentity = generateKeypair();
    await bindGitHubIdentity(currentIdentity, '4'.repeat(43));

    const reposUrl = `https://alpha.example/auth/github/repos/${currentIdentity.publicKey}`;
    const response = await app.inject({
      method: 'GET',
      url: `/auth/github/repos/${currentIdentity.publicKey}`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          currentIdentity.secretKey,
          currentIdentity.publicKey,
          reposUrl,
          'GET',
        ),
      },
    });

    expect(response.json()).toMatchObject({
      installed: true,
      installations: [{ installationId: 77 }],
      repositories: [{ fullName: 'octocat/widget' }],
    });
    await expect(
      store.githubInstallationsForPubkey(alphaTenant.community, oldIdentity.publicKey),
    ).resolves.toEqual([]);
    await expect(
      store.githubInstallationsForPubkey(alphaTenant.community, currentIdentity.publicKey),
    ).resolves.toEqual([expect.objectContaining({ installationId: 77, authorizedSubject: '123' })]);
  });

  it('returns the honest cached miss when GitHub installation reconciliation fails', async () => {
    githubAppInstallations = new Error('GitHub rate limited');
    const identity = generateKeypair();
    await bindGitHubIdentity(identity, 'f'.repeat(43));

    const reposUrl = `https://alpha.example/auth/github/repos/${identity.publicKey}`;
    const response = await app.inject({
      method: 'GET',
      url: `/auth/github/repos/${identity.publicKey}`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, reposUrl, 'GET'),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ installed: false, installations: [], repositories: [] });
    expect(githubInstallationListCalls).toBe(1);

    const throttledUrl = `${reposUrl}?retry=1`;
    const throttled = await app.inject({
      method: 'GET',
      url: `/auth/github/repos/${identity.publicKey}?retry=1`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, throttledUrl, 'GET'),
      },
    });
    expect(throttled.statusCode).toBe(200);
    expect(throttled.json()).toEqual({ installed: false, installations: [], repositories: [] });
    expect(githubInstallationListCalls).toBe(1);
    // No GitHub credential material ever reaches the log — the reconcile
    // path signs App JWTs and decrypts user tokens internally.
    expect(logLines.join('\n')).not.toMatch(/Bearer ey|PRIVATE KEY|github-user-token/);
  });

  it('keeps users with no GitHub App installation in the install flow', async () => {
    const identity = generateKeypair();
    await bindGitHubIdentity(identity, 'z'.repeat(43));

    const reposUrl = `https://alpha.example/auth/github/repos/${identity.publicKey}`;
    const response = await app.inject({
      method: 'GET',
      url: `/auth/github/repos/${identity.publicKey}`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, reposUrl, 'GET'),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ installed: false, installations: [], repositories: [] });
    expect(githubInstallationListCalls).toBe(1);
  });

  it('does not claim repository access when GitHub repository verification fails', async () => {
    githubAppInstallations = [77];
    githubUserInstallations = [77];
    githubRepositoryListError = new Error('repository listing failed');
    const identity = generateKeypair();
    await bindGitHubIdentity(identity, 'v'.repeat(43));

    const reposUrl = `https://alpha.example/auth/github/repos/${identity.publicKey}`;
    const response = await app.inject({
      method: 'GET',
      url: `/auth/github/repos/${identity.publicKey}`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, reposUrl, 'GET'),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ installed: false, installations: [], repositories: [] });
    await expect(
      store.githubInstallationsForPubkey(alphaTenant.community, identity.publicKey),
    ).resolves.toEqual([]);
  });

  it('does not transfer an organization installation between distinct GitHub subjects', async () => {
    githubAppInstallations = [78];
    githubUserInstallations = [78];
    const firstIdentity = generateKeypair();
    await bindGitHubIdentity(firstIdentity, '1'.repeat(43));
    const firstReposUrl = `https://alpha.example/auth/github/repos/${firstIdentity.publicKey}`;
    const firstResponse = await app.inject({
      method: 'GET',
      url: `/auth/github/repos/${firstIdentity.publicKey}`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          firstIdentity.secretKey,
          firstIdentity.publicKey,
          firstReposUrl,
          'GET',
        ),
      },
    });
    expect(firstResponse.json()).toMatchObject({
      installed: true,
      installations: [{ installationId: 78 }],
    });

    githubSubject = '999';
    const secondIdentity = generateKeypair();
    await bindGitHubIdentity(secondIdentity, '2'.repeat(43));
    const secondReposUrl = `https://alpha.example/auth/github/repos/${secondIdentity.publicKey}`;
    const secondResponse = await app.inject({
      method: 'GET',
      url: `/auth/github/repos/${secondIdentity.publicKey}`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          secondIdentity.secretKey,
          secondIdentity.publicKey,
          secondReposUrl,
          'GET',
        ),
      },
    });

    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json()).toEqual({
      installed: false,
      installations: [],
      repositories: [],
    });
    await expect(
      store.githubInstallationsForPubkey(alphaTenant.community, firstIdentity.publicKey),
    ).resolves.toEqual([expect.objectContaining({ installationId: 78, authorizedSubject: '123' })]);
    await expect(
      store.githubInstallationsForPubkey(alphaTenant.community, secondIdentity.publicKey),
    ).resolves.toEqual([]);
  });

  it('discovers an unrecorded organization installation on refresh and grants its repositories', async () => {
    const identity = generateKeypair();
    await bindGitHubIdentity(identity, 'r'.repeat(43));
    // The App is installed on org acme but the callback never persisted, and
    // an unscoped OAuth token cannot even list organization installations.
    // Only the App JWT enumeration can discover it.
    githubAppInstallations = [78];
    githubUserInstallations = new Error('GitHub user installations failed: HTTP 404');

    const reposUrl = `https://alpha.example/auth/github/repos/${identity.publicKey}?refresh=1`;
    const response = await app.inject({
      method: 'GET',
      url: `/auth/github/repos/${identity.publicKey}?refresh=1`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, reposUrl, 'GET'),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      installed: true,
      installations: [
        { installationId: 78, accountLogin: 'acme', accountType: 'Organization', status: 'active' },
      ],
      repositories: [{ installationId: 78, fullName: 'acme/widget' }],
    });
    await expect(
      store.githubInstallationsForPubkey(alphaTenant.community, identity.publicKey),
    ).resolves.toEqual([
      expect.objectContaining({ installationId: 78, authorizedSubject: '123', status: 'active' }),
    ]);

    // The discovered installation now grants Room tokens with no callback.
    roomTokenAuthority = async () => ({
      authorized: true,
      authorizedBy: identity.publicKey,
      fullName: 'acme/widget',
    });
    roomTokenMint = undefined;
    const tokenUrl = 'https://alpha.example/auth/github/room-token';
    const minted = await app.inject({
      method: 'POST',
      url: '/auth/github/room-token',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, tokenUrl, 'POST'),
      },
      payload: {
        pubkey: identity.publicKey,
        room_id: 'org-room',
        relay_authorizations: Array.from({ length: 16 }, () =>
          nip98AuthHeader(
            identity.secretKey,
            identity.publicKey,
            `${alphaTenant.origin}/query`,
            'POST',
          ),
        ),
      },
    });
    expect(minted.statusCode).toBe(200);
    expect(minted.json()).toMatchObject({ installation_id: 78, full_name: 'acme/widget' });
    expect(roomTokenMint).toMatchObject({ installationId: 78, repositoryIds: [42] });
  });

  it('heals a missed installation during a room-token refusal instead of refusing a covered repository', async () => {
    const owner = generateKeypair();
    await bindGitHubIdentity(owner, 'h'.repeat(43));
    githubAppInstallations = [78];
    githubUserInstallations = [78];
    roomTokenAuthority = async () => ({
      authorized: true,
      authorizedBy: owner.publicKey,
      fullName: 'acme/widget',
    });
    roomTokenMint = undefined;
    const tokenUrl = 'https://alpha.example/auth/github/room-token';
    const response = await app.inject({
      method: 'POST',
      url: '/auth/github/room-token',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(owner.secretKey, owner.publicKey, tokenUrl, 'POST'),
      },
      payload: {
        pubkey: owner.publicKey,
        room_id: 'org-room',
        relay_authorizations: Array.from({ length: 16 }, () =>
          nip98AuthHeader(owner.secretKey, owner.publicKey, `${alphaTenant.origin}/query`, 'POST'),
        ),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ installation_id: 78, full_name: 'acme/widget' });
    expect(roomTokenMint).toMatchObject({ installationId: 78 });
    await expect(
      store.githubInstallationsForPubkey(alphaTenant.community, owner.publicKey),
    ).resolves.toEqual([expect.objectContaining({ installationId: 78, status: 'active' })]);
  });

  it('still refuses a room token when reconciliation finds no covering installation', async () => {
    const owner = generateKeypair();
    await bindGitHubIdentity(owner, 'm'.repeat(43));
    roomTokenAuthority = async () => ({
      authorized: true,
      authorizedBy: owner.publicKey,
      fullName: 'octocat/widget',
    });
    const tokenUrl = 'https://alpha.example/auth/github/room-token';
    const response = await app.inject({
      method: 'POST',
      url: '/auth/github/room-token',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(owner.secretKey, owner.publicKey, tokenUrl, 'POST'),
      },
      payload: {
        pubkey: owner.publicKey,
        room_id: 'uncovered-room',
        relay_authorizations: Array.from({ length: 16 }, () =>
          nip98AuthHeader(owner.secretKey, owner.publicKey, `${alphaTenant.origin}/query`, 'POST'),
        ),
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'owner_grant_needed' });
    expect(githubInstallationListCalls).toBe(1);
  });

  it('answers a never-granted repository with the typed owner-grant state and records the pending link', async () => {
    const requester = generateKeypair();
    await bindGitHubIdentity(requester, 'g'.repeat(43));
    // The requester administers the Room and authors the binding, but the
    // repository's OWNER has never installed the App — only the owner can.
    roomTokenAuthority = async (_tenant, input) =>
      input.agentPubkey === requester.publicKey && input.roomId === 'room-foreign'
        ? { authorized: true, authorizedBy: requester.publicKey, fullName: 'bananaman/widget' }
        : { authorized: false, reason: 'agent_not_room_member' };
    const tokenUrl = `${alphaTenant.origin}/auth/github/room-token`;
    const refused = await app.inject({
      method: 'POST',
      url: '/auth/github/room-token',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          requester.secretKey,
          requester.publicKey,
          tokenUrl,
          'POST',
        ),
      },
      payload: {
        pubkey: requester.publicKey,
        room_id: 'room-foreign',
        relay_authorizations: Array.from({ length: 16 }, () =>
          nip98AuthHeader(
            requester.secretKey,
            requester.publicKey,
            `${alphaTenant.origin}/query`,
            'POST',
          ),
        ),
      },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({
      error: 'owner_grant_needed',
      message:
        'bananaman/widget is waiting for its owner to grant Beeline access. Ask the repository owner to install the Beeline GitHub App: https://github.test/apps/beeline/installations/new',
      install_url: 'https://github.test/apps/beeline/installations/new',
      repository: 'bananaman/widget',
    });

    // The bind-time probe surfaces the same typed state (with Room context so
    // the pending link is recorded here too) — a pending state, not an error.
    const accessUrl = `${alphaTenant.origin}/auth/github/repo-access/${requester.publicKey}?full_name=bananaman%2Fwidget&room_id=room-foreign`;
    const probe = await app.inject({
      method: 'GET',
      url: `/auth/github/repo-access/${requester.publicKey}?full_name=bananaman%2Fwidget&room_id=room-foreign`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          requester.secretKey,
          requester.publicKey,
          accessUrl,
          'GET',
        ),
      },
    });
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toMatchObject({
      accessible: false,
      grant_needed: true,
      install_url: 'https://github.test/apps/beeline/installations/new',
    });
  });

  it('flips a pending Room link active when the owner installs, announcing it once', async () => {
    const requester = generateKeypair();
    const owner = generateKeypair();
    await bindGitHubIdentity(requester, 'h'.repeat(43));
    roomTokenAuthority = async (_tenant, input) =>
      input.agentPubkey === requester.publicKey && input.roomId === 'room-pending'
        ? { authorized: true, authorizedBy: requester.publicKey, fullName: 'octocat/widget' }
        : { authorized: false, reason: 'agent_not_room_member' };
    const tokenUrl = `${alphaTenant.origin}/auth/github/room-token`;
    const injectRefusal = () =>
      app.inject({
        method: 'POST',
        url: '/auth/github/room-token',
        headers: {
          host: alphaTenant.host,
          authorization: nip98AuthHeader(
            requester.secretKey,
            requester.publicKey,
            tokenUrl,
            'POST',
          ),
        },
        payload: {
          pubkey: requester.publicKey,
          room_id: 'room-pending',
          relay_authorizations: Array.from({ length: 16 }, () =>
            nip98AuthHeader(
              requester.secretKey,
              requester.publicKey,
              `${alphaTenant.origin}/query`,
              'POST',
            ),
          ),
        },
      });
    expect((await injectRefusal()).statusCode).toBe(403);

    // The repository OWNER installs the App on their own account later. The
    // installation webhook records coverage under the community...
    await store.saveGitHubInstallation(
      {
        community: alphaTenant.community,
        pubkey: owner.publicKey,
        authorizedSubject: 'owner-subject',
        accountId: '123',
        accountLogin: 'octocat',
        accountType: 'User',
        installationId: 77,
        repositorySelection: 'all',
        status: 'active',
        repositoryCount: 0,
      },
      new Date(),
    );
    const addedPayload = JSON.stringify({
      action: 'added',
      installation: { id: 77 },
      repositories_added: [
        {
          id: 42,
          name: 'widget',
          full_name: 'octocat/widget',
          clone_url: 'https://github.com/octocat/widget.git',
          default_branch: 'main',
        },
      ],
      repositories_removed: [],
    });
    const webhook = await app.inject({
      method: 'POST',
      url: '/auth/github/webhook',
      headers: {
        host: alphaTenant.host,
        'content-type': 'application/json',
        'x-github-event': 'installation_repositories',
        'x-github-delivery': 'delivery-grant-1',
        'x-hub-signature-256': `sha256=${createHmac('sha256', 'webhook-secret').update(addedPayload).digest('hex')}`,
      },
      payload: addedPayload,
    });
    expect(webhook.statusCode).toBe(202);

    // ...and the pending link flips active with exactly one feed announcement.
    // A duplicate grant (redelivery or reconcile) is idempotent.
    const announcements = await store.githubRepoEvents('octocat/widget', 0, 100);
    expect(
      announcements.filter((event) => event.eventType === 'beeline_room_link'),
    ).toHaveLength(1);
    expect(announcements.at(-1)).toMatchObject({
      eventType: 'beeline_room_link',
      summary: 'Beeline access granted: octocat/widget is now linked.',
    });
    await store.activateGitHubRoomLinks(alphaTenant.community, ['octocat/widget'], new Date());
    const stillOne = await store.githubRepoEvents('octocat/widget', 0, 100);
    expect(stillOne.filter((event) => event.eventType === 'beeline_room_link')).toHaveLength(1);

    // Once the grant is claimable by the community (the install callback or
    // reconcile records the installation against a linked human — the
    // requester here), the SAME room-token request succeeds with no re-entry.
    await store.saveGitHubInstallation(
      {
        community: alphaTenant.community,
        pubkey: requester.publicKey,
        authorizedSubject: 'owner-subject',
        accountId: '123',
        accountLogin: 'octocat',
        accountType: 'User',
        installationId: 77,
        repositorySelection: 'all',
        status: 'active',
        repositoryCount: 1,
      },
      new Date(),
    );
    await store.replaceGitHubRepositories(
      alphaTenant.community,
      77,
      [
        {
          id: 42,
          installationId: 77,
          name: 'widget',
          fullName: 'octocat/widget',
          remote: 'https://github.com/octocat/widget.git',
          defaultBranch: 'main',
        },
      ],
      new Date(),
    );
    const granted = await injectRefusal();
    expect(granted.statusCode).toBe(200);
    expect(granted.json()).toMatchObject({ full_name: 'octocat/widget' });
  });

  it('does not claim a newly discovered user-owned installation the user cannot administer', async () => {
    const identity = generateKeypair();
    await bindGitHubIdentity(identity, 'u'.repeat(43));
    // The App serves installation 77 elsewhere; this user's listing succeeds
    // but does not include it, so reconciliation must not claim it for them.
    githubAppInstallations = [77];
    githubUserInstallations = [];

    const reposUrl = `https://alpha.example/auth/github/repos/${identity.publicKey}?refresh=1`;
    const response = await app.inject({
      method: 'GET',
      url: `/auth/github/repos/${identity.publicKey}?refresh=1`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, reposUrl, 'GET'),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ installed: false, installations: [], repositories: [] });
    await expect(
      store.githubInstallationsForPubkey(alphaTenant.community, identity.publicKey),
    ).resolves.toEqual([]);
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
        redirect_uri: 'beeline://buzz/github-installation',
      },
    });
    expect(installStart.statusCode).toBe(200);
    const installUrl = new URL(installStart.json().authorization_url);
    const installed = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?installation_id=77&setup_action=install&state=${installUrl.searchParams.get('state')}`,
      headers: { host: alphaTenant.host },
    });
    expect(installed.statusCode).toBe(302);
    expect(installed.headers.location).toBe('beeline://buzz/github-installation?installed=1');

    const manageStartUrl = 'https://alpha.example/auth/github/install/start?intent=manage';
    const manageStart = await app.inject({
      method: 'POST',
      url: '/auth/github/install/start?intent=manage',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          identity.secretKey,
          identity.publicKey,
          manageStartUrl,
          'POST',
        ),
      },
      payload: {
        pubkey: identity.publicKey,
        redirect_uri: 'beeline://buzz/github-installation',
        installation_id: 77,
      },
    });
    expect(manageStart.statusCode).toBe(200);
    const manageUrl = new URL(manageStart.json().authorization_url);
    expect(manageUrl.origin + manageUrl.pathname).toBe(
      'https://github.com/settings/installations/77',
    );
    expect(manageUrl.searchParams.get('state')).toHaveLength(43);

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
      url: `/auth/github/callback?installation_id=78&setup_action=update&state=${secondUrl.searchParams.get('state')}`,
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

    const refreshReposUrl = `${reposUrl}?refresh=1`;
    const refreshedRepos = await app.inject({
      method: 'GET',
      url: `/auth/github/repos/${identity.publicKey}?refresh=1`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          identity.secretKey,
          identity.publicKey,
          refreshReposUrl,
          'GET',
        ),
      },
    });
    expect(refreshedRepos.statusCode).toBe(200);
    expect(refreshedRepos.json().repositories).toHaveLength(2);

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

  async function recover(challenge: BindChallenge, identity: Keypair, confirmReplace: unknown) {
    return app.inject({
      method: 'POST',
      url: '/auth/oidc/recover',
      headers: { host: alphaTenant.host },
      payload: {
        ticket: challenge.ticket,
        event: bindEvent(challenge, identity),
        confirm_replace: confirmReplace,
      },
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
      ['github', 'beeline://buzz/github-callback/'],
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
      ['github', 'beeline://buzz/github-callback//'],
      ['github', 'beeline://buzz/github-callback#evil'],
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

  it('allowlists only the Beeline native scheme', async () => {
    const appState = 's'.repeat(43);
    const pubkey = 'a'.repeat(64);
    for (const scheme of ['beeline']) {
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

      const oidcRedirect = `${scheme}://buzz/oidc-callback`;
      const oidc = await app.inject({
        method: 'GET',
        url: `/auth/oidc/start?app_redirect=${encodeURIComponent(oidcRedirect)}&app_state=${appState}`,
        headers: { host: alphaTenant.host },
      });
      expect(oidc.statusCode, oidcRedirect).toBe(302);
    }

    for (const scheme of ['buzzy', 'buzzy-dev', 'buzzy-preview', 'buzzy-nightly', 'other']) {
      for (const path of ['github-callback', 'github-installation']) {
        const redirectUri = `${scheme}://buzz/${path}`;
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

      const oidcRedirect = `${scheme}://buzz/oidc-callback`;
      const oidc = await app.inject({
        method: 'GET',
        url: `/auth/oidc/start?app_redirect=${encodeURIComponent(oidcRedirect)}&app_state=${appState}`,
        headers: { host: alphaTenant.host },
      });
      expect(oidc.statusCode, oidcRedirect).toBe(400);
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

  it('requires a separate explicit confirmation before OAuth can replace a device key', async () => {
    const original = generateKeypair();
    const originalChallenge = await ceremony();
    expect((await bind(originalChallenge, original)).statusCode).toBe(201);

    const replacement = generateKeypair();
    const recoveryChallenge = await ceremony();
    const conflict = await bind(recoveryChallenge, replacement);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe('identity_conflict');
    const replayedConflict = await bind(recoveryChallenge, replacement);
    expect(replayedConflict.statusCode).toBe(409);
    expect(replayedConflict.json().error).toBe('identity_conflict');

    const wrongKey = generateKeypair();
    const wrongKeyRecovery = await recover(recoveryChallenge, wrongKey, true);
    expect(wrongKeyRecovery.statusCode).toBe(409);
    expect(wrongKeyRecovery.json().error).toBe('ticket_used');
    expect(await store.linksForPubkey(alphaTenant.community, original.publicKey)).toHaveLength(1);
    expect(await store.linksForPubkey(alphaTenant.community, wrongKey.publicKey)).toHaveLength(0);

    const unconfirmed = await recover(recoveryChallenge, replacement, false);
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error).toBe('recovery_confirmation_required');
    expect(await store.linksForPubkey(alphaTenant.community, original.publicKey)).toHaveLength(1);
    expect(await store.linksForPubkey(alphaTenant.community, replacement.publicKey)).toHaveLength(
      0,
    );

    const confirmed = await recover(recoveryChallenge, replacement, true);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toEqual({
      linked: true,
      replaced: true,
      pubkey: replacement.publicKey,
    });
    expect(await store.linksForPubkey(alphaTenant.community, original.publicKey)).toHaveLength(0);
    expect(await store.linksForPubkey(alphaTenant.community, replacement.publicKey)).toHaveLength(
      1,
    );

    const staleSuccessfulTicket = await recover(originalChallenge, original, true);
    expect(staleSuccessfulTicket.statusCode).toBe(409);
    expect(staleSuccessfulTicket.json().error).toBe('recovery_not_available');
    expect(await store.linksForPubkey(alphaTenant.community, original.publicKey)).toHaveLength(0);
    expect(await store.linksForPubkey(alphaTenant.community, replacement.publicKey)).toHaveLength(
      1,
    );

    const laterAttacker = generateKeypair();
    const laterConflict = await bind(await ceremony(), laterAttacker);
    expect(laterConflict.statusCode).toBe(409);
    expect(await store.linksForPubkey(alphaTenant.community, replacement.publicKey)).toHaveLength(
      1,
    );
    expect(await store.linksForPubkey(alphaTenant.community, laterAttacker.publicKey)).toHaveLength(
      0,
    );
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

describe('GitHub repository events in Rooms', () => {
  let provider: DemoOidcProvider;
  let database: PgliteDatabase;
  let store: AuthStore;
  let app: FastifyInstance;
  let roomTokenAuthority: NonNullable<
    Parameters<typeof buildAuthServer>[0]['authorizeGitHubRoomToken']
  >;

  const agent = generateKeypair();
  const ROOM_ID = 'room-1';
  const REPO = 'octocat/widget';

  function webhook(event: string, deliveryId: string, payload: unknown, secret = 'webhook-secret') {
    const body = JSON.stringify(payload);
    return app.inject({
      method: 'POST',
      url: '/auth/github/webhook',
      headers: {
        host: alphaTenant.host,
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      },
      payload: body,
    });
  }

  /** Deliver one of each shipped event type against `octocat/widget`. */
  async function deliverSampleEvents(prefix = 'd'): Promise<void> {
    await webhook(
      'star',
      `${prefix}-star-1`,
      {
        action: 'created',
        starred_at: '2026-01-01T00:00:00Z',
        repository: { id: 42, full_name: REPO },
        sender: { login: 'lena' },
      },
    );
    await webhook(
      'issues',
      `${prefix}-issue-1`,
      {
        action: 'opened',
        issue: { number: 12, title: 'Fix login', html_url: `https://github.com/${REPO}/issues/12`, user: { login: 'lena' } },
        repository: { id: 42, full_name: REPO },
        sender: { login: 'lena' },
      },
    );
    await webhook(
      'pull_request',
      `${prefix}-pr-1`,
      {
        action: 'opened',
        pull_request: { number: 34, title: 'Add dark mode', html_url: `https://github.com/${REPO}/pull/34`, user: { login: 'lena' }, merged: false },
        repository: { id: 42, full_name: REPO },
        sender: { login: 'lena' },
      },
    );
  }

  function roomEventsUrl(): string {
    return `${alphaTenant.origin}/auth/github/room-events`;
  }

  function fetchRoomEvents(
    identity: Keypair,
    options: { since?: number; waitMs?: number } = {},
    roomId = ROOM_ID,
  ) {
    const url = roomEventsUrl();
    return app.inject({
      method: 'POST',
      url: '/auth/github/room-events',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, url, 'POST'),
      },
      payload: {
        pubkey: identity.publicKey,
        room_id: roomId,
        relay_authorizations: Array.from({ length: 16 }, () =>
          nip98AuthHeader(identity.secretKey, identity.publicKey, `${alphaTenant.origin}/query`, 'POST'),
        ),
        ...(options.since !== undefined ? { since: options.since } : {}),
        ...(options.waitMs !== undefined ? { wait_ms: options.waitMs } : {}),
      },
    });
  }

  beforeEach(async () => {
    provider = new DemoOidcProvider();
    await provider.start();
    const pglite = new PGlite();
    await pglite.waitReady;
    database = new PgliteDatabase(pglite);
    store = new AuthStore(database);
    await store.migrate();
    roomTokenAuthority = async () => ({ authorized: false, reason: 'agent_not_room_member' });
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
          authorizationUrl: ({ state, redirectUri }: { state: string; redirectUri: string }) =>
            `https://github.test/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
          exchangeCode: async () => ({
            issuer: 'https://github.com' as const,
            audience: 'github-client',
            subject: '123',
            login: 'octocat',
            accessToken: 'github-user-token',
          }),
        } as unknown as GitHubOAuthClient,
        app: {
          installationToken: async () => ({
            token: 'room-installation-token',
            expiresAt: '2030-01-01T00:00:00Z',
          }),
        } as unknown as GitHubAppClient,
        webhookSecret: 'webhook-secret',
      },
      authorizeGitHubRoomToken: (tenant, input) => roomTokenAuthority(tenant, input),
      tenants: [alphaTenant, betaTenant],
    });
  });

  afterEach(async () => {
    await app.close();
    await database.close();
    await provider.close();
  });

  it('stores a real star, issue, and pull request payload and releases it to an authorized Room', async () => {
    await deliverSampleEvents();
    roomTokenAuthority = async (_tenant, input) =>
      input.agentPubkey === agent.publicKey && input.roomId === ROOM_ID
        ? { authorized: true, authorizedBy: agent.publicKey, fullName: REPO }
        : { authorized: false, reason: 'agent_not_room_member' };

    // Bootstrap read (no cursor): nothing old, just the position to start from.
    const bootstrap = await fetchRoomEvents(agent);
    expect(bootstrap.statusCode).toBe(200);
    const bootstrapped = bootstrap.json();
    expect(bootstrapped.full_name).toBe(REPO);
    expect(bootstrapped.events).toEqual([]);
    expect(bootstrapped.cursor).toBe(bootstrapped.head);
    expect(bootstrapped.head).toBeGreaterThan(0);

    const feed = await fetchRoomEvents(agent, { since: bootstrapped.cursor - 3 });
    expect(feed.statusCode).toBe(200);
    const events = feed.json().events;
    expect(events.map((event: { type: string }) => event.type)).toEqual([
      'star',
      'issues',
      'pull_request',
    ]);
    expect(events[1]).toMatchObject({
      actor: 'lena',
      number: 12,
      title: 'Fix login',
      summary: 'lena opened issue #12 in octocat/widget: Fix login',
    });
    expect(events[2]).toMatchObject({
      actor: 'lena',
      number: 34,
      summary: 'lena opened pull request #34 in octocat/widget: Add dark mode',
    });
    expect(feed.json().cursor).toBe(feed.json().head);
  });

  it('rejects a webhook with an invalid signature before storing anything', async () => {
    const badSignature = await webhook('star', 'sig-star-1', {
      action: 'created',
      repository: { id: 42, full_name: REPO },
      sender: { login: 'lena' },
    }, 'wrong-secret');
    expect(badSignature.statusCode).toBe(401);

    roomTokenAuthority = async () => ({
      authorized: true,
      authorizedBy: agent.publicKey,
      fullName: REPO,
    });
    const bootstrap = await fetchRoomEvents(agent);
    expect(bootstrap.json().head).toBe(0);
  });

  it('collapses a duplicate delivery to one stored event', async () => {
    const payload = {
      action: 'created',
      repository: { id: 42, full_name: REPO },
      sender: { login: 'lena' },
    };
    const first = await webhook('star', 'dup-star-1', payload);
    expect(first.json()).toMatchObject({ accepted: true });
    const duplicate = await webhook('star', 'dup-star-1', payload);
    expect(duplicate.json()).toMatchObject({ accepted: true, duplicate: true });

    roomTokenAuthority = async () => ({
      authorized: true,
      authorizedBy: agent.publicKey,
      fullName: REPO,
    });
    const feed = await fetchRoomEvents(agent, { since: 0 });
    expect(feed.json().events).toHaveLength(1);
  });

  it('stays silent on unreported actions and unrelated event types', async () => {
    // A `labeled` issue action is churn, never a Room notice.
    await webhook('issues', 'noise-issue-labeled', {
      action: 'labeled',
      issue: { number: 12, title: 'Fix login', user: { login: 'lena' } },
      repository: { id: 42, full_name: REPO },
      sender: { login: 'lena' },
    });
    // Deploy status is out of scope entirely.
    await webhook('deployment_status', 'noise-deploy', {
      action: 'created',
      repository: { id: 42, full_name: REPO },
      sender: { login: 'lena' },
    });

    roomTokenAuthority = async () => ({
      authorized: true,
      authorizedBy: agent.publicKey,
      fullName: REPO,
    });
    const bootstrap = await fetchRoomEvents(agent);
    expect(bootstrap.json().head).toBe(0);
  });

  it('refuses a daemon that is not a member of a Room bound to the repo', async () => {
    await deliverSampleEvents();
    roomTokenAuthority = async (_tenant, input) =>
      input.agentPubkey === agent.publicKey && input.roomId === ROOM_ID
        ? { authorized: true, authorizedBy: agent.publicKey, fullName: REPO }
        : { authorized: false, reason: 'agent_not_room_member' };

    const stranger = generateKeypair();
    const refused = await fetchRoomEvents(stranger, { since: 0 }, 'some-other-room');
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({
      error: 'room_membership_required',
      message: 'agent is not a member of this Room',
    });

    // And a Room bound to a DIFFERENT repo reads that repo's feed, not ours.
    roomTokenAuthority = async (_tenant, input) => ({
      authorized: input.agentPubkey === agent.publicKey && input.roomId === 'other-room',
      authorizedBy: agent.publicKey,
      fullName: 'acme/other',
      ...(input.agentPubkey === agent.publicKey && input.roomId === 'other-room'
        ? {}
        : { reason: 'room_repository_missing' as const }),
    });
    const otherRoom = await fetchRoomEvents(agent, { since: 0 }, 'other-room');
    expect(otherRoom.statusCode).toBe(200);
    expect(otherRoom.json().full_name).toBe('acme/other');
    expect(otherRoom.json().events).toEqual([]);
    expect(otherRoom.json().head).toBe(0); // never leaks widget's activity
  });

  it('releases events late to a daemon whose cursor predates the outage window', async () => {
    await deliverSampleEvents('early');
    roomTokenAuthority = async () => ({
      authorized: true,
      authorizedBy: agent.publicKey,
      fullName: REPO,
    });
    const first = await fetchRoomEvents(agent, { since: 0 });
    const cursorAfterEarly = first.json().cursor;

    // The daemon goes offline; more activity lands while it is away.
    await deliverSampleEvents('late');

    // Back online: catches up from its persisted cursor.
    const catchUp = await fetchRoomEvents(agent, { since: cursorAfterEarly });
    expect(catchUp.statusCode).toBe(200);
    const caught = catchUp.json();
    expect(caught.events).toHaveLength(3);
    // Only NEW events (ids past the persisted cursor), never a replay.
    for (const event of caught.events) {
      expect(event.id).toBeGreaterThan(cursorAfterEarly);
    }
  });
});

describe('GitHub App manifest setup + drift endpoints', () => {
  let provider: DemoOidcProvider;
  let database: PgliteDatabase;
  let store: AuthStore;
  let app: FastifyInstance;
  let liveApp:
    | { slug: string; events?: unknown; permissions?: unknown }
    | Error;
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
    expect(manifest.default_events).toEqual(['star', 'issues', 'pull_request']);
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
      vi.fn(async () =>
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
    expect(body.drift?.missingEvents).toEqual(['star', 'issues', 'pull_request']);
    expect(logLines.filter((line) => line.includes('/permissions'))).toHaveLength(1);
  });
});
