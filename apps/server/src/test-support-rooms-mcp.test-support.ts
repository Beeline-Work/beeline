import { phoneFetch } from '../../../tests/helpers/phone-operation.js';

import { COMMAND_COMPLETION_CHANNEL, notifyCommandCompletion } from './command-completion.js';

import { cornerOwnerSql } from './corner-worker.js';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { createServer } from 'node:http';

import { Webhook } from 'standardwebhooks';

import { MCP_ORDER_WAKE_HINT, MCP_REVIEW_WAKE_HINT, MCP_WAKE_HINT, RoomsMcpEvents } from './rooms-mcp-events.js';

import { backfillMcpMemberRoomsAndAvatars, ensureMcpMember, MCP_TAG_INSTRUCTION, postMcpWebhook } from './rooms-mcp-members.js';

import { randomBytes, createHash, randomUUID } from 'node:crypto';

import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { migrate } from './database.js';

import { MemoryObjectStorage, PgliteDatabase, assignCornerWorker, insertCornerFacts } from './test-support.js';

import { ObjectService } from './object-service.js';

import { TokenAuth, tokenHash } from './auth.js';

import { recordSigninAttempt } from './signin-attempts.js';

import { PhoneService } from './phone-service.js';

import { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';

import { LiveHub } from './live.js';

import { createBeelineServer } from './server.js';

import { BROWSER_REFUSALS, RoomsMcpOAuth } from './rooms-mcp-oauth.js';

import { RoomsMcp } from './rooms-mcp.js';

import { MCP_AGENT_EXCLUSIONS, MCP_AGENT_TOOLS, MCP_APP_ROUTE_OPERATIONS, pendingMcpWakes } from './rooms-mcp-agent.js';

import { claimAgentCommand, createAgentCommand, routeHumanMessage, routeAgentResult } from './agent-command.js';

import { cornerWorkSql } from './chat-corner-counts.js';

import { openSecrets } from './free-agents.js';

import { deliverMcpMemberWebhooks, runMcpWebhookDelivery } from './rooms-mcp-members.js';


import { PREREGISTERED_MCP_CLIENTS } from './rooms-mcp-preregistered.js';

import type { readFileSync } from 'node:fs';

import sharp from 'sharp';

import { MCP_STARTER_ROUTINE, FACE_SOULS } from '@beeline/api-contract/phone';


export const USER = tokenHash('google:mcp-demo'), OTHER = 'b'.repeat(64), AGENT = 'c'.repeat(64);

export const WORKSPACE = '11111111-1111-4111-8111-111111111111';

export const ROOM = '22222222-2222-4222-8222-222222222222', PRIVATE = '33333333-3333-4333-8333-333333333333';

export const CORNER = '44444444-4444-4444-8444-444444444444';

export const PUBLIC_CORNER = '55555555-5555-4555-8555-555555555555';

export const opaque = () => randomBytes(32).toString('base64url');
export function fixtureScope1() {

  let db: PgliteDatabase, server: ReturnType<typeof createBeelineServer>, origin: string, phone: PhoneService, daemon: DaemonService;

  const clients: Client[] = [];

  let releaseCompletions: () => Promise<void>;

  let eventTransport: typeof postMcpWebhook = postMcpWebhook;

  beforeAll(async () => {
    db = new PgliteDatabase(); await migrate(db);
    releaseCompletions = await db.client.listen(COMMAND_COMPLETION_CHANNEL, notifyCommandCompletion);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Demo','demo'),($2,'human','Other','other'),($3,'agent','Demo Agent','demo-agent')`, [USER, OTHER, AGENT]);
    await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [AGENT, USER]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'MCP Demo')`, [WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name,visibility) VALUES($1,$3,'Demo','public'),($2,$3,'Private','invite-only')`, [ROOM, PRIVATE, WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name,parent_id) VALUES($1,$2,'Private corner',$3)`, [CORNER, WORKSPACE, PRIVATE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name,parent_id) VALUES($1,$2,'Demo corner',$3)`, [PUBLIC_CORNER, WORKSPACE, ROOM]);
    await insertCornerFacts(db, { cornerId: PUBLIC_CORNER, ownerAgentId: AGENT });
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$4,'owner'),($1,NULL,$5,'member'),($1,NULL,$6,'member'),($1,$2,$4,'owner'),($1,$2,$6,'member'),($1,$3,$5,'member')`, [WORKSPACE, ROOM, PRIVATE, USER, OTHER, AGENT]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'private nebula')`, ['d'.repeat(64), PRIVATE, OTHER]);
    const auth = new TokenAuth(db, async () => { throw new Error('unused'); }, () => new Date(), async ticket => {
      if (ticket.startsWith('local-new-')) return { subject: ticket, name: 'Robin Proof', audience: 'local-test' };
      if (ticket !== 'local-demo-ticket') throw new Error('Invalid ticket');
      return { subject: 'mcp-demo', name: 'Demo', audience: 'local-test' };
    });
    const live = new LiveHub();
    phone = new PhoneService(db, 'http://127.0.0.1', undefined, undefined, live);
    daemon = new DaemonService(db, live, undefined, undefined, false, undefined, false, undefined,
      undefined, undefined, { enabled: true, live: true });
    const options = { database: db, auth, phone, daemon, live, mediaMaximumBytes: 1024, roomsMcp: undefined as RoomsMcp | undefined };
    server = createBeelineServer(options);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    options.roomsMcp = new RoomsMcp(new RoomsMcpOAuth(db, origin, auth, 'localhost'), phone, live, daemon,
      new ObjectService(db, new MemoryObjectStorage().asStorage(), origin),
      new RoomsMcpEvents(db, (url, init) => eventTransport(url, init)));
  }, 60_000);

  beforeEach(async () => {
    // Each independent HTTP scenario starts with its own admission budget.
    await db.query('DELETE FROM rooms_mcp_admission');
  });

  afterAll(async () => {
    for (const client of clients) await client.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); await releaseCompletions(); await db.close();
  });

  async function post(path: string, input: Record<string, unknown>, headers: Record<string, string> = {}) {
    return phoneFetch(origin + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) });
  }

  async function prepareAuthorization(scope = 'rooms:read rooms:write', clientId?: string, redirectUri = 'http://127.0.0.1:9876/callback', ticket = 'local-demo-ticket', resource = origin + '/mcp') {
    const registered = await post('/mcp/oauth/register', { client_name: 'Local MCP reviewer', redirect_uris: ['http://127.0.0.1:9876/callback'], token_endpoint_auth_method: 'none' });
    expect(registered.status).toBe(201);
    const client = clientId ? { client_id: clientId } : await registered.json() as { client_id: string };
    const verifier = opaque();
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code', resource,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope, state: 'review-state' });
    if (!scope) query.delete('scope');
    const start = await phoneFetch(origin + '/mcp/oauth/authorize?' + query, { redirect: 'manual' });
    expect(start.status).toBe(302);
    const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
    const consent = start.headers.get('location')!;
    const flow = new URL(consent, origin).searchParams.get('flow')!;
    const login = await phoneFetch(`${origin}/mcp/oauth/login?flow=${flow}&provider=google`, { headers: { cookie }, redirect: 'manual' });
    expect(login.headers.get('location')).toContain('/auth/oidc/start');
    const callback = await phoneFetch(`${origin}/mcp/oauth/callback/google?state=${flow}&ticket=${encodeURIComponent(ticket)}`, { headers: { cookie }, redirect: 'manual' });
    expect(callback.status).toBe(302);
    const page = await phoneFetch(origin + consent, { headers: { cookie } });
    expect(page.headers.get('referrer-policy')).toBe('same-origin');
    // Reproduction mcp-consent-1: form-action blocked the client's own redirect hops after Allow.
    expect(page.headers.get('content-security-policy')).not.toContain('form-action');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const consentHtml = await page.text();
    expect(consentHtml).toContain(clientId ? 'to your team</h1>' : 'Local MCP reviewer');
    return { consentHtml, consent, clientId: client.client_id, verifier, cookie, flow };
  }

  async function authorize(scope = 'rooms:read rooms:write', decision = 'allow', clientId?: string, redirectUri = 'http://127.0.0.1:9876/callback', wake: Record<string, unknown> = {}, resource = origin + '/mcp') {
    const prepared = await prepareAuthorization(scope, clientId, redirectUri, undefined, resource);
    const { flow, cookie } = prepared;
    const result = await post('/mcp/oauth/consent', { flow, decision, trust_app: '1', workspace_selection: '1', workspace_ids: [WORKSPACE], ...wake }, { cookie, origin });
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

  async function connected(scope?: string, workspaceIds: readonly string[] = [WORKSPACE]) {
    const grant = await authorize(scope, 'allow', undefined, undefined, { workspace_ids: workspaceIds });
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

  const data = (result: unknown) => JSON.parse(((result as { content: { text: string }[] }).content)[0]!.text).data;
return {
get db(){return db;}, set db(value: typeof db){db=value;},
get server(){return server;}, set server(value: typeof server){server=value;},
get origin(){return origin;}, set origin(value: typeof origin){origin=value;},
get phone(){return phone;}, set phone(value: typeof phone){phone=value;},
get daemon(){return daemon;}, set daemon(value: typeof daemon){daemon=value;},
clients,
get releaseCompletions(){return releaseCompletions;}, set releaseCompletions(value: typeof releaseCompletions){releaseCompletions=value;},
get eventTransport(){return eventTransport;}, set eventTransport(value: typeof eventTransport){eventTransport=value;},
post,
prepareAuthorization,
authorize,
exchange,
connected,
eventCall,
eventFixture,
data,
};
}
export function fixtureScope2(scope1: ReturnType<typeof fixtureScope1>) {

    const BIG = '66666666-6666-4666-8666-666666666666';

    const bigWorkspace = randomUUID();

    beforeAll(async () => {
      // Keep bulk history outside ordinary clients' consented Workspace. Otherwise
      // every later grant joins this public Room and repeats its history fanout.
      await scope1.db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Large MCP history')`, [bigWorkspace]);
      await scope1.db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner'),($1,$3,'member')`, [bigWorkspace, USER, AGENT]);
      await scope1.db.query(`INSERT INTO rooms(id,workspace_id,name,visibility) VALUES($1,$2,'big','public')`, [BIG, bigWorkspace]);
      await scope1.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`, [bigWorkspace, BIG, USER, AGENT]);
      // Seed pre-cutover history without replay fanout. Fresh MCP sends below
      // retain all triggers and exercise the live write path against this history.
      await scope1.db.query('ALTER TABLE messages DISABLE TRIGGER beeline_notify_live_messages');
      try {
        await scope1.db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
          SELECT encode(sha256(('big'||g)::bytea),'hex'),$1,CASE WHEN g%3=0 THEN $3 ELSE $2 END,
            'message '||g||' about @demo-agent and the release plan, with body text long enough to look real',
            now()-((20001-g)||' seconds')::interval FROM generate_series(1,20000) g`, [BIG, USER, AGENT]);
      } finally {
        await scope1.db.query('ALTER TABLE messages ENABLE TRIGGER beeline_notify_live_messages');
      }
      // The long seed outlives the server's keep-alive; drop the stale pooled socket.
      await phoneFetch(scope1.origin + '/.well-known/oauth-authorization-server').catch(() => undefined);
    }, 120_000);

    const commands = async (messageId: string) => (await scope1.db.query(
      'SELECT 1 FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2', [messageId, AGENT])).rowCount;
