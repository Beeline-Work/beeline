import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { Webhook } from 'standardwebhooks';
import { RoomsMcpEvents } from './rooms-mcp-events.js';
import { backfillMcpMemberRoomsAndAvatars, ensureMcpMember, MCP_TAG_INSTRUCTION, postMcpWebhook } from './rooms-mcp-members.js';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { TokenAuth, tokenHash } from './auth.js';
import { recordSigninAttempt } from './signin-attempts.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { createBeelineServer } from './server.js';
import { BROWSER_REFUSALS, RoomsMcpOAuth } from './rooms-mcp-oauth.js';
import { RoomsMcp } from './rooms-mcp.js';
import { MCP_AGENT_EXCLUSIONS, MCP_AGENT_TOOLS, MCP_APP_ROUTE_OPERATIONS } from './rooms-mcp-agent.js';
import { claimAgentCommand, routeHumanMessage, routeAgentResult } from './agent-command.js';
import { openSecrets } from './free-agents.js';
import { deliverMcpMemberWebhooks } from './rooms-mcp-members.js';
import { runMaintenance } from './background.js';
import { PREREGISTERED_MCP_CLIENTS } from './rooms-mcp-preregistered.js';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { MCP_STARTER_ROUTINE, FACE_SOULS } from '@beeline/api-contract/phone';

const USER = tokenHash('google:mcp-demo'), OTHER = 'b'.repeat(64), AGENT = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222', PRIVATE = '33333333-3333-4333-8333-333333333333';
const CORNER = '44444444-4444-4444-8444-444444444444';
const PUBLIC_CORNER = '55555555-5555-4555-8555-555555555555';
const opaque = () => randomBytes(32).toString('base64url');

