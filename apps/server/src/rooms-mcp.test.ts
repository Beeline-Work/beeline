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
import { claimAgentCommand, routeHumanMessage } from './agent-command.js';
import { deliverMcpMemberWebhooks } from './rooms-mcp-members.js';

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
  async function authorize(scope = 'rooms:read rooms:write', decision = 'allow', clientId?: string) {
    const registered = await post('/mcp/oauth/register', { client_name: 'Local MCP reviewer', redirect_uris: ['http://127.0.0.1:9876/callback'], token_endpoint_auth_method: 'none' });
    expect(registered.status).toBe(201);
    const client = clientId ? { client_id: clientId } : await registered.json() as { client_id: string };
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
    // The connection acts through a member owned by the approving person; a
    // person adds it to a Room before it can read or post there.
    const member = (await db.query<{ member_id: string }>(
      'SELECT member_id FROM rooms_mcp_members WHERE client_id=$1', [grant.clientId])).rows[0]!.member_id;
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')
      ON CONFLICT (room_id,identity_id) WHERE room_id IS NOT NULL DO NOTHING`, [WORKSPACE, ROOM, member]);
    const client = new Client({ name: 'rooms-review-proof', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
    return { client, token: tokens.access_token, grant, member };
  }
  it('rotates refresh tokens and revokes their family on reuse', async () => {
    const grant = await authorize();
    const initial = await (await exchange(grant)).json() as { access_token: string; refresh_token: string };
    const refresh = (token: string, clientId = grant.clientId) => post('/mcp/oauth/token', {
      grant_type: 'refresh_token', refresh_token: token, client_id: clientId, resource: origin + '/mcp',
    });
    expect((await refresh(initial.refresh_token, 'wrong-client')).status).toBe(400);
    const response = await refresh(initial.refresh_token);
    expect(response.status).toBe(200);
    const next = await response.json() as typeof initial;
    expect(next.refresh_token).not.toBe(initial.refresh_token);
    expect((await fetch(origin + '/mcp', { headers: { authorization: `Bearer ${next.access_token}` } })).status).not.toBe(401);
    expect((await refresh(initial.refresh_token)).status).toBe(400);
    expect((await refresh(next.refresh_token)).status).toBe(400);
    for (const token of [initial.access_token, next.access_token]) {
      expect((await fetch(origin + '/mcp', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    }
  });
  it('lists only the viewer connections and disconnects access and refresh credentials together', async () => {
    const grant = await authorize();
    const tokens = await (await exchange(grant)).json() as { access_token: string; refresh_token: string };
    expect((await phone.readWorkbench({ workspaceId: WORKSPACE }, OTHER)).aiClients).not.toContainEqual(expect.objectContaining({ clientId: grant.clientId }));
    expect((await phone.readWorkbench({ workspaceId: WORKSPACE }, USER)).aiClients).toContainEqual(expect.objectContaining({ clientId: grant.clientId }));
    await phone.execute('disconnectAiClient', { clientId: grant.clientId }, OTHER);
    expect((await fetch(origin + '/mcp', { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).not.toBe(401);
    const otherGrant = await authorize('rooms:read', 'allow', grant.clientId);
    const otherTokens = await (await exchange(otherGrant)).json() as typeof tokens;
    const phoneToken = opaque();
    await db.query("INSERT INTO phone_access_tokens(token_hash,identity_id,family_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [tokenHash(phoneToken), USER, WORKSPACE]);
    const disconnected = await post('/v1/phone/operations/disconnectAiClient', { clientId: grant.clientId }, { authorization: `Bearer ${phoneToken}` });
    expect(disconnected.status).toBe(204);
    expect((await fetch(origin + '/mcp', { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401);
    expect((await post('/mcp/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: grant.clientId })).status).toBe(400);
    expect((await fetch(origin + '/mcp', { headers: { authorization: `Bearer ${otherTokens.access_token}` } })).status).toBe(401);
    expect((await post('/mcp/oauth/token', { grant_type: 'refresh_token', refresh_token: otherTokens.refresh_token, client_id: grant.clientId })).status).toBe(400);
    expect((await phone.readWorkbench({ workspaceId: WORKSPACE }, USER)).aiClients).not.toContainEqual(expect.objectContaining({ clientId: grant.clientId }));
  });
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
  it('previews and edits the joining member on consent', async () => {
    const registered = await post('/mcp/oauth/register', { client_name: 'Grok Bot', redirect_uris: ['http://127.0.0.1:9876/callback'] });
    const client = await registered.json() as { client_id: string };
    const verifier = opaque();
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'http://127.0.0.1:9876/callback', response_type: 'code', resource: origin + '/mcp',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'rooms:read rooms:write', state: 'edit-state' });
    const start = await fetch(origin + '/mcp/oauth/authorize?' + query, { redirect: 'manual' });
    const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
    const flow = new URL(start.headers.get('location')!, origin).searchParams.get('flow')!;
    await fetch(`${origin}/mcp/oauth/login?flow=${flow}&provider=google`, { headers: { cookie }, redirect: 'manual' });
    await fetch(`${origin}/mcp/oauth/callback/google?state=${flow}&ticket=local-demo-ticket`, { headers: { cookie }, redirect: 'manual' });
    const page = await (await fetch(`${origin}/mcp/oauth/consent?flow=${flow}`, { headers: { cookie } })).text();
    expect(page).toContain('JOINS AS'); expect(page).toContain('Grok Bot');
    expect(page).toContain('Read Rooms you add it to'); expect(page).toContain('Post as Grok Bot');
    const edit = await (await fetch(`${origin}/mcp/oauth/consent?flow=${flow}&edit=1`, { headers: { cookie } })).text();
    expect(edit).toContain('name="joiner_name"');
    expect((await post('/mcp/oauth/consent', { flow, decision: 'save', joiner_name: 'Firstmate', joiner_handle: 'firstmate' }, { cookie, origin })).status).toBe(302);
    const renamed = await (await fetch(`${origin}/mcp/oauth/consent?flow=${flow}`, { headers: { cookie } })).text();
    expect(renamed).toContain('Firstmate'); expect(renamed).toContain('@firstmate');
    const allowed = await post('/mcp/oauth/consent', { flow, decision: 'allow' }, { cookie, origin });
    expect(allowed.status).toBe(302);
    const code = new URL(allowed.headers.get('location')!).searchParams.get('code')!;
    expect((await post('/mcp/oauth/token', { grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier, redirect_uri: 'http://127.0.0.1:9876/callback', resource: origin + '/mcp' })).status).toBe(200);
    const member = (await db.query<{ member_id: string }>('SELECT member_id FROM rooms_mcp_members WHERE owner_id=$1 AND client_id=$2', [USER, client.client_id])).rows[0]!.member_id;
    expect((await db.query<{ name: string; handle: string }>('SELECT name,handle FROM identities WHERE id=$1', [member])).rows[0]).toEqual({ name: 'Firstmate', handle: 'firstmate' });
  });
  it('connects a real SDK client, reads, searches, posts as the member and wakes an agent', async () => {
    const { client, token, grant, member } = await connected();
    const tools = await client.listTools(); expect(tools.tools).toHaveLength(7);
    const rooms = await client.callTool({ name: 'list_rooms', arguments: {} });
    expect(JSON.stringify(rooms)).toContain(ROOM); expect(JSON.stringify(rooms)).not.toContain(PRIVATE);
    const posted = await client.callTool({ name: 'send_message', arguments: { room: ROOM, text: '@demo-agent report the nebula test' } });
    expect(posted.isError).not.toBe(true);
    expect(JSON.parse((posted.content as { text: string }[])[0]!.text).data.woken).toEqual(['demo-agent']);
    const message = (await db.query<{ id: string; author_id: string }>(`SELECT id,author_id FROM messages WHERE room_id=$1 AND text=$2`, [ROOM, '@demo-agent report the nebula test'])).rows[0]!;
    expect(message.author_id).toBe(member);
    expect(message.author_id).not.toBe(USER);
    const command = (await db.query<{ id: string }>('SELECT id FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2', [message.id, AGENT])).rows[0]!;
    expect(command).toBeDefined(); await claimAgentCommand(db, ROOM, AGENT, command.id, 'mcp-proof');
    expect((await db.query('SELECT state FROM agent_commands WHERE id=$1', [command.id])).rows[0]!.state).toBe('claimed');
    expect(JSON.stringify(await client.callTool({ name: 'read_messages', arguments: { room: ROOM, limit: 1 } }))).toContain('nebula test');
    const searched = JSON.stringify(await client.callTool({ name: 'search_messages', arguments: { query: 'nebula' } }));
    expect(searched).toContain('nebula test'); expect(searched).not.toContain('private nebula');
    expect(JSON.stringify(await client.callTool({ name: 'list_corners', arguments: { room: ROOM } }))).toContain(PUBLIC_CORNER);
    expect(JSON.stringify(await client.callTool({ name: 'corner_status', arguments: { corner: PUBLIC_CORNER } }))).toContain('Demo corner');
    expect((await phone.readRoom(ROOM, USER))!.messages.find(m => m.id === message.id)?.sourceClient).toEqual({ id: grant.clientId, name: 'Local MCP reviewer' });
    // One wake per tagged agent.
    expect((await db.query('SELECT 1 FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2', [message.id, AGENT])).rowCount).toBe(1);
    expect((await db.query('SELECT 1 FROM rooms_mcp_audit WHERE client_id=$1 AND outcome=$2', [grant.clientId, 'succeeded'])).rowCount).toBeGreaterThan(0);
    await post('/mcp/oauth/revoke', { client_id: grant.clientId, token });
    expect((await fetch(origin + '/mcp', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });
  it('sets this member’s own profile without changing its registered model label', async () => {
    const { client, member } = await connected();
    const updated = await client.callTool({ name: 'set_profile', arguments: { name: 'Firstmate', handle: 'firstmate_set', avatar: '' } });
    expect(updated.isError).not.toBe(true);
    const identity = (await db.query<{ name: string; handle: string }>('SELECT name,handle FROM identities WHERE id=$1', [member])).rows[0]!;
    expect(identity).toEqual({ name: 'Firstmate', handle: 'firstmate_set' });
    const config = (await db.query<{ selected_model: string }>('SELECT selected_model FROM agents WHERE agent_id=$1', [member])).rows[0]!;
    expect(config.selected_model).toBe('Local MCP reviewer');
  });
  it('is idempotent on the client key and posts nothing on a retry', async () => {
    const { client } = await connected();
    const first = await client.callTool({ name: 'send_message', arguments: { room: ROOM, text: 'idempotent handoff @demo-agent', idempotencyKey: 'job-1' } });
    const id = JSON.parse((first.content as { text: string }[])[0]!.text).data.messageId as string;
    expect((await db.query('SELECT 1 FROM messages WHERE id=$1', [id])).rowCount).toBe(1);
    const second = await client.callTool({ name: 'send_message', arguments: { room: ROOM, text: 'idempotent handoff @demo-agent', idempotencyKey: 'job-1' } });
    expect(JSON.parse((second.content as { text: string }[])[0]!.text).data.messageId).toBe(id);
    expect((await db.query('SELECT 1 FROM messages WHERE text=$1', ['idempotent handoff @demo-agent'])).rowCount).toBe(1);
  });
  it('fires one outgoing webhook per (message, member) and never for its own post', async () => {
    const { client, grant, member } = await connected();
    await db.query(`UPDATE rooms_mcp_clients SET callback_url='https://hooks.example/firstmate' WHERE id=$1`, [grant.clientId]);
    const handle = (await db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    const sent = await phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} ship the webhook` }, USER);
    const calls = async () => (await db.query('SELECT id FROM subscription_webhook_calls WHERE member_id=$1 AND wake_message_id=$2', [member, sent.messageId])).rowCount;
    expect(await calls()).toBe(1);
    // A repeated route of the same message never calls again.
    await routeHumanMessage(db, sent.messageId);
    expect(await calls()).toBe(1);
    const delivered: string[] = [];
    const count = await deliverMcpMemberWebhooks(db, async (url) => {
      delivered.push(String(url)); return new Response('', { status: 200 });
    });
    expect(count).toBe(1); expect(delivered).toEqual(['https://hooks.example/firstmate']);
    expect((await db.query('SELECT delivered_at FROM rooms_mcp_webhook_outbox WHERE member_id=$1 AND message_id=$2', [member, sent.messageId])).rows[0]!.delivered_at).not.toBeNull();
    // Its own post tags itself; a member is never its own wake target, so no webhook call.
    const own = await client.callTool({ name: 'send_message', arguments: { room: ROOM, text: `@${handle} self note` } });
    const ownId = JSON.parse((own.content as { text: string }[])[0]!.text).data.messageId as string;
    expect((await db.query('SELECT 1 FROM subscription_webhook_calls WHERE member_id=$1 AND wake_message_id=$2', [member, ownId])).rowCount).toBe(0);
  });
  it('claims a pending delivery once so overlapping drains never double-post', async () => {
    const { grant, member } = await connected();
    await db.query(`UPDATE rooms_mcp_clients SET callback_url='https://hooks.example/concurrent' WHERE id=$1`, [grant.clientId]);
    // Drain earlier tests' backlog so only this delivery is pending.
    await deliverMcpMemberWebhooks(db, async () => new Response('', { status: 200 }));
    const handle = (await db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    const sent = await phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} deliver once` }, USER);
    let calls = 0;
    let started!: () => void;
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    // Only the first HTTP request is held open; a duplicate attempt returns at
    // once, so an overlapping drain that re-claims the row is caught, not stuck.
    const transport = (async () => {
      calls++;
      if (calls === 1) {
        started();
        await gate;
      }
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const first = deliverMcpMemberWebhooks(db, transport);
    await firstStarted;
    // A second drain overlaps the first while its HTTP request is held open.
    const overlapping = await deliverMcpMemberWebhooks(db, transport);
    release();
    expect(await first).toBe(1);
    expect(overlapping).toBe(0);
    expect(calls).toBe(1);
    expect((await db.query('SELECT delivered_at FROM rooms_mcp_webhook_outbox WHERE member_id=$1 AND message_id=$2', [member, sent.messageId])).rows[0]!.delivered_at).not.toBeNull();
  });
  it('claims each delivery at send time so a slow batch cannot go stale and double-post', async () => {
    const { grant, member } = await connected();
    await db.query(`UPDATE rooms_mcp_clients SET callback_url='https://hooks.example/slow-batch' WHERE id=$1`, [grant.clientId]);
    // Drain earlier tests' backlog so only this batch is pending.
    await deliverMcpMemberWebhooks(db, async () => new Response('', { status: 200 }));
    const handle = (await db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    const texts = ['batch one', 'batch two', 'batch three'];
    for (const text of texts) await phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} ${text}` }, USER);
    const received: string[] = [];
    let inFlight = '';
    let started!: () => void;
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const transport = (async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body)) as { text: string };
      received.push(payload.text);
      if (!inFlight) { inFlight = payload.text; started(); await gate; }
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const first = deliverMcpMemberWebhooks(db, transport);
    await firstStarted;
    // The first drain is still sending its first row. Backdate every other
    // queued claim to simulate a batch that has outlived the one-minute lease.
    const inFlightId = (await db.query<{ message_id: string }>(
      'SELECT message_id FROM rooms_mcp_webhook_outbox WHERE body=$1 AND delivered_at IS NULL', [inFlight])).rows[0]!.message_id;
    await db.query(
      `UPDATE rooms_mcp_webhook_outbox SET claimed_at=now()-interval '2 minutes'
       WHERE delivered_at IS NULL AND message_id<>$1`, [inFlightId]);
    const overlapping = await deliverMcpMemberWebhooks(db, transport);
    release();
    await first;
    // Each queued delivery is sent exactly once, by whichever drain claimed it.
    expect(overlapping).toBe(2);
    expect(received).toHaveLength(3);
    for (const text of texts) expect(received.filter(body => body.endsWith(text))).toHaveLength(1);
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
    expect((await other.client.listTools()).tools.length).toBe(7);
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
    const { client, member } = await connected();
    expect((await client.callTool({ name: 'read_messages', arguments: { room: ROOM, limit: 1000 } })).isError).toBe(true);
    // Removing the member from the Room revokes its next read and post at once.
    await db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2', [ROOM, member]);
    expect((await client.callTool({ name: 'read_messages', arguments: { room: ROOM } })).isError).toBe(true);
    expect(JSON.stringify(await client.callTool({ name: 'list_rooms', arguments: {} }))).not.toContain(ROOM);
  });
});