return {
BIG,
bigWorkspace,
commands,
};
}
export function fixtureScope3(scope1: ReturnType<typeof fixtureScope1>) {

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
      const sent = await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text }, USER) as { messageId: string };
      const command = (await scope1.db.query<{ id: string; turn_request_id: string }>(
        'SELECT id,turn_request_id FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2', [sent.messageId, AGENT])).rows[0]!;
      const generationId = `gen-${randomBytes(4).toString('hex')}`;
      await scope1.daemon.execute('claimAgentCommand', { roomId: ROOM, commandId: command.id, generationId } as never, AGENT);
      return { roomId: ROOM, requestId: command.turn_request_id, generationId };
    }

    async function reportCorner(member: string) {
      const corner = randomUUID();
      await scope1.db.query(`INSERT INTO rooms(id,workspace_id,name,parent_id,created_by) VALUES($1,$2,'Report proof',$3,$4)`, [corner, WORKSPACE, ROOM, AGENT]);
      await insertCornerFacts(scope1.db, { cornerId: corner, ownerAgentId: AGENT });
      await assignCornerWorker(scope1.db, corner, member);
      await scope1.db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,spec,approval_basis,author_id,source_room_id)
        VALUES($1,1,'Report proof','{"repositoryWork":false}',$2,$3)`, [corner, AGENT, ROOM]);
      return corner;
    }

    async function cornerWorking(corner: string) {
      return (await scope1.db.query<{ worker_active: boolean }>(`SELECT activity.worker_active FROM rooms c
        JOIN corner_facts f ON f.corner_id=c.id
        LEFT JOIN corner_github_cache gh ON gh.corner_id=c.id ${cornerWorkSql()} WHERE c.id=$1`, [corner])).rows[0]!.worker_active;
    }
return {
call,
ok,
agentTurn,
reportCorner,
cornerWorking,
};
}
export { phoneFetch } from '../../../tests/helpers/phone-operation.js';
export { COMMAND_COMPLETION_CHANNEL, notifyCommandCompletion } from './command-completion.js';
export { cornerOwnerSql } from './corner-worker.js';
export { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
export { createServer } from 'node:http';
export { Webhook } from 'standardwebhooks';
export { MCP_ORDER_WAKE_HINT, MCP_REVIEW_WAKE_HINT, MCP_WAKE_HINT, RoomsMcpEvents } from './rooms-mcp-events.js';
export { backfillMcpMemberRoomsAndAvatars, ensureMcpMember, MCP_TAG_INSTRUCTION, postMcpWebhook, deliverMcpMemberWebhooks, runMcpWebhookDelivery } from './rooms-mcp-members.js';
export { randomBytes, createHash, randomUUID } from 'node:crypto';
export { Client } from '@modelcontextprotocol/sdk/client/index.js';
export { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
export { migrate } from './database.js';
export { MemoryObjectStorage, PgliteDatabase, assignCornerWorker, insertCornerFacts } from './test-support.js';
export { ObjectService } from './object-service.js';
export { TokenAuth, tokenHash } from './auth.js';
export { recordSigninAttempt } from './signin-attempts.js';
export { PhoneService } from './phone-service.js';
export { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';
export { LiveHub } from './live.js';
export { createBeelineServer } from './server.js';
export { BROWSER_REFUSALS, RoomsMcpOAuth } from './rooms-mcp-oauth.js';
export { RoomsMcp } from './rooms-mcp.js';
export { MCP_AGENT_EXCLUSIONS, MCP_AGENT_TOOLS, MCP_APP_ROUTE_OPERATIONS, pendingMcpWakes } from './rooms-mcp-agent.js';
export { claimAgentCommand, createAgentCommand, routeHumanMessage, routeAgentResult } from './agent-command.js';
export { cornerWorkSql } from './chat-corner-counts.js';
export { openSecrets } from './free-agents.js';
export { PREREGISTERED_MCP_CLIENTS } from './rooms-mcp-preregistered.js';
export { readFileSync } from 'node:fs';
export { default as sharp } from 'sharp';
export { MCP_STARTER_ROUTINE, FACE_SOULS } from '@beeline/api-contract/phone';
export type { AddressInfo } from 'node:net';
