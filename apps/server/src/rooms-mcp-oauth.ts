import { readFileSync } from 'node:fs';
import { fetchMcpLogo, bundledMcpLogo } from './rooms-mcp-logos.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqlDatabase } from './database.js';
import type { TokenAuth } from './auth.js';
import { tokenHash } from './auth.js';
import { connectMcp, refreshMcp } from './rooms-mcp-connections.js';
import { ensureMcpMember, mcpMemberId, setMcpMemberProfile } from './rooms-mcp-members.js';
import { agentHandleFromName } from '@beeline/api-contract/phone';

export const MCP_READ = 'rooms:read';
export const MCP_WRITE = 'rooms:write';
const opaque = () => randomBytes(32).toString('base64url');
const escape = (text: string) => text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
// The real Beeline app icon, inline because the page CSP allows only data images.
const BEELINE_ICON = `data:image/svg+xml;base64,${readFileSync(new URL('../assets/mcp/beeline.svg', import.meta.url)).toString('base64')}`;
/** DESIGN.md Bone, and Obsidian when the device is dark; type, spacing and buttons follow the app. */
const PAGE_STYLE = `@font-face{font-family:SG;src:url('/mcp/oauth/SpaceGrotesk-Regular.ttf')}@font-face{font-family:SG;src:url('/mcp/oauth/SpaceGrotesk-Medium.ttf');font-weight:500}@font-face{font-family:SG;src:url('/mcp/oauth/SpaceGrotesk-SemiBold.ttf');font-weight:600}
:root{--canvas:#F3EEE4;--raised:#ECE4D5;--border:#DED2BC;--strong:#C9BBA0;--t1:#171310;--t2:#4A4038;--quiet:#6F6455;--muted:#8B7F6E;--brass:#8a6323;--fill:#1C1712;--fillText:#F3EDE3}
@media (prefers-color-scheme:dark){:root{--canvas:#14091A;--raised:#190e21;--border:#291e33;--strong:#3b3048;--t1:#f0f0f3;--t2:#c9c9d1;--quiet:#90909B;--muted:#83838d;--brass:#b08a4a;--fill:#F3EDE3;--fillText:#1C1712}}
*{box-sizing:border-box}html{background:var(--canvas)}body{margin:0;background:var(--canvas);color:var(--t1);font:16px/23px SG,system-ui,sans-serif}
main{display:flex;flex-direction:column;min-height:100vh;max-width:440px;margin:0 auto;padding:48px 24px 32px}
a{color:var(--brass);text-decoration:none}a:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid var(--brass);outline-offset:3px}
.brand{display:flex;align-items:center;gap:16px;margin-bottom:32px}
.mark{width:48px;height:48px;border-radius:10px;display:block;border:1px solid var(--border);object-fit:contain}
.mark.client{background:var(--raised);padding:8px}.initial{display:grid;place-items:center;font-weight:500;font-size:22px;color:var(--t1)}
.link{flex:0 0 32px;height:0;border-top:1px dashed var(--strong)}
h1{font-weight:500;font-size:22px;line-height:32px;letter-spacing:-.3px;margin:0 0 8px}
.lede{color:var(--t2);margin:0 0 32px}.lede b,.who b{font-weight:500}.lede b{color:var(--t1)}
.btn{height:44px;border-radius:3px;font:500 16px/23px SG,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;width:100%;border:1px solid var(--strong);background:transparent;color:var(--t1);cursor:pointer;padding:0 16px}
.btn.primary{background:var(--fill);color:var(--fillText);border-color:var(--fill)}
.stack{display:flex;flex-direction:column;gap:8px}.row{display:flex;gap:8px}.row .btn{flex:1}
.meta,.who,.fine{font-size:13px;line-height:19px;color:var(--quiet);margin:0}
.meta{margin-top:16px}.who{margin-bottom:24px}.who b{color:var(--brass)}.fine{margin-bottom:24px}
.head{font-weight:500;font-size:10px;line-height:15px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin:0 0 8px}
.joins{display:flex;align-items:center;gap:16px;border:1px solid var(--border);border-radius:3px;padding:12px 16px;margin-bottom:24px}
.plate{width:36px;height:36px;flex:0 0 36px;border-radius:3px;background:var(--raised);padding:6px;object-fit:contain}
span.plate{display:grid;place-items:center;padding:0;font-weight:500}
.joins .who-am{flex:1;min-width:0}.joins .name{font-weight:500;overflow-wrap:anywhere}.joins .tag{font-size:13px;line-height:19px;color:var(--quiet);overflow-wrap:anywhere}
.edit{font-size:13px;line-height:19px;display:flex;align-items:center;min-height:44px}
.perms{border-top:1px solid var(--border);margin-bottom:24px}.perm{padding:16px 0;border-bottom:1px solid var(--border)}
.perm strong{display:block;font-weight:500}.perm span{font-size:13px;line-height:19px;color:var(--quiet)}
label{display:block;font-weight:500;margin-bottom:8px}.field{margin-bottom:24px}.field p{font-size:13px;line-height:19px;color:var(--quiet);margin:8px 0 0}
input{width:100%;height:44px;font:16px SG,system-ui,sans-serif;padding:0 12px;border:1px solid var(--strong);border-radius:3px;background:var(--raised);color:var(--t1)}
.foot{margin:auto 0 0;padding-top:24px;display:flex;justify-content:center;gap:16px;font-size:13px;line-height:19px}`;
/** Whose privacy terms cover Room text a known client reads. */
const PUBLISHERS: Record<string, string> = { 'meta muse': 'Meta', muse: 'Meta', grok: 'xAI', 'grok bot': 'xAI', chatgpt: 'OpenAI', claude: 'Anthropic' };
export function mcpJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
export async function mcpBody(request: IncomingMessage, maxBytes = 32_768): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > maxBytes) throw new Error('invalid_request');
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
const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'];
// Schemes a browser runs or reads locally instead of handing to an app.
const BLOCKED_SCHEMES = ['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:', 'filesystem:', 'ftp:', 'ftps:', 'ws:', 'wss:', 'mailto:', 'tel:', 'intent:'];
function redirectUri(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error('invalid_redirect_uri');
  const raw = value;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('invalid_redirect_uri'); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  // Native apps may use a private-use scheme (RFC 8252 section 7.1); PKCE and the Allow page guard the code.
  const privateUse = !['https:', 'http:', ...BLOCKED_SCHEMES].includes(url.protocol);
  if (raw.includes('#') || url.username || url.password ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback) || privateUse))
    throw new Error('invalid_redirect_uri');
  return raw;
}
/** Non-secret registration metadata, so a refused client can be diagnosed from the log. */
function registrationSummary(input: Record<string, unknown> | undefined) {
  const list = (value: unknown) => Array.isArray(value) ? value.slice(0, 10).map(item => String(item).slice(0, 60)) : value === undefined ? undefined : typeof value;
  const redirects = Array.isArray(input?.redirect_uris) ? input.redirect_uris.slice(0, 10).map(value => {
    try { const url = new URL(String(value)); return url.host ? `${url.protocol}//${url.host}` : url.protocol; } catch { return 'unparseable'; }
  }) : input?.redirect_uris === undefined ? undefined : typeof input.redirect_uris;
  return {
    client_name: typeof input?.client_name === 'string' ? input.client_name.slice(0, 120) : undefined,
    redirect_uris: redirects,
    token_endpoint_auth_method: typeof input?.token_endpoint_auth_method === 'string' ? input.token_endpoint_auth_method.slice(0, 60) : input?.token_endpoint_auth_method === undefined ? undefined : typeof input.token_endpoint_auth_method,
    grant_types: list(input?.grant_types), response_types: list(input?.response_types),
  };
}
function callbackUri(value: unknown): string {
  const raw = string(value, 2048);
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.hash || url.username || url.password)
    throw new Error('invalid_client_metadata');
  return raw;
}
interface Flow {
  id: string; browser_hash: string; client_id: string; redirect_uri: string; state: string;
  challenge: string; scope: string; identity_id: string | null; provider: string | null;
  name: string; logo: string | null; identity_name: string | null;
  joiner_name: string | null; joiner_handle: string | null;
}
export interface McpPrincipal { hash: string; client_id: string; identity_id: string; member_id: string | null; scope: string }

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
  private page(response: ServerResponse, title: string, content: string, formRedirect?: string): void {
    // Chrome also applies form-action to the redirect after a form POST.
    // A private-use scheme has an opaque origin, so allow that scheme instead.
    const target = formRedirect ? new URL(formRedirect) : undefined;
    const formAction = target ? `'self' ${target.origin === 'null' ? target.protocol : target.origin}` : "'self'";
    response.writeHead(200, {
      // Preserve Origin on same-origin form POSTs without sending referrers to other sites.
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'same-origin',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src data:; base-uri 'none'; form-action ${formAction}; frame-ancestors 'none'`,
      'x-content-type-options': 'nosniff',
    });
    response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escape(title)} · Beeline</title><style>${PAGE_STYLE}</style><main>${content}<p class="foot"><a href="https://usebeeline.app/privacy/">Privacy</a><a href="https://usebeeline.app/terms/">Terms</a><a href="mailto:hello@usebeeline.app">Support</a></p></main></html>`);
  }
  /** The client's own mark joined to the real Beeline icon by a dashed line. */
  private brand(flow: Pick<Flow, 'name' | 'logo'>): string {
    const client = flow.logo
      ? `<img class="mark client" src="${escape(flow.logo)}" alt="${escape(flow.name)}">`
      : `<span class="mark client initial" role="img" aria-label="${escape(flow.name)}">${escape((flow.name[0] ?? 'C').toUpperCase())}</span>`;
    return `<div class="brand">${client}<span class="link" aria-hidden="true"></span><img class="mark" src="${BEELINE_ICON}" alt="Beeline"></div>`;
  }
  private redirect(response: ServerResponse, location: string): void {
    response.writeHead(302, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); response.end();
  }
  private async flow(id: unknown, request: IncomingMessage, db = this.database): Promise<Flow> {
    const result = await db.query<Flow>(`SELECT f.*,c.name,c.logo,i.name identity_name FROM rooms_mcp_flows f
      JOIN rooms_mcp_clients c ON c.id=f.client_id LEFT JOIN identities i ON i.id=f.identity_id
      WHERE f.id=$1 AND f.browser_hash=$2 AND f.expires_at>now() FOR UPDATE OF f`,
      [string(id, 100), tokenHash(this.cookie(request))]);
    if (!result.rows[0]) throw new Error('invalid_request');
    return result.rows[0];
  }
  /** Require the registered authentication method before consuming any grant. */
  private async client(request: IncomingMessage, input: Record<string, unknown>): Promise<string> {
    let id = input.client_id, secret = input.client_secret;
    const authorization = request.headers.authorization;
    const basic = /^Basic\s+(\S+)$/i.exec(authorization ?? '');
    if (authorization && !basic) throw new Error('invalid_client');
    if (basic) {
      const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon < 0 || secret !== undefined) throw new Error('invalid_client');
      // OAuth Basic credentials use application/x-www-form-urlencoded components.
      const decode = (value: string) => decodeURIComponent(value.replace(/\+/g, ' '));
      let basicId: string;
      try { basicId = decode(decoded.slice(0, colon)); secret = decode(decoded.slice(colon + 1)); }
      catch { throw new Error('invalid_client'); }
      if (id !== undefined && id !== basicId) throw new Error('invalid_client');
      id = basicId;
    }
    const clientId = string(id, 100);
    const row = (await this.database.query<{ secret_hash: string | null; auth_method: string }>(
      'SELECT secret_hash,auth_method FROM rooms_mcp_clients WHERE id=$1', [clientId])).rows[0];
    if (row?.secret_hash) {
      const method = basic ? 'client_secret_basic' : 'client_secret_post';
      if (row.auth_method !== method || typeof secret !== 'string' ||
          !timingSafeEqual(Buffer.from(tokenHash(secret)), Buffer.from(row.secret_hash))) throw new Error('invalid_client');
    } else if (secret !== undefined || basic) throw new Error('invalid_client');
    return clientId;
  }
  async audit(principal: McpPrincipal, operation: string, outcome: string): Promise<void> {
    await this.database.query(`INSERT INTO rooms_mcp_audit(client_id,identity_id,operation,outcome) VALUES($1,$2,$3,$4)`,
      [principal.client_id, principal.identity_id, operation.slice(0, 100), outcome]);
  }
  async principal(raw: string): Promise<McpPrincipal | undefined> {
    return (await this.database.query<McpPrincipal>(`SELECT t.hash,t.client_id,t.identity_id,t.scope,m.member_id FROM rooms_mcp_tokens t
      JOIN identities i ON i.id=t.identity_id AND i.kind='human'
      LEFT JOIN rooms_mcp_members m ON m.client_id=t.client_id AND m.owner_id=t.identity_id
      LEFT JOIN rooms_mcp_families f ON f.id=t.family_id
      LEFT JOIN rooms_mcp_connections c ON c.client_id=f.client_id AND c.identity_id=f.identity_id
      WHERE t.hash=$1 AND t.revoked_at IS NULL AND t.expires_at>now()
      AND (t.family_id IS NULL OR (f.revoked_at IS NULL AND c.revoked_at IS NULL))`, [tokenHash(raw)])).rows[0];
  }
  async take(principal: McpPrincipal): Promise<boolean> {
    const result = await this.database.query(`UPDATE rooms_mcp_tokens SET
      calls=CASE WHEN window_at<=now()-interval '1 minute' THEN 1 ELSE calls+1 END,
      window_at=CASE WHEN window_at<=now()-interval '1 minute' THEN now() ELSE window_at END
      WHERE hash=$1 AND revoked_at IS NULL AND expires_at>now()
        AND (window_at<=now()-interval '1 minute' OR calls<60) RETURNING hash`, [principal.hash]);
    if (result.rowCount) await this.database.query('UPDATE rooms_mcp_connections SET last_used_at=now() WHERE client_id=$1 AND identity_id=$2 AND revoked_at IS NULL', [principal.client_id, principal.identity_id]);
    return result.rowCount > 0;
  }
  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    if (!path.startsWith('/mcp/oauth/') && path !== '/.well-known/oauth-authorization-server' &&
        path !== '/.well-known/oauth-protected-resource/mcp') return false;
    if (request.method === 'GET' && /^\/mcp\/oauth\/SpaceGrotesk-(Regular|Medium|SemiBold)\.ttf$/.test(path)) {
      response.writeHead(200, { 'content-type': 'font/ttf', 'cache-control': 'public, max-age=31536000' });
      response.end(readFileSync(new URL(`../assets/mcp/${path.split('/').at(-1)}`, import.meta.url))); return true;
    }
    response.setHeader('access-control-allow-origin', '*');
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization' });
      response.end(); return true;
    }
    let registrationInput: Record<string, unknown> | undefined;
    const registration = request.method === 'POST' && path === '/mcp/oauth/register';
    try {
      if (request.method === 'GET' && path === '/.well-known/oauth-protected-resource/mcp') {
        mcpJson(response, 200, { resource: this.resource, authorization_servers: [this.origin], scopes_supported: [MCP_READ, MCP_WRITE], bearer_methods_supported: ['header'] }); return true;
      }
      if (request.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
        mcpJson(response, 200, { issuer: this.origin, authorization_endpoint: `${this.origin}/mcp/oauth/authorize`,
          token_endpoint: `${this.origin}/mcp/oauth/token`, registration_endpoint: `${this.origin}/mcp/oauth/register`,
          revocation_endpoint: `${this.origin}/mcp/oauth/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: AUTH_METHODS,
          revocation_endpoint_auth_methods_supported: AUTH_METHODS, scopes_supported: [MCP_READ, MCP_WRITE], authorization_response_iss_parameter_supported: true }); return true;
      }
      // Shared across server instances; never trust a caller-provided forwarded address.
      const admitted = await this.database.query(`INSERT INTO rooms_mcp_admission(key,calls) VALUES($1,1)
        ON CONFLICT(key) DO UPDATE SET calls=CASE WHEN rooms_mcp_admission.window_at<=now()-interval '1 minute' THEN 1 ELSE rooms_mcp_admission.calls+1 END,
        window_at=CASE WHEN rooms_mcp_admission.window_at<=now()-interval '1 minute' THEN now() ELSE rooms_mcp_admission.window_at END
        WHERE rooms_mcp_admission.window_at<=now()-interval '1 minute' OR rooms_mcp_admission.calls<300 RETURNING key`,
        [tokenHash(request.socket.remoteAddress ?? 'unknown')]);
      if (!admitted.rowCount) {
        if (registration) console.warn('[rooms-mcp-oauth] registration refused', JSON.stringify({ error: 'temporarily_unavailable' }));
        mcpJson(response, 429, { error: 'temporarily_unavailable' }); return true;
      }
      if (request.method === 'POST' && path === '/mcp/oauth/register') {
        const input = registrationInput = await mcpBody(request);
        const name = input.client_name === undefined ? 'MCP client' : string(input.client_name, 120);
        const method = input.token_endpoint_auth_method === undefined ? 'none' : string(input.token_endpoint_auth_method, 60);
        if (!Array.isArray(input.redirect_uris) || !input.redirect_uris.length || input.redirect_uris.length > 10 ||
            !AUTH_METHODS.includes(method) ||
            (input.grant_types !== undefined && (!Array.isArray(input.grant_types) || !input.grant_types.includes('authorization_code') || input.grant_types.some(g => !['authorization_code', 'refresh_token'].includes(String(g))))) ||
            (input.response_types !== undefined && JSON.stringify(input.response_types) !== '["code"]')) throw new Error('invalid_client_metadata');
        const redirects = input.redirect_uris.map(redirectUri);
        const id = opaque();
        const logo = input.logo_uri === undefined ? await bundledMcpLogo(name) : await fetchMcpLogo(string(input.logo_uri));
        // An optional outgoing callback lets the client be pushed a tag instead of polling.
        const callback = input.webhook_uri === undefined ? null : callbackUri(input.webhook_uri);
        // Only the hash is kept; a client that loses its secret registers again.
        const secret = method === 'none' ? undefined : opaque();
        await this.database.query('INSERT INTO rooms_mcp_clients(id,name,redirects,logo,callback_url,secret_hash,auth_method) VALUES($1,$2,$3::jsonb,$4,$5,$6,$7)',
          [id, name, JSON.stringify(redirects), logo ?? null, callback, secret ? tokenHash(secret) : null, method]);
        mcpJson(response, 201, { client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: redirects, token_endpoint_auth_method: method,
          ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}), grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }); return true;
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
        const client = escape(flow.name);
        if (!flow.identity_id) this.page(response, `Connect ${flow.name} to Beeline`, `${this.brand(flow)}<h1>Connect ${client} to Beeline</h1><p class="lede">Sign in to Beeline. Next, you see what <b>${client}</b> can do before you allow it.</p><div class="stack"><a class="btn primary" href="/mcp/oauth/login?flow=${flow.id}&amp;provider=google">Continue with Google</a><a class="btn" href="/mcp/oauth/login?flow=${flow.id}&amp;provider=github">Continue with GitHub</a></div><p class="meta">Beeline never shares your sign-in with ${client}.</p>`);
        else {
          const member = await mcpMemberId(this.database, flow.client_id, flow.identity_id);
          const existing = member
            ? (await this.database.query<{ name: string; handle: string | null }>('SELECT name,handle FROM identities WHERE id=$1', [member])).rows[0]
            : undefined;
          const name = flow.joiner_name ?? existing?.name ?? flow.name;
          const handle = flow.joiner_handle ?? existing?.handle ?? agentHandleFromName(name);
          const who = `<p class="who">Signed in as <b>${escape(flow.identity_name ?? 'Beeline user')}</b></p>`;
          if (url.searchParams.get('edit') === '1') {
            this.page(response, `Name ${flow.name}'s Beeline member`, `${this.brand(flow)}<h1>Name ${client}'s Beeline member</h1>${who}<form method="post" action="/mcp/oauth/consent"><input type="hidden" name="flow" value="${flow.id}"><div class="field"><label for="joiner_name">Name</label><input id="joiner_name" name="joiner_name" value="${escape(name)}" maxlength="60"></div><div class="field"><label for="joiner_handle">Handle</label><input id="joiner_handle" name="joiner_handle" value="${escape(handle)}" maxlength="40"><p>Tag it as @${escape(handle)} in a Room.</p></div><div class="row"><a class="btn" href="/mcp/oauth/consent?flow=${flow.id}">Cancel</a><button class="btn primary" name="decision" value="save">Save</button></div></form>`);
            return true;
          }
          const plate = flow.logo ? `<img class="plate" src="${escape(flow.logo)}" alt="">` : `<span class="plate" aria-hidden="true">${escape((name[0] ?? 'C').toUpperCase())}</span>`;
          const publisher = PUBLISHERS[flow.name.toLowerCase()];
          const terms = publisher ? `${escape(publisher)}'s privacy terms` : 'its own privacy terms';
          this.page(response, `Add ${flow.name} to your team`, `${this.brand(flow)}<h1>Add ${client} to your team</h1>${who}<p class="head">Joins as</p><div class="joins">${plate}<div class="who-am"><div class="name">${escape(name)}</div><div class="tag">@${escape(handle)} · ${client}</div></div><a class="edit" href="/mcp/oauth/consent?flow=${flow.id}&amp;edit=1">Edit</a></div><p class="head">It can</p><div class="perms">${flow.scope.includes(MCP_READ) ? '<div class="perm"><strong>Read your public Rooms</strong><span>It joins every public Room, like your other agents. Add or remove it in any Room under Members.</span></div>' : ''}${flow.scope.includes(MCP_WRITE) ? `<div class="perm"><strong>Post as ${escape(name)}</strong><span>Its messages show as ${escape(name)}, never as you. Allowing it is your approval for it to answer anyone in a Room who tags it.</span></div>` : ''}</div><p class="fine">Room text it reads goes to ${client} under ${terms}. Remove it any time in Settings, under Connectors.</p><form method="post" action="/mcp/oauth/consent"><input type="hidden" name="flow" value="${flow.id}"><div class="row"><button class="btn" name="decision" value="deny">Cancel</button><button class="btn primary" name="decision" value="allow">Allow</button></div></form>`, flow.redirect_uri);
        }
        return true;
      }
      if (request.method === 'POST' && path === '/mcp/oauth/consent') {
        if (request.headers.origin !== this.origin) throw new Error('invalid_request');
        const input = await mcpBody(request);
        if (input.decision === 'save') {
          const name = typeof input.joiner_name === 'string' ? input.joiner_name.trim().replace(/\s+/g, ' ') : '';
          const handle = typeof input.joiner_handle === 'string' ? input.joiner_handle.trim().replace(/^@+/, '').toLowerCase() : '';
          if (!name || name.length > 60 || !/^[a-z0-9_]{1,40}$/.test(handle)) throw new Error('invalid_request');
          await this.database.transaction(async db => {
            const flow = await this.flow(input.flow, request, db);
            if (!flow.identity_id) throw new Error('invalid_request');
            await db.query('UPDATE rooms_mcp_flows SET joiner_name=$2,joiner_handle=$3 WHERE id=$1', [flow.id, name, handle]);
          });
          this.redirect(response, `/mcp/oauth/consent?flow=${encodeURIComponent(String(input.flow))}`); return true;
        }
        const target = await this.database.transaction(async db => {
          const flow = await this.flow(input.flow, request, db);
          if (!flow.identity_id || !['allow', 'deny'].includes(String(input.decision))) throw new Error('invalid_request');
          const target = new URL(flow.redirect_uri);
          target.searchParams.set('state', flow.state); target.searchParams.set('iss', this.origin);
          if (input.decision === 'allow') {
            await ensureMcpMember(db, { clientId: flow.client_id, ownerId: flow.identity_id, modelLabel: flow.name });
            const member = await mcpMemberId(db, flow.client_id, flow.identity_id);
            if (member && (flow.joiner_name || flow.joiner_handle))
              await setMcpMemberProfile(db, member, { name: flow.joiner_name ?? undefined, handle: flow.joiner_handle ?? undefined }, false);
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
        if (input.grant_type === 'refresh_token') {
          if (input.resource !== undefined && input.resource !== this.resource) throw new Error('invalid_grant');
          const token = await refreshMcp(this.database, string(input.refresh_token, 100), await this.client(request, input), input.scope === undefined ? undefined : string(input.scope, 100));
          if (!token) throw new Error('invalid_grant');
          mcpJson(response, 200, token); return true;
        }
        if (input.grant_type !== 'authorization_code' || input.resource !== this.resource ||
            typeof input.code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier)) throw new Error('invalid_grant');
        const clientId = await this.client(request, input);
        const challenge = createHash('sha256').update(input.code_verifier).digest('base64url');
        const token = await this.database.transaction(async db => {
          const row = (await db.query<{ identity_id: string; client_id: string; scope: string }>(`DELETE FROM rooms_mcp_codes
            WHERE hash=$1 AND client_id=$2 AND redirect_uri=$3 AND challenge=$4 AND expires_at>now() RETURNING identity_id,client_id,scope`,
            [tokenHash(string(input.code, 100)), clientId, input.redirect_uri, challenge])).rows[0];
          if (!row) throw new Error('invalid_grant');
          return connectMcp(db, row);
        });
        mcpJson(response, 200, token); return true;
      }
      if (request.method === 'POST' && path === '/mcp/oauth/revoke') {
        const input = await mcpBody(request);
        const clientId = await this.client(request, input);
        await this.database.query('UPDATE rooms_mcp_tokens SET revoked_at=now() WHERE hash=$1 AND client_id=$2', [tokenHash(string(input.token, 200)), clientId]);
        await this.database.query(`UPDATE rooms_mcp_families SET revoked_at=now() WHERE client_id=$1 AND id IN (SELECT family_id FROM rooms_mcp_refresh WHERE hash=$2)`, [clientId, tokenHash(string(input.token, 200))]);
        mcpJson(response, 200, {}); return true;
      }
      mcpJson(response, 404, { error: 'not_found' });
    } catch (error) {
      const known = ['invalid_request', 'invalid_scope', 'invalid_grant', 'invalid_client', 'invalid_client_metadata', 'invalid_redirect_uri'];
      const message = error instanceof Error && known.includes(error.message) ? error.message : 'invalid_request';
      if (registration) console.warn('[rooms-mcp-oauth] registration refused', JSON.stringify({ error: message,
        ...(error instanceof SyntaxError ? { reason: 'invalid_json' } : {}), ...registrationSummary(registrationInput) }));
      if (message === 'invalid_client' && request.headers.authorization) response.setHeader('www-authenticate', 'Basic realm="Beeline MCP"');
      mcpJson(response, message === 'invalid_client' ? 401 : 400, { error: message });
    }
    return true;
  }
}
