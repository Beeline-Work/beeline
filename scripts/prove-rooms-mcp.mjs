/** Local-only seeded reviewer fixture. No production credentials or helper are used. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { connectMcp } from '../apps/server/dist/rooms-mcp-connections.js';
import { bundledMcpLogo } from '../apps/server/dist/rooms-mcp-logos.js';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth as mcpAuth } from '@modelcontextprotocol/sdk/client/auth.js';
import { AuthStore } from '../apps/auth/dist/store.js';
import { migrate } from '../apps/server/dist/database.js';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { TokenAuth, tokenHash } from '../apps/server/dist/auth.js';
import { createMonolithAuth } from '../apps/server/dist/monolith-auth.js';
import { RoomsMcp } from '../apps/server/dist/rooms-mcp.js';
import { RoomsMcpOAuth } from '../apps/server/dist/rooms-mcp-oauth.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { createBeelineServer } from '../apps/server/dist/server.js';
import { claimAgentCommand } from '../apps/server/dist/agent-command.js';
import { deliverMcpMemberWebhooks } from '../apps/server/dist/rooms-mcp-members.js';

const db = new PgliteDatabase();
let server, mount, client;
const room = '22222222-2222-4222-8222-222222222222';
const workspace = '11111111-1111-4111-8111-111111111111';
const person = tokenHash('github:rooms-mcp-reviewer');
const agent = 'a'.repeat(64);
const transcript = text => console.log(`[ROOMS-MCP-1] ${text}`);
try {
  await migrate(db); await new AuthStore(db).migrate();
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Connector Reviewer','connector-reviewer'),($2,'agent','Demo Agent','demo-agent')`, [person, agent]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [agent, person]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Connector Review')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,visibility) VALUES($1,$2,'connector-demo','invite-only')`, [room, workspace]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,NULL,$4,'member'),($1,$2,$3,'owner'),($1,$2,$4,'member')`, [workspace, room, person, agent]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Today I prepared the connector review. This is synthetic demo content.')`, ['b'.repeat(64), room, agent]);
  const tokenAuth = new TokenAuth(db, ticket => mount.verifyGitHubTicket(ticket), () => new Date(), ticket => mount.verifyGoogleTicket(ticket));
  const live = new LiveHub();
  const options = { database: db, auth: tokenAuth, live, mediaMaximumBytes: 1024, phone: new PhoneService(db, 'http://127.0.0.1', undefined, undefined, live),
    daemon: new DaemonService(db, live), authHandler: (request, response) => {
      const incoming = new URL(request.url, 'http://127.0.0.1');
      if (incoming.pathname === '/auth/proof-provider') {
        response.writeHead(302, { location: `/auth/github/callback?state=${encodeURIComponent(incoming.searchParams.get('state') ?? '')}&code=synthetic-provider-code` });
        response.end();
      } else mount.handle(request, response);
    } };
  server = createBeelineServer(options);
  await new Promise(resolve => server.listen(Number(process.env.MCP_PROOF_PORT ?? 0), '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const tenant = { host: new URL(origin).host, community: 'local-connector-review', origin, roomCommunityIds: ['local-review-room'] };
  // The only stand-in is the upstream GitHub identity provider. Beeline's actual
  // browser-bound login flow, ticket mint/consume and account linking run unchanged.
  const github = {
    oauth: { config: { clientId: 'fixture-client', clientSecret: 'fixture-secret' },
      authorizationUrl: ({ state, redirectUri }) => `${origin}/auth/proof-provider?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      exchangeCode: async code => {
        assert.equal(code, 'synthetic-provider-code');
        return { issuer: 'https://github.com', audience: 'fixture-client', subject: 'rooms-mcp-reviewer', login: 'connector-reviewer', displayName: 'Connector Reviewer', accessToken: 'synthetic-provider-token' };
      },
    },
    app: { installationUrl: () => 'https://provider.invalid/install' },
  };
  mount = await createMonolithAuth(db, origin, github, { createDaemonExchange: (id, tx) => tokenAuth.createDaemonExchange(id, tx), env: {
    NODE_ENV: 'test', BEELINE_AUTH_TENANTS_JSON: JSON.stringify([tenant]), BEELINE_AUTH_OIDC_ISSUER: 'https://accounts.google.com',
    BEELINE_AUTH_OIDC_AUTHORIZATION_ENDPOINT: 'https://accounts.google.com/o/oauth2/v2/auth',
    BEELINE_AUTH_OIDC_TOKEN_ENDPOINT: 'https://oauth2.googleapis.com/token', BEELINE_AUTH_OIDC_JWKS_URI: 'https://www.googleapis.com/oauth2/v3/certs', BEELINE_AUTH_OIDC_CLIENT_ID: 'fixture-client',
  } });
  options.roomsMcp = new RoomsMcp(new RoomsMcpOAuth(db, origin, tokenAuth), options.phone, live);
  if (process.argv.includes('--serve')) {
    transcript(`Local demo server: ${origin}/mcp. Use GitHub in consent; the fixture supplies only the synthetic reviewer identity.`);
    transcript('This loopback fixture has no production account access. Stop with Ctrl+C.');
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  } else {
  const jar = new Map();
  const browser = async (url, init = {}) => {
    const response = await fetch(new URL(url, origin), { ...init, redirect: 'manual', headers: { cookie: [...jar].map(([k,v]) => `${k}=${v}`).join('; '), ...init.headers } });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';'); const index = pair.indexOf('='); jar.set(pair.slice(0,index), pair.slice(index+1));
    }
    return response;
  };
  let info, tokens, verifier, authorizeUrl;
  const provider = {
    redirectUrl: 'http://127.0.0.1:9876/callback',
    clientMetadata: { client_name: 'Grok', redirect_uris: ['http://127.0.0.1:9876/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'rooms:read rooms:write' },
    state: () => 'local-proof-state', clientInformation: () => info, saveClientInformation: value => { info = value; },
    tokens: () => tokens, saveTokens: value => { tokens = value; },
    codeVerifier: () => verifier, saveCodeVerifier: value => { verifier = value; }, redirectToAuthorization: value => { authorizeUrl = value; },
  };
  assert.equal(await mcpAuth(provider, { serverUrl: origin + '/mcp', scope: 'rooms:read rooms:write', resourceMetadataUrl: new URL(origin + '/.well-known/oauth-protected-resource/mcp') }), 'REDIRECT');
  transcript('SDK discovered metadata, dynamically registered, generated S256 PKCE and requested both scopes.');
  let response = await browser(authorizeUrl); assert.equal(response.status, 302);
  const consentUrl = response.headers.get('location');
  response = await browser(consentUrl); assert.match(await response.text(), /Continue with GitHub/);
  const flow = new URL(consentUrl, origin).searchParams.get('flow');
  response = await browser(`/mcp/oauth/login?flow=${flow}&provider=github`); assert.equal(response.status, 302);
  response = await browser(response.headers.get('location')); assert.equal(response.status, 302);
  const upstream = new URL(response.headers.get('location'));
  response = await browser(`/auth/github/callback?state=${upstream.searchParams.get('state')}&code=synthetic-provider-code`); assert.equal(response.status, 302);
  response = await browser(response.headers.get('location')); assert.equal(response.status, 302);
  response = await browser(response.headers.get('location'));
  const html = await response.text(); assert.match(html, /JOINS AS/); assert.match(html, /Read Rooms you add it to/); assert.match(html, /Post as Grok/); assert.match(html, /Connector Reviewer/);
  transcript('Built Beeline GitHub login completed, consumed a one-use ticket, and showed the joining member, account, read scope and write scope on consent. Upstream GitHub is a local test double.');
  response = await browser('/mcp/oauth/consent', { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ flow, decision: 'allow' }) });
  assert.equal(response.status, 302);
  const callback = new URL(response.headers.get('location'));
  assert.equal(callback.searchParams.get('state'), 'local-proof-state'); assert.equal(callback.searchParams.get('iss'), origin);
  assert.equal(await mcpAuth(provider, { serverUrl: origin + '/mcp', authorizationCode: callback.searchParams.get('code'), resourceMetadataUrl: new URL(origin + '/.well-known/oauth-protected-resource/mcp') }), 'AUTHORIZED');
  transcript('SDK exchanged the code with PKCE and the resource audience. No credentials are printed or saved.');
  // The connection is a member owned by the reviewer; a person adds it to a Room to read and post there.
  const member = (await db.query(`SELECT member_id FROM rooms_mcp_members WHERE owner_id=$1`, [person])).rows[0].member_id;
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member') ON CONFLICT DO NOTHING`, [workspace, room, member]);
  const firstRefresh = tokens.refresh_token;
  tokens.expires_in = 0;
  assert.equal(await mcpAuth(provider, { serverUrl: origin + '/mcp', resourceMetadataUrl: new URL(origin + '/.well-known/oauth-protected-resource/mcp') }), 'AUTHORIZED');
  assert.notEqual(tokens.refresh_token, firstRefresh);
  transcript('SDK refreshed the connection and received a rotated refresh token.');
  client = new Client({ name: 'beeline-rooms-proof', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { authProvider: provider }));
  assert.equal((await client.listTools()).tools.length, 7);
  const rooms = await client.callTool({ name: 'list_rooms', arguments: {} }); assert.match(JSON.stringify(rooms), /connector-demo/);
  const read = await client.callTool({ name: 'read_messages', arguments: { room, limit: 10 } }); assert.match(JSON.stringify(read), /synthetic demo content/);
  transcript('Streamable HTTP client initialized, discovered all tools, listed its seeded Room and read synthetic agent activity.');
  const sent = await client.callTool({ name: 'send_message', arguments: { room, text: '@demo-agent acknowledge the connector review' } }); assert.notEqual(sent.isError, true);
  const row = (await db.query(`SELECT m.id,m.author_id,c.id command_id FROM messages m JOIN agent_commands c ON c.source_message_id=m.id WHERE m.text=$1 AND m.room_id=$2`, ['@demo-agent acknowledge the connector review', room])).rows[0];
  assert.equal(row.author_id, member);
  await claimAgentCommand(db, room, agent, row.command_id, 'connector-proof');
  await options.daemon.execute('postRoomMessage', { roomId: room, requestId: row.id, generationId: 'connector-proof', text: 'Connector review acknowledged.' }, agent);
  assert.match(JSON.stringify(await options.phone.readRoom(room, person)), /Connector review acknowledged/);
  transcript('send_message posted as the member; the tagged demo agent claimed its command and replied; the phone Room read shows the reply.');
  // Optional Inspector CLI library uses the very same short-lived local grant.
  if (process.env.MCP_INSPECTOR_CLIENT) {
    process.env.MCP_INSPECTOR_SECRET_STORE = 'memory';
    process.env.MCP_INSPECTOR_PERSIST_TOKENS = 'false';
    const { runCli } = await import(pathToFileURL(process.env.MCP_INSPECTOR_CLIENT).href);
    for (const [name, args] of [
      ['list_rooms', {}], ['read_messages', { room, limit: 10 }],
      ['send_message', { room, text: 'MCP Inspector reviewed this synthetic Room.' }],
    ]) {
      await runCli(['node', 'inspector-cli', '--server-url', origin + '/mcp', '--transport', 'http',
        '--header', `Authorization: Bearer ${tokens.access_token}`, '--method', 'tools/call',
        '--tool-name', name, '--tool-args-json', JSON.stringify(args), '--format', 'json', '--quiet']);
      transcript(`MCP Inspector tools/call ${name} completed through Streamable HTTP using the OAuth-issued local grant.`);
    }
  }
  if (process.argv.includes('--ui')) {
    const muse = 'local-muse-reviewer';
    await db.query('INSERT INTO rooms_mcp_clients(id,name,redirects,logo) VALUES($1,$2,$3::jsonb,$4)', [muse, 'Meta Muse', '[]', await bundledMcpLogo('Meta Muse')]);
    await db.transaction(tx => connectMcp(tx, { client_id: muse, identity_id: person, scope: 'rooms:read' }));
    const phoneToken = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO phone_access_tokens(token_hash,identity_id,family_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [tokenHash(phoneToken), person, '11111111-1111-4111-8111-111111111111']);
    const handler = server.listeners('request')[0];
    server.removeAllListeners('request');
    server.on('request', async (req, res) => {
      if (req.url === '/proof/bootstrap') {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ phoneToken, person, workspace, room, clientId: info.client_id }));
      } else if (req.url === '/proof/status') {
        const status = (await fetch(origin + '/mcp', { headers: { authorization: `Bearer ${tokens.access_token}` } })).status;
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify({ status }));
        if (status === 401) transcript('Settings disconnect: the next MCP call returned 401.');
      } else handler(req, res);
    });
    transcript(`UI proof fixture ${origin}; only synthetic accounts and credentials. Keep running until screenshots and Disconnect complete.`);
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  } else {
    // A wake queued before removal must never deliver Room text after it.
    await db.query(`UPDATE rooms_mcp_clients SET callback_url='https://hooks.invalid/removed' WHERE id=$1`, [info.client_id]);
    const memberHandle = (await db.query(`SELECT handle FROM identities WHERE id=$1`, [member])).rows[0].handle;
    const queued = await options.phone.execute('sendRoomMessage', { roomId: room, text: `@${memberHandle} queued before removal` }, person);
    await options.phone.execute('removeRoomMember', { roomId: room, memberId: member }, person);
    assert.equal((await client.callTool({ name: 'read_messages', arguments: { room } })).isError, true);
    let removalDeliveries = 0;
    const removalCount = await deliverMcpMemberWebhooks(db, async () => { removalDeliveries++; return new Response('', { status: 200 }); });
    assert.equal(removalCount, 0); assert.equal(removalDeliveries, 0);
    const skipped = (await db.query(`SELECT c.outcome,o.delivered_at FROM subscription_webhook_calls c
      JOIN rooms_mcp_webhook_outbox o ON o.call_id=c.id WHERE c.member_id=$1 AND c.wake_message_id=$2`, [member, queued.messageId])).rows[0];
    assert.equal(skipped.outcome, 'skipped'); assert.ok(skipped.delivered_at);
    transcript('Removed from the Room: the next MCP read was denied and the webhook queued before removal was retired skipped with zero HTTP calls.');
    await options.phone.execute('disconnectAiClient', { clientId: info.client_id }, person);
  }
  response = await fetch(origin + '/mcp', { headers: { authorization: `Bearer ${tokens.access_token}` } }); assert.equal(response.status, 401);
  transcript('Disconnect succeeded; the next MCP request returned unauthorized. PASS.');
  }
} finally {
  await client?.close(); server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  await mount?.close(); await db.close();
}
