/** Local-only seeded reviewer fixture. No production credentials or helper are used. */
import assert from 'node:assert/strict';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
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
import { PREREGISTERED_MCP_CLIENTS } from '../apps/server/dist/rooms-mcp-preregistered.js';
import { POSTGRES_LIVE_CHANNEL, PostgresLiveListener } from '../apps/server/dist/postgres-live.js';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';

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
  const options = { database: db, auth: tokenAuth, live, mediaMaximumBytes: 1024,
    ...(process.env.MCP_PROOF_WEB_ORIGIN ? { webAppOrigins: [process.env.MCP_PROOF_WEB_ORIGIN] } : {}), phone: new PhoneService(db, process.env.MCP_PROOF_PORT ? `http://127.0.0.1:${process.env.MCP_PROOF_PORT}` : 'http://127.0.0.1', undefined, undefined, live),
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
  if (process.argv.includes('--connect-pages')) {
    // CONNECT-1: Meta Muse signs in with its published client id, joins every
    // public Room, shows its logo, and a tag reaches its webhook on commit.
    // Only the upstream GitHub provider and the outside webhook receiver are doubles.
    process.env.BEELINE_MCP_WEBHOOK_KEY ??= 'local-proof-key';
    const publicRooms = [['33333333-3333-4333-8333-333333333333', 'general'], ['44444444-4444-4444-8444-444444444444', 'design']];
    for (const [id, name] of publicRooms) {
      await db.query(`INSERT INTO rooms(id,workspace_id,name,visibility) VALUES($1,$2,$3,'public')`, [id, workspace, name]);
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`, [workspace, id, person, agent]);
    }
    const posts = [];
    class Listen extends EventEmitter {
      async connect() {}
      async query() { this.release = await db.client.listen(POSTGRES_LIVE_CHANNEL, payload => this.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload })); }
      async end() { await this.release?.(); }
    }
    const listener = new PostgresLiveListener(db, live, () => new Listen(), 1);
    listener.setMcpWebhookWake(() => void deliverMcpMemberWebhooks(db, async (url, init) => {
      posts.push({ url: String(url), at: Date.now(), authorization: new Headers(init.headers).get('authorization'), body: JSON.parse(init.body) });
      return new Response('', { status: 200 });
    }));
    void listener.run();
    const muse = PREREGISTERED_MCP_CLIENTS[0];
    const verifier = randomBytes(32).toString('base64url');
    const authorizeUrl = `${origin}/mcp/oauth/authorize?${new URLSearchParams({ client_id: muse.id, redirect_uri: muse.redirects[0], response_type: 'code',
      resource: origin + '/mcp', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'rooms:read rooms:write', state: 'connect-proof' })}`;
    const handler = server.listeners('request')[0];
    server.removeAllListeners('request');
    server.on('request', async (req, res) => {
      const url = new URL(req.url, origin);
      if (url.pathname !== '/proof/finish') return handler(req, res);
      try {
        const token = await (await fetch(origin + '/mcp/oauth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          grant_type: 'authorization_code', client_id: muse.id, code: url.searchParams.get('code'), code_verifier: verifier, redirect_uri: muse.redirects[0], resource: origin + '/mcp' }) })).json();
        assert.ok(token.access_token, 'token exchange');
        const member = (await db.query('SELECT member_id FROM rooms_mcp_members WHERE client_id=$1 AND owner_id=$2', [muse.id, person])).rows[0].member_id;
        const identity = (await db.query('SELECT name,handle,avatar FROM identities WHERE id=$1', [member])).rows[0];
        const joined = (await db.query(`SELECT r.name FROM memberships m JOIN rooms r ON r.id=m.room_id WHERE m.identity_id=$1 AND m.removed_at IS NULL ORDER BY r.name`, [member])).rows.map(row => row.name);
        const avatar = await fetch(origin + identity.avatar);
        client = new Client({ name: 'connect-proof', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${token.access_token}` } } }));
        const firstRead = JSON.parse((await client.callTool({ name: 'list_rooms', arguments: {} })).content[0].text).data;
        const { default: sharp } = await import('sharp');
        const museJpeg = await sharp(new URL('../apps/server/assets/mcp/muse.svg', import.meta.url).pathname, { density: 300 })
          .resize(192, 192, { fit: 'contain', background: '#ffffff' }).flatten({ background: '#ffffff' }).jpeg().toBuffer();
        const profile = JSON.parse((await client.callTool({ name: 'set_profile', arguments: { name: 'Muse', handle: 'muse',
          avatar: `data:image/jpeg;base64,${museJpeg.toString('base64')}` } })).content[0].text).data;
        const afterProfile = JSON.parse((await client.callTool({ name: 'list_rooms', arguments: {} })).content[0].text).data;
        identity.handle = 'muse';
        const webhook = await client.callTool({ name: 'set_webhook', arguments: { url: 'https://hooks.invalid/muse', secret: 'proof-bearer' } });
        const sentAt = Date.now();
        const tag = await options.phone.execute('sendRoomMessage', { roomId: publicRooms[0][0], text: `@${identity.handle} what changed today?` }, person);
        for (let i = 0; i < 100 && !posts.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
        await new Promise(resolve => setTimeout(resolve, 300));
        const mentions = JSON.parse((await client.callTool({ name: 'list_mentions', arguments: {} })).content[0].text).data;
        const replyStarted = Date.now();
        const reply = JSON.parse((await client.callTool({ name: 'send_message', arguments: { room: publicRooms[0][0],
          text: '@demo-agent please summarize today for the owner', replyTo: tag.messageId, idempotencyKey: 'connect-proof-reply' } })).content[0].text).data;
        const replyMs = Date.now() - replyStarted;
        const threaded = (await db.query('SELECT reply_to_message_id FROM messages WHERE id=$1', [reply.messageId])).rows[0].reply_to_message_id === tag.messageId;
        const soul = (await options.phone.readAgent(workspace, member, person)).seededSoul;
        const result = { setupNoteBeforeProfile: Boolean(firstRead.setup), setupNoteAfterProfile: Boolean(afterProfile.setup), profileAvatar: profile.avatar,
          mentions: mentions.mentions.map(m => m.text), reply: { ...reply, ms: replyMs, threaded }, profileSoul: soul, registeredClients: (await db.query('SELECT count(*)::int n FROM rooms_mcp_clients')).rows[0].n, member: identity, joined,
          avatar: { status: avatar.status, type: avatar.headers.get('content-type') }, webhookResult: webhook.content[0].text,
          posts: posts.filter(post => post.body.messageId === tag.messageId).map(post => ({ url: post.url, authorization: post.authorization, ms: post.at - sentAt, text: post.body.text, instruction: post.body.instruction })),
          phoneToken: phone };
        transcript(`CONNECT-1 ${JSON.stringify({ ...result, phoneToken: undefined })}`);
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
      } catch (error) { res.writeHead(500); res.end(String(error?.stack ?? error)); }
    });
    const phone = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO phone_access_tokens(token_hash,identity_id,family_id,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [tokenHash(phone), person, '11111111-1111-4111-8111-111111111111']);
    transcript(`CONNECT-1 fixture ${origin}; start ${authorizeUrl}`);
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  } else if (process.argv.includes('--serve')) {
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
  const registrationMethod = process.argv.includes('--secret-post') ? 'client_secret_post' : process.argv.includes('--secret-basic') ? 'client_secret_basic' : 'none';
  const redirectUrl = process.argv.includes('--native') ? 'cursor://anysphere.cursor-mcp/oauth/callback' : registrationMethod === 'none' ? 'http://127.0.0.1:9876/callback' : 'https://example.com/cb';
  const provider = {
    redirectUrl,
    clientMetadata: { client_name: 'Grok', redirect_uris: [redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: registrationMethod, scope: 'rooms:read rooms:write' },
    state: () => 'local-proof-state', clientInformation: () => info, saveClientInformation: value => { info = value; },
    tokens: () => tokens, saveTokens: value => { tokens = value; },
    codeVerifier: () => verifier, saveCodeVerifier: value => { verifier = value; }, redirectToAuthorization: value => { authorizeUrl = value; },
  };
  assert.equal(await mcpAuth(provider, { serverUrl: origin + '/mcp', scope: 'rooms:read rooms:write', resourceMetadataUrl: new URL(origin + '/.well-known/oauth-protected-resource/mcp') }), 'REDIRECT');
  assert.equal(info.token_endpoint_auth_method, registrationMethod);
  const registration = (await db.query('SELECT secret_hash,auth_method FROM rooms_mcp_clients WHERE id=$1', [info.client_id])).rows[0];
  assert.equal(registration.auth_method, registrationMethod);
  assert.equal(registration.secret_hash, info.client_secret ? tokenHash(info.client_secret) : null);
  transcript(`R1: registered ${redirectUrl} with ${registrationMethod}; persisted only the secret hash when applicable.`);
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
  const target = new URL(redirectUrl);
  assert.ok(!response.headers.get('content-security-policy').includes('form-action'));
  const html = await response.text(); assert.match(html, /Joins as/); assert.match(html, /Read public Rooms in selected Workspaces/); assert.match(html, /Post as Grok/); assert.match(html, /Connector Reviewer/);
  transcript('Built Beeline GitHub login completed, consumed a one-use ticket, and showed the joining member, account, read scope and write scope on consent. Upstream GitHub is a local test double.');
  if (process.argv.includes('--wake-setup')) process.env.BEELINE_MCP_WEBHOOK_KEY = 'synthetic-proof-sealing-key';
  response = await browser('/mcp/oauth/consent', { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ flow, decision: 'allow', workspace_selection: '1', workspace_ids: workspace, ...(process.argv.includes('--wake-setup') ? { wake_url: 'https://hooks.example/proof', wake_key: ' Bearer synthetic-wake-key ' } : {}) }) });
  assert.equal(response.status, 302);
  const callback = new URL(response.headers.get('location'));
  assert.equal(callback.searchParams.get('state'), 'local-proof-state'); assert.equal(callback.searchParams.get('iss'), origin);
  assert.equal(await mcpAuth(provider, { serverUrl: origin + '/mcp', authorizationCode: callback.searchParams.get('code'), resourceMetadataUrl: new URL(origin + '/.well-known/oauth-protected-resource/mcp') }), 'AUTHORIZED');
  transcript(`R1 PASS: sign-in, Allow, exact redirect and SDK token exchange succeeded for ${registrationMethod} / ${target.protocol}.`);
  transcript('SDK exchanged the code with PKCE and the resource audience. No credentials are printed or saved.');
  // The connection is a member owned by the reviewer; a person adds it to a Room to read and post there.
  const member = (await db.query(`SELECT member_id FROM rooms_mcp_members WHERE owner_id=$1`, [person])).rows[0].member_id;
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member') ON CONFLICT DO NOTHING`, [workspace, room, member]);
  if (process.argv.includes('--wake-setup')) {
    // HTTPS receiver double: only this proof transport maps a public destination
    // to loopback. Production postMcpWebhook keeps DNS pinning and TLS validation.
    const temp = await mkdtemp(join(tmpdir(), 'beeline-wake-proof-'));
    const received = [];
    let receiver;
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', join(temp, 'tls.key'), '-out', join(temp, 'tls.crt'),
        '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' });
      receiver = createHttpsServer({ key: await readFile(join(temp, 'tls.key')), cert: await readFile(join(temp, 'tls.crt')) }, (req, res) => {
        let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
          received.push({ authorization: req.headers.authorization, body }); res.end();
        });
      });
      await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
      const transport = async (url, init) => {
        assert.equal(url, 'https://hooks.example/proof');
        return new Promise((resolve, reject) => {
          const request = httpsRequest({ hostname: '127.0.0.1', port: receiver.address().port,
            method: 'POST', headers: init.headers, rejectUnauthorized: false }, response => {
            response.resume(); response.on('end', () => resolve(new Response('', { status: response.statusCode })));
          });
          request.on('error', reject); request.end(init.body);
        });
      };
      const handle = (await db.query('SELECT handle FROM identities WHERE id=$1', [member])).rows[0].handle;
      for (const path of ['consent', 'profile']) {
        if (path === 'profile') await options.phone.execute('updateAgentWake',
          { workspaceId: workspace, agentId: member, url: 'https://hooks.example/proof', key: ' bearer synthetic-wake-key ' }, person);
        const wake = await options.phone.execute('sendRoomMessage', { roomId: room, text: `@${handle} wake from ${path}` }, person);
        assert.equal((await db.query('SELECT 1 FROM rooms_mcp_webhook_outbox WHERE member_id=$1 AND message_id=$2', [member, wake.messageId])).rowCount, 1);
        assert.equal(await deliverMcpMemberWebhooks(db, transport), 1);
        assert.equal(received.at(-1).authorization, 'Bearer synthetic-wake-key');
        const profile = await options.phone.readAgent(workspace, member, person);
        assert.deepEqual(profile.wake, { url: 'https://hooks.example/proof', keySet: true });
        assert.ok(!JSON.stringify(profile).includes('synthetic-wake-key'));
      }
      assert.equal(received.length, 2);
      transcript('MCP-WAKE-SETUP PASS: Allow and profile setup each deliver one tag to a local HTTPS receiver with the bearer key; reads contain only key status.');
      // Continue the pre-existing inherited-callback proof below.
      await options.phone.execute('updateAgentWake', { workspaceId: workspace, agentId: member, url: '' }, person);
      await db.query('UPDATE rooms_mcp_members SET callback_url=NULL WHERE member_id=$1', [member]);
    } finally {
      if (receiver) await new Promise(resolve => receiver.close(resolve));
      await rm(temp, { recursive: true, force: true });
    }
  }
  const firstRefresh = tokens.refresh_token;
  tokens.expires_in = 0;
  assert.equal(await mcpAuth(provider, { serverUrl: origin + '/mcp', resourceMetadataUrl: new URL(origin + '/.well-known/oauth-protected-resource/mcp') }), 'AUTHORIZED');
  assert.notEqual(tokens.refresh_token, firstRefresh);
  transcript('SDK refreshed the connection and received a rotated refresh token.');
  client = new Client({ name: 'beeline-rooms-proof', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { authProvider: provider }));
  assert.equal((await client.listTools()).tools.length, 9);
  const rooms = await client.callTool({ name: 'list_rooms', arguments: {} }); assert.match(JSON.stringify(rooms), /connector-demo/);
  const read = await client.callTool({ name: 'read_messages', arguments: { room, limit: 10 } }); assert.match(JSON.stringify(read), /synthetic demo content/);
  transcript('Streamable HTTP client initialized, discovered all tools, listed its seeded Room and read synthetic agent activity.');
  // MCP-WAKE-1 repeats the live tag/DM -> webhook -> MCP reply -> notice sweep path.
  // Only the outside webhook receiver is a transport double; the built service,
  // OAuth, MCP HTTP transport, routing, outbox and phone projection run unchanged.
  await db.query(`UPDATE rooms_mcp_clients SET callback_url='https://hooks.invalid/proof' WHERE id=$1`, [info.client_id]);
  const wakeHandle = (await db.query('SELECT handle FROM identities WHERE id=$1', [member])).rows[0].handle;
  const dm = (await options.phone.execute('resolveDirectMessage', { workspaceId: workspace, participantId: member }, person)).id;
  for (const [wakeRoom, text] of [[room, `@${wakeHandle} reply pong please`], [dm, 'reply pong please']]) {
    const wake = await options.phone.execute('sendRoomMessage', { roomId: wakeRoom, text }, person);
    const reply = await client.callTool({ name: 'send_message', arguments: { room: wakeRoom, text: 'pong' } });
    assert.notEqual(reply.isError, true);
    let posts = 0;
    assert.equal(await deliverMcpMemberWebhooks(db, async () => { posts++; return new Response('', { status: 200 }); }), 1);
    assert.equal(posts, 1);
    assert.equal(await deliverMcpMemberWebhooks(db, async () => { posts++; return new Response('', { status: 200 }); }), 0);
    await options.phone.flushPendingMentionNotices(Date.now() + 120_000);
    const view = await options.phone.readRoom(wakeRoom, person);
    const commands = (await db.query('SELECT 1 FROM agent_commands WHERE agent_id=$1 AND source_message_id=$2', [member, wake.messageId])).rowCount;
    const offline = JSON.stringify(view).includes('helper is offline');
    const working = view.pendingAgentCommands.some(command => command.agentPubkey === member);
    transcript(`MCP-WAKE-1 ${wakeRoom === dm ? 'DM' : 'human tag'}: webhook POSTs=${posts}; phantom commands=${commands}; offline line=${offline}; pending working=${working}; pong visible=${JSON.stringify(view).includes('pong')}.`);
    assert.equal(commands, 0); assert.equal(offline, false); assert.equal(working, false);
    assert.match(JSON.stringify(view), /pong/);
  }
  // WEBHOOK-CLEAR-1: disabling must not fall back or leak an already queued tag.
  assert.notEqual((await client.callTool({ name: 'set_webhook', arguments: { url: 'https://hooks.invalid/member' } })).isError, true);
  const queuedBeforeClear = await options.phone.execute('sendRoomMessage', { roomId: room, text: `@${wakeHandle} queued before webhook clear` }, person);
  const cleared = JSON.parse((await client.callTool({ name: 'set_webhook', arguments: { url: '' } })).content[0].text).data;
  assert.equal(cleared.webhook, null);
  await options.phone.execute('sendRoomMessage', { roomId: room, text: `@${wakeHandle} after webhook clear` }, person);
  let clearedPosts = 0;
  const clearTransport = async () => { clearedPosts++; return new Response('', { status: 200 }); };
  assert.equal(await deliverMcpMemberWebhooks(db, clearTransport), 0);
  assert.equal(clearedPosts, 0);
  const cancelled = (await db.query('SELECT outcome FROM subscription_webhook_calls WHERE member_id=$1 AND wake_message_id=$2', [member, queuedBeforeClear.messageId])).rows[0];
  assert.equal(cancelled.outcome, 'skipped');
  await client.callTool({ name: 'set_webhook', arguments: { url: 'https://hooks.invalid/reenabled' } });
  assert.equal(await deliverMcpMemberWebhooks(db, clearTransport), 0);
  await options.phone.execute('sendRoomMessage', { roomId: room, text: `@${wakeHandle} fresh tag after enabling` }, person);
  assert.equal(await deliverMcpMemberWebhooks(db, clearTransport), 1);
  assert.equal(clearedPosts, 1);
  transcript('WEBHOOK-CLEAR-1 PASS: authenticated clear cancelled the queued tag and blocked the registration fallback; enabling a new URL delivered only a fresh tag.');
  // MCP-INTERRUPTED-1: the authenticated HTTP retry must recover a saved post's wake.
  const interruptedArgs = { room, text: '@demo-agent please recover this interrupted handoff', idempotencyKey: 'interrupted-handoff-proof' };
  const query = db.query.bind(db);
  let interrupted = false;
  db.query = async (sql, values) => {
    if (!interrupted && sql.includes('INSERT INTO rooms_mcp_pending_routes')) {
      interrupted = true;
      throw new Error('MCP-INTERRUPTED-1: interrupted routing record');
    }
    return query(sql, values);
  };
  try {
    assert.equal((await client.callTool({ name: 'send_message', arguments: interruptedArgs })).isError, true);
  } finally { db.query = query; }
  assert.equal(interrupted, true);
  await db.query("UPDATE rooms_mcp_idempotency SET claimed_at=now()-interval '2 minutes' WHERE member_id=$1", [member]);
  const recovered = JSON.parse((await client.callTool({ name: 'send_message', arguments: interruptedArgs })).content[0].text).data;
  assert.deepEqual(recovered.woken, ['demo-agent']);
  assert.equal((await db.query('SELECT 1 FROM messages WHERE id=$1', [recovered.messageId])).rowCount, 1);
  assert.equal((await db.query('SELECT 1 FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2', [recovered.messageId, agent])).rowCount, 1);
  assert.equal((await db.query('SELECT 1 FROM rooms_mcp_pending_routes WHERE message_id=$1', [recovered.messageId])).rowCount, 0);
  assert.match(JSON.stringify(await options.phone.readRoom(room, person)), /recover this interrupted handoff/);
  transcript('MCP-INTERRUPTED-1 PASS: authenticated retry returned the saved message and demo-agent wake; one visible message, one wake command, no pending routing gap.');
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
