import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { PGlite, type PGliteInterface, type Transaction } from '@electric-sql/pglite';
import { generateKeypair, nip98AuthHeader, signEvent, type Keypair } from '@beeline/nostr';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OidcClient } from './oidc.js';
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
        ['ticket', challenge.ticket],
        ['challenge', challenge.challenge],
        ['provider', challenge.provider],
        ['audience', challenge.audience],
        ['subject', challenge.subject],
        ['community', challenge.community],
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

  async function ceremony(tenant = alphaTenant): Promise<BindChallenge> {
    const start = await app.inject({
      method: 'GET',
      url: '/auth/oidc/start',
      headers: { host: tenant.host },
    });
    expect(start.statusCode).toBe(302);
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
    expect(replayedBind.statusCode).toBe(409);
    expect(replayedBind.json().error).toBe('ticket_used');
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
