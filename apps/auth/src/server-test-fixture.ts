import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { PGlite, type PGliteInterface, type Transaction } from '@electric-sql/pglite';
import { generateKeypair, nip98AuthHeader, signEvent, type Keypair } from '@beeline/nostr';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { afterEach, beforeEach, expect } from 'vitest';
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

export class PgliteDatabase implements TransactionalDatabase {
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

export class DemoOidcProvider {
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

export interface BindChallenge {
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

export const alphaTenant: AuthTenant = {
  host: 'alpha.example',
  community: 'community-alpha',
  roomCommunityIds: ['11111111-1111-4111-8111-111111111111'],
  origin: 'https://alpha.example',
};
export const betaTenant: AuthTenant = {
  host: 'beta.example',
  community: 'community-beta',
  roomCommunityIds: ['22222222-2222-4222-8222-222222222222'],
  origin: 'https://beta.example',
};

export function startCookie(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error('OIDC start response did not set its browser-session cookie');
  return value.split(';', 1)[0]!;
}

export function bindEvent(challenge: BindChallenge, identity: Keypair) {
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

export let provider: DemoOidcProvider;
export let database: PgliteDatabase;
export let store: AuthStore;
export let app: FastifyInstance;
export let githubState = '';

export const state: {
  githubSubject: string;
  githubLogin: string;
  githubDisplayName: string;
  githubUserInstallations: number[] | Error;
  githubAppInstallations: number[] | Error;
  githubAppInstallationDetail:
    | Array<{
        installationId: number;
        accountId: string;
        login: string;
        type: 'User' | 'Organization';
      }>
    | undefined;
  githubAppRepositoryDetail:
    Record<number, Array<{ id: number; name: string; fullName: string }>> | undefined;
  githubInstallationListCalls: number;
  githubRepositoryListError: Error | undefined;
  githubInstallationAccess: boolean | Error;
  githubRepositoryLookup: { id: number; fullName: string } | undefined;
  roomTokenAuthority: NonNullable<
    Parameters<typeof buildAuthServer>[0]['authorizeGitHubRoomToken']
  >;
  roomTokenMint:
    | {
        installationId: number;
        repositoryIds?: readonly number[];
        permissions?: Readonly<Record<string, string>>;
      }
    | undefined;
  logLines: string[];
} = {
  githubSubject: '123',
  githubLogin: 'octocat',
  githubDisplayName: 'The Octocat',
  githubUserInstallations: [],
  githubAppInstallations: [],
  githubAppInstallationDetail: undefined,
  githubAppRepositoryDetail: undefined,
  githubInstallationListCalls: 0,
  githubRepositoryListError: undefined,
  githubInstallationAccess: true,
  githubRepositoryLookup: undefined,
  roomTokenAuthority: async () => ({ authorized: false, reason: 'agent_not_room_member' }),
  roomTokenMint: undefined,
  logLines: [],
};

export function useAuthServerFixture(): void {
  beforeEach(async () => {
    provider = new DemoOidcProvider();
    await provider.start();
    const pglite = new PGlite();
    await pglite.waitReady;
    database = new PgliteDatabase(pglite);
    store = new AuthStore(database);
    await store.migrate();
    state.githubSubject = '123';
    state.githubLogin = 'octocat';
    state.githubDisplayName = 'The Octocat';
    state.githubUserInstallations = [];
    state.githubAppInstallations = [];
    state.githubAppInstallationDetail = undefined;
    state.githubAppRepositoryDetail = undefined;
    state.githubInstallationListCalls = 0;
    state.githubRepositoryListError = undefined;
    state.githubInstallationAccess = true;
    state.githubRepositoryLookup = undefined;
    state.roomTokenAuthority = async () => ({
      authorized: false,
      reason: 'agent_not_room_member',
    });
    state.roomTokenMint = undefined;
    state.logLines = [];
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
            subject: state.githubSubject,
            login: state.githubLogin,
            displayName: state.githubDisplayName,
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
            if (state.githubUserInstallations instanceof Error) throw state.githubUserInstallations;
            return state.githubUserInstallations;
          },
          // The App JWT enumeration the server-side reconcile relies on.
          listInstallations: async () => {
            state.githubInstallationListCalls += 1;
            if (state.githubAppInstallations instanceof Error) throw state.githubAppInstallations;
            if (state.githubAppInstallationDetail) {
              return state.githubAppInstallationDetail.map(
                ({ installationId, accountId, login, type }) => ({
                  installationId,
                  account: {
                    id: accountId,
                    login,
                    type,
                    repositorySelection: 'all' as const,
                  },
                }),
              );
            }
            return state.githubAppInstallations.map((installationId) => ({
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
            if (state.githubInstallationAccess instanceof Error)
              throw state.githubInstallationAccess;
            return state.githubInstallationAccess;
          },
          repositoryByFullName: async () => state.githubRepositoryLookup,
          listRepositories: async (installationId: number) => {
            if (state.githubRepositoryListError) throw state.githubRepositoryListError;
            if (state.githubAppRepositoryDetail) {
              return (state.githubAppRepositoryDetail[installationId] ?? []).map((repo) => ({
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
            state.roomTokenMint = { installationId, ...options };
            return { token: 'room-installation-token', expiresAt: '2030-01-01T00:00:00Z' };
          },
        } as unknown as GitHubAppClient,
        webhookSecret: 'webhook-secret',
      },
      tenants: [alphaTenant, betaTenant],
      authorizeGitHubRoomToken: (tenant, input) => state.roomTokenAuthority(tenant, input),
      logger: {
        level: 'warn',
        stream: { write: (line: string) => state.logLines.push(line) },
      },
      nativeRedirectUris: ['beeline://buzz/oidc-callback'],
    });
  });

  afterEach(async () => {
    await app.close();
    await database.close();
    await provider.close();
  });
}

export async function ceremony(tenant = alphaTenant): Promise<BindChallenge> {
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

export async function bindGitHubIdentity(
  identity: Keypair,
  appState: string,
): Promise<Record<string, unknown>> {
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
  return bound.json<Record<string, unknown>>();
}
