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
  it('does not reflect unknown Host or forwarded headers into discovery', async () => {
    const response = await get('/join', 'attacker.example', { accept: 'text/event-stream', 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'https' });
    expect(response.headers['www-authenticate']).toContain(origin + '/.well-known/oauth-protected-resource/join');
    const metadata = await get('/.well-known/oauth-protected-resource/join', 'attacker.example');
    expect(JSON.parse(metadata.body).resource).toBe(origin + '/join');
    expect((await get('/', 'attacker.example')).status).toBe(404);
  });
});
