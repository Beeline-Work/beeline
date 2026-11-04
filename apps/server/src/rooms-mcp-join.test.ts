import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { RoomsMcp } from './rooms-mcp.js';
import { RoomsMcpOAuth } from './rooms-mcp-oauth.js';
import type { SqlDatabase } from './database.js';
import type { TokenAuth } from './auth.js';
import type { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';

describe('unified join HTTP negotiation and OAuth discovery', () => {
  let origin: string;
  let mcp: RoomsMcp;
  const server = createServer((req, res) => {
    void mcp.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // These public paths must not need a database, identity or auth credentials.
    mcp = new RoomsMcp(new RoomsMcpOAuth({} as SqlDatabase, origin, {} as TokenAuth), {} as PhoneService, new LiveHub());
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  async function get(path: string, host = new URL(origin).host, headers: Record<string, string> = {}, method = 'GET') {
    return new Promise<{ status: number; headers: Record<string, any>; body: string }>((resolve, reject) => {
      const req = httpRequest(origin + path, { method, headers: { host, ...headers } }, res => {
        let body = ''; res.on('data', chunk => body += String(chunk));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      });
      req.on('error', reject); req.end();
    });
  }
  for (const host of ['server', 'short']) {
    for (const path of ['/', '/join', '/mcp']) {
      it(`${host}${path} negotiates the page, challenge and exact resource`, async () => {
        const authority = host === 'short' ? `join.usebeeline.app:${new URL(origin).port}` : new URL(origin).host;
        const base = host === 'short' ? `http://${authority}` : origin;
        const plain = await get(path, authority);
        if (host === 'server' && path === '/') { expect(plain.status).toBe(404); return; }
        expect(plain.status).toBe(path === '/mcp' ? 401 : 200);
        if (path !== '/mcp') {
          expect(plain.headers['content-type']).toContain('text/html');
          expect(plain.body).toBe(readFileSync(new URL('../../../web/room/index.html', import.meta.url), 'utf8'));
          expect(plain.body).toContain('claude mcp add --transport http beeline https://join.usebeeline.app');
          expect(plain.body).toContain('codex mcp add beeline --url https://join.usebeeline.app');
        }
        for (const [method, headers] of [
          ['POST', { 'content-type': 'application/json' }],
          ['GET', { accept: 'application/json' }],
          ['GET', { accept: 'Application/JSON; charset=utf-8' }],
          ['GET', { accept: 'text/event-stream' }],
          ['GET', { authorization: 'Basic invalid' }],
          ['GET', { 'mcp-protocol-version': '2025-03-26' }],
          ['GET', { 'mcp-session-id': 'session' }],
        ] as const) {
          const response = await get(path, authority, headers, method);
          expect(response.status).toBe(401);
          const metadata = /resource_metadata="([^"]+)"/.exec(response.headers['www-authenticate'])![1]!;
          const expectedPath = '/.well-known/oauth-protected-resource' + (path === '/' ? '' : path);
          expect(metadata).toBe(base + expectedPath);
          const resource = await get(expectedPath, authority);
          expect(JSON.parse(resource.body)).toMatchObject({ resource: base + path, authorization_servers: [origin] });
          const issuer = await get('/.well-known/oauth-authorization-server', authority);
          expect(JSON.parse(issuer.body)).toMatchObject({ issuer: origin, authorization_endpoint: origin + '/mcp/oauth/authorize' });
        }
        expect((await get(path, authority, {}, 'OPTIONS')).status).toBe(204);
      });
    }
  }
  it.each(['server', 'short'])('%s member stream keeps bearer discovery instead of serving the join page', async host => {
    const authority = host === 'short' ? `join.usebeeline.app:${new URL(origin).port}` : new URL(origin).host;
    for (const headers of [{}, { accept: 'text/event-stream' }]) {
      const response = await get('/mcp/member-stream', authority, headers);
      expect(response.status).toBe(401);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.headers['www-authenticate']).toContain(`${origin}/.well-known/oauth-protected-resource/mcp`);
      expect(JSON.parse(response.body)).toEqual({ error: 'invalid_token' });
    }
  });
  it('does not reflect unknown Host or forwarded headers into discovery', async () => {
    const response = await get('/join', 'attacker.example', { accept: 'text/event-stream', 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'https' });
    expect(response.headers['www-authenticate']).toContain(origin + '/.well-known/oauth-protected-resource/join');
    const metadata = await get('/.well-known/oauth-protected-resource/join', 'attacker.example');
    expect(JSON.parse(metadata.body).resource).toBe(origin + '/join');
    expect((await get('/', 'attacker.example')).status).toBe(404);
  });
});

describe('hosted Claude connector discovery through the MCP SDK', () => {
  let db: PgliteDatabase;
  let origin: string;
  let short: string;
  let mcp: RoomsMcp;
  const server = createServer((req, res) => {
    void mcp.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  beforeAll(async () => {
    db = new PgliteDatabase(); await migrate(db);
    // Listen on both loopback families so the issuer and localhost alias can differ.
    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    origin = `http://127.0.0.1:${port}`;
    short = `http://localhost:${port}`;
    mcp = new RoomsMcp(new RoomsMcpOAuth(db, origin, {} as TokenAuth, 'localhost'), {} as PhoneService, new LiveHub());
  }, 60_000);
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
  });
  for (const path of ['', '/', '/mcp']) {
    it.each(['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'])(
      `discovers ${path || '(bare origin)'}, registers %s and reaches sign-in`, async redirectUri => {
        let registration: OAuthClientInformationFull | undefined;
        let authorization: URL | undefined;
        let verifier: string | undefined;
        const provider: OAuthClientProvider = {
          redirectUrl: redirectUri,
          clientMetadata: { client_name: 'Claude', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
          clientInformation: () => registration,
          saveClientInformation: value => { registration = value; },
          tokens: () => undefined,
          saveTokens: () => { throw new Error('No account sign-in in this proof'); },
          codeVerifier: () => verifier!,
          saveCodeVerifier: value => { verifier = value; },
          state: () => 'hosted-claude-proof',
          redirectToAuthorization: value => { authorization = value; },
        };
        const client = new Client({ name: 'claude-ai', version: '1' });
        try {
          await expect(client.connect(new StreamableHTTPClientTransport(new URL(short + path), { authProvider: provider })))
            .rejects.toBeInstanceOf(UnauthorizedError);
          expect(registration).toMatchObject({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' });
          expect(registration?.client_secret).toBeUndefined();
          const target = authorization!;
          expect(target.origin).toBe(origin);
          expect(target.pathname).toBe('/mcp/oauth/authorize');
          expect(target.searchParams.get('resource')).toBe(new URL(short + path).href);
          expect(target.searchParams.get('code_challenge_method')).toBe('S256');
          expect(target.searchParams.get('redirect_uri')).toBe(redirectUri);
          const start = await fetch(target, { redirect: 'manual' });
          expect(start.status).toBe(302);
          const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
          const page = await fetch(new URL(start.headers.get('location')!, origin), { headers: { cookie } });
          expect(page.status).toBe(200);
          const html = await page.text();
          expect(html).toContain('Continue with Google');
          expect(html).toContain('Continue with GitHub');
        } finally { await client.close(); }
      });
  }
});