describe('Rooms connector HTTP OAuth and MCP', () => {
  let db: PgliteDatabase, server: ReturnType<typeof createBeelineServer>, origin: string, phone: PhoneService, daemon: DaemonService;
  const clients: Client[] = [];
  let eventTransport: typeof postMcpWebhook = postMcpWebhook;
  beforeAll(async () => {
    db = new PgliteDatabase(); await migrate(db);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Demo','demo'),($2,'human','Other','other'),($3,'agent','Demo Agent','demo-agent')`, [USER, OTHER, AGENT]);
    await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [AGENT, USER]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'MCP Demo')`, [WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name,visibility) VALUES($1,$3,'Demo','public'),($2,$3,'Private','invite-only')`, [ROOM, PRIVATE, WORKSPACE]);
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
    daemon = new DaemonService(db, live);
    const options = { database: db, auth, phone, daemon, live, mediaMaximumBytes: 1024, roomsMcp: undefined as RoomsMcp | undefined };
    server = createBeelineServer(options);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    options.roomsMcp = new RoomsMcp(new RoomsMcpOAuth(db, origin, auth), phone, live, daemon, undefined,
      new RoomsMcpEvents(db, (url, init) => eventTransport(url, init)));
  }, 60_000);
  beforeEach(async () => {
    // Each independent HTTP scenario starts with its own admission budget.
    await db.query('DELETE FROM rooms_mcp_admission');
  });
  afterAll(async () => {
    for (const client of clients) await client.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); await db.close();
  });
  async function post(path: string, input: Record<string, unknown>, headers: Record<string, string> = {}) {
    return fetch(origin + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) });
  }
  async function prepareAuthorization(scope = 'rooms:read rooms:write', clientId?: string, redirectUri = 'http://127.0.0.1:9876/callback') {
    const registered = await post('/mcp/oauth/register', { client_name: 'Local MCP reviewer', redirect_uris: ['http://127.0.0.1:9876/callback'], token_endpoint_auth_method: 'none' });
    expect(registered.status).toBe(201);
    const client = clientId ? { client_id: clientId } : await registered.json() as { client_id: string };
    const verifier = opaque();
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code', resource: origin + '/mcp',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope, state: 'review-state' });
    if (!scope) query.delete('scope');
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
    expect(page.headers.get('referrer-policy')).toBe('same-origin');
    // Reproduction mcp-consent-1: form-action blocked the client's own redirect hops after Allow.
    expect(page.headers.get('content-security-policy')).not.toContain('form-action');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const consentHtml = await page.text();
    expect(consentHtml).toContain(clientId ? 'to your team</h1>' : 'Local MCP reviewer');
    return { consentHtml, consent, clientId: client.client_id, verifier, cookie, flow };
  }
  async function authorize(scope = 'rooms:read rooms:write', decision = 'allow', clientId?: string, redirectUri = 'http://127.0.0.1:9876/callback', wake: Record<string, unknown> = {}) {
    const prepared = await prepareAuthorization(scope, clientId, redirectUri);
    const { flow, cookie } = prepared;
    const result = await post('/mcp/oauth/consent', { flow, decision, workspace_selection: '1', workspace_ids: [WORKSPACE], ...wake }, { cookie, origin });
    expect(result.status).toBe(302);
    const target = new URL(result.headers.get('location')!);
    expect(target.href.startsWith(redirectUri + '?')).toBe(true);
    expect(target.searchParams.get('state')).toBe('review-state');
    expect(target.searchParams.get('iss')).toBe(origin);
    return { ...prepared, code: target.searchParams.get('code'), error: target.searchParams.get('error') };
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
  async function eventCall(token: string, method: string, params: Record<string, unknown> = {}) {
    const response = await post('/mcp', { jsonrpc: '2.0', id: 1, method, params },
      { authorization: 'Bearer ' + token, accept: 'application/json, text/event-stream' });
    expect(response.status).toBe(200);
    return response.json() as Promise<{ result?: any; error?: { code: number; data?: { reason: string } } }>;
  }
  async function eventFixture() {
    vi.stubEnv('BEELINE_MCP_WEBHOOK_KEY', 'local-events-sealing-key');
    const connectedMember = await connected();
    const secret = 'whsec_' + randomBytes(32).toString('base64');
    const url = 'https://hooks.example/events/' + opaque();
    const params = { name: 'mention', arguments: {}, delivery: { mode: 'webhook', url, secret }, cursor: null };
    const posts: Array<{ body: any; headers: Record<string, string> }> = [];
    eventTransport = async (_url, init) => {
      const body = new Webhook(secret).verify(init.body, init.headers);
      posts.push({ body, headers: init.headers });
      return Response.json({ challenge: (body as { challenge?: string }).challenge });
    };
    return { ...connectedMember, secret, url, params, posts };
  }
  afterEach(async () => {
    eventTransport = postMcpWebhook; vi.unstubAllEnvs();
    await db.query('DELETE FROM rooms_mcp_event_subscriptions');
  });
  it('MCP-EVENTS-1: discovers, verifies, refreshes and unsubscribes on the authenticated MCP endpoint', async () => {
    const fixture = await eventFixture();
    const { token, params, posts, member } = fixture;
    const initialized = await eventCall(token, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'events-test', version: '1' } });
    expect(initialized.result.capabilities.events).toEqual({});
    expect((await eventCall(token, 'server/discover')).result.capabilities.events).toEqual({});
    expect((await eventCall(token, 'events/list')).result.events).toMatchObject([{ name: 'mention', delivery: ['webhook'] }]);
    expect((await eventCall(token, 'events/list', { cursor: 'invalid' })).error?.code).toBe(-32602);
    const first = await eventCall(token, 'events/subscribe', params);
    expect(first.error).toBeUndefined();
    expect(first.result).toMatchObject({ cursor: null, truncated: false });
    expect(posts.map(p => p.body.type)).toEqual(['verification']);
    expect(posts[0]!.headers['X-MCP-Subscription-Id']).toBe(first.result.id);
    const saved = (await db.query<{ secret: string }>('SELECT secret FROM rooms_mcp_event_subscriptions WHERE id=$1', [first.result.id])).rows[0]!;
    expect(saved.secret).not.toContain(fixture.secret);
    const refresh = await eventCall(token, 'events/subscribe', { ...params, ttlMs: 60_000 });
    expect(refresh.result.id).toBe(first.result.id);
    expect(Date.parse(refresh.result.refreshBefore) - Date.now()).toBeLessThanOrEqual(60_000);
    expect(posts).toHaveLength(1);
    const noExpiry = await eventCall(token, 'events/subscribe', { ...params, ttlMs: null });
    expect(noExpiry.result.refreshBefore).toEqual(expect.any(String));
    expect((await db.query('SELECT id FROM rooms_mcp_event_subscriptions WHERE member_id=$1', [member])).rowCount).toBe(1);
    const { secret: _secret, ...delivery } = params.delivery;
    expect((await eventCall(token, 'events/unsubscribe', { name: 'mention', arguments: {}, delivery })).result).toEqual({});
    expect((await eventCall(token, 'events/unsubscribe', { name: 'mention', arguments: {}, delivery })).result).toEqual({});
    expect((await db.query('SELECT id FROM rooms_mcp_event_subscriptions WHERE member_id=$1', [member])).rowCount).toBe(0);
  });
  it('MCP-EVENTS-1: a human tag reaches a local receiver once, and the connected member replies under its own byline', async () => {
    const fixture = await eventFixture();
    const { token, params, member, secret, url, client } = fixture;
    const received: any[] = [];
    const receiver = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      const headers = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k, String(v)]));
      const event = new Webhook(secret).verify(body, headers) as any;
      received.push(event);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(event.type === 'verification' ? { challenge: event.challenge } : {}));
    });
    await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
    // Local receiver stand-in only: production retains HTTPS + public DNS pinning.
    eventTransport = async (target, init) => {
      expect(target).toBe(url);
      return fetch(`http://127.0.0.1:${(receiver.address() as AddressInfo).port}`, { method: 'POST', ...init });
    };
    try {
      const subscription = (await eventCall(token, 'events/subscribe', params)).result;
      const other = await connected();
      const otherSecret = 'whsec_' + randomBytes(32).toString('base64');
      eventTransport = async (_target, init) => Response.json({ challenge: JSON.parse(init.body).challenge });
      expect((await eventCall(other.token, 'events/subscribe', { ...params,
        delivery: { ...params.delivery, url: 'https://hooks.example/other', secret: otherSecret } })).error).toBeUndefined();
      expect((await eventCall(other.token, 'events/unsubscribe', { name: 'mention', arguments: {}, delivery: { mode: 'webhook', url } })).result).toEqual({});
      expect((await db.query('SELECT id FROM rooms_mcp_event_subscriptions WHERE id=$1', [subscription.id])).rowCount).toBe(1);
      await client.callTool({ name: 'set_webhook', arguments: { url: 'https://hooks.example/bearer', secret: 'legacy-bearer' } });
      const handle = (await db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
      const sent = await phone.execute('sendRoomMessage', { roomId: ROOM, text: '@' + handle + ' reply here' }, USER);
      await routeHumanMessage(db, sent.messageId);
      expect((await db.query('SELECT subscription_id FROM rooms_mcp_event_deliveries WHERE message_id=$1', [sent.messageId])).rows).toEqual([{ subscription_id: subscription.id }]);
      let bearerCalls = 0;
      const deliveryTransport: typeof postMcpWebhook = async (target, init) => {
        if (target === 'https://hooks.example/bearer') {
          bearerCalls++; expect(init.headers.authorization).toBe('Bearer legacy-bearer'); return new Response(null, { status: 204 });
        }
        expect(target).toBe(url);
        expect(init.headers['X-MCP-Subscription-Id']).toBe(subscription.id);
        return fetch(`http://127.0.0.1:${(receiver.address() as AddressInfo).port}`, { method: 'POST', ...init });
      };
      expect(await deliverMcpMemberWebhooks(db, deliveryTransport)).toBe(2);
      expect(bearerCalls).toBe(1);
      expect(received).toHaveLength(2);
      expect(received[1]).toMatchObject({ name: 'mention', cursor: null,
        data: { roomId: ROOM, messageId: sent.messageId, author: { id: USER }, text: '@' + handle + ' reply here' } });
      expect(await deliverMcpMemberWebhooks(db, deliveryTransport)).toBe(0);
      const reply = await client.callTool({ name: 'send_message', arguments: { room: ROOM, text: 'Event received.', replyTo: sent.messageId } });
      expect(reply.isError).not.toBe(true);
      const view = await phone.readRoom(ROOM, USER);
      expect(JSON.stringify(view)).toContain('Event received.');
      expect((await db.query('SELECT author_id FROM messages WHERE room_id=$1 AND text=$2', [ROOM, 'Event received.'])).rows).toEqual([{ author_id: member }]);
    } finally { receiver.closeAllConnections(); await new Promise<void>(resolve => receiver.close(() => resolve())); }
  });
  it.each(['challenge', 'private HTTPS', 'url', 'secret', 'member', 'cursor', 'ttl'])('MCP-EVENTS-1: refuses invalid %s before activation', async kind => {
    const { token, params, member } = await eventFixture();
    let input: Record<string, unknown> = params;
    if (kind === 'challenge') eventTransport = async () => Response.json({ challenge: 'wrong' });
    if (kind === 'private HTTPS') {
      eventTransport = postMcpWebhook;
      input = { ...params, delivery: { ...params.delivery, url: 'https://127.0.0.1/private' } };
    }
    if (kind === 'url') input = { ...params, delivery: { ...params.delivery, url: 'http://127.0.0.1/private' } };
    if (kind === 'secret') input = { ...params, delivery: { ...params.delivery, secret: 'whsec_c2hvcnQ=' } };
    if (kind === 'member') input = { ...params, arguments: { memberId: OTHER } };
    if (kind === 'cursor') input = { ...params, cursor: '1000' };
    if (kind === 'ttl') input = { ...params, ttlMs: -1 };
    const result = await eventCall(token, 'events/subscribe', input);
    expect(result.error?.code).toBe(['challenge', 'private HTTPS'].includes(kind) ? -32015 : -32602);
    if (kind === 'challenge') expect(result.error?.data?.reason).toBe('challenge_failed');
    expect((await db.query('SELECT id FROM rooms_mcp_event_subscriptions WHERE member_id=$1', [member])).rowCount).toBe(0);
  });
  it.each(['expiration', 'removal', 'disconnect', 'unsubscribe', 'deleted message'])('MCP-EVENTS-1: queued text stays private after %s', async kind => {
    const { token, params, member, grant } = await eventFixture();
    await eventCall(token, 'events/subscribe', params);
    const handle = (await db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    const sent = await phone.execute('sendRoomMessage', { roomId: ROOM, text: '@' + handle + ' private after revocation' }, USER);
    if (kind === 'expiration') await db.query("UPDATE rooms_mcp_event_subscriptions SET expires_at=now()-interval '1 second' WHERE member_id=$1", [member]);
    if (kind === 'removal') await phone.execute('removeRoomMember', { roomId: ROOM, memberId: member }, USER);
    if (kind === 'disconnect') await phone.execute('disconnectAiClient', { clientId: grant.clientId }, USER);
    if (kind === 'unsubscribe') await eventCall(token, 'events/unsubscribe', { name: 'mention', arguments: {}, delivery: { mode: 'webhook', url: params.delivery.url } });
    if (kind === 'deleted message') await db.query('UPDATE messages SET deleted_at=now() WHERE id=$1', [sent.messageId]);
    const deliver = vi.fn(async () => new Response(null, { status: 204 }));
    await deliverMcpMemberWebhooks(db, deliver);
    expect(deliver).not.toHaveBeenCalled();
  });
  it.each([410, 413])('MCP-EVENTS-1: terminal callback response %s retires the delivery', async status => {
    const { token, params, member } = await eventFixture();
    await eventCall(token, 'events/subscribe', params);
    const handle = (await db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    await phone.execute('sendRoomMessage', { roomId: ROOM, text: '@' + handle + ' terminal response' }, USER);
    const transport = vi.fn(async () => new Response(null, { status }));
    await deliverMcpMemberWebhooks(db, transport);
    await db.query('UPDATE rooms_mcp_event_deliveries SET next_attempt_at=now()');
    await deliverMcpMemberWebhooks(db, transport);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('MCP-EVENTS-1: a concurrent drain cannot redeliver an in-flight event', async () => {
    const { token, params, member } = await eventFixture();
    await eventCall(token, 'events/subscribe', params);
    const handle = (await db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    await phone.execute('sendRoomMessage', { roomId: ROOM, text: '@' + handle + ' concurrent drain' }, USER);
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const transport = vi.fn(async () => { entered(); await ready; return new Response(null, { status: 204 }); });
    const first = deliverMcpMemberWebhooks(db, transport);
    await started;
    try {
      expect(await deliverMcpMemberWebhooks(db, transport)).toBe(0);
    } finally { release(); }
    expect(await first).toBe(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('MCP-EVENTS-1: secret rotation keeps both signatures briefly; retries preserve event identity', async () => {
    const { token, params, member, secret } = await eventFixture();
    await eventCall(token, 'events/subscribe', params);
    const replacement = 'whsec_' + randomBytes(32).toString('base64');
    eventTransport = async (_url, init) => {
      const body = new Webhook(replacement).verify(init.body, init.headers) as any;
      return Response.json({ challenge: body.challenge });
    };
    await eventCall(token, 'events/subscribe', { ...params, delivery: { ...params.delivery, secret: replacement } });
    const handle = (await db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    await phone.execute('sendRoomMessage', { roomId: ROOM, text: '@' + handle + ' retry me' }, USER);
    const attempts: string[] = [];
    const transport: typeof postMcpWebhook = async (_url, init) => {
      expect(() => new Webhook(secret).verify(init.body, init.headers)).not.toThrow();
      expect(() => new Webhook(replacement).verify(init.body, init.headers)).not.toThrow();
      attempts.push(init.body);
      return new Response(null, { status: attempts.length === 1 ? 503 : 204 });
    };
    expect(await deliverMcpMemberWebhooks(db, transport)).toBe(0);
    expect(await deliverMcpMemberWebhooks(db, transport)).toBe(0);
    await db.query('UPDATE rooms_mcp_event_deliveries SET next_attempt_at=now() WHERE delivered_at IS NULL');
    expect(await deliverMcpMemberWebhooks(db, transport)).toBe(1);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toBe(attempts[0]);
  });
  it.each(['consent', 'profile'])('MCP-WAKE-SETUP: %s saves once, delivers tags and never reads the key back', async path => {
    vi.stubEnv('BEELINE_MCP_WEBHOOK_KEY', 'local-wake-test-key');
    const secret = 'wake-key-sentinel-' + opaque();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const grant = await authorize(undefined, 'allow', undefined, undefined,
        path === 'consent' ? { wake_url: 'https://hooks.example/wake', wake_key: ' Bearer ' + secret + ' ' } : {});
      expect((await exchange(grant)).status).toBe(200);
      const member = (await db.query<{ member_id: string }>('SELECT member_id FROM rooms_mcp_members WHERE client_id=$1', [grant.clientId])).rows[0]!.member_id;
      const operation = async (viewer: string, key?: string, url = 'https://hooks.example/wake') => {
        const token = opaque();
        await db.query(`INSERT INTO phone_access_tokens(token_hash,identity_id,family_id,expires_at)
          VALUES($1,$2,$3,now()+interval '1 hour')`, [tokenHash(token), viewer, randomUUID()]);
        return post('/v1/phone/operations/updateAgentWake', { workspaceId: WORKSPACE, agentId: member, url, ...(key ? { key } : {}) },
          { authorization: 'Bearer ' + token });
      };
      expect((await operation(OTHER, 'attacker-key')).status).toBe(403);
      if (path === 'profile') {
        const saved = await operation(USER, ' bearer ' + secret + ' ');
        expect(saved.status).toBe(200);
        expect(JSON.stringify(await saved.json())).not.toContain(secret);
      }
      const stored = (await db.query<{ callback_secret: string }>('SELECT callback_secret FROM rooms_mcp_members WHERE member_id=$1', [member])).rows[0]!;
      expect(openSecrets<string>('local-wake-test-key', stored.callback_secret)).toBe(secret);
      expect((await operation(USER, 'Bearer bad token')).status).toBe(400);
      const profile = await phone.readAgent(WORKSPACE, member, USER);
      expect(profile?.wake).toEqual({ url: 'https://hooks.example/wake', keySet: true });
      expect(JSON.stringify(profile)).not.toContain(secret);
      expect((await phone.readAgent(WORKSPACE, member, OTHER))?.wake).toBeUndefined();
      const handle = (await db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
      const sent = await phone.execute('sendRoomMessage', { roomId: ROOM, text: '@' + handle + ' hello' }, USER);
      expect((await db.query('SELECT 1 FROM rooms_mcp_webhook_outbox WHERE member_id=$1 AND message_id=$2', [member, sent.messageId])).rowCount).toBe(1);
      const received: Array<{ url: string; authorization: string | null }> = [];
      await deliverMcpMemberWebhooks(db, async (url, init) => {
        if (url === 'https://hooks.example/wake') received.push({ url, authorization: new Headers(init.headers).get('authorization') });
        return new Response('', { status: 200 });
      });
      expect(received).toEqual([{ url: 'https://hooks.example/wake', authorization: 'Bearer ' + secret }]);
      expect(JSON.stringify([...warn.mock.calls, ...log.mock.calls])).not.toContain(secret);
      const cleared = await operation(USER, undefined, '');
      expect(cleared.status).toBe(200);
      expect((await cleared.json() as { wake: unknown }).wake).toEqual({ url: null, keySet: false });
      expect((await operation(USER, secret, 'http://localhost/wake')).status).toBe(400);
      expect(JSON.stringify([...warn.mock.calls, ...log.mock.calls, ...errors.mock.calls])).not.toContain(secret);
    } finally { warn.mockRestore(); log.mockRestore(); errors.mockRestore(); vi.unstubAllEnvs(); }
  });
  it('R-MCP-SIGNIN-LEDGER: records an exchanged ticket when browser sign-in reaches MCP consent', async () => {
    const flowHash = tokenHash(opaque());
    const at = new Date(), expiresAt = new Date(at.getTime() + 120_000);
    await recordSigninAttempt(db, { stage: 'started', provider: 'google', flowHash, at, expiresAt });
    await recordSigninAttempt(db, { stage: 'provider_returned', flowHash, at });
    await recordSigninAttempt(db, { stage: 'ticket_issued', flowHash, ticketHash: tokenHash('local-demo-ticket'), at, expiresAt });
    await authorize();
    const rows = await db.query(`SELECT stage FROM signin_attempt_events WHERE attempt_id=(
      SELECT attempt_id FROM signin_attempt_correlations WHERE flow_hash=$1)`, [flowHash]);
    expect(rows.rows.map(row => row.stage).sort())
      .toEqual(['provider_returned', 'started', 'ticket_exchanged', 'ticket_issued']);
  });
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
    expect(metadata).toMatchObject({ code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'] });
    expect(await (await fetch(origin + '/.well-known/oauth-authorization-server/mcp')).json()).toEqual(metadata);
    const resource = await (await fetch(origin + '/.well-known/oauth-protected-resource/mcp')).json();
    expect(resource).toMatchObject({ resource: origin + '/mcp', authorization_servers: [origin] });
    expect(await (await fetch(origin + '/.well-known/oauth-protected-resource')).json()).toEqual(resource);
  });
  it('logs each refused registration once with its reason and non-secret metadata', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const refused = [
        ['javascript:alert(1)', 'invalid_redirect_uri'], ['data:text/html,x', 'invalid_redirect_uri'], ['file:///tmp/cb', 'invalid_redirect_uri'],
        ['vbscript:x', 'invalid_redirect_uri'], ['http://client.example/cb', 'invalid_redirect_uri'], ['https://client.example/cb#x', 'invalid_redirect_uri'],
        ['https://user:pw@client.example/cb', 'invalid_redirect_uri'], ['cursor://anysphere.cursor-mcp/cb#x', 'invalid_redirect_uri'], ['not a uri', 'invalid_redirect_uri'],
        ...['blob:https://x/y', 'about:blank', 'filesystem:https://x/y', 'ftp://x/cb', 'mailto:a@b', 'intent://cb', 'cursor://user:pw@host/cb', 'cursor://host/cb#', ' cursor://host/cb', 'cursor://host/\ncb'].map(uri => [uri, 'invalid_redirect_uri']),
      ];
      for (const [uri, error] of refused) {
        warn.mockClear();
        const response = await post('/mcp/oauth/register', { client_name: 'Refused', redirect_uris: [uri] });
        expect([uri, response.status, await response.json()]).toEqual([uri, 400, { error }]);
        expect(warn).toHaveBeenCalledTimes(1);
      }
      warn.mockClear();
      const method = await post('/mcp/oauth/register', { client_name: 'Hosted bot', redirect_uris: ['https://user:secret-user@bot.example/oauth/cb?x=secret-path'], token_endpoint_auth_method: 'private_key_jwt', grant_types: ['authorization_code', 'client_credentials'] });
      expect([method.status, await method.json()]).toEqual([400, { error: 'invalid_client_metadata' }]);
      expect(warn).toHaveBeenCalledTimes(1);
      const [label, line] = warn.mock.calls[0] as [string, string];
      expect(label).toBe('[rooms-mcp-oauth] registration refused');
      expect(JSON.parse(line)).toEqual({ error: 'invalid_client_metadata', client_name: 'Hosted bot', redirect_uris: ['https://bot.example'],
        token_endpoint_auth_method: 'private_key_jwt', grant_types: ['authorization_code', 'client_credentials'] });
      expect(line).not.toContain('secret-path');
      expect(line).not.toContain('secret-user');
      for (const invalid of [{ redirect_uris: [] }, { redirect_uris: Array(11).fill('https://bot.example/cb') }, { redirect_uris: 'https://bot.example/cb' },
        { grant_types: ['client_credentials'] }, { grant_types: 'authorization_code' }, { response_types: ['token'] }, { response_types: 'code' }, { client_name: '' }, { webhook_uri: 'http://bot.example/cb' }]) {
        warn.mockClear();
        expect((await post('/mcp/oauth/register', { redirect_uris: ['https://bot.example/cb'], ...invalid })).status).toBe(400);
        expect(warn).toHaveBeenCalledTimes(1);
      }
      warn.mockClear();
      expect((await fetch(origin + '/mcp/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"client_secret":"leak' })).status).toBe(400);
      expect(warn.mock.calls[0]![1]).toContain('invalid_json');
      expect(warn.mock.calls[0]![1]).not.toContain('leak');
    } finally { warn.mockRestore(); }
  });
  it('logs admission refusals once without reading or logging a rate-limited body', async () => {
    await db.query('INSERT INTO rooms_mcp_admission(key,calls) VALUES($1,300)', [tokenHash('127.0.0.1')]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const response = await post('/mcp/oauth/register', { client_secret: 'never-log-this' });
      expect([response.status, await response.json()]).toEqual([429, { error: 'temporarily_unavailable' }]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('[rooms-mcp-oauth] registration refused', JSON.stringify({ error: 'temporarily_unavailable' }));
      warn.mockClear();
      const token = await fetch(origin + '/mcp/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic c2VjcmV0LWlkOnNlY3JldC12YWx1ZQ==' },
        body: 'grant_type=authorization_code&code=code-never-log&code_verifier=verifier-never-log' });
      expect([token.status, await token.json()]).toEqual([429, { error: 'temporarily_unavailable' }]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('[rooms-mcp-oauth] token refused', JSON.stringify({ error: 'temporarily_unavailable', reason: 'rate_limited',
        client_auth: 'basic', content_type: 'application/x-www-form-urlencoded' }));
    } finally { warn.mockRestore(); }
  });
  it.each(['https://example.com/cb', 'http://127.0.0.1:9876/cb', 'http://[::1]:9876/cb', 'http://localhost:9876/cb'])(
    'keeps accepting web and loopback redirect %s without issuing a secret', async redirect => {
      const response = await post('/mcp/oauth/register', { redirect_uris: [redirect] });
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ token_endpoint_auth_method: 'none', redirect_uris: [redirect] });
    });
  it('registers a client whose logo cannot be loaded and keeps the bundled logo', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const [name, logo_uri, stored] of [['Cursor', 'https://127.0.0.1/favicon.svg', 'data:image/png;base64,'], ['Grok Bot', 'http://grok.example/logo.png', 'data:image/png;base64,'], ['Cursor', 42, 'data:image/png;base64,']] as const) {
        warn.mockClear();
        const response = await post('/mcp/oauth/register', { client_name: name, logo_uri, redirect_uris: ['https://www.cursor.com/callback'], token_endpoint_auth_method: 'none' });
        expect(response.status).toBe(201);
        const { client_id } = await response.json() as { client_id: string };
        const { logo } = (await db.query<{ logo: string | null }>('SELECT logo FROM rooms_mcp_clients WHERE id=$1', [client_id])).rows[0]!;
        if (stored) expect(logo).toMatch(/^data:image\/png;base64,/); else expect(logo).toBeNull();
        expect(warn).toHaveBeenCalledWith('[rooms-mcp-oauth] registration logo skipped', expect.stringContaining(name));
      }
    } finally { warn.mockRestore(); }
  });
  it('signs in a native client through a private-use redirect scheme', async () => {
    for (const redirect of ['cursor://anysphere.cursor-mcp/oauth/callback', 'com.example.app:/oauth/callback']) {
    const registered = await post('/mcp/oauth/register', { client_name: 'Cursor', redirect_uris: [redirect] });
    expect(registered.status).toBe(201);
    const { client_id } = await registered.json() as { client_id: string };
    const grant = await authorize(undefined, 'allow', client_id, redirect);
    expect((await exchange(grant, { redirect_uri: redirect })).status).toBe(200);
    }
  });
  it('issues and requires a client secret for client_secret_post and client_secret_basic', async () => {
    for (const method of ['client_secret_post', 'client_secret_basic']) {
      const registered = await post('/mcp/oauth/register', { client_name: 'Hosted bot', redirect_uris: ['https://bot.example/oauth/cb'], token_endpoint_auth_method: method });
      expect(registered.status).toBe(201);
      const client = await registered.json() as { client_id: string; client_secret: string; token_endpoint_auth_method: string; client_secret_expires_at: number };
      expect(client).toMatchObject({ token_endpoint_auth_method: method, client_secret_expires_at: 0 });
      expect(client.client_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const stored = (await db.query<{ secret_hash: string }>('SELECT secret_hash FROM rooms_mcp_clients WHERE id=$1', [client.client_id])).rows[0]!.secret_hash;
      expect(stored).toBe(tokenHash(client.client_secret));
      const basic = (id: string, secret: string) => ({ authorization: 'Basic ' + Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64') });
      const auth = method === 'client_secret_post'
        ? { body: { client_secret: client.client_secret }, headers: {} }
        : { body: {}, headers: basic(client.client_id, client.client_secret) };
      const grant = await authorize(undefined, 'allow', client.client_id, 'https://bot.example/oauth/cb');
      const tokenBody = { grant_type: 'authorization_code', client_id: client.client_id, code: grant.code, code_verifier: grant.verifier, redirect_uri: 'https://bot.example/oauth/cb', resource: origin + '/mcp' };
      for (const wrong of [{ body: {}, headers: {} }, { body: { client_secret: 'wrong' }, headers: {} }, { body: {}, headers: basic(client.client_id, 'wrong') }]) {
        const refused = await post('/mcp/oauth/token', { ...tokenBody, ...wrong.body }, wrong.headers);
        expect([refused.status, await refused.json()]).toEqual([401, { error: 'invalid_client' }]);
      }
      const otherMethod = method === 'client_secret_post' ? { body: {}, headers: basic(client.client_id, client.client_secret) } : { body: { client_secret: client.client_secret }, headers: {} };
      expect((await post('/mcp/oauth/token', { ...tokenBody, ...otherMethod.body }, otherMethod.headers)).status).toBe(401);
      expect((await post('/mcp/oauth/token', { ...tokenBody, client_secret: client.client_secret }, basic(client.client_id, client.client_secret))).status).toBe(401);
      expect((await post('/mcp/oauth/token', tokenBody, { authorization: 'Basic ' + Buffer.from('%broken:secret').toString('base64') })).status).toBe(401);
      for (const mismatch of [{ code_verifier: opaque() }, { resource: origin + '/other' }, { redirect_uri: 'https://evil.example/cb' }]) {
        expect((await post('/mcp/oauth/token', { ...tokenBody, ...auth.body, ...mismatch }, auth.headers)).status).toBe(400);
      }
      const issued = await post('/mcp/oauth/token', { ...tokenBody, ...auth.body }, auth.headers);
      expect(issued.status).toBe(200);
      const tokens = await issued.json() as { access_token: string; refresh_token: string };
      const refresh = { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id, resource: origin + '/mcp' };
      expect((await post('/mcp/oauth/token', refresh)).status).toBe(401);
      const refreshed = await post('/mcp/oauth/token', { ...refresh, ...auth.body }, auth.headers);
      expect(refreshed.status).toBe(200);
      const next = await refreshed.json() as typeof tokens;
      expect((await post('/mcp/oauth/revoke', { token: next.access_token, client_id: client.client_id })).status).toBe(401);
      expect((await post('/mcp/oauth/revoke', { token: next.access_token, client_id: client.client_id, ...auth.body }, auth.headers)).status).toBe(200);
      expect((await fetch(origin + '/mcp', { headers: { authorization: `Bearer ${next.access_token}` } })).status).toBe(401);
    }
    const publicGrant = await authorize();
    const withSecret = await exchange(publicGrant, { client_secret: 'unexpected' });
    expect(withSecret.status).toBe(401);
    expect((await exchange(publicGrant)).status).toBe(200);
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
  it('R1: starts sign-in when Cursor omits resource or sends the origin or a trailing slash, and refuses other hosts', async () => {
    const registered = await (await post('/mcp/oauth/register', { client_name: 'Cursor', redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback'], token_endpoint_auth_method: 'none' })).json() as { client_id: string };
    const start = (resource?: string) => fetch(origin + '/mcp/oauth/authorize?' + new URLSearchParams({ client_id: registered.client_id, redirect_uri: 'cursor://anysphere.cursor-mcp/oauth/callback',
      response_type: 'code', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(opaque()).digest('base64url'), state: 'r1-state', ...(resource === undefined ? {} : { resource }) }), { redirect: 'manual' });
    for (const resource of [undefined, origin + '/mcp', origin + '/mcp/', origin, origin + '/']) {
      const response = await start(resource);
      expect([resource, response.status, response.headers.get('location')?.startsWith('/mcp/oauth/consent?flow=')]).toEqual([resource, 302, true]);
    }
    for (const resource of ['https://other.example/mcp', 'https://other.example', origin + '/other'])
      expect([resource, (await start(resource)).status]).toEqual([resource, 400]);
  });
  it('logs each refused browser sign-in step with its reason, never parameter values', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const registered = await (await post('/mcp/oauth/register', { client_name: 'Logged', redirect_uris: ['https://client.example/callback'] })).json() as { client_id: string };
      const challenge = createHash('sha256').update(opaque()).digest('base64url');
      const base = { client_id: registered.client_id, redirect_uri: 'https://client.example/callback', response_type: 'code', code_challenge_method: 'S256',
        code_challenge: challenge, state: 'state-sentinel-123', resource: origin + '/mcp' };
      const refused = async (step: string, reason: string, response: Response, params?: string[]) => {
        expect([step, reason, response.status]).toEqual([step, reason, 400]);
        expect(warn).toHaveBeenCalledTimes(1);
        const [label, line] = warn.mock.calls[0] as [string, string];
        expect(label).toBe(`[rooms-mcp-oauth] ${step} refused`);
        expect(JSON.parse(line)).toEqual({ error: 'invalid_request', reason, ...(params ? { params } : {}) });
        for (const value of [registered.client_id, challenge, 'state-sentinel-123', 'client.example', 'evil.example', 'flow-sentinel-123', 'cookie-sentinel-123', 'ticket-sentinel-123'])
          expect(line).not.toContain(value);
        warn.mockClear();
      };
      const authorizeCases: [Record<string, string>, string][] = [
        [{ ...base, resource: 'https://evil.example/mcp' }, 'resource_mismatch'],
        [{ ...base, code_challenge: 'short' }, 'pkce_invalid'],
        [{ ...base, client_id: 'unknown-client' }, 'client_unknown'],
        [{ ...base, redirect_uri: 'https://evil.example/callback' }, 'redirect_uri_unregistered'],
        [{ ...base, response_type: 'token' }, 'response_type_invalid'],
      ];
      for (const [input, reason] of authorizeCases)
        await refused('authorize', reason, await fetch(origin + '/mcp/oauth/authorize?' + new URLSearchParams(input), { redirect: 'manual' }), Object.keys(input).sort());
      await refused('authorize', 'duplicate_parameter', await fetch(origin + '/mcp/oauth/authorize?' + new URLSearchParams(base) + '&state=state-sentinel-123', { redirect: 'manual' }), Object.keys(base).sort());
      const stale = { cookie: 'beeline_mcp=cookie-sentinel-123' };
      await refused('login', 'flow_missing_or_expired', await fetch(`${origin}/mcp/oauth/login?flow=flow-sentinel-123&provider=google`, { headers: stale, redirect: 'manual' }));
      await refused('callback', 'flow_missing_or_expired', await fetch(`${origin}/mcp/oauth/callback/google?state=flow-sentinel-123&ticket=ticket-sentinel-123`, { headers: stale, redirect: 'manual' }));
      await refused('consent', 'flow_missing_or_expired', await fetch(`${origin}/mcp/oauth/consent?flow=flow-sentinel-123`, { headers: stale }));
      await refused('consent submit', 'origin_mismatch', await post('/mcp/oauth/consent', { flow: 'flow-sentinel-123', decision: 'allow' }, { ...stale, origin: 'https://evil.example' }));
      await refused('consent submit', 'flow_missing_or_expired', await post('/mcp/oauth/consent', { flow: 'flow-sentinel-123', decision: 'allow' }, { ...stale, origin }));
      // A live flow names the later branches too.
      const start = await fetch(origin + '/mcp/oauth/authorize?' + new URLSearchParams(base), { redirect: 'manual' });
      const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
      const flow = new URL(start.headers.get('location')!, origin).searchParams.get('flow')!;
      const scrub = async (step: string, reason: string, response: Response) => {
        expect(JSON.parse((warn.mock.calls[0] as [string, string])[1])).not.toHaveProperty('flow');
        expect((warn.mock.calls[0] as [string, string])[1]).not.toContain(flow);
        expect((warn.mock.calls[0] as [string, string])[1]).not.toContain(cookie.slice(12));
        await refused(step, reason, response);
      };
      let response = await fetch(`${origin}/mcp/oauth/login?flow=${flow}&provider=other`, { headers: { cookie }, redirect: 'manual' });
      await scrub('login', 'provider_invalid', response);
      response = await post('/mcp/oauth/consent', { flow, decision: 'allow', workspace_selection: '1', workspace_ids: [WORKSPACE] }, { cookie, origin });
      await scrub('consent submit', 'flow_not_signed_in', response);
      await fetch(`${origin}/mcp/oauth/login?flow=${flow}&provider=google`, { headers: { cookie }, redirect: 'manual' });
      response = await fetch(`${origin}/mcp/oauth/callback/github?state=${flow}&ticket=ticket-sentinel-123`, { headers: { cookie }, redirect: 'manual' });
      await scrub('callback', 'provider_mismatch', response);
      response = await fetch(`${origin}/mcp/oauth/callback/google?state=${flow}&ticket=ticket-sentinel-123`, { headers: { cookie }, redirect: 'manual' });
      await scrub('callback', 'ticket_exchange_failed', response);
      expect((await fetch(`${origin}/mcp/oauth/callback/google?state=${flow}&ticket=local-demo-ticket`, { headers: { cookie }, redirect: 'manual' })).status).toBe(302);
      response = await post('/mcp/oauth/consent', { flow, decision: 'maybe' }, { cookie, origin });
      await scrub('consent submit', 'decision_invalid', response);
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
  it('R1: shows each refused browser step as a page naming the step and reason, never JSON or request values', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const registered = await (await post('/mcp/oauth/register', { client_name: 'Shown', redirect_uris: ['https://client.example/callback'] })).json() as { client_id: string };
      const challenge = createHash('sha256').update(opaque()).digest('base64url');
      const base = { client_id: registered.client_id, redirect_uri: 'https://client.example/callback', response_type: 'code', code_challenge_method: 'S256',
        code_challenge: challenge, state: 'state-sentinel-123', resource: origin + '/mcp' };
      const shown = new Set<string>();
      const page = async (label: string, step: string, reason: string, response: Response) => {
        const body = await response.text();
        expect([reason, response.status, response.headers.get('content-type')]).toEqual([reason, 400, 'text/html; charset=utf-8']);
        expect(body).toContain(`<p class="head">${label}</p>`);
        expect(body).toContain(BROWSER_REFUSALS[reason]!.replace(/'/g, '&#39;'));
        expect(body).toMatch(new RegExp(`Reference: ${step} · ${reason} · \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ`));
        for (const value of [registered.client_id, challenge, 'state-sentinel-123', 'client.example', 'evil.example', 'flow-sentinel-123', 'cookie-sentinel-123', 'ticket-sentinel-123', 'Bad Handle!', 'private-wake-sentinel'])
          expect(body).not.toContain(value);
        shown.add(reason);
      };
      const authorize = (input: Record<string, string>, extra = '') => fetch(origin + '/mcp/oauth/authorize?' + new URLSearchParams(input) + extra, { redirect: 'manual' });
      const authorizeCases: [Record<string, string>, string, string?][] = [
        [base, 'query_too_long', `&pad=${'x'.repeat(8200)}`],
        [{ ...base, state: 'x'.repeat(2100) }, 'state_too_long'],
        [base, 'duplicate_parameter', '&state=state-sentinel-123'],
        [{ ...base, response_type: 'token' }, 'response_type_invalid'],
        [{ ...base, code_challenge: 'short' }, 'pkce_invalid'],
        [{ ...base, resource: 'https://evil.example/mcp' }, 'resource_mismatch'],
        [{ ...base, client_id: 'unknown-client' }, 'client_unknown'],
        [{ ...base, redirect_uri: 'https://evil.example/callback' }, 'redirect_uri_unregistered'],
        [{ ...base, scope: 'rooms:admin' }, 'scope_invalid'],
      ];
      for (const [input, reason, extra] of authorizeCases) await page('Starting the connection', 'authorize', reason, await authorize(input, extra));
      // An unexpected failure still names its step.
      vi.spyOn(db, 'query').mockRejectedValueOnce(new Error('database offline'));
      await page('Starting the connection', 'authorize', 'invalid_parameter', await authorize(base));
      const stale = { cookie: 'beeline_mcp=cookie-sentinel-123' };
      await page('Choosing how to sign in', 'login', 'flow_missing_or_expired', await fetch(`${origin}/mcp/oauth/login?flow=flow-sentinel-123&provider=google`, { headers: stale, redirect: 'manual' }));
      await page('Showing what the app can do', 'consent', 'flow_missing_or_expired', await fetch(`${origin}/mcp/oauth/consent?flow=flow-sentinel-123`, { headers: stale }));
      const submit = (body: string, headers: Record<string, string>) => fetch(origin + '/mcp/oauth/consent', { method: 'POST', redirect: 'manual', headers, body });
      const form = { 'content-type': 'application/x-www-form-urlencoded', origin };
      await page('Saving your choice', 'consent submit', 'origin_mismatch', await post('/mcp/oauth/consent', { flow: 'flow-sentinel-123', decision: 'allow' }, { ...stale, origin: 'https://evil.example' }));
      await page('Saving your choice', 'consent submit', 'flow_missing_or_expired', await post('/mcp/oauth/consent', { flow: 'flow-sentinel-123', decision: 'allow' }, { ...stale, origin }));
      await page('Saving your choice', 'consent submit', 'body_too_large', await submit(`flow=${'x'.repeat(40_000)}`, form));
      await page('Saving your choice', 'consent submit', 'duplicate_parameter', await submit('flow=flow-sentinel-123&flow=flow-sentinel-123', form));
      await page('Saving your choice', 'consent submit', 'body_not_object', await submit('[]', { 'content-type': 'application/json', origin }));
      await page('Saving your choice', 'consent submit', 'invalid_json', await submit('flow-sentinel-123', { 'content-type': 'application/json', origin }));
      // A live flow reaches the later branches.
      const start = await authorize(base);
      const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
      const flow = new URL(start.headers.get('location')!, origin).searchParams.get('flow')!;
      const callback = (provider: string, ticket?: string) => fetch(`${origin}/mcp/oauth/callback/${provider}?state=${flow}${ticket ? `&ticket=${ticket}` : ''}`, { headers: { cookie }, redirect: 'manual' });
      await page('Choosing how to sign in', 'login', 'provider_invalid', await fetch(`${origin}/mcp/oauth/login?flow=${flow}&provider=other`, { headers: { cookie }, redirect: 'manual' }));
      await page('Saving your choice', 'consent submit', 'flow_not_signed_in', await post('/mcp/oauth/consent', { flow, decision: 'allow', workspace_selection: '1', workspace_ids: [WORKSPACE] }, { cookie, origin }));
      await fetch(`${origin}/mcp/oauth/login?flow=${flow}&provider=google`, { headers: { cookie }, redirect: 'manual' });
      await page('Signing in with Google', 'callback', 'ticket_missing', await callback('google'));
      await page('Signing in with GitHub', 'callback', 'provider_mismatch', await callback('github', 'ticket-sentinel-123'));
      await page('Signing in with Google', 'callback', 'ticket_exchange_failed', await callback('google', 'ticket-sentinel-123'));
      expect((await callback('google', 'local-demo-ticket')).status).toBe(302);
      await page('Signing in with Google', 'callback', 'flow_already_signed_in', await callback('google', 'local-demo-ticket'));
      await page('Saving your choice', 'consent submit', 'joiner_invalid', await post('/mcp/oauth/consent', { flow, decision: 'save', joiner_name: 'Shown', joiner_handle: 'Bad Handle!' }, { cookie, origin }));
      await page('Saving your choice', 'consent submit', 'decision_invalid', await post('/mcp/oauth/consent', { flow, decision: 'maybe' }, { cookie, origin }));
      await page('Saving your choice', 'consent submit', 'wake_invalid',
        await post('/mcp/oauth/consent', { flow, decision: 'allow', workspace_selection: '1', workspace_ids: [WORKSPACE], wake_url: 'http://localhost', wake_key: 'private-wake-sentinel' }, { cookie, origin }));
      const previousKey = process.env.BEELINE_MCP_WEBHOOK_KEY;
      delete process.env.BEELINE_MCP_WEBHOOK_KEY;
      try {
        await page('Saving your choice', 'consent submit', 'wake_unavailable',
          await post('/mcp/oauth/consent', { flow, decision: 'allow', workspace_selection: '1', workspace_ids: [WORKSPACE], wake_url: 'https://hooks.example/wake', wake_key: 'private-wake-sentinel' }, { cookie, origin }));
        expect((await db.query('SELECT 1 FROM rooms_mcp_members WHERE client_id=$1', [registered.client_id])).rowCount).toBe(0);
      } finally {
        if (previousKey === undefined) delete process.env.BEELINE_MCP_WEBHOOK_KEY;
        else process.env.BEELINE_MCP_WEBHOOK_KEY = previousKey;
      }
      await page('Saving your choice', 'consent submit', 'workspaces_invalid',
        await post('/mcp/oauth/consent', { flow, decision: 'allow', workspace_selection: '1', workspace_ids: [] }, { cookie, origin }));
      const takenHandle = (await db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [USER])).rows[0]!.handle;
      expect((await post('/mcp/oauth/consent', { flow, decision: 'save', joiner_name: 'Shown', joiner_handle: takenHandle }, { cookie, origin })).status).toBe(302);
      await page('Saving your choice', 'consent submit', 'handle_taken',
        await post('/mcp/oauth/consent', { flow, decision: 'allow', workspace_selection: '1', workspace_ids: [WORKSPACE] }, { cookie, origin }));
      await page('Returning to your session', 'handoff', 'handoff_invalid', await fetch(`${origin}/mcp/oauth/handoff?state=state-sentinel-123&code=x`));
      // Every sentence is driven by a real refusal, and each reason reads differently.
      expect([...shown].sort()).toEqual(Object.keys(BROWSER_REFUSALS).sort());
      expect(new Set(Object.values(BROWSER_REFUSALS)).size).toBe(Object.keys(BROWSER_REFUSALS).length);
      // Client endpoints keep the OAuth JSON error.
      const token = await post('/mcp/oauth/token', { grant_type: 'password', resource: origin + '/mcp' });
      expect([token.status, token.headers.get('content-type'), await token.json()]).toEqual([400, 'application/json', { error: 'unsupported_grant_type' }]);
    } finally { vi.restoreAllMocks(); }
  });
  it('has a page sentence for every reason a browser step can refuse with', () => {
    const source = readFileSync(new URL('./rooms-mcp-oauth.ts', import.meta.url), 'utf8');
    const section = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
    // The browser branches, plus the body reader and flow lookup they call.
    const browser = section("path === '/mcp/oauth/authorize') {", "path === '/mcp/oauth/token') {")
      + section('export async function mcpBody(', 'function string(') + section('private async flow(', 'private async client(');
    const reasons = [...browser.matchAll(/new Refusal\([^,]+, '([a-z_]+)'/g)].map(match => match[1]!);
    expect(reasons.length).toBeGreaterThan(20);
    expect(reasons.filter(reason => !BROWSER_REFUSALS[reason])).toEqual([]);
  });
  it('binds single-use authorization codes to the client, redirect, verifier and resource', async () => {
    const grant = await authorize();
    for (const overrides of [{ code_verifier: opaque() }, { client_id: 'other' }, { redirect_uri: 'https://evil.example' }, { resource: origin + '/other' }]) {
      expect((await exchange(grant, overrides)).status).toBe(400);
    }
    expect((await exchange(grant)).status).toBe(200);
    expect((await exchange(grant)).status).toBe(400);
  });
  it('MCP-TOKEN-1: exchanges a code without resource or redirect_uri, as Cursor sends it', async () => {
    const grant = await authorize();
    const response = await exchange(grant, { resource: undefined, redirect_uri: undefined });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token_type: 'Bearer' });
  });
  it('accepts the server origin or MCP URL as resource, with or without a trailing slash, and refuses other hosts', async () => {
    for (const resource of [origin, origin + '/', origin + '/mcp/']) {
      expect([resource, (await exchange(await authorize(), { resource })).status]).toEqual([resource, 200]);
    }
    const grant = await authorize();
    for (const overrides of [{ resource: 'https://other.example/mcp' }, { resource: 'https://other.example' }, { redirect_uri: 'http://127.0.0.1:9876/other' }]) {
      expect((await exchange(grant, overrides)).status).toBe(400);
    }
    expect((await exchange(grant)).status).toBe(200);
  });
  it('keeps an authorization code valid for ten minutes', async () => {
    const grant = await authorize();
    await db.query("UPDATE rooms_mcp_codes SET expires_at=expires_at-interval '5 minutes' WHERE hash=$1", [tokenHash(grant.code!)]);
    expect((await exchange(grant)).status).toBe(200);
    const late = await authorize();
    await db.query("UPDATE rooms_mcp_codes SET expires_at=expires_at-interval '10 minutes' WHERE hash=$1", [tokenHash(late.code!)]);
    expect((await exchange(late)).status).toBe(400);
  });
  it('logs each refused token request with parameter names and reason, never values', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const grant = await authorize();
      const form = (input: Record<string, string>, headers: Record<string, string> = {}) => fetch(origin + '/mcp/oauth/token', { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(input).toString() });
      const base = { grant_type: 'authorization_code', client_id: grant.clientId, code: grant.code!, code_verifier: grant.verifier };
      const cases: [Record<string, string>, Record<string, string>, string, string][] = [
        [{ ...base, redirect_uri: 'http://127.0.0.1:9876/other' }, {}, 'invalid_grant', 'redirect_uri_mismatch'],
        [{ ...base, resource: 'https://other.example/mcp' }, {}, 'invalid_grant', 'resource_mismatch'],
        [{ ...base, code_verifier: opaque() }, {}, 'invalid_grant', 'code_verifier_mismatch'],
        [{ ...base, code_verifier: 'short' }, {}, 'invalid_grant', 'code_verifier_invalid'],
        [{ ...base, code: opaque() }, {}, 'invalid_grant', 'code_unknown_or_used'],
        [{ ...base, client_secret: 'secret-value-123' }, {}, 'invalid_client', 'client_secret_unexpected'],
        [{ grant_type: 'refresh_token', client_id: grant.clientId, refresh_token: 'refresh-value-123' }, {}, 'invalid_grant', 'refresh_token_invalid'],
        [{ grant_type: 'password', client_id: grant.clientId }, {}, 'unsupported_grant_type', 'grant_type_unsupported'],
        // A client-chosen grant_type or content-type never reaches the log verbatim.
        [{ grant_type: 'grant-sentinel-123', client_id: grant.clientId, client_secret: 'grant-sentinel-123' }, { 'content-type': 'application/x-www-form-urlencoded; x=y', 'x-ignored': 'z' }, 'unsupported_grant_type', 'grant_type_unsupported'],
      ];
      for (const [input, headers, error, reason] of cases) {
        warn.mockClear();
        const response = await form(input, headers);
        expect([reason, response.status, (await response.json() as { error: string }).error]).toEqual([reason, error === 'invalid_client' ? 401 : 400, error]);
        expect(warn).toHaveBeenCalledTimes(1);
        const [label, line] = warn.mock.calls[0] as [string, string];
        expect(label).toBe('[rooms-mcp-oauth] token refused');
        const grantType = ['authorization_code', 'refresh_token'].includes(input.grant_type!) ? input.grant_type : 'other';
        expect(JSON.parse(line)).toMatchObject({ error, reason, grant_type: grantType, params: Object.keys(input).sort(), content_type: 'application/x-www-form-urlencoded' });
        for (const secret of [grant.code!, grant.verifier, 'secret-value-123', 'refresh-value-123', 'grant-sentinel-123', 'password', input.code_verifier!, input.code!].filter(Boolean))
          expect(line).not.toContain(secret);
      }
      // A JSON grant_type that cannot become a string still gets an OAuth error and one log line.
      warn.mockClear();
      const odd = await fetch(origin + '/mcp/oauth/token', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: { toString: null }, client_id: grant.clientId }) });
      expect([odd.status, (await odd.json() as { error: string }).error]).toEqual([400, 'unsupported_grant_type']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(warn.mock.calls[0]![1] as string)).toMatchObject({ error: 'unsupported_grant_type', reason: 'grant_type_unsupported', grant_type: 'other',
        params: ['client_id', 'grant_type'], content_type: 'application/json' });
      // A body refused before parsing still logs its parameter names and the exact branch, never the values.
      warn.mockClear();
      const duplicate = await fetch(origin + '/mcp/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=dup-one-123&code=dup-two-123&client_id=${grant.clientId}&code_verifier=dup-verifier-123` });
      expect([duplicate.status, (await duplicate.json() as { error: string }).error]).toEqual([400, 'invalid_request']);
      expect(warn).toHaveBeenCalledTimes(1);
      const duplicateLine = warn.mock.calls[0]![1] as string;
      expect(JSON.parse(duplicateLine)).toMatchObject({ error: 'invalid_request', reason: 'duplicate_parameter',
        params: ['client_id', 'code', 'code_verifier', 'grant_type'], content_type: 'application/x-www-form-urlencoded' });
      for (const value of ['dup-one-123', 'dup-two-123', 'dup-verifier-123', grant.clientId]) expect(duplicateLine).not.toContain(value);
      warn.mockClear();
      expect((await exchange(grant)).status).toBe(200);
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
  it('does not grant on denial, replayed consent or a missing browser binding', async () => {
    const grant = await authorize(undefined, 'deny');
    expect(grant.code).toBeNull(); expect(grant.error).toBe('access_denied');
    expect((await post('/mcp/oauth/consent', { flow: grant.flow, decision: 'allow' }, { cookie: grant.cookie, origin })).status).toBe(400);
    expect((await fetch(`${origin}/mcp/oauth/consent?flow=${grant.flow}`)).status).toBe(400);
  });
  it('R1: explains a taken consent handle without granting or changing the existing member', async () => {
    const existing = await connected();
    const handle = `pidoong_${randomBytes(4).toString('hex')}`;
    await existing.client.callTool({ name: 'set_profile', arguments: { name: 'Pidoong', handle } });
    const client = await (await post('/mcp/oauth/register', { client_name: 'ChatGPT', redirect_uris: ['http://127.0.0.1:9876/callback'] })).json() as { client_id: string };
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'http://127.0.0.1:9876/callback', response_type: 'code',
      code_challenge: createHash('sha256').update(opaque()).digest('base64url'), code_challenge_method: 'S256', scope: 'rooms:read rooms:write', state: 'collision' });
    const start = await fetch(origin + '/mcp/oauth/authorize?' + query, { redirect: 'manual' });
    const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
    const flow = new URL(start.headers.get('location')!, origin).searchParams.get('flow')!;
    await fetch(`${origin}/mcp/oauth/login?flow=${flow}&provider=google`, { headers: { cookie }, redirect: 'manual' });
    await fetch(`${origin}/mcp/oauth/callback/google?state=${flow}&ticket=local-demo-ticket`, { headers: { cookie }, redirect: 'manual' });
    expect((await post('/mcp/oauth/consent', { flow, decision: 'save', joiner_name: 'Pidoong', joiner_handle: handle }, { cookie, origin })).status).toBe(302);
    const refused = await post('/mcp/oauth/consent', { flow, decision: 'allow', workspace_selection: '1', workspace_ids: [WORKSPACE] }, { cookie, origin });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('Handle already taken');
    expect((await db.query('SELECT 1 FROM rooms_mcp_members WHERE client_id=$1', [client.client_id])).rowCount).toBe(0);
    expect((await db.query('SELECT 1 FROM rooms_mcp_codes WHERE client_id=$1', [client.client_id])).rowCount).toBe(0);
    expect((await db.query('SELECT handle FROM identities WHERE id=$1', [existing.member])).rows[0]!.handle).toBe(handle);
  });
  it('previews and edits the joining member on consent', async () => {
    const registered = await post('/mcp/oauth/register', { client_name: 'Grok Bot', redirect_uris: ['http://127.0.0.1:9876/callback'] });
    const client = await registered.json() as { client_id: string };
    const verifier = opaque();
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'http://127.0.0.1:9876/callback', response_type: 'code', resource: origin + '/mcp',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'rooms:read', state: 'edit-state' });
    const start = await fetch(origin + '/mcp/oauth/authorize?' + query, { redirect: 'manual' });
    const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
    const flow = new URL(start.headers.get('location')!, origin).searchParams.get('flow')!;
    await fetch(`${origin}/mcp/oauth/login?flow=${flow}&provider=google`, { headers: { cookie }, redirect: 'manual' });
    await fetch(`${origin}/mcp/oauth/callback/google?state=${flow}&ticket=local-demo-ticket`, { headers: { cookie }, redirect: 'manual' });
    const page = await (await fetch(`${origin}/mcp/oauth/consent?flow=${flow}`, { headers: { cookie } })).text();
    expect(page).toContain('Webhook URL (optional)'); expect(page).toContain('Auth token (optional)');
    expect(page).not.toMatch(/Wake (link|key)/);
    expect(page).toContain('Joins as'); expect(page).toContain('Add Grok Bot to your team');
    expect(page).toContain('Starter instructions');
    expect(page).toContain('id="copy-routine" type="button">Copy</button>');
    expect(page).toContain('<ol id="starter-routine" class="routine-text">');
    for (const step of MCP_STARTER_ROUTINE.split('\n\n')) {
      expect(page).toContain(`<li>${step.replace(/^\d+\. /, '').replaceAll("'", '&#39;')}</li>`);
    }
    expect(page).toMatch(/<script nonce="[A-Za-z0-9+/=]+">/);
    expect(page).toContain('Read public Rooms in selected Workspaces'); expect(page).toContain('It joins their public Rooms'); expect(page).toContain('Post as Grok Bot');
    // The real Beeline icon, never a letter stand-in.
    expect(page).toContain('<img class="mark" src="data:image/svg+xml;base64,'); expect(page).not.toContain('>b</span>');
    const editPage = await fetch(`${origin}/mcp/oauth/consent?flow=${flow}&edit=1`, { headers: { cookie } });
    expect(editPage.headers.get('referrer-policy')).toBe('same-origin');
    expect(editPage.headers.get('content-security-policy')).not.toContain('form-action');
    const edit = await editPage.text();
    expect(edit).toContain('name="joiner_name"');
    for (const untrustedOrigin of ['https://evil.example', 'null', undefined]) {
      for (const decision of ['save', 'allow', 'deny']) {
        expect((await post('/mcp/oauth/consent', { flow, decision, joiner_name: 'Attacker', joiner_handle: 'attacker' },
          { cookie, ...(untrustedOrigin ? { origin: untrustedOrigin } : {}) })).status).toBe(400);
      }
    }
    expect((await post('/mcp/oauth/consent', { flow, decision: 'save', joiner_name: 'Firstmate', joiner_handle: 'firstmate' }, { cookie, origin })).status).toBe(302);
    const renamed = await (await fetch(`${origin}/mcp/oauth/consent?flow=${flow}`, { headers: { cookie } })).text();
    expect(renamed).toContain('Firstmate'); expect(renamed).toContain('@firstmate');
    const allowed = await post('/mcp/oauth/consent', { flow, decision: 'allow', workspace_selection: '1', workspace_ids: [WORKSPACE] }, { cookie, origin });
    expect(allowed.status).toBe(302);
    const code = new URL(allowed.headers.get('location')!).searchParams.get('code')!;
    expect((await post('/mcp/oauth/token', { grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier, redirect_uri: 'http://127.0.0.1:9876/callback', resource: origin + '/mcp' })).status).toBe(200);
    const member = (await db.query<{ member_id: string }>('SELECT member_id FROM rooms_mcp_members WHERE owner_id=$1 AND client_id=$2', [USER, client.client_id])).rows[0]!.member_id;
    expect((await db.query<{ name: string; handle: string }>('SELECT name,handle FROM identities WHERE id=$1', [member])).rows[0]).toEqual({ name: 'Firstmate', handle: 'firstmate' });
  });
  it('repeats the saved starter wake rule in server, setup and webhook instructions', async () => {
    const { client } = await connected();
    const setup = data(await client.callTool({ name: 'list_rooms', arguments: {} })).setup;
    const send = (await client.listTools()).tools.find(tool => tool.name === 'send_message')!;
    expect(send.description).toContain("asking agent's exact @handle to wake it");
    for (const text of [client.getInstructions(), setup, MCP_TAG_INSTRUCTION]) {
      expect(text).toContain(MCP_STARTER_ROUTINE);
      expect(text).not.toContain('Tag another agent only to hand it a spelled-out job');
    }
  });
  it('connects a real SDK client, reads, searches, posts as the member and wakes an agent', async () => {
    const { client, token, grant, member } = await connected();
    const tools = await client.listTools(); expect(tools.tools).toHaveLength(9 + MCP_AGENT_TOOLS.length);
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
  it.each(['send_message', 'post'])('keeps the wake chain across member replies through %s so a tag loop still stops at the depth limit', async replyTool => {
    const { client, grant, member } = await connected();
    await db.query(`UPDATE rooms_mcp_clients SET callback_url='https://hooks.example/loop' WHERE id=$1`, [grant.clientId]);
    const handle = (await db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    const latestMemberCommand = async () => (await db.query<{ agent_depth: number }>(
      'SELECT agent_depth FROM agent_commands WHERE room_id=$1 AND agent_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
      [ROOM, member])).rows[0];
    const agentCommand = async (sourceMessageId: string) => (await db.query<{ id: string; turn_request_id: string; agent_depth: number }>(
      'SELECT id,turn_request_id,agent_depth FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND source_message_id=$3',
      [ROOM, AGENT, sourceMessageId])).rows[0]!;
    // A person's tag wakes the webhook without a helper turn.
    await phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} begin the handoff` }, USER);
    expect(await latestMemberCommand()).toBeUndefined();
    // The member replies through MCP and tags the demo agent: depth one, not a reset.
    const first = await client.callTool({ name: 'send_message', arguments: { room: ROOM, text: '@demo-agent step one' } });
    const firstId = JSON.parse((first.content as { text: string }[])[0]!.text).data.messageId as string;
    const firstCommand = await agentCommand(firstId);
    expect(firstCommand.agent_depth).toBe(1);
    // The demo agent answers, tagging the external member at depth two.
    await daemon.execute('claimAgentCommand', { roomId: ROOM, commandId: firstCommand.id, generationId: 'loop-1' }, AGENT);
    await daemon.execute('postAgentTurnReceipt', { roomId: ROOM, agentId: AGENT, requestId: firstCommand.turn_request_id, generationId: 'loop-1', status: 'working' }, AGENT);
    await daemon.execute('postRoomMessage', { roomId: ROOM, requestId: firstCommand.turn_request_id, generationId: 'loop-1', text: `@${handle} step one done` }, AGENT);
    expect(await latestMemberCommand()).toBeUndefined();
    expect((await db.query('SELECT 1 FROM rooms_mcp_webhook_outbox WHERE member_id=$1', [member])).rowCount).toBe(2);
    // The member replies again: depth three, the last depth the limit allows.
    const second = await client.callTool(replyTool === 'post'
      ? { name: 'post', arguments: { address: ROOM, text: '@demo-agent step two' } }
      : { name: 'send_message', arguments: { room: ROOM, text: '@demo-agent step two' } });
    expect(second.isError).not.toBe(true);
    const secondId = (await db.query<{ id: string }>(
      'SELECT id FROM messages WHERE room_id=$1 AND author_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1', [ROOM, member])).rows[0]!.id;
    const secondCommand = await agentCommand(secondId);
    expect(secondCommand.agent_depth).toBe(3);
    // The demo agent's next tag cannot open a new member turn: the loop stops.
    const stopped = await latestMemberCommand();
    await daemon.execute('claimAgentCommand', { roomId: ROOM, commandId: secondCommand.id, generationId: 'loop-2' }, AGENT);
    await daemon.execute('postAgentTurnReceipt', { roomId: ROOM, agentId: AGENT, requestId: secondCommand.turn_request_id, generationId: 'loop-2', status: 'working' }, AGENT);
    await daemon.execute('postRoomMessage', { roomId: ROOM, requestId: secondCommand.turn_request_id, generationId: 'loop-2', text: `@${handle} step two done` }, AGENT);
    expect(await latestMemberCommand()).toEqual(stopped);
    expect((await db.query('SELECT 1 FROM rooms_mcp_webhook_outbox WHERE member_id=$1', [member])).rowCount).toBe(2);
  });
  it.each([
    ['Claude Code', [], 'Claude Code'],
    ['Codex', [], 'Codex'],
    ['OpenCode', [], 'OpenCode'],
    ['Cursor', [], 'Cursor'],
    ['Cursor', ['https://www.cursor.com/agents/mcp/oauth/callback'], 'Grok Bot'],
  ])('shows registered %s app identity for existing joined sessions', async (name, redirects, label) => {
    const { grant, member } = await connected();
    await db.query('UPDATE rooms_mcp_clients SET name=$2,redirects=$3 WHERE id=$1',
      [grant.clientId, name, JSON.stringify(redirects)]);
    // Old registrations kept these placeholders even after their client identity changed.
    await db.query("UPDATE agents SET selected_model='agent' WHERE agent_id=$1", [member]);
    await db.query("UPDATE identities SET name='My reviewer' WHERE id=$1", [member]);
    const roster = await phone.readWorkspaceMembers(WORKSPACE, USER, { q: 'My reviewer' });
    expect(roster?.agents.find(agent => agent.identity.pubkey === member)?.model).toBe(label);
    const profile = await phone.readAgent(WORKSPACE, member, USER);
    expect(profile?.selected?.model).toBe(label);
    expect(profile?.seededSoul).toContain(`Connected through ${label}.`);
    expect(profile?.agent.identity.name).toBe('My reviewer');
    await ensureMcpMember(db, { clientId: grant.clientId, ownerId: USER, modelLabel: name });
    expect((await db.query<{ selected_model: string }>('SELECT selected_model FROM agents WHERE agent_id=$1', [member])).rows[0]?.selected_model).toBe(label);
    expect((await phone.readAgent(WORKSPACE, member, USER))?.agent.identity.name).toBe('My reviewer');
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
  it.each(['human tag', 'DM', 'agent tag'])('MCP-WAKE-1: %s wakes only the webhook', async path => {
    const { client, grant, member } = await connected();
    await db.query(`UPDATE rooms_mcp_clients SET callback_url='https://hooks.example/wake' WHERE id=$1`, [grant.clientId]);
    const handle = (await db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    let roomId = ROOM;
    if (path === 'DM') {
      roomId = (await phone.execute('resolveDirectMessage', { workspaceId: WORKSPACE, participantId: member }, USER)).id;
    }
    const text = path === 'DM' ? 'reply pong please' : `@${handle} reply pong please`;
    const sent = await phone.execute('sendRoomMessage', { roomId, text }, path === 'agent tag' ? AGENT : USER);
    if (path === 'agent tag') {
      const routed = await routeAgentResult(db, undefined, sent.messageId, { roomId, agentId: AGENT });
      expect(routed.woken).toEqual([handle]);
      expect(routed.notWoken).toEqual([]);
      await routeAgentResult(db, undefined, sent.messageId, { roomId, agentId: AGENT });
    } else await routeHumanMessage(db, sent.messageId);
    expect((await db.query('SELECT 1 FROM rooms_mcp_webhook_outbox WHERE member_id=$1 AND message_id=$2', [member, sent.messageId])).rowCount).toBe(1);
    expect((await db.query('SELECT 1 FROM agent_commands WHERE agent_id=$1', [member])).rowCount).toBe(0);
    const reply = await client.callTool({ name: 'send_message', arguments: { room: roomId, text: 'pong' } });
    expect(reply.isError).not.toBe(true);
    await phone.flushPendingMentionNotices(Date.now() + 120_000);
    const view = await phone.readRoom(roomId, USER);
    expect(JSON.stringify(view)).toContain('pong');
    expect(JSON.stringify(view)).not.toContain('helper is offline');
    expect(view.pendingAgentCommands?.some(command => command.agentPubkey === member)).toBe(false);
    expect(view.latestAgentTurns.some(turn => turn.agentPubkey === member && turn.status === 'working')).toBe(false);
    expect((await db.query('SELECT 1 FROM pending_mention_notices WHERE agent_id=$1', [member])).rowCount).toBe(0);
  });
  it.each(['human tag', 'DM', 'agent tag'])('keeps an MCP member without a webhook silent on %s', async path => {
    const { member } = await connected();
    const handle = (await db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    const roomId = path === 'DM' ? (await phone.execute('resolveDirectMessage', { workspaceId: WORKSPACE, participantId: member }, USER)).id : ROOM;
    const sent = await phone.execute('sendRoomMessage', { roomId, text: path === 'DM' ? 'hello' : `@${handle} hello` }, path === 'agent tag' ? AGENT : USER);
    if (path === 'agent tag') expect((await routeAgentResult(db, undefined, sent.messageId, { roomId, agentId: AGENT })).woken).toEqual([]);
    const own = await phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} self` }, member);
    const routed = await routeAgentResult(db, undefined, own.messageId, { roomId: ROOM, agentId: member });
    expect(routed.woken).toEqual([]);
    await phone.flushPendingMentionNotices(Date.now() + 120_000);
    expect((await db.query('SELECT 1 FROM agent_commands WHERE agent_id=$1', [member])).rowCount).toBe(0);
    expect((await db.query('SELECT 1 FROM rooms_mcp_webhook_outbox WHERE member_id=$1', [member])).rowCount).toBe(0);
    expect((await db.query('SELECT 1 FROM pending_mention_notices WHERE source_message_id=$1', [sent.messageId])).rowCount).toBe(0);
  });
  it('returns the webhook member in send_message woken without creating its command', async () => {
    const sender = await connected();
    const target = await connected();
    await db.query(`UPDATE rooms_mcp_clients SET callback_url='https://hooks.example/member' WHERE id=$1`, [target.grant.clientId]);
    const handle = (await db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [target.member])).rows[0]!.handle;
    const result = await sender.client.callTool({ name: 'send_message', arguments: { room: ROOM, text: `@${handle} hello`, idempotencyKey: 'webhook-wake' } });
    const data = JSON.parse((result.content as { text: string }[])[0]!.text).data;
    expect(data.woken).toEqual([handle]);
    const retry = await sender.client.callTool({ name: 'send_message', arguments: { room: ROOM, text: `@${handle} hello`, idempotencyKey: 'webhook-wake' } });
    expect(JSON.parse((retry.content as { text: string }[])[0]!.text).data).toEqual(data);
    expect((await db.query('SELECT 1 FROM agent_commands WHERE agent_id=$1', [target.member])).rowCount).toBe(0);
    expect((await db.query('SELECT 1 FROM rooms_mcp_webhook_outbox WHERE member_id=$1 AND message_id=$2', [target.member, data.messageId])).rowCount).toBe(1);
  });
  it('fires one outgoing webhook per (message, member) and never for its own post', async () => {
    await deliverMcpMemberWebhooks(db, async () => new Response('', { status: 200 }));
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
  it('delivers nothing to a member removed from the Room before the drain', async () => {
    const { grant, member } = await connected();
    await db.query(`UPDATE rooms_mcp_clients SET callback_url='https://hooks.example/removed' WHERE id=$1`, [grant.clientId]);
    // Drain earlier tests' backlog so only this delivery is pending.
    await deliverMcpMemberWebhooks(db, async () => new Response('', { status: 200 }));
    const handle = (await db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    const sent = await phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} queued before removal` }, USER);
    // The wake is already queued, then the owner removes the member from the Room.
    await phone.execute('removeRoomMember', { roomId: ROOM, memberId: member }, USER);
    let calls = 0;
    const delivered = await deliverMcpMemberWebhooks(db, async () => { calls++; return new Response('', { status: 200 }); });
    // No HTTP call fires and the queued text never leaves the outbox.
    expect(delivered).toBe(0);
    expect(calls).toBe(0);
    expect((await db.query('SELECT delivered_at FROM rooms_mcp_webhook_outbox WHERE member_id=$1 AND message_id=$2', [member, sent.messageId])).rows[0]!.delivered_at).not.toBeNull();
    expect((await db.query('SELECT outcome FROM subscription_webhook_calls WHERE member_id=$1 AND wake_message_id=$2', [member, sent.messageId])).rows[0]!.outcome).toBe('skipped');
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
  it('Reproduction R1: grants every tool after one Allow, with no scope or a read-only scope, and limits per token', async () => {
    for (const scope of ['', 'rooms:read']) {
      const { client } = await connected(scope);
      const profile = await client.callTool({ name: 'set_profile', arguments: { name: `Grok ${scope || 'none'}` } });
      expect(profile.isError).toBeFalsy();
      const sent = await client.callTool({ name: 'send_message', arguments: { room: ROOM, text: `full rights ${scope || 'none'}` } });
      expect(sent.isError).toBeFalsy();
    }
    expect((await db.query("SELECT 1 FROM messages WHERE text LIKE 'full rights %'")).rowCount).toBe(2);
    const { token } = await connected('rooms:read');
    await db.query('UPDATE rooms_mcp_tokens SET calls=60,window_at=now() WHERE hash=$1', [tokenHash(token)]);
    expect((await fetch(origin + '/mcp', { headers: { authorization: `Bearer ${token}` } })).status).toBe(429);
  });
  it('Reproduction R1: lets a stored read-only connection post and refresh without reconnecting', async () => {
    const grant = await authorize();
    const tokens = await (await exchange(grant)).json() as { access_token: string; refresh_token: string };
    // Seed the pre-fix state: every stored row for this connection holds read only.
    for (const table of ['rooms_mcp_tokens', 'rooms_mcp_families', 'rooms_mcp_connections']) {
      await db.query(`UPDATE ${table} SET scope='rooms:read' WHERE client_id=$1`, [grant.clientId]);
    }
    const member = (await db.query<{ member_id: string }>('SELECT member_id FROM rooms_mcp_members WHERE client_id=$1', [grant.clientId])).rows[0]!.member_id;
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')
      ON CONFLICT (room_id,identity_id) WHERE room_id IS NOT NULL DO NOTHING`, [WORKSPACE, ROOM, member]);
    const call = async (token: string, name: string, args: Record<string, unknown>) => {
      const client = new Client({ name: 'rooms-review-proof', version: '1.0.0' }); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      return client.callTool({ name, arguments: args });
    };
    expect((await call(tokens.access_token, 'set_profile', { name: 'Grok Bot' })).isError).toBeFalsy();
    const refreshed = await post('/mcp/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
      client_id: grant.clientId, resource: origin + '/mcp', scope: 'rooms:read rooms:write' });
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json() as { access_token: string; refresh_token: string; scope: string };
    expect(next.scope).toBe('rooms:read rooms:write');
    expect((await call(next.access_token, 'send_message', { room: ROOM, text: 'posted after refresh' })).isError).toBeFalsy();
    const narrowed = await post('/mcp/oauth/token', { grant_type: 'refresh_token', refresh_token: next.refresh_token,
      client_id: grant.clientId, resource: origin + '/mcp', scope: 'rooms:read' });
    expect(narrowed.status).toBe(200);
    const last = await narrowed.json() as { access_token: string };
    expect((await call(last.access_token, 'send_message', { room: ROOM, text: 'posted after narrow refresh' })).isError).toBeFalsy();
    expect((await phone.readWorkbench({ workspaceId: WORKSPACE }, USER)).aiClients)
      .toContainEqual(expect.objectContaining({ clientId: grant.clientId, scopes: ['rooms:read', 'rooms:write'] }));
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
  it('MCP-WORKSPACE-1: limits membership and tools to the selected Workspaces through exchange, refresh and reconnect', async () => {
    const secondWorkspace = randomUUID(), secondRoom = randomUUID();
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Other eligible Workspace')`, [secondWorkspace]);
    await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [secondWorkspace, USER]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name,visibility) VALUES($1,$2,'Excluded public Room','public')`, [secondRoom, secondWorkspace]);
    try {
      const grant = await authorize();
      expect(grant.consentHtml).toContain('Workspaces');
      expect(grant.consentHtml).toContain('Other eligible Workspace');
      const member = (await db.query<{ member_id: string; workspace_ids: string[] }>(
        'SELECT member_id,workspace_ids FROM rooms_mcp_members WHERE client_id=$1 AND owner_id=$2', [grant.clientId, USER])).rows[0]!;
      expect(member.workspace_ids).toEqual([WORKSPACE]);
      const response = await exchange(grant);
      expect(response.status).toBe(200);
      const tokens = await response.json() as { access_token: string; refresh_token: string };
      const client = new Client({ name: 'workspace-selection-proof', version: '1.0.0' }); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
      const activeWorkspaces = async () => (await db.query<{ workspace_id: string }>(
        'SELECT workspace_id FROM memberships WHERE identity_id=$1 AND room_id IS NULL AND removed_at IS NULL ORDER BY workspace_id', [member.member_id])).rows.map(row => row.workspace_id);
      expect(await activeWorkspaces()).toEqual([WORKSPACE]);
      expect(JSON.stringify(await client.callTool({ name: 'list_rooms', arguments: {} }))).not.toContain(secondRoom);
      expect((await client.callTool({ name: 'read_messages', arguments: { room: secondRoom } })).isError).toBe(true);
      expect((await client.callTool({ name: 'send_message', arguments: { room: secondRoom, text: 'must not send' } })).isError).toBe(true);
      expect((await post('/mcp/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
        client_id: grant.clientId, resource: origin + '/mcp' })).status).toBe(200);
      await ensureMcpMember(db, { clientId: grant.clientId, ownerId: USER, modelLabel: 'Local MCP reviewer' });
      await backfillMcpMemberRoomsAndAvatars(db);
      expect(await activeWorkspaces()).toEqual([WORKSPACE]);
      // Explicit re-consent can add a Workspace, then remove the old one. The
      // earlier live token must lose the removed Room immediately as well.
      const both = await authorize(undefined, 'allow', grant.clientId, undefined, { workspace_ids: [WORKSPACE, secondWorkspace] });
      expect((await exchange(both)).status).toBe(200);
      expect(await activeWorkspaces()).toEqual([WORKSPACE, secondWorkspace].sort());
      const narrowed = await authorize(undefined, 'allow', grant.clientId, undefined, { workspace_ids: [secondWorkspace] });
      expect((await exchange(narrowed)).status).toBe(200);
      expect(await activeWorkspaces()).toEqual([secondWorkspace]);
      expect((await db.query('SELECT 1 FROM memberships WHERE identity_id=$1 AND workspace_id=$2 AND removed_at IS NULL', [member.member_id, WORKSPACE])).rowCount).toBe(0);
      expect((await client.callTool({ name: 'read_messages', arguments: { room: ROOM } })).isError).toBe(true);
      await ensureMcpMember(db, { clientId: grant.clientId, ownerId: USER, modelLabel: 'Local MCP reviewer' });
      await backfillMcpMemberRoomsAndAvatars(db);
      expect(await activeWorkspaces()).toEqual([secondWorkspace]);
      const reconnect = await prepareAuthorization(undefined, grant.clientId);
      const checkboxes = reconnect.consentHtml.match(/<input\b[^>]*name="workspace_ids"[^>]*>/g) ?? [];
      expect(checkboxes.find(input => input.includes(secondWorkspace))).toMatch(/\bchecked\b/);
      expect(checkboxes.find(input => input.includes(WORKSPACE))).not.toMatch(/\bchecked\b/);
    } finally {
      await db.query('DELETE FROM workspaces WHERE id=$1', [secondWorkspace]);
    }
  });
  it('MCP-WORKSPACE-1: newly joined Workspaces stay unselected and narrowing suppresses queued mentions and events', async () => {
    const { token, params, member, grant, client } = await eventFixture();
    await eventCall(token, 'events/subscribe', params);
    const handle = (await db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    const sent = await phone.execute('sendRoomMessage', { roomId: ROOM, text: '@' + handle + ' queued before Workspace deselection' }, USER);
    expect(JSON.stringify(await client.callTool({ name: 'list_mentions', arguments: {} }))).toContain(sent.messageId);
    const laterWorkspace = randomUUID();
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Joined after approval')`, [laterWorkspace]);
    await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [laterWorkspace, USER]);
    try {
      const reconnect = await prepareAuthorization(undefined, grant.clientId);
      const checkboxes = reconnect.consentHtml.match(/<input\b[^>]*name="workspace_ids"[^>]*>/g) ?? [];
      expect(checkboxes.find(input => input.includes(laterWorkspace))).toBeDefined();
      expect(checkboxes.find(input => input.includes(laterWorkspace))).not.toMatch(/\bchecked\b/);
      await ensureMcpMember(db, { clientId: grant.clientId, ownerId: USER, modelLabel: 'Local MCP reviewer' });
      expect((await db.query('SELECT 1 FROM memberships WHERE identity_id=$1 AND workspace_id=$2 AND removed_at IS NULL', [member, laterWorkspace])).rowCount).toBe(0);
      await authorize(undefined, 'allow', grant.clientId, undefined, { workspace_ids: [laterWorkspace] });
      expect(JSON.stringify(await client.callTool({ name: 'list_mentions', arguments: {} }))).not.toContain(sent.messageId);
      const deliver = vi.fn(async () => new Response(null, { status: 204 }));
      await deliverMcpMemberWebhooks(db, deliver);
      expect(deliver).not.toHaveBeenCalled();
    } finally { await db.query('DELETE FROM workspaces WHERE id=$1', [laterWorkspace]); }
  });
  it('MCP-WORKSPACE-1: legacy connections retain all-Workspace behavior until explicit re-consent', async () => {
    const grant = await authorize();
    await db.query('UPDATE rooms_mcp_members SET workspace_ids=NULL WHERE client_id=$1', [grant.clientId]);
    const laterWorkspace = randomUUID(), laterRoom = randomUUID();
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'New legacy Workspace')`, [laterWorkspace]);
    await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [laterWorkspace, USER]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name,visibility) VALUES($1,$2,'Legacy public Room','public')`, [laterRoom, laterWorkspace]);
    try {
      const member = await ensureMcpMember(db, { clientId: grant.clientId, ownerId: USER, modelLabel: 'Local MCP reviewer' });
      expect((await db.query('SELECT 1 FROM memberships WHERE identity_id=$1 AND room_id=$2 AND removed_at IS NULL', [member, laterRoom])).rowCount).toBe(1);
      expect((await db.query<{ workspace_ids: string[] | null }>('SELECT workspace_ids FROM rooms_mcp_members WHERE client_id=$1', [grant.clientId])).rows[0]!.workspace_ids).toBeNull();
      await authorize(undefined, 'allow', grant.clientId);
      await ensureMcpMember(db, { clientId: grant.clientId, ownerId: USER, modelLabel: 'Local MCP reviewer' });
      expect((await db.query('SELECT 1 FROM memberships WHERE identity_id=$1 AND workspace_id=$2 AND removed_at IS NULL', [member, laterWorkspace])).rowCount).toBe(0);
    } finally { await db.query('DELETE FROM workspaces WHERE id=$1', [laterWorkspace]); }
  });
  it('MCP-WORKSPACE-1: rejects empty, malformed, duplicate and foreign selections without granting membership', async () => {
    const prepared = await prepareAuthorization();
    const { flow, cookie, clientId } = prepared;
    for (const selection of [
      {}, { workspace_selection: '1' }, { workspace_selection: '1', workspace_ids: [] },
      { workspace_selection: '1', workspace_ids: ['not-a-workspace'] },
      { workspace_selection: '1', workspace_ids: [randomUUID()] },
      { workspace_selection: '1', workspace_ids: [WORKSPACE, WORKSPACE] },
      { workspace_selection: '1', workspace_ids: { id: WORKSPACE } },
    ]) {
      const response = await post('/mcp/oauth/consent', { flow, decision: 'allow', ...selection }, { cookie, origin });
      expect(response.status).toBe(400);
      expect((await db.query('SELECT 1 FROM rooms_mcp_members WHERE client_id=$1', [clientId])).rowCount).toBe(0);
      expect((await db.query('SELECT 1 FROM rooms_mcp_codes WHERE client_id=$1', [clientId])).rowCount).toBe(0);
    }
    // Eligibility is rechecked on POST, not trusted from the earlier page.
    const staleWorkspace = randomUUID();
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Departed Workspace')`, [staleWorkspace]);
    await db.query(`INSERT INTO memberships(workspace_id,identity_id,role,removed_at) VALUES($1,$2,'member',now())`, [staleWorkspace, USER]);
    try {
      expect((await post('/mcp/oauth/consent', { flow, decision: 'allow', workspace_selection: '1', workspace_ids: [staleWorkspace] }, { cookie, origin })).status).toBe(400);
      expect((await db.query('SELECT 1 FROM rooms_mcp_members WHERE client_id=$1', [clientId])).rowCount).toBe(0);
    } finally { await db.query('DELETE FROM workspaces WHERE id=$1', [staleWorkspace]); }
  });
  it('MCP-WORKSPACE-1: accepts repeated workspace form fields but still rejects duplicate security parameters', async () => {
    const secondWorkspace = randomUUID();
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Second form Workspace')`, [secondWorkspace]);
    await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [secondWorkspace, USER]);
    try {
      const { flow, cookie, clientId } = await prepareAuthorization();
      const body = new URLSearchParams({ flow, decision: 'allow', workspace_selection: '1' });
      body.append('workspace_ids', WORKSPACE); body.append('workspace_ids', secondWorkspace);
      const submit = (value: URLSearchParams) => fetch(origin + '/mcp/oauth/consent', { method: 'POST', redirect: 'manual',
        headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' }, body: value });
      const duplicateFlow = new URLSearchParams(body); duplicateFlow.append('flow', flow);
      expect((await submit(duplicateFlow)).status).toBe(400);
      expect((await submit(body)).status).toBe(302);
      const saved = (await db.query<{ workspace_ids: string[] }>('SELECT workspace_ids FROM rooms_mcp_members WHERE client_id=$1', [clientId])).rows[0]!;
      expect([...saved.workspace_ids].sort()).toEqual([WORKSPACE, secondWorkspace].sort());
    } finally { await db.query('DELETE FROM workspaces WHERE id=$1', [secondWorkspace]); }
  });
  it('joins every public top-level Room on Allow, and other Rooms through Members', async () => {
    const { member, client } = await connected();
    const rooms = async () => (await db.query<{ room_id: string }>(
      'SELECT room_id FROM memberships WHERE identity_id=$1 AND room_id IS NOT NULL AND removed_at IS NULL ORDER BY room_id', [member])).rows.map(row => row.room_id);
    // Every public top-level Room, never an invite-only Room or a corner.
    expect(await rooms()).toEqual([ROOM]);
    expect(JSON.stringify(await client.callTool({ name: 'list_rooms', arguments: {} }))).toContain(ROOM);
    // A public Room made later includes it, like any agent.
    const later = (await phone.execute('createRoom', { workspaceId: WORKSPACE, name: `later-${member.slice(0, 6)}` }, USER)).id;
    expect(await rooms()).toContain(later);
    // An invite-only Room takes it through the normal Members path.
    const closed = (await phone.execute('createRoom', { workspaceId: WORKSPACE, name: `closed-${member.slice(0, 6)}`, visibility: 'invite-only' }, USER)).id;
    expect(await rooms()).not.toContain(closed);
    await phone.execute('addRoomMember', { roomId: closed, memberId: member }, USER);
    expect(await rooms()).toContain(closed);
    await phone.execute('removeRoomMember', { roomId: later, memberId: member }, USER);
    expect(await rooms()).not.toContain(later);
  });
  it('signs Meta Muse in with its published client id, which maintenance never deletes', async () => {
    const muse = PREREGISTERED_MCP_CLIENTS[0];
    expect(muse.id).toBe('6Zxge0aVJeCxF8Jvshy-oYTjYPJmrFHdTnwVfvkaF0o');
    const row = (await db.query<{ name: string; redirects: string[]; preregistered: boolean; auth_method: string; logo: string | null }>(
      'SELECT name,redirects,preregistered,auth_method,logo FROM rooms_mcp_clients WHERE id=$1', [muse.id])).rows[0]!;
    expect(row).toMatchObject({ name: 'Meta Muse', redirects: ['https://agent.meta.ai/api/hatch/oauth/callback'], preregistered: true, auth_method: 'none' });
    expect(row.logo).toMatch(/^data:image\/png;base64,/);
    // Nobody registers anything: the published id signs in at once.
    const grant = await authorize('rooms:read rooms:write', 'allow', muse.id, muse.redirects[0]);
    expect(grant.code).toBeTruthy();
    expect((await exchange(grant, { redirect_uri: muse.redirects[0] })).status).toBe(200);
    // Unused for 30 days: an ordinary registration expires, the published one stays.
    const unused = await (await post('/mcp/oauth/register', { client_name: 'Unused', redirect_uris: ['https://example.com/cb'] })).json() as { client_id: string };
    await db.query(`UPDATE rooms_mcp_connections SET revoked_at=now()-interval '40 days' WHERE client_id=$1`, [muse.id]);
    await db.query(`DELETE FROM rooms_mcp_tokens WHERE client_id=$1`, [muse.id]);
    await db.query(`UPDATE rooms_mcp_clients SET created_at=now()-interval '40 days' WHERE id=ANY($1)`, [[muse.id, unused.client_id]]);
    await runMaintenance(db);
    await db.query(`DELETE FROM rooms_mcp_connections WHERE client_id=$1`, [muse.id]);
    await runMaintenance(db);
    expect((await db.query('SELECT 1 FROM rooms_mcp_clients WHERE id=$1', [unused.client_id])).rowCount).toBe(0);
    expect((await db.query('SELECT 1 FROM rooms_mcp_clients WHERE id=$1 AND preregistered', [muse.id])).rowCount).toBe(1);
  });
  it.each([
    ['Cursor', ['https://www.cursor.com/agents/mcp/oauth/callback', 'http://localhost:8787/callback'], 'Grok Bot'],
    ['Cursor', ['cursor://anysphere.cursor-mcp/oauth/callback'], 'Cursor'],
    ['Cursor', ['https://cursor.com/agents/oauth/callback'], 'Cursor'],
    ['Meta Muse', ['https://agent.meta.ai/api/hatch/oauth/callback'], 'Meta Muse'],
    ['Codex', ['http://127.0.0.1:9876/callback'], 'Codex'],
    ['Claude Code', ['http://127.0.0.1:9876/callback'], 'Claude Code'],
    ['Dots', ['http://127.0.0.1:9876/callback'], 'Dots'],
  ])('R-MCP-DEFAULT-PICTURES: %s %j shows app pictures on Allow and its member', async (name, redirects, display) => {
    const registered = await (await post('/mcp/oauth/register', { client_name: name, redirect_uris: redirects })).json() as { client_id: string };
    const grant = await authorize('rooms:read rooms:write', 'allow', registered.client_id, redirects[0]);
    const html = grant.consentHtml;
    expect(html).toContain(`Add ${display} to your team`);
    expect(html).toMatch(/<img class="mark client" src="data:image/);
    expect(html).toMatch(/<img class="plate" src="data:image/);
    expect(html).not.toContain('class="mark client initial"');
    const member = (await db.query<{ member_id: string; name: string; avatar: string }>(
      'SELECT m.member_id,i.name,i.avatar FROM rooms_mcp_members m JOIN identities i ON i.id=m.member_id WHERE m.client_id=$1 AND m.owner_id=$2', [registered.client_id, USER])).rows[0]!;
    expect(member.name).toBe(display);
    expect((await fetch(origin + member.avatar)).status).toBe(200);
    // A default from the old bundled mark is upgraded; custom provenance wins,
    // including legacy request ids that predate drawing.source.
    await db.query("UPDATE agent_avatars SET bytes=$2 WHERE agent_id=$1", [member.member_id, Buffer.from('old default')]);
    await backfillMcpMemberRoomsAndAvatars(db);
    const updated = (await db.query<{ bytes: Buffer; id: string }>('SELECT bytes,id FROM agent_avatars WHERE agent_id=$1', [member.member_id])).rows[0]!;
    expect(Buffer.from(updated.bytes).toString()).not.toBe('old default');
    await backfillMcpMemberRoomsAndAvatars(db);
    expect((await db.query<{ id: string }>('SELECT id FROM agent_avatars WHERE agent_id=$1', [member.member_id])).rows[0]!.id).toBe(updated.id);
    for (const [request, drawing] of [['rooms-mcp-set_profile', { source: 'set_profile' }], ['mcp-set-profile-hotfix', []], ['rooms-mcp-client-logo', { source: 'set_profile' }]]) {
      await db.query("UPDATE agent_avatars SET request_id=$2,drawing=$3::jsonb WHERE agent_id=$1", [member.member_id, request, JSON.stringify(drawing)]);
      await backfillMcpMemberRoomsAndAvatars(db);
      expect((await db.query<{ id: string }>('SELECT id FROM agent_avatars WHERE agent_id=$1', [member.member_id])).rows[0]!.id).toBe(updated.id);
    }
  });
  it('shows the client logo as the member picture until the member sets its own', async () => {
    const muse = PREREGISTERED_MCP_CLIENTS[0];
    const grant = await authorize('rooms:read rooms:write', 'allow', muse.id, muse.redirects[0]);
    const tokens = await (await exchange(grant, { redirect_uri: muse.redirects[0] })).json() as { access_token: string };
    const member = (await db.query<{ member_id: string }>('SELECT member_id FROM rooms_mcp_members WHERE client_id=$1 AND owner_id=$2', [muse.id, USER])).rows[0]!.member_id;
    const avatar = async () => (await db.query<{ avatar: string | null }>('SELECT avatar FROM identities WHERE id=$1', [member])).rows[0]!.avatar;
    const logo = await avatar();
    expect(logo).toMatch(/^\/v1\/agent-avatars\/[0-9a-f-]{36}$/);
    const served = await fetch(origin + logo);
    expect(served.status).toBe(200); expect(served.headers.get('content-type')).toBe('image/webp');
    expect((await sharp(Buffer.from(await served.arrayBuffer())).metadata()).width).toBe(256);
    const client = new Client({ name: 'muse-proof', version: '1.0.0' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
    const own = await sharp({ create: { width: 64, height: 64, channels: 3, background: 'blue' } }).png().toBuffer();
    const set = await client.callTool({ name: 'set_profile', arguments: { avatar: `data:image/png;base64,${own.toString('base64')}` } });
    expect(set.isError).not.toBe(true);
    const chosen = await avatar();
    expect(chosen).toMatch(/^\/v1\/agent-avatars\/[0-9a-f-]{36}$/); expect(chosen).not.toBe(logo);
    // Reconnecting never puts the logo back over the member's own picture.
    const reconnect = await authorize('rooms:read rooms:write', 'allow', muse.id, muse.redirects[0]);
    const portrait = (await db.query<{ bytes: Buffer }>('SELECT bytes FROM agent_avatars WHERE agent_id=$1', [member])).rows[0]!;
    expect(reconnect.consentHtml).toContain('data:image/webp;base64,' + Buffer.from(portrait.bytes).toString('base64'));
    expect(await avatar()).toBe(chosen);
  });
  it('R1: pushes the asking agent’s exact back-tag instructions per tag to the webhook a member set, with its sealed bearer secret', async () => {
    await deliverMcpMemberWebhooks(db, async () => new Response('', { status: 200 }));
    const { client, member } = await connected();
    const previous = process.env.BEELINE_MCP_WEBHOOK_KEY;
    delete process.env.BEELINE_MCP_WEBHOOK_KEY;
    try {
      // Without a sealing key no secret can be stored.
      expect((await client.callTool({ name: 'set_webhook', arguments: { url: 'https://hooks.example/muse', secret: 'tag-secret' } })).isError).toBe(true);
      process.env.BEELINE_MCP_WEBHOOK_KEY = 'test-key';
      expect((await client.callTool({ name: 'set_webhook', arguments: { url: 'http://hooks.example/muse' } })).isError).toBe(true);
      const set = await client.callTool({ name: 'set_webhook', arguments: { url: 'https://hooks.example/muse', secret: ' Bearer tag-secret ' } });
      expect(set.isError).not.toBe(true);
      expect(JSON.stringify(set)).not.toContain('tag-secret');
      const stored = (await db.query<{ callback_url: string; callback_secret: string }>('SELECT callback_url,callback_secret FROM rooms_mcp_members WHERE member_id=$1', [member])).rows[0]!;
      expect(stored.callback_url).toBe('https://hooks.example/muse'); expect(stored.callback_secret).not.toContain('tag-secret');
      const handle = (await db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
      const sent = await phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} please answer` }, AGENT);
      await routeAgentResult(db, undefined, sent.messageId, { roomId: ROOM, agentId: AGENT });
      const posts: { url: string; authorization: string | null; body: Record<string, unknown> }[] = [];
      await deliverMcpMemberWebhooks(db, async (url, init) => {
        posts.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) });
        return new Response('', { status: 200 });
      });
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ url: 'https://hooks.example/muse', authorization: 'Bearer tag-secret',
        body: { memberId: member, roomId: ROOM, messageId: sent.messageId, text: `@${handle} please answer` } });
      expect(String(posts[0]!.body.instruction)).toContain('send_message');
      expect(String(posts[0]!.body.instruction)).toContain('Start your reply with @demo-agent to wake the asking agent.');
      expect(String(posts[0]!.body.instruction)).toContain('start with its handle so it wakes');
      // Removing the webhook stops the push.
      await client.callTool({ name: 'set_webhook', arguments: { url: '' } });
      const quiet = await phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} again` }, USER);
      await routeHumanMessage(db, quiet.messageId);
      expect((await db.query('SELECT 1 FROM rooms_mcp_webhook_outbox WHERE member_id=$1 AND message_id=$2', [member, quiet.messageId])).rowCount).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.BEELINE_MCP_WEBHOOK_KEY; else process.env.BEELINE_MCP_WEBHOOK_KEY = previous;
    }
  });
  it.each([
    [' Bearer abc123 ', 'abc123'], [' bearer abc123 ', 'abc123'],
    ['bEaReR abc123', 'abc123'], ['bearerabc123', 'bearerabc123'],
    ['Bearer bad token', null], ['Bearer ', null], ['Bearer abc\ttoken', null],
  ])('MCP-WEBHOOK-TOKEN: set_webhook normalizes or refuses %j', async (input, expected) => {
    vi.stubEnv('BEELINE_MCP_WEBHOOK_KEY', 'local-token-test-key');
    try {
      const { client, member } = await connected();
      const result = await client.callTool({ name: 'set_webhook', arguments: { url: 'https://hooks.example/token', secret: input } });
      if (expected === null) expect(result.isError).toBe(true);
      else {
        expect(result.isError).not.toBe(true);
        const stored = (await db.query<{ callback_secret: string }>('SELECT callback_secret FROM rooms_mcp_members WHERE member_id=$1', [member])).rows[0]!;
        expect(openSecrets<string>('local-token-test-key', stored.callback_secret)).toBe(expected);
      }
    } finally { vi.unstubAllEnvs(); }
  });
  it('WEBHOOK-CLEAR-1: clearing a member webhook disables fallback and cancels queued tags', async () => {
    const { client, member, grant } = await connected();
    const handle = (await db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    await db.query("UPDATE rooms_mcp_clients SET callback_url='https://hooks.example/registration' WHERE id=$1", [grant.clientId]);
    const posts: string[] = [];
    const deliver = () => deliverMcpMemberWebhooks(db, async url => { posts.push(url); return new Response('', { status: 200 }); });
    // A never-configured member keeps the registration fallback.
    await phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} initial fallback` }, USER);
    expect(await deliver()).toBe(1);
    expect(posts).toEqual(['https://hooks.example/registration']);
    expect(data(await client.callTool({ name: 'set_webhook', arguments: { url: 'https://hooks.example/member' } })).webhook).toBe('https://hooks.example/member');
    const queued = await phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} queued before clearing` }, USER);
    expect(data(await client.callTool({ name: 'set_webhook', arguments: { url: '' } })).webhook).toBeNull();
    expect(await deliver()).toBe(0);
    const human = await phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} after clearing` }, USER);
    const agent = await phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} please answer after clearing` }, AGENT);
    await routeAgentResult(db, undefined, agent.messageId, { roomId: ROOM, agentId: AGENT });
    const dm = await phone.execute('resolveDirectMessage', { workspaceId: WORKSPACE, participantId: member }, USER);
    await phone.execute('sendRoomMessage', { roomId: dm.id, text: 'after clearing in a DM' }, USER);
    expect(await deliver()).toBe(0);
    expect(posts).toHaveLength(1);
    expect((await db.query('SELECT 1 FROM rooms_mcp_webhook_outbox WHERE member_id=$1 AND message_id=$2', [member, human.messageId])).rowCount).toBe(0);
    expect((await db.query('SELECT outcome FROM subscription_webhook_calls WHERE member_id=$1 AND wake_message_id=$2', [member, queued.messageId])).rows[0]!.outcome).toBe('skipped');
    // Explicitly enabling a new receiver must not replay the cancelled queue.
    await client.callTool({ name: 'set_webhook', arguments: { url: 'https://hooks.example/new' } });
    expect(await deliver()).toBe(0);
    await phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} freshly enabled` }, USER);
    expect(await deliver()).toBe(1);
    expect(posts).toEqual(['https://hooks.example/registration', 'https://hooks.example/new']);
  });
  it('publishes every preregistered client id on the public connect page', () => {
    const page = readFileSync(new URL('../../../web/connect/index.html', import.meta.url), 'utf8');
    for (const client of PREREGISTERED_MCP_CLIENTS) {
      expect(page).toContain(client.id);
      expect(page).toContain(client.name);
    }
    expect(page).toContain('https://server.usebeeline.app/mcp');
    expect(readFileSync(new URL('../../../web/sitemap.xml', import.meta.url), 'utf8')).toContain('<loc>https://usebeeline.app/connect/</loc>');
  });
  const data = (result: unknown) => JSON.parse(((result as { content: { text: string }[] }).content)[0]!.text).data;
  it('owner-unknown: identifies the approving owner before and after setup, even without Rooms', async () => {
    const { client, member } = await connected();
    const listed = () => client.callTool({ name: 'list_rooms', arguments: {} }).then(data);
    expect((await listed()).owner).toEqual({ name: 'Demo', handle: 'demo' });
    expect((await listed()).setup).toContain('Preserve the approved @handle');
    const profile = await client.callTool({ name: 'set_profile', arguments: { name: 'Existing Bot' } });
    expect(profile.isError).toBeFalsy();
    expect(await listed()).toMatchObject({ owner: { name: 'Demo', handle: 'demo' } });
    expect((await listed()).setup).toBeUndefined();
    await db.query('UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id IS NOT NULL', [member]);
    expect(await listed()).toMatchObject({ rooms: [], owner: { name: 'Demo', handle: 'demo' } });
  });
  it('repeats the setup rule in read results until the member calls set_profile', async () => {
    const { client } = await connected();
    expect(data(await client.callTool({ name: 'list_rooms', arguments: {} })).setup).toContain('set_profile');
    expect(data(await client.callTool({ name: 'read_messages', arguments: { room: ROOM, limit: 1 } })).setup).toContain('tags your @handle');
    const tools = (await client.listTools()).tools;
    expect(tools.find(t => t.name === 'list_rooms')!.description).toContain('verify your approved member identity and owner');
    expect(tools.find(t => t.name === 'set_profile')!.description).toMatch(/^After verifying list_rooms/);
    expect(tools.find(t => t.name === 'set_profile')!.description).toContain('display name and profile picture you already use in your own app');
    expect(tools.find(t => t.name === 'set_profile')!.description).toContain('https URL or data URI');
    expect(client.getInstructions()).toContain('Read the owner field in list_rooms');
    expect(client.getInstructions()).toContain('display name and profile picture you already use in your own app');
    await client.callTool({ name: 'set_profile', arguments: { name: 'Named', handle: `named_${randomBytes(3).toString('hex')}` } });
    expect(data(await client.callTool({ name: 'list_rooms', arguments: {} })).setup).toBeUndefined();
    expect(data(await client.callTool({ name: 'read_messages', arguments: { room: ROOM, limit: 1 } })).setup).toBeUndefined();
  });
  it('tells a member in no Rooms how its owner adds it', async () => {
    const { client, member } = await connected();
    await db.query('UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id IS NOT NULL', [member]);
    const listed = data(await client.callTool({ name: 'list_rooms', arguments: {} }));
    expect(listed.rooms).toEqual([]); expect(listed.note).toContain('under Members in the Beeline app');
  });
  it('lists the tags owed a reply across Rooms, oldest first, after a cursor', async () => {
    const { client, member } = await connected();
    const handle = (await db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    const second = (await phone.execute('createRoom', { workspaceId: WORKSPACE, name: `mentions-${member.slice(0, 6)}` }, USER)).id;
    const first = await phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} first question` }, USER);
    const next = await phone.execute('sendRoomMessage', { roomId: second, text: `@${handle} second question` }, USER);
    await phone.execute('sendRoomMessage', { roomId: second, text: 'no tag here' }, USER);
    const page = data(await client.callTool({ name: 'list_mentions', arguments: {} }));
    expect(page.mentions.map((m: { id: string }) => m.id)).toEqual([first.messageId, next.messageId]);
    expect(page.mentions[0]).toMatchObject({ room_id: ROOM, author_id: USER, text: `@${handle} first question` });
    expect(data(await client.callTool({ name: 'list_mentions', arguments: { cursor: page.nextCursor } })).mentions).toEqual([]);
    const third = await phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} third` }, USER);
    expect(data(await client.callTool({ name: 'list_mentions', arguments: { cursor: page.nextCursor } })).mentions.map((m: { id: string }) => m.id)).toEqual([third.messageId]);
  });
  it('SESSION-JOIN-1: a long poll returns at once when a tag arrives, and after its wait otherwise', async () => {
    const { client, member } = await connected();
    const handle = (await db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    // A client learns the name and handle its owner allowed.
    expect(data(await client.callTool({ name: 'list_rooms', arguments: {} })).you).toEqual({ id: member, name: expect.any(String), handle });
    const first = data(await client.callTool({ name: 'list_mentions', arguments: {} }));
    const now = new Date().toISOString();
    let started = Date.now();
    const empty = data(await client.callTool({ name: 'list_mentions', arguments: { cursor: first.nextCursor, waitSeconds: 1, wakesAfter: now } }));
    expect(empty.mentions).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    started = Date.now();
    const waiting = client.callTool({ name: 'list_mentions', arguments: { cursor: first.nextCursor, waitSeconds: 20, wakesAfter: now } });
    await new Promise(resolve => setTimeout(resolve, 300));
    const tag = await phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} are you there?` }, USER);
    const page = data(await waiting);
    expect(page.mentions.map((m: { id: string }) => m.id)).toEqual([tag.messageId]);
    expect(Date.now() - started).toBeLessThan(5000);
    const refused = await client.callTool({ name: 'list_mentions', arguments: { waitSeconds: 26 } });
    expect(refused.isError).toBe(true);
  });
  it.each([{ fallback: false, app: 'Claude Code' }, { fallback: true, app: 'Claude Code' }, { fallback: false, app: 'Codex' }])('SESSION-JOIN-1: a headless $app session signs in with fallback consent=$fallback and collects its code by state', async ({ fallback, app }) => {
    const label = app === 'Codex' ? 'codex' : fallback ? 'fallback' : 'api';
    const memberName = `payments ${label}`, memberHandle = `payments_${label}`;
    const handoff = origin + '/mcp/oauth/handoff';
    const registered = await post('/mcp/oauth/register', { client_name: app, redirect_uris: [handoff] });
    expect(registered.status).toBe(201);
    const client = await registered.json() as { client_id: string };
    const verifier = opaque(), state = opaque();
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: handoff, response_type: 'code', resource: origin + '/mcp',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'rooms:read rooms:write', state,
      member_name: `payments  ${label}\u0007` });
    if (fallback) query.set('claude_inbound_fallback', '1');
    expect(await (await post('/mcp/oauth/handoff', { state })).json()).toEqual({ error: 'authorization_pending' });
    const start = await fetch(origin + '/mcp/oauth/authorize?' + query, { redirect: 'manual' });
    const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
    const flow = new URL(start.headers.get('location')!, origin).searchParams.get('flow')!;
    await fetch(`${origin}/mcp/oauth/login?flow=${flow}&provider=google`, { headers: { cookie }, redirect: 'manual' });
    await fetch(`${origin}/mcp/oauth/callback/google?state=${flow}&ticket=local-demo-ticket`, { headers: { cookie }, redirect: 'manual' });
    await db.query(`UPDATE identities SET handle=$2 WHERE id=$1`, [AGENT, memberHandle]);
    const page = await (await fetch(`${origin}/mcp/oauth/consent?flow=${flow}`, { headers: { cookie } })).text();
    expect(page).toContain(`Add ${app} to your team`);
    expect(page.includes('Would you like to run the following command?')).toBe(app === 'Codex');
    expect(page.includes('choose “Yes, proceed”')).toBe(app === 'Codex');
    expect(page).toContain(memberName);
    expect(page).toContain('Agents and people who tag this session in your Rooms can send it messages');
    expect(page.includes('user-level "crossSessionInbound": "accept" setting')).toBe(fallback);
    // Another member in the Workspace holds the plain handle already.
    expect(page).toContain(`@${memberHandle}_2`);
    await db.query(`UPDATE identities SET handle='demo-agent' WHERE id=$1`, [AGENT]);
    const allowed = await post('/mcp/oauth/consent', { flow, decision: 'allow', workspace_selection: '1', workspace_ids: [WORKSPACE] }, { cookie, origin });
    const target = new URL(allowed.headers.get('location')!);
    expect(target.origin + target.pathname).toBe(handoff);
    // The person's browser lands on Beeline's own page, which keeps the code for the session.
    const landed = await fetch(target);
    expect(landed.status).toBe(200);
    expect(await landed.text()).toContain('Go back to your session');
    expect((await post('/mcp/oauth/handoff', { state: opaque() })).status).toBe(400);
    const collected = await (await post('/mcp/oauth/handoff', { state })).json() as { code: string };
    expect(collected.code).toBe(target.searchParams.get('code'));
    expect(await (await post('/mcp/oauth/handoff', { state })).json()).toEqual({ error: 'authorization_pending' });
    // The code alone is not enough: the verifier stays with the session.
    expect((await post('/mcp/oauth/token', { grant_type: 'authorization_code', client_id: client.client_id, code: collected.code, code_verifier: opaque() })).status).toBe(400);
    const tokens = await post('/mcp/oauth/token', { grant_type: 'authorization_code', client_id: client.client_id, code: collected.code, code_verifier: verifier });
    expect(tokens.status).toBe(200);
    const member = (await db.query<{ member_id: string }>('SELECT member_id FROM rooms_mcp_members WHERE owner_id=$1 AND client_id=$2', [USER, client.client_id])).rows[0]!.member_id;
    expect((await db.query('SELECT name,handle FROM identities WHERE id=$1', [member])).rows[0]).toEqual({ name: memberName, handle: `${memberHandle}_2` });
    expect((await fetch(`${origin}/mcp/oauth/handoff?state=short&code=x`)).status).toBe(400);
  });
  it('threads a reply under a message in the same Room and refuses a foreign one', async () => {
    const { client, member } = await connected();
    const parent = await phone.execute('sendRoomMessage', { roomId: ROOM, text: 'thread parent' }, USER);
    const reply = data(await client.callTool({ name: 'send_message', arguments: { room: ROOM, text: 'threaded answer', replyTo: parent.messageId } }));
    const row = (await db.query<{ reply_to_message_id: string; root_message_id: string; author_id: string; source_client: unknown }>(
      'SELECT reply_to_message_id,root_message_id,author_id,source_client FROM messages WHERE id=$1', [reply.messageId])).rows[0]!;
    expect(row).toMatchObject({ reply_to_message_id: parent.messageId, root_message_id: parent.messageId, author_id: member });
    expect(row.source_client).toBeTruthy();
    const foreign = (await db.query<{ id: string }>('SELECT id FROM messages WHERE room_id=$1 LIMIT 1', [PRIVATE])).rows[0]!.id;
    expect((await client.callTool({ name: 'send_message', arguments: { room: ROOM, text: 'nope', replyTo: foreign } })).isError).toBe(true);
  });
  it('stores a set_profile JPEG as a served portrait, refuses non-images, and keeps the old picture', async () => {
    const { client, member } = await connected();
    const jpeg = await sharp({ create: { width: 96, height: 96, channels: 3, background: 'orange' } }).jpeg().toBuffer();
    const set = await client.callTool({ name: 'set_profile', arguments: { avatar: `data:image/jpeg;base64,${jpeg.toString('base64')}` } });
    expect(set.isError).not.toBe(true);
    const avatar = (await db.query<{ avatar: string }>('SELECT avatar FROM identities WHERE id=$1', [member])).rows[0]!.avatar;
    // The app renders an agent picture only for this path (isGeneratedAgentAvatarUrl).
    expect(avatar).toMatch(/\/v1\/agent-avatars\/[0-9a-f-]{36}$/);
    expect(data(set).avatar).toBe(origin + avatar);
    const served = await fetch(origin + avatar);
    expect(served.headers.get('content-type')).toBe('image/webp');
    expect((await sharp(Buffer.from(await served.arrayBuffer())).metadata()).width).toBe(256);
    for (const bad of ['javascript:alert(1)', 'data:text/html;base64,PGh0bWw+', `data:image/png;base64,${Buffer.from('not an image').toString('base64')}`, 'http://example.com/a.png']) {
      const refused = await client.callTool({ name: 'set_profile', arguments: { avatar: bad } });
      expect(refused.isError).toBe(true);
      expect((refused.content as { text: string }[])[0]!.text).toMatch(/^Request refused: avatar/);
      expect((await db.query<{ avatar: string }>('SELECT avatar FROM identities WHERE id=$1', [member])).rows[0]!.avatar).toBe(avatar);
    }
  });
  it('names the client on an AI-client member profile instead of an animal soul', async () => {
    const { member } = await connected();
    const profile = (await phone.readAgent(WORKSPACE, member, USER))!;
    expect(profile.soul).toBeUndefined();
    expect(profile.seededSoul).toContain('Local MCP reviewer');
    expect(Object.values(FACE_SOULS)).not.toContain(profile.seededSoul);
  });
  it.each([false, true])('commits the post and routing record atomically (reply=%s)', async reply => {
    const { client, member } = await connected();
    const parent = reply ? await phone.execute('sendRoomMessage', { roomId: ROOM, text: 'atomic reply parent' }, USER) : undefined;
    const args = { room: ROOM, text: '@demo-agent please handle this atomic post', idempotencyKey: `atomic-${reply}`,
      ...(parent ? { replyTo: parent.messageId } : {}) };
    const id = createHash('sha256').update(`rooms-mcp-message:${member}:${args.idempotencyKey}`).digest('hex');
    await db.query(`CREATE FUNCTION reject_mcp_route_proof() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'proof: pending route storage unavailable'; END $$;
      CREATE TRIGGER reject_mcp_route_proof BEFORE INSERT ON rooms_mcp_pending_routes
      FOR EACH ROW EXECUTE FUNCTION reject_mcp_route_proof()`);
    try {
      expect((await client.callTool({ name: 'send_message', arguments: args })).isError).toBe(true);
      expect((await db.query('SELECT 1 FROM messages WHERE id=$1', [id])).rowCount).toBe(0);
      expect((await db.query('SELECT 1 FROM rooms_mcp_pending_routes WHERE message_id=$1', [id])).rowCount).toBe(0);
    } finally {
      await db.query('DROP TRIGGER reject_mcp_route_proof ON rooms_mcp_pending_routes; DROP FUNCTION reject_mcp_route_proof()');
    }
    await db.query("UPDATE rooms_mcp_idempotency SET claimed_at=now()-interval '2 minutes' WHERE member_id=$1", [member]);
    const retry = data(await client.callTool({ name: 'send_message', arguments: args }));
    expect(retry.woken).toEqual(['demo-agent']);
    expect((await db.query('SELECT 1 FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2', [id, AGENT])).rowCount).toBe(1);
  });
  it('resumes a saved post after interruption before routing, without posting twice', async () => {
    const { client, member } = await connected();
    const args = { room: ROOM, text: '@demo-agent please resume this saved post', idempotencyKey: 'saved-post' };
    const id = createHash('sha256').update(`rooms-mcp-message:${member}:${args.idempotencyKey}`).digest('hex');
    const execute = phone.execute.bind(phone);
    const fault = vi.spyOn(phone, 'execute').mockImplementation(async (...args) => {
      await execute(...args);
      throw new Error('proof: request interrupted after message commit');
    });
    try {
      expect((await client.callTool({ name: 'send_message', arguments: args })).isError).toBe(true);
    } finally { fault.mockRestore(); }
    expect((await db.query('SELECT 1 FROM rooms_mcp_pending_routes WHERE message_id=$1', [id])).rowCount).toBe(1);
    await db.query("UPDATE rooms_mcp_idempotency SET claimed_at=now()-interval '2 minutes' WHERE member_id=$1", [member]);
    const retry = data(await client.callTool({ name: 'send_message', arguments: args }));
    expect(retry.woken).toEqual(['demo-agent']);
    expect((await db.query('SELECT 1 FROM messages WHERE id=$1', [id])).rowCount).toBe(1);
    expect((await db.query('SELECT 1 FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2', [id, AGENT])).rowCount).toBe(1);
    expect(data(await client.callTool({ name: 'send_message', arguments: args }))).toEqual(retry);
  });
  it('retries a cached routing failure instead of returning it forever', async () => {
    const { client } = await connected();
    const args = { room: ROOM, text: '@demo-agent please retry this failed wake', idempotencyKey: 'cached-failed-wake' };
    const query = db.query.bind(db);
    let injected = false;
    const fault = vi.spyOn(db, 'query').mockImplementation(async (sql, values) => {
      if (!injected && sql.includes('SELECT text,room_id FROM messages')) {
        injected = true;
        throw new Error('proof: transient wake routing failure');
      }
      return query(sql, values);
    });
    let first: ReturnType<typeof data>;
    try {
      first = data(await client.callTool({ name: 'send_message', arguments: args }));
      expect(first.routing).toBe('retrying');
    } finally { fault.mockRestore(); }
    expect(injected).toBe(true);
    const retry = data(await client.callTool({ name: 'send_message', arguments: args }));
    expect(retry.messageId).toBe(first!.messageId);
    expect(retry.woken).toEqual(['demo-agent']);
    expect(retry.routing).toBeUndefined();
    expect((await db.query('SELECT 1 FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2', [retry.messageId, AGENT])).rowCount).toBe(1);
  });
  it('review proof: an interrupted routing record cannot lose a tagged wake on retry', async () => {
    const { client, member } = await connected();
    const args = { room: ROOM, text: '@demo-agent please handle this interrupted post', idempotencyKey: 'interrupted-route' };
    const id = createHash('sha256').update(`rooms-mcp-message:${member}:${args.idempotencyKey}`).digest('hex');
    const query = db.query.bind(db);
    let injected = false;
    const fault = vi.spyOn(db, 'query').mockImplementation(async (sql, values) => {
      if (!injected && sql.includes('INSERT INTO rooms_mcp_pending_routes')) {
        injected = true;
        throw new Error('review proof: interrupted routing insert');
      }
      return query(sql, values);
    });
    try {
      expect((await client.callTool({ name: 'send_message', arguments: args })).isError).toBe(true);
    } finally { fault.mockRestore(); }
    expect(injected).toBe(true);
    await db.query("UPDATE rooms_mcp_idempotency SET claimed_at=now()-interval '2 minutes' WHERE member_id=$1", [member]);
    const retry = data(await client.callTool({ name: 'send_message', arguments: args }));
    expect(retry.messageId).toBe(id);
    expect(retry.woken).toEqual(['demo-agent']);
    expect((await db.query('SELECT 1 FROM messages WHERE id=$1', [id])).rowCount).toBe(1);
    expect((await db.query('SELECT 1 FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2', [id, AGENT])).rowCount).toBe(1);
    expect((await db.query('SELECT 1 FROM rooms_mcp_pending_routes WHERE message_id=$1', [id])).rowCount).toBe(0);
  });
  describe('in a Room of 20,000 messages', () => {
    const BIG = '66666666-6666-4666-8666-666666666666';
    beforeAll(async () => {
      await db.query(`INSERT INTO rooms(id,workspace_id,name,visibility) VALUES($1,$2,'big','public')`, [BIG, WORKSPACE]);
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`, [WORKSPACE, BIG, USER, AGENT]);
      // Seed pre-cutover history without replay fanout. Fresh MCP sends below
      // retain all triggers and exercise the live write path against this history.
      await db.query('ALTER TABLE messages DISABLE TRIGGER beeline_notify_live_messages');
      try {
        await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
          SELECT encode(sha256(('big'||g)::bytea),'hex'),$1,CASE WHEN g%3=0 THEN $3 ELSE $2 END,
            'message '||g||' about @demo-agent and the release plan, with body text long enough to look real',
            now()-((20001-g)||' seconds')::interval FROM generate_series(1,20000) g`, [BIG, USER, AGENT]);
      } finally {
        await db.query('ALTER TABLE messages ENABLE TRIGGER beeline_notify_live_messages');
      }
      // The long seed outlives the server's keep-alive; drop the stale pooled socket.
      await fetch(origin + '/.well-known/oauth-authorization-server').catch(() => undefined);
    }, 120_000);
    const commands = async (messageId: string) => (await db.query(
      'SELECT 1 FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2', [messageId, AGENT])).rowCount;
    it('answers send_message in under 3 s and wakes the tagged agent once', async () => {
      const { client } = await connected();
      const started = Date.now();
      const sent = data(await client.callTool({ name: 'send_message', arguments: { room: BIG, text: '@demo-agent please review the plan' } }));
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(sent.woken).toEqual(['demo-agent']);
      expect(await commands(sent.messageId)).toBe(1);
      expect((await db.query(`SELECT 1 FROM live_journal
        WHERE stream_id=$1 AND event->>'messageId'=$2`, [`room:${BIG}`, sent.messageId])).rowCount).toBe(1);
    }, 60_000);
    it('returns one message to a retry sent while the first call is in flight, and wakes once', async () => {
      const { client } = await connected();
      const args = { room: BIG, text: '@demo-agent retried handoff', idempotencyKey: 'in-flight' };
      const [a, b] = await Promise.all([client.callTool({ name: 'send_message', arguments: args }), client.callTool({ name: 'send_message', arguments: args })]);
      expect(data(a).messageId).toBe(data(b).messageId);
      expect((await db.query('SELECT 1 FROM messages WHERE room_id=$1 AND text=$2', [BIG, args.text])).rowCount).toBe(1);
      expect(await commands(data(a).messageId)).toBe(1);
      expect(data(await client.callTool({ name: 'send_message', arguments: args })).messageId).toBe(data(a).messageId);
      expect(await commands(data(a).messageId)).toBe(1);
    }, 60_000);
    it('still wakes the tagged agent when the provenance read fails', async () => {
      const { client } = await connected();
      await db.query('ALTER TABLE rooms_mcp_mentions RENAME TO rooms_mcp_mentions_off');
      try {
        const sent = data(await client.callTool({ name: 'send_message', arguments: { room: BIG, text: '@demo-agent wake without provenance' } }));
        expect(sent.woken).toEqual(['demo-agent']);
        expect(await commands(sent.messageId)).toBe(1);
        const command = (await db.query<{ agent_depth: number }>('SELECT agent_depth FROM agent_commands WHERE source_message_id=$1', [sent.messageId])).rows[0]!;
        expect(command.agent_depth).toBe(1);
        expect((await db.query('SELECT 1 FROM rooms_mcp_pending_routes WHERE message_id=$1', [sent.messageId])).rowCount).toBe(0);
      } finally {
        await db.query('ALTER TABLE rooms_mcp_mentions_off RENAME TO rooms_mcp_mentions');
      }
    }, 60_000);
  });
  describe('agent tools for a connected app', () => {
    const call = async (client: Client, name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
      return { error: result.isError === true, text: result.content[0]!.text };
    };
    const ok = async (client: Client, name: string, args: Record<string, unknown>) => {
      const result = await call(client, name, args);
      expect(result.error, result.text).toBe(false);
      return JSON.parse(result.text).data;
    };
    /** A person's tag starts one demo-agent turn; returns that turn's authority. */
    async function agentTurn(text: string) {
      const sent = await phone.execute('sendRoomMessage', { roomId: ROOM, text }, USER) as { messageId: string };
      const command = (await db.query<{ id: string; turn_request_id: string }>(
        'SELECT id,turn_request_id FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2', [sent.messageId, AGENT])).rows[0]!;
      const generationId = `gen-${randomBytes(4).toString('hex')}`;
      await daemon.execute('claimAgentCommand', { roomId: ROOM, commandId: command.id, generationId } as never, AGENT);
      return { roomId: ROOM, requestId: command.turn_request_id, generationId };
    }
    it('R-MCP-PARITY: exposes every agent tool except the documented exclusions', async () => {
      const surface = await import('../../body/src/minimal-tool-surface.js');
      const agentTools = new Set([
        ...surface.minimalTools(true), ...surface.minimalTools(false), surface.RUNNER_TOOL, surface.SILENT_TOOL,
        ...surface.scratchTools(true), ...surface.repositoryTools(),
      ].map(definition => definition.name));
      for (const name of [...Object.values(surface.REPOSITORY_ROUTES), ...Object.values(surface.SCRATCH_ROUTES),
        ...Object.values(surface.CAPABILITY_ROUTES).flatMap(routes => Object.values(routes))]) agentTools.add(name);
      const { client } = await connected();
      const exposed = new Set([...(await client.listTools()).tools.map(definition => definition.name), ...MCP_APP_ROUTE_OPERATIONS]);
      const missing = [...agentTools].filter(name => !exposed.has(name) && !MCP_AGENT_EXCLUSIONS[name]);
      expect(missing).toEqual([]);
      expect(Object.keys(MCP_AGENT_EXCLUSIONS).filter(name => exposed.has(name))).toEqual([]);
      // Every exclusion names a real agent tool, so the table cannot hide a typo.
      expect(Object.keys(MCP_AGENT_EXCLUSIONS).filter(name => !agentTools.has(name))).toEqual([]);
    });
    it('R-MCP-EXCLUDED: refuses wallet spending and host grants with a plain reason', async () => {
      const { client } = await connected();
      for (const name of ['wallet_pay', 'wallet_swap', 'wallet_contract_call', 'wallet_sign_typed_data',
        'create_link_spend_request', 'wait_link_spend_request', 'request_grant', 'run_granted_command']) {
        const refused = await call(client, name, {});
        expect(refused.error, name).toBe(true);
        expect(refused.text).toMatch(name.includes('grant') ? /host grants are kept out of connected apps/ : /wallet spending is kept out of connected apps/);
      }
      for (const tool of ['pay', 'swap', 'contract_call', 'sign_typed_data', 'link_request', 'link_wait']) {
        const refused = await call(client, 'app_tool', { address: ROOM, app: 'beeline:wallet', tool, args: { amount: '1', to: '0x0' } });
        expect(refused.error, tool).toBe(true);
        expect(refused.text).toContain('wallet spending is kept out of connected apps');
      }
      const listed = await ok(client, 'app_tool', { address: ROOM, app: 'beeline:wallet' });
      expect(listed.tools.map((entry: { name: string }) => entry.name)).toEqual(['address', 'balance', 'chains', 'history', 'quote']);
      expect((await db.query("SELECT 1 FROM agent_grants WHERE kind='mcp' AND target='wallet'")).rowCount).toBe(0);
    });
    it('R-MCP-ORDER: orders an agent and receives its report as a wake', async () => {
      const { client, member } = await connected();
      const ordered = await ok(client, 'order', { address: ROOM, agent: 'demo-agent', text: 'Check the nebula numbers.' });
      expect(ordered.accepted).toBe(true);
      const order = (await db.query<{ id: string; turn_request_id: string; private_payload: { authorId: string } }>(
        `SELECT id,turn_request_id,private_payload FROM agent_commands WHERE id=$1`, [ordered.id])).rows[0]!;
      expect(order.private_payload.authorId).toBe(member);
      // The app's own call left no open turn behind.
      expect((await db.query(`SELECT 1 FROM agent_commands WHERE agent_id=$1 AND state<>'complete'`, [member])).rowCount).toBe(0);
      const generationId = 'gen-report';
      await daemon.execute('claimAgentCommand', { roomId: ROOM, commandId: order.id, generationId } as never, AGENT);
      await daemon.execute('report', { roomId: ROOM, requestId: order.turn_request_id, generationId, status: 'done', text: 'done: the numbers match' } as never, AGENT);
      const wakes = (await ok(client, 'list_mentions', {})).wakes as { address: string; reason: string; text: string }[];
      expect(wakes).toContainEqual(expect.objectContaining({ address: ROOM, reason: 'report', text: expect.stringContaining('the numbers match') }));
      expect((await ok(client, 'no_reply_needed', { address: ROOM })).cleared).toBe(1);
      expect((await ok(client, 'list_mentions', {})).wakes).toEqual([]);
    });
    it('R-MCP-REPORT: reports an order back to the agent that sent it', async () => {
      const { client, member, grant } = await connected();
      await db.query(`UPDATE rooms_mcp_clients SET callback_url='https://hooks.example/orders' WHERE id=$1`, [grant.clientId]);
      const handle = (await db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
      expect((await call(client, 'report', { address: ROOM, status: 'done', text: 'done: nothing was ordered' })).text)
        .toContain('no order is waiting for your report');
      const turn = await agentTurn('@demo-agent hand the audit to the app');
      const sent = await daemon.execute('order', { ...turn, address: ROOM, agent: handle, text: 'Audit the corner list.' } as never, AGENT) as { id: string };
      // The order reaches the app's webhook at once; no helper claims it.
      expect((await db.query<{ body: string }>('SELECT body FROM rooms_mcp_webhook_outbox WHERE member_id=$1 AND message_id=$2',
        [member, sent.id])).rows[0]?.body).toContain('Order (order): Audit the corner list.');
      const wakes = (await ok(client, 'list_mentions', {})).wakes as { address: string; kind?: string; text?: string }[];
      expect(wakes).toContainEqual(expect.objectContaining({ address: ROOM, kind: 'order', text: expect.stringContaining('Audit the corner list') }));
      // Another call in that Room leaves the order waiting for its report.
      await ok(client, 'read', { facet: 'members', address: ROOM });
      await ok(client, 'post', { address: ROOM, text: 'Auditing now.' });
      expect((await db.query(`SELECT 1 FROM agent_commands WHERE agent_id=$1 AND private_payload->>'kind'='order' AND state='pending'`, [member])).rowCount).toBe(1);
      expect((await call(client, 'report', { address: ROOM, status: 'done', text: 'finished without a prefix' })).error).toBe(true);
      await ok(client, 'report', { address: ROOM, status: 'done', text: 'done: three corners, all green' });
      const back = (await db.query<{ private_payload: { kind: string; text: string } }>(
        `SELECT private_payload FROM agent_commands WHERE agent_id=$1 AND reason='report' ORDER BY created_at DESC LIMIT 1`, [AGENT])).rows[0]!;
      expect(back.private_payload).toMatchObject({ kind: 'report', text: expect.stringContaining('three corners, all green') });
      expect((await db.query(`SELECT 1 FROM agent_commands WHERE agent_id=$1 AND state<>'complete'`, [member])).rowCount).toBe(0);
    });
    it('R-MCP-GATES: keeps reviewer, merge, hold and implementer gates for the app', async () => {
      const { client, member } = await connected();
      // Not the configured reviewer: no PASS.
      const pass = await call(client, 'approve_merge', { address: PUBLIC_CORNER, headSha: 'a'.repeat(40) });
      expect(pass.error).toBe(true);
      expect(pass.text).toMatch(/NOT_CONFIGURED_REVIEWER|reviewer/);
      // No pull request and no checks: the merge gate stays closed.
      expect(await ok(client, 'merge_corner', { address: PUBLIC_CORNER })).toMatchObject({ status: 'blocked' });
      // Agent callers must cite a readable person's request.
      const hold = await call(client, 'set_corner_hold', { address: PUBLIC_CORNER });
      expect(hold.error).toBe(true);
      expect(hold.text).toContain('close the PR to stop it');
      // A person's tag makes that person the requester, as it does for an agent turn.
      const handle0 = (await db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
      const request = await phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle0} hold the demo corner` }, USER);
      const held = await ok(client, 'set_corner_hold', { address: PUBLIC_CORNER, sourceMessageId: request.messageId });
      expect(held.holdId).toMatch(/^[0-9a-f-]{36}$/);
      expect(await ok(client, 'set_corner_hold', { address: PUBLIC_CORNER, releaseHoldId: held.holdId })).toBeDefined();
      // An app has no checkout, so repository work needs another implementer.
      const repoRoom = randomUUID();
      await db.query(`INSERT INTO rooms(id,workspace_id,name,visibility,repository_key,repository_remote,repository_resolution)
        VALUES($1,$2,'Repo','public','acme/repo','https://github.com/acme/repo.git','repository')`, [repoRoom, WORKSPACE]);
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member'),($1,$2,$4,'member')`, [WORKSPACE, repoRoom, member, AGENT]);
      const handle = (await db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
      const self = await call(client, 'open_corner', { room: repoRoom, implementer: handle, brief: { spec: 'Fix the login copy.' } });
      expect(self.error).toBe(true);
      expect(self.text).toContain('cannot implement repository work; name another agent as implementer');
      expect((await db.query('SELECT 1 FROM rooms WHERE parent_id=$1', [repoRoom])).rowCount).toBe(0);
    });
    it('R-MCP-CORNER: opens a corner with another implementer and posts in it', async () => {
      const { client } = await connected();
      const opened = await ok(client, 'open_corner', { room: ROOM, name: 'nebula-check', objective: 'Check the nebula numbers',
        implementer: 'demo-agent', brief: { spec: '## Intent\nCheck the nebula numbers.', repositoryWork: false } });
      expect(opened.status).toBe('starting');
      const corner = opened.address as string;
      expect((await db.query<{ owner_agent_id: string }>('SELECT owner_agent_id FROM corner_facts WHERE corner_id=$1', [corner])).rows[0]?.owner_agent_id).toBeDefined();
      const posted = await ok(client, 'post', { address: corner, text: 'Numbers attached below.' });
      expect(posted.stored).toBe(true);
      await ok(client, 'react_to_message', { address: corner, messageId: posted.id, emoji: '👀' });
      expect((await ok(client, 'read', { facet: 'brief', address: corner })).revisions?.length ?? 1).toBeGreaterThan(0);
    });
  });
});
