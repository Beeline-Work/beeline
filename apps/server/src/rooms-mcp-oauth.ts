import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqlDatabase } from './database.js';
import type { TokenAuth } from './auth.js';
import { tokenHash } from './auth.js';

export const MCP_READ = 'rooms:read';
export const MCP_WRITE = 'rooms:write';
const opaque = () => randomBytes(32).toString('base64url');
const escape = (text: string) => text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
export function mcpJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
export async function mcpBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 32_768) throw new Error('invalid_request');
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (request.headers['content-type']?.split(';')[0] === 'application/x-www-form-urlencoded') {
    const params = new URLSearchParams(raw);
    if ([...params.keys()].some(key => params.getAll(key).length !== 1)) throw new Error('invalid_request');
    return Object.fromEntries(params);
  }
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_request');
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || !value || value.length > max) throw new Error('invalid_request');
  return value;
}
function redirectUri(value: unknown): string {
  const raw = string(value);
  const url = new URL(raw);
  if (url.hash || url.username || url.password ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))))
    throw new Error('invalid_redirect_uri');
  return raw;
}
interface Flow {
  id: string; browser_hash: string; client_id: string; redirect_uri: string; state: string;
  challenge: string; scope: string; identity_id: string | null; provider: string | null;
  name: string; identity_name: string | null;
}
export interface McpPrincipal { hash: string; client_id: string; identity_id: string; scope: string }

