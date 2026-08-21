import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { QueryResultRow } from 'pg';
import { OidcClient } from '../src/oidc.js';
import { buildAuthServer } from '../src/server.js';
import {
  AuthStore,
  type SqlExecutor,
  type SqlResult,
  type TransactionalDatabase,
} from '../src/store.js';

class MemoryDatabase implements TransactionalDatabase {
  constructor(private readonly client: PGlite) {}
  async query<Row extends QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<SqlResult<Row>> {
    const result = await this.client.query<Row>(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }
  async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    return this.client.transaction(async (transaction: Transaction) =>
      work({
        query: async <Row extends QueryResultRow>(sql: string, values: unknown[] = []) => {
          const result = await transaction.query<Row>(sql, values);
          return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
        },
      }),
    );
  }
  async close(): Promise<void> {
    await this.client.close();
  }
}

const clientId = 'beeline-device-emulator';
const clientSecret = 'emulator-only';
const issuer = 'http://127.0.0.1:8790/issuer';
const codes = new Map<string, { challenge: string; nonce: string; redirect: string }>();
const pair = await generateKeyPair('RS256');
const jwk = {
  ...(await exportJWK(pair.publicKey)),
  kid: 'device-emulator',
  alg: 'RS256',
  use: 'sig',
};
let nextCode = 0;

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function provider(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1:8790');
  if (request.method === 'GET' && url.pathname === '/authorize') {
    const state = url.searchParams.get('state');
    const nonce = url.searchParams.get('nonce');
    const challenge = url.searchParams.get('code_challenge');
    const redirect = url.searchParams.get('redirect_uri');
    if (!state || !nonce || !challenge || !redirect)
      return json(response, 400, { error: 'invalid_request' });
    const code = `device-code-${++nextCode}`;
    codes.set(code, { challenge, nonce, redirect });
    const callback = new URL(redirect);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', state);
    response.writeHead(302, { location: callback.toString() });
    response.end();
    return;
  }
  if (request.method === 'GET' && url.pathname === '/jwks')
    return json(response, 200, { keys: [jwk] });
  if (request.method === 'POST' && url.pathname === '/token') {
    const chunks: Buffer[] = [];
    for await (const chunk of request)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const record = codes.get(body.get('code') ?? '');
    if (!record) return json(response, 400, { error: 'invalid_grant' });
    const actual = createHash('sha256')
      .update(body.get('code_verifier') ?? '')
      .digest('base64url');
    if (actual !== record.challenge || body.get('redirect_uri') !== record.redirect) {
      return json(response, 400, { error: 'invalid_request' });
    }
    codes.delete(body.get('code')!);
    const now = Math.floor(Date.now() / 1_000);
    const token = await new SignJWT({ nonce: record.nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'device-emulator', typ: 'JWT' })
      .setIssuer(issuer)
      .setAudience(clientId)
      .setSubject('emulated-google-user')
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(pair.privateKey);
    return json(response, 200, { token_type: 'Bearer', id_token: token });
  }
  json(response, 404, { error: 'not_found' });
}

const providerServer = createServer((request, response) => void provider(request, response));
await new Promise<void>((resolve) => providerServer.listen(8790, '0.0.0.0', resolve));
const pglite = new PGlite();
await pglite.waitReady;
const database = new MemoryDatabase(pglite);
const store = new AuthStore(database);
await store.migrate();
const app = buildAuthServer({
  store,
  oidc: new OidcClient({
    issuer,
    authorizationEndpoint: 'http://127.0.0.1:8790/authorize',
    tokenEndpoint: 'http://127.0.0.1:8790/token',
    jwksUri: 'http://127.0.0.1:8790/jwks',
    clientId,
    clientSecret,
    allowInsecure: true,
  }),
  tenants: [
    {
      host: '127.0.0.1:8789',
      community: 'emulated-workspace',
      roomCommunityIds: ['emulated-workspace'],
      origin: 'http://127.0.0.1:8789',
    },
  ],
  nativeRedirectUris: ['beeline://buzz/oidc-callback'],
  logger: true,
  secureCookies: false,
});
await app.listen({ port: 8789, host: '0.0.0.0' });
console.log('[device-emulator] OIDC :8790, auth :8789');

const shutdown = async () => {
  await app.close();
  await database.close();
  await new Promise<void>((resolve) => providerServer.close(() => resolve()));
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
