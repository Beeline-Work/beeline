import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { TokenAuth, tokenHash } from './auth.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { createBeelineServer } from './server.js';
import { RoomsMcpOAuth } from './rooms-mcp-oauth.js';
import { RoomsMcp } from './rooms-mcp.js';
import { claimAgentCommand } from './agent-command.js';

const USER = tokenHash('google:mcp-demo'), OTHER = 'b'.repeat(64), AGENT = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222', PRIVATE = '33333333-3333-4333-8333-333333333333';
const CORNER = '44444444-4444-4444-8444-444444444444';
const PUBLIC_CORNER = '55555555-5555-4555-8555-555555555555';
const opaque = () => randomBytes(32).toString('base64url');

describe('Rooms connector HTTP OAuth and MCP', () => {
  let db: PgliteDatabase, server: ReturnType<typeof createBeelineServer>, origin: string, phone: PhoneService;
  const clients: Client[] = [];
  beforeAll(async () => {
    db = new PgliteDatabase(); await migrate(db);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Demo','demo'),($2,'human','Other','other'),($3,'agent','Demo Agent','demo-agent')`, [USER, OTHER, AGENT]);
    await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [AGENT, USER]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'MCP Demo')`, [WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Demo'),($2,$3,'Private')`, [ROOM, PRIVATE, WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name,parent_id) VALUES($1,$2,'Private corner',$3)`, [CORNER, WORKSPACE, PRIVATE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name,parent_id) VALUES($1,$2,'Demo corner',$3)`, [PUBLIC_CORNER, WORKSPACE, ROOM]);
    await db.query(`INSERT INTO corner_facts(corner_id,owner_agent_id) VALUES($1,$2)`, [PUBLIC_CORNER, AGENT]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$4,'owner'),($1,NULL,$5,'member'),($1,NULL,$6,'member'),($1,$2,$4,'owner'),($1,$2,$6,'member'),($1,$3,$5,'member')`, [WORKSPACE, ROOM, PRIVATE, USER, OTHER, AGENT]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'private nebula')`, ['d'.repeat(64), PRIVATE, OTHER]);
    const auth = new TokenAuth(db, async () => { throw new Error('unused'); }, () => new Date(), async ticket => {
      if (ticket !== 'local-demo-ticket') throw new Error('Invalid ticket');
      return { subject: 'mcp-demo', name: 'Demo', audience: 'local-test' };
    });
    const live = new LiveHub();
    phone = new PhoneService(db, 'http://127.0.0.1', undefined, undefined, live);
    const options = { database: db, auth, phone, daemon: new DaemonService(db, live), live, mediaMaximumBytes: 1024, roomsMcp: undefined as RoomsMcp | undefined };
    server = createBeelineServer(options);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    options.roomsMcp = new RoomsMcp(new RoomsMcpOAuth(db, origin, auth), phone, live);
  }, 60_000);
  afterAll(async () => {
    for (const client of clients) await client.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); await db.close();
  });
  async function post(path: string, input: Record<string, unknown>, headers: Record<string, string> = {}) {
    return fetch(origin + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) });
  }
  async function authorize(scope = 'rooms:read rooms:write', decision = 'allow') {
    const registered = await post('/mcp/oauth/register', { client_name: 'Local MCP reviewer', redirect_uris: ['http://127.0.0.1:9876/callback'], token_endpoint_auth_method: 'none' });
    expect(registered.status).toBe(201);
    const client = await registered.json() as { client_id: string };
    const verifier = opaque();
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'http://127.0.0.1:9876/callback', response_type: 'code', resource: origin + '/mcp',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope, state: 'review-state' });
    const start = await fetch(origin + '/mcp/oauth/authorize?' + query, { redirect: 'manual' });
    expect(start.status).toBe(302);
    const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
    const consent = start.headers.get('location')!;
    const flow = new URL(consent, origin).searchParams.get('flow')!;
    const login = await fetch(`${origin}/mcp/oauth/login?flow=${flow}&provider=google`, { headers: { cookie }, redirect: 'manual' });
    expect(login.headers.get('location')).toContain('/auth/oidc/start');
    const callback = await fetch(`${origin}/mcp/oauth/callback/google?state=${flow}&ticket=local-demo-ticket`, { headers: { cookie }, redirect: 'manual' });
    expect(callback.status).toBe(302);
    const page = await fetch(origin + consent, { headers: { cookie } });
    expect(await page.text()).toContain('Local MCP reviewer');
    const result = await post('/mcp/oauth/consent', { flow, decision }, { cookie, origin });
    expect(result.status).toBe(302);
    const target = new URL(result.headers.get('location')!);
    expect(target.searchParams.get('state')).toBe('review-state');
    expect(target.searchParams.get('iss')).toBe(origin);
    return { clientId: client.client_id, code: target.searchParams.get('code'), verifier, error: target.searchParams.get('error'), cookie, flow };
  }
  async function exchange(grant: Awaited<ReturnType<typeof authorize>>, overrides: Record<string, unknown> = {}) {
    return post('/mcp/oauth/token', { grant_type: 'authorization_code', client_id: grant.clientId, code: grant.code, code_verifier: grant.verifier,
      redirect_uri: 'http://127.0.0.1:9876/callback', resource: origin + '/mcp', ...overrides });
  }
  async function connected(scope?: string) {
    const grant = await authorize(scope);
    const response = await exchange(grant);
    expect(response.status).toBe(200);
    const tokens = await response.json() as { access_token: string };
    const client = new Client({ name: 'rooms-review-proof', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
    return { client, token: tokens.access_token, grant };
  }
  it('advertises resource discovery and OAuth metadata without credentials', async () => {
    const unauthorized = await fetch(origin + '/mcp'); expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/mcp');
    const metadata = await (await fetch(origin + '/.well-known/oauth-authorization-server')).json();
    expect(metadata).toMatchObject({ code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
  });
  it('requires exact redirects, S256 and the intended resource, and refuses unsupported registration', async () => {
    expect((await post('/mcp/oauth/register', { client_name: 'Bad', redirect_uris: ['javascript:alert(1)'] })).status).toBe(400);
    const registered = await (await post('/mcp/oauth/register', { client_name: 'Test', redirect_uris: ['https://client.example/callback'] })).json() as { client_id: string };
    const q = new URLSearchParams({ client_id: registered.client_id, redirect_uri: 'https://evil.example/callback', response_type: 'code', resource: origin + '/mcp', code_challenge_method: 'S256', code_challenge: opaque() });
    expect((await fetch(origin + '/mcp/oauth/authorize?' + q)).status).toBe(400);
    q.set('redirect_uri', 'https://client.example/callback'); q.set('code_challenge_method', 'plain');
    expect((await fetch(origin + '/mcp/oauth/authorize?' + q)).status).toBe(400);
    q.set('code_challenge_method', 'S256'); q.set('resource', 'https://other.example/mcp');
    expect((await fetch(origin + '/mcp/oauth/authorize?' + q)).status).toBe(400);
  });
  it('binds single-use authorization codes to the client, redirect, verifier and resource', async () => {
    const grant = await authorize();
    for (const overrides of [{ code_verifier: opaque() }, { client_id: 'other' }, { redirect_uri: 'https://evil.example' }, { resource: origin + '/other' }]) {
      expect((await exchange(grant, overrides)).status).toBe(400);
    }
    expect((await exchange(grant)).status).toBe(200);
    expect((await exchange(grant)).status).toBe(400);
  });
  it('does not grant on denial, replayed consent or a missing browser binding', async () => {
    const grant = await authorize(undefined, 'deny');
    expect(grant.code).toBeNull(); expect(grant.error).toBe('access_denied');
    expect((await post('/mcp/oauth/consent', { flow: grant.flow, decision: 'allow' }, { cookie: grant.cookie, origin })).status).toBe(400);
    expect((await fetch(`${origin}/mcp/oauth/consent?flow=${grant.flow}`)).status).toBe(400);
  });
  it('connects a real SDK client, reads, searches, posts as the user and wakes an agent', async () => {
    const { client, token, grant } = await connected();
    const tools = await client.listTools(); expect(tools.tools).toHaveLength(6);
    const rooms = await client.callTool({ name: 'list_rooms', arguments: {} });
    expect(JSON.stringify(rooms)).toContain(ROOM); expect(JSON.stringify(rooms)).not.toContain(PRIVATE);
    const posted = await client.callTool({ name: 'send_message', arguments: { room: ROOM, text: '@demo-agent report the nebula test' } });
    expect(posted.isError).not.toBe(true);
    const message = (await db.query<{ id: string; author_id: string }>(`SELECT id,author_id FROM messages WHERE room_id=$1 AND text=$2`, [ROOM, '@demo-agent report the nebula test'])).rows[0]!;
    expect(message.author_id).toBe(USER);
    const command = (await db.query<{ id: string }>('SELECT id FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2', [message.id, AGENT])).rows[0]!;
    expect(command).toBeDefined(); await claimAgentCommand(db, ROOM, AGENT, command.id, 'mcp-proof');
    expect((await db.query('SELECT state FROM agent_commands WHERE id=$1', [command.id])).rows[0]!.state).toBe('claimed');
    expect(JSON.stringify(await client.callTool({ name: 'read_messages', arguments: { room: ROOM, limit: 1 } }))).toContain('nebula test');
    const searched = JSON.stringify(await client.callTool({ name: 'search_messages', arguments: { query: 'nebula' } }));
    expect(searched).toContain('nebula test'); expect(searched).not.toContain('private nebula');
    expect(JSON.stringify(await client.callTool({ name: 'list_corners', arguments: { room: ROOM } }))).toContain(PUBLIC_CORNER);
    expect(JSON.stringify(await client.callTool({ name: 'corner_status', arguments: { corner: PUBLIC_CORNER } }))).toContain('Demo corner');
    expect((await phone.readRoom(ROOM, USER))!.messages.some(m => m.id === message.id)).toBe(true);
    expect((await db.query('SELECT 1 FROM rooms_mcp_audit WHERE client_id=$1 AND outcome=$2', [grant.clientId, 'succeeded'])).rowCount).toBeGreaterThan(0);
    await post('/mcp/oauth/revoke', { client_id: grant.clientId, token });
    expect((await fetch(origin + '/mcp', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });
  it('denies cross-user reads, searches, sends and corner reads without exposing private content', async () => {
    const { client } = await connected();
    for (const [name, args] of [
      ['read_messages', { room: PRIVATE }], ['search_messages', { room: PRIVATE, query: 'nebula' }],
      ['send_message', { room: PRIVATE, text: 'forbidden' }], ['list_corners', { room: PRIVATE }], ['corner_status', { corner: CORNER }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args }); expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain('private nebula');
    }
    expect((await db.query("SELECT 1 FROM messages WHERE room_id=$1 AND text='forbidden'", [PRIVATE])).rowCount).toBe(0);
  });
  it('enforces read-only consent even on direct tools/call and limits per token', async () => {
    const { client, token } = await connected('rooms:read');
    expect((await client.listTools()).tools.map(t => t.name)).toContain('send_message');
    await expect(client.callTool({ name: 'send_message', arguments: { room: ROOM, text: 'no consent' } })).rejects.toThrow();
    expect((await db.query("SELECT 1 FROM messages WHERE text='no consent'")).rowCount).toBe(0);
    await db.query('UPDATE rooms_mcp_tokens SET calls=60,window_at=now() WHERE hash=$1', [tokenHash(token)]);
    expect((await fetch(origin + '/mcp', { headers: { authorization: `Bearer ${token}` } })).status).toBe(429);
    const other = await connected('rooms:read');
    expect((await other.client.listTools()).tools.length).toBe(6);
  });
  it('rejects expired grants and never accepts an MCP grant as a phone session', async () => {
    const { token } = await connected();
    expect((await fetch(origin + '/mcp', { headers: { authorization: `Bearer ${token}`, origin: 'https://unregistered.example' } })).status).toBe(403);
    expect((await fetch(origin + '/v1/phone/workspaces', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    await db.query("UPDATE rooms_mcp_tokens SET expires_at=now()-interval '1 second' WHERE hash=$1", [tokenHash(token)]);
    expect((await fetch(origin + '/mcp', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    const grant = await authorize();
    await db.query("UPDATE rooms_mcp_codes SET expires_at=now()-interval '1 second' WHERE hash=$1", [tokenHash(grant.code!)]);
    expect((await exchange(grant)).status).toBe(400);
  });
  it('pages messages without crossing Room cursors and rejects oversized input', async () => {
    const { client } = await connected();
    for (let i=0; i<3; i++) await phone.execute('sendRoomMessage', { roomId: ROOM, text: `page ${i}` }, USER);
    const first = await client.callTool({ name: 'read_messages', arguments: { room: ROOM, limit: 1 } });
    const data = JSON.parse((first.content as { text: string }[])[0]!.text).data;
    expect(data.messages).toHaveLength(1); expect(data.nextCursor).toBeTruthy();
    const next = await client.callTool({ name: 'read_messages', arguments: { room: ROOM, limit: 1, cursor: data.nextCursor } });
    expect(JSON.parse((next.content as { text: string }[])[0]!.text).data.messages[0].id).not.toBe(data.messages[0].id);
    const foreignCursor = await client.callTool({ name: 'read_messages', arguments: { room: ROOM, cursor: 'd'.repeat(64) } });
    expect(JSON.parse((foreignCursor.content as { text: string }[])[0]!.text).data.messages).toEqual([]);
    expect((await client.callTool({ name: 'send_message', arguments: { room: ROOM, text: 'x'.repeat(16001) } })).isError).toBe(true);
  });
  it('bounds messages and drops access immediately when membership ends', async () => {
    const { client } = await connected();
    expect((await client.callTool({ name: 'read_messages', arguments: { room: ROOM, limit: 1000 } })).isError).toBe(true);
    await db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2', [ROOM, USER]);
    expect((await client.callTool({ name: 'read_messages', arguments: { room: ROOM } })).isError).toBe(true);
    expect(JSON.stringify(await client.callTool({ name: 'list_rooms', arguments: {} }))).not.toContain(ROOM);
  });
});