export class RoomsMcpOAuth {
  readonly origin: string;
  readonly resource: string;
  constructor(readonly database: SqlDatabase, origin: string, readonly auth: TokenAuth) {
    this.origin = new URL(origin).origin;
    this.resource = `${this.origin}/mcp`;
  }
  private cookie(request: IncomingMessage): string {
    return (request.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith('beeline_mcp='))?.slice(12) ?? '';
  }
  private page(response: ServerResponse, title: string, content: string): void {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
    });
    response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Beeline</title><style>body{margin:0;background:#14091a;color:#f0f0f3;font:16px/1.5 system-ui}main{max-width:32rem;margin:10vh auto;padding:24px}h1{font-size:26px}p{color:#c9c9d1}a{color:#e5a645}button{font:inherit;padding:12px 20px;margin:12px 12px 0 0;border:1px solid #b08a4a;border-radius:3px;background:#e5a645;color:#14091a;cursor:pointer}button[value=deny]{background:transparent;color:#f0f0f3}a:focus-visible,button:focus-visible{outline:3px solid #f0f0f3;outline-offset:4px}small{color:#c9c9d1}</style><main><small>BEELINE ROOMS</small><h1>${escape(title)}</h1>${content}</main></html>`);
  }
  private redirect(response: ServerResponse, location: string): void {
    response.writeHead(302, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); response.end();
  }
  private async flow(id: unknown, request: IncomingMessage, db = this.database): Promise<Flow> {
    const result = await db.query<Flow>(`SELECT f.*,c.name,i.name identity_name FROM rooms_mcp_flows f
      JOIN rooms_mcp_clients c ON c.id=f.client_id LEFT JOIN identities i ON i.id=f.identity_id
      WHERE f.id=$1 AND f.browser_hash=$2 AND f.expires_at>now() FOR UPDATE OF f`,
      [string(id, 100), tokenHash(this.cookie(request))]);
    if (!result.rows[0]) throw new Error('invalid_request');
    return result.rows[0];
  }
  async audit(principal: McpPrincipal, operation: string, outcome: string): Promise<void> {
    await this.database.query(`INSERT INTO rooms_mcp_audit(client_id,identity_id,operation,outcome) VALUES($1,$2,$3,$4)`,
      [principal.client_id, principal.identity_id, operation.slice(0, 100), outcome]);
  }
  async principal(raw: string): Promise<McpPrincipal | undefined> {
    return (await this.database.query<McpPrincipal>(`SELECT t.hash,t.client_id,t.identity_id,t.scope FROM rooms_mcp_tokens t
      JOIN identities i ON i.id=t.identity_id AND i.kind='human'
      WHERE t.hash=$1 AND t.revoked_at IS NULL AND t.expires_at>now()`, [tokenHash(raw)])).rows[0];
  }
  async take(principal: McpPrincipal): Promise<boolean> {
    const result = await this.database.query(`UPDATE rooms_mcp_tokens SET
      calls=CASE WHEN window_at<=now()-interval '1 minute' THEN 1 ELSE calls+1 END,
      window_at=CASE WHEN window_at<=now()-interval '1 minute' THEN now() ELSE window_at END
      WHERE hash=$1 AND revoked_at IS NULL AND expires_at>now()
        AND (window_at<=now()-interval '1 minute' OR calls<60) RETURNING hash`, [principal.hash]);
    return result.rowCount > 0;
  }
  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    if (!path.startsWith('/mcp/oauth/') && path !== '/.well-known/oauth-authorization-server' &&
        path !== '/.well-known/oauth-protected-resource/mcp') return false;
    response.setHeader('access-control-allow-origin', '*');
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization' });
      response.end(); return true;
    }
    try {
      if (request.method === 'GET' && path === '/.well-known/oauth-protected-resource/mcp') {
        mcpJson(response, 200, { resource: this.resource, authorization_servers: [this.origin], scopes_supported: [MCP_READ, MCP_WRITE], bearer_methods_supported: ['header'] }); return true;
      }
      if (request.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
        mcpJson(response, 200, { issuer: this.origin, authorization_endpoint: `${this.origin}/mcp/oauth/authorize`,
          token_endpoint: `${this.origin}/mcp/oauth/token`, registration_endpoint: `${this.origin}/mcp/oauth/register`,
          revocation_endpoint: `${this.origin}/mcp/oauth/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code'],
          code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
          revocation_endpoint_auth_methods_supported: ['none'], scopes_supported: [MCP_READ, MCP_WRITE], authorization_response_iss_parameter_supported: true }); return true;
      }
      // Shared across server instances; never trust a caller-provided forwarded address.
      const admitted = await this.database.query(`INSERT INTO rooms_mcp_admission(key,calls) VALUES($1,1)
        ON CONFLICT(key) DO UPDATE SET calls=CASE WHEN rooms_mcp_admission.window_at<=now()-interval '1 minute' THEN 1 ELSE rooms_mcp_admission.calls+1 END,
        window_at=CASE WHEN rooms_mcp_admission.window_at<=now()-interval '1 minute' THEN now() ELSE rooms_mcp_admission.window_at END
        WHERE rooms_mcp_admission.window_at<=now()-interval '1 minute' OR rooms_mcp_admission.calls<300 RETURNING key`,
        [tokenHash(request.socket.remoteAddress ?? 'unknown')]);
      if (!admitted.rowCount) { mcpJson(response, 429, { error: 'temporarily_unavailable' }); return true; }
      if (request.method === 'POST' && path === '/mcp/oauth/register') {
        const input = await mcpBody(request);
        const name = input.client_name === undefined ? 'MCP client' : string(input.client_name, 120);
        if (!Array.isArray(input.redirect_uris) || !input.redirect_uris.length || input.redirect_uris.length > 10 ||
            (input.token_endpoint_auth_method !== undefined && input.token_endpoint_auth_method !== 'none') ||
            (input.grant_types !== undefined && JSON.stringify(input.grant_types) !== '["authorization_code"]') ||
            (input.response_types !== undefined && JSON.stringify(input.response_types) !== '["code"]')) throw new Error('invalid_client_metadata');
        const redirects = input.redirect_uris.map(redirectUri);
        const id = opaque();
        await this.database.query('INSERT INTO rooms_mcp_clients(id,name,redirects) VALUES($1,$2,$3::jsonb)', [id, name, JSON.stringify(redirects)]);
        mcpJson(response, 201, { client_id: id, client_name: name, redirect_uris: redirects, token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }); return true;
      }
      if (request.method === 'GET' && path === '/mcp/oauth/authorize') {
        const q = url.searchParams;
        if (url.search.length > 8192 || (q.get('state')?.length ?? 0) > 2048) throw new Error('invalid_request');
        if ([...q.keys()].some(key => q.getAll(key).length !== 1) || q.get('response_type') !== 'code' ||
            q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(q.get('code_challenge') ?? '') || q.get('resource') !== this.resource) throw new Error('invalid_request');
        const client = (await this.database.query<{ redirects: string[] }>('SELECT redirects FROM rooms_mcp_clients WHERE id=$1', [q.get('client_id')])).rows[0];
        if (!client || !client.redirects.includes(q.get('redirect_uri') ?? '')) throw new Error('invalid_request');
        const scopes = [...new Set((q.get('scope') ?? MCP_READ).split(' '))];
        if (!scopes.length || scopes.some(scope => ![MCP_READ, MCP_WRITE].includes(scope))) throw new Error('invalid_scope');
        const id = opaque(), browser = opaque();
        await this.database.query(`INSERT INTO rooms_mcp_flows(id,browser_hash,client_id,redirect_uri,state,challenge,scope,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '10 minutes')`,
          [id, tokenHash(browser), q.get('client_id'), q.get('redirect_uri'), q.get('state') ?? '', q.get('code_challenge'), scopes.join(' ')]);
        response.setHeader('set-cookie', `beeline_mcp=${browser}; Path=/mcp/oauth; HttpOnly; SameSite=Lax; Max-Age=600${this.origin.startsWith('https:') ? '; Secure' : ''}`);
        this.redirect(response, `/mcp/oauth/consent?flow=${id}`); return true;
      }
      if (request.method === 'GET' && path === '/mcp/oauth/login') {
        const flow = await this.flow(url.searchParams.get('flow'), request);
        const provider = url.searchParams.get('provider');
        if (!['google', 'github'].includes(provider ?? '')) throw new Error('invalid_request');
        await this.database.query('UPDATE rooms_mcp_flows SET provider=$2,identity_id=NULL WHERE id=$1', [flow.id, provider]);
        const target = new URL(provider === 'google' ? '/auth/oidc/start' : '/auth/github/start', this.origin);
        target.searchParams.set('app_redirect', `${this.origin}/mcp/oauth/callback/${provider}`);
        target.searchParams.set('app_state', flow.id);
        this.redirect(response, target.toString()); return true;
      }
      if (request.method === 'GET' && /^\/mcp\/oauth\/callback\/(google|github)$/.test(path)) {
        const flow = await this.flow(url.searchParams.get('state'), request);
        if (flow.provider !== path.split('/').at(-1) || flow.identity_id) throw new Error('invalid_request');
        const ticket = string(url.searchParams.get('ticket'), 100);
        const tokens = flow.provider === 'google' ? await this.auth.exchangeGoogleOidc(ticket) : await this.auth.exchangeGitHubOidc(ticket);
        // Sign-in establishes identity, but no phone credentials reach the external client or browser.
        await this.auth.revokePhoneSession(tokens.refreshToken);
        await this.database.query('UPDATE rooms_mcp_flows SET identity_id=$2 WHERE id=$1 AND expires_at>now()', [flow.id, tokens.identityId]);
        this.redirect(response, `/mcp/oauth/consent?flow=${flow.id}`); return true;
      }
      if (request.method === 'GET' && path === '/mcp/oauth/consent') {
        const flow = await this.flow(url.searchParams.get('flow'), request);
        if (!flow.identity_id) this.page(response, 'Connect your Rooms', `<p>Sign in to Beeline to review access for <strong>${escape(flow.name)}</strong>.</p><p><a href="/mcp/oauth/login?flow=${flow.id}&amp;provider=google">Continue with Google</a></p><p><a href="/mcp/oauth/login?flow=${flow.id}&amp;provider=github">Continue with GitHub</a></p>`);
        else this.page(response, `Allow ${flow.name}?`, `<p>Signed in as <strong>${escape(flow.identity_name ?? 'Beeline user')}</strong>.</p><p>This client will be able to:</p><ul>${flow.scope.includes(MCP_READ) ? '<li>Read and search messages and view corners in Rooms you belong to.</li>' : ''}${flow.scope.includes(MCP_WRITE) ? '<li>Post messages as you, including instructions that wake your agents.</li>' : ''}</ul><p>Room content will be shared with this client and its AI providers. Only connect clients you trust. Access expires after one hour. Contact support to revoke it sooner.</p><form method="post" action="/mcp/oauth/consent"><input type="hidden" name="flow" value="${flow.id}"><button name="decision" value="allow">Allow access</button><button name="decision" value="deny">Cancel</button></form><p><a href="https://usebeeline.app/privacy/">Privacy</a> · <a href="mailto:hello@usebeeline.app">Support</a></p>`);
        return true;
      }
      if (request.method === 'POST' && path === '/mcp/oauth/consent') {
        if (request.headers.origin !== this.origin) throw new Error('invalid_request');
        const input = await mcpBody(request);
        const target = await this.database.transaction(async db => {
          const flow = await this.flow(input.flow, request, db);
          if (!flow.identity_id || !['allow', 'deny'].includes(String(input.decision))) throw new Error('invalid_request');
          const target = new URL(flow.redirect_uri);
          target.searchParams.set('state', flow.state); target.searchParams.set('iss', this.origin);
          if (input.decision === 'allow') {
            const code = opaque();
            await db.query(`INSERT INTO rooms_mcp_codes(hash,client_id,identity_id,redirect_uri,challenge,scope,expires_at)
              VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 minute')`, [tokenHash(code), flow.client_id, flow.identity_id, flow.redirect_uri, flow.challenge, flow.scope]);
            target.searchParams.set('code', code);
          } else target.searchParams.set('error', 'access_denied');
          await db.query('DELETE FROM rooms_mcp_flows WHERE id=$1', [flow.id]);
          return target.toString();
        });
        this.redirect(response, target); return true;
      }
      if (request.method === 'POST' && path === '/mcp/oauth/token') {
        const input = await mcpBody(request);
        if (input.grant_type !== 'authorization_code' || input.resource !== this.resource ||
            typeof input.code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier)) throw new Error('invalid_grant');
        const challenge = createHash('sha256').update(input.code_verifier).digest('base64url');
        const token = await this.database.transaction(async db => {
          const row = (await db.query<{ identity_id: string; client_id: string; scope: string }>(`DELETE FROM rooms_mcp_codes
            WHERE hash=$1 AND client_id=$2 AND redirect_uri=$3 AND challenge=$4 AND expires_at>now() RETURNING identity_id,client_id,scope`,
            [tokenHash(string(input.code, 100)), input.client_id, input.redirect_uri, challenge])).rows[0];
          if (!row) throw new Error('invalid_grant');
          const access = opaque();
          await db.query(`INSERT INTO rooms_mcp_tokens(hash,identity_id,client_id,scope,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')`, [tokenHash(access), row.identity_id, row.client_id, row.scope]);
          return { access_token: access, token_type: 'Bearer', expires_in: 3600, scope: row.scope };
        });
        mcpJson(response, 200, token); return true;
      }
      if (request.method === 'POST' && path === '/mcp/oauth/revoke') {
        const input = await mcpBody(request);
        await this.database.query('UPDATE rooms_mcp_tokens SET revoked_at=now() WHERE hash=$1 AND client_id=$2', [tokenHash(string(input.token, 200)), string(input.client_id, 100)]);
        mcpJson(response, 200, {}); return true;
      }
      mcpJson(response, 404, { error: 'not_found' });
    } catch (error) {
      const known = ['invalid_request', 'invalid_scope', 'invalid_grant', 'invalid_client_metadata', 'invalid_redirect_uri'];
      const message = error instanceof Error && known.includes(error.message) ? error.message : 'invalid_request';
      mcpJson(response, 400, { error: message });
    }
    return true;
  }
}
