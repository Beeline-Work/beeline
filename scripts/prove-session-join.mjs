/**
 * SESSION-JOIN-1: a running Claude Code or Codex session joins a Beeline Room from one pasted line and one sign-in,
 * and a tag reaches it while idle. This serves the built production server on loopback with a synthetic GitHub
 * identity provider (the only stand-in), and a few /proof endpoints the operator uses as the person's phone:
 *
 *   node --import tsx scripts/prove-session-join.mjs            # prints the line to paste
 *   curl -X POST 127.0.0.1:47123/proof/open -d '{"url":"<printed link>"}'   # the person signs in and taps Allow
 *   curl -X POST 127.0.0.1:47123/proof/tag -d '{"handle":"x","text":"..."}' # the person tags the session
 *   curl 127.0.0.1:47123/proof/messages                                      # the Room, oldest first
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

const port = Number(process.env.SESSION_JOIN_PORT ?? 47123);
const evidence = resolve(process.env.SESSION_JOIN_EVIDENCE ?? 'evidence/session-join');
const bundle = resolve('packages/usebeeline/dist/usebeeline.mjs');
mkdirSync(evidence, { recursive: true });
const log = text => console.log(`[SESSION-JOIN-1] ${new Date().toISOString()} ${text}`);

const db = new PgliteDatabase();
await migrate(db); await new AuthStore(db).migrate();
const person = tokenHash('github:session-join-owner');
const workspace = '11111111-1111-4111-8111-111111111111', general = '33333333-3333-4333-8333-333333333333';
await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Proof Owner','proof_owner')`, [person]);
await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Session join proof')`, [workspace]);
await db.query(`INSERT INTO rooms(id,workspace_id,name,visibility) VALUES($1,$2,'general','public')`, [general, workspace]);
await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner')`, [workspace, general, person]);

let mount;
const origin = `http://127.0.0.1:${port}`;
const tokenAuth = new TokenAuth(db, ticket => mount.verifyGitHubTicket(ticket), () => new Date(), ticket => mount.verifyGoogleTicket(ticket));
const live = new LiveHub();
const phone = new PhoneService(db, origin, undefined, undefined, live);
const options = { database: db, auth: tokenAuth, live, mediaMaximumBytes: 1024, phone, daemon: new DaemonService(db, live),
  authHandler: (request, response) => {
    const incoming = new URL(request.url, origin);
    // The synthetic upstream GitHub: it signs the proof owner in at once.
    if (incoming.pathname === '/auth/proof-provider') {
      response.writeHead(302, { location: `/auth/github/callback?state=${encodeURIComponent(incoming.searchParams.get('state') ?? '')}&code=synthetic-provider-code` });
      response.end();
    } else mount.handle(request, response);
  } };
const server = createBeelineServer(options);
const github = {
  oauth: { config: { clientId: 'fixture-client', clientSecret: 'fixture-secret' },
    authorizationUrl: ({ state, redirectUri }) => `${origin}/auth/proof-provider?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    exchangeCode: async () => ({ issuer: 'https://github.com', audience: 'fixture-client', subject: 'session-join-owner', login: 'proof-owner',
      displayName: 'Proof Owner', accessToken: 'synthetic-provider-token' }) },
  app: { installationUrl: () => 'https://provider.invalid/install' },
};
mount = await createMonolithAuth(db, origin, github, { createDaemonExchange: (id, tx) => tokenAuth.createDaemonExchange(id, tx), env: {
  NODE_ENV: 'test', BEELINE_AUTH_TENANTS_JSON: JSON.stringify([{ host: new URL(origin).host, community: 'session-join-proof', origin, roomCommunityIds: ['session-join-room'] }]),
  BEELINE_AUTH_OIDC_ISSUER: 'https://accounts.google.com', BEELINE_AUTH_OIDC_AUTHORIZATION_ENDPOINT: 'https://accounts.google.com/o/oauth2/v2/auth',
  BEELINE_AUTH_OIDC_TOKEN_ENDPOINT: 'https://oauth2.googleapis.com/token', BEELINE_AUTH_OIDC_JWKS_URI: 'https://www.googleapis.com/oauth2/v3/certs', BEELINE_AUTH_OIDC_CLIENT_ID: 'fixture-client',
} });
options.roomsMcp = new RoomsMcp(new RoomsMcpOAuth(db, origin, tokenAuth), phone, live, options.daemon);

/** The person's phone browser: follows the printed link with its own cookies, chooses GitHub, then Allow. */
async function openLink(url) {
  const jar = new Map();
  const visit = async (target, init = {}) => {
    const response = await fetch(new URL(target, origin), { ...init, redirect: 'manual', headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...init.headers } });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';'); const index = pair.indexOf('='); jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  };
  let response = await visit(url);
  const consent = response.headers.get('location');
  const flow = new URL(consent, origin).searchParams.get('flow');
  const signInPage = await (await visit(consent)).text();
  writeFileSync(join(evidence, '1-sign-in.html'), signInPage);
  response = await visit(`/mcp/oauth/login?flow=${flow}&provider=github`);
  for (let hops = 0; hops < 6 && response.status === 302 && !response.headers.get('location').includes('/mcp/oauth/consent'); hops++)
    response = await visit(response.headers.get('location'));
  const allowPage = await (await visit(`/mcp/oauth/consent?flow=${flow}`)).text();
  writeFileSync(join(evidence, '2-allow.html'), allowPage);
  response = await visit('/mcp/oauth/consent', { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ flow, decision: 'allow' }) });
  const handoff = response.headers.get('location');
  const donePage = await (await visit(handoff)).text();
  writeFileSync(join(evidence, '3-connected.html'), donePage);
  const joinsAs = /<div class="name">([^<]*)<\/div><div class="tag">@([^ <]*)/.exec(allowPage);
  return { joinsAs: joinsAs ? { name: joinsAs[1], handle: joinsAs[2] } : null, handoff: new URL(handoff).pathname, connected: donePage.includes('Go back to your session') };
}

const body = async request => { const chunks = []; for await (const chunk of request) chunks.push(chunk); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; };
const handler = server.listeners('request')[0];
server.removeAllListeners('request');
server.on('request', async (req, res) => {
  const url = new URL(req.url, origin);
  const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value, null, 2)); };
  try {
    // The stand-in for usebeeline.app/room: the same steps, with this loopback server's command.
    if (url.pathname === '/room') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(['Join a Beeline Room from a running coding session.', '', 'If you are the coding agent reading this, your person asked you to join their Beeline Room:',
        `1. Run this command in your working folder (it needs network access to ${origin}):`, `   node ${bundle} join --server ${origin}`,
        '2. Show your person the sign-in link the command prints, exactly as printed.',
        '3. Stop there. After they tap Allow, a confirmation arrives in this conversation by itself.', '',
        'From then on, each Room message that tags you arrives in this conversation, with the command that posts your answer.'].join('\n'));
      log('GET /room (the pasted line was followed)');
      return;
    }
    if (url.pathname === '/proof/open') { const result = await openLink((await body(req)).url); log(`person signed in and allowed: ${JSON.stringify(result)}`); return json(200, result); }
    if (url.pathname === '/proof/tag') {
      const input = await body(req);
      const sent = await phone.execute('sendRoomMessage', { roomId: general, text: `@${input.handle} ${input.text}` }, person);
      log(`person tagged @${input.handle}: ${sent.messageId}`);
      return json(200, sent);
    }
    if (url.pathname === '/proof/messages') {
      const rows = (await db.query(`SELECT m.id,m.created_at,i.name author,i.handle,m.reply_to_message_id reply_to,m.text FROM messages m JOIN identities i ON i.id=m.author_id
        WHERE m.room_id=$1 ORDER BY m.created_at`, [general])).rows;
      return json(200, rows);
    }
    if (url.pathname === '/proof/members') {
      return json(200, (await db.query(`SELECT i.name,i.handle,mm.model_label FROM rooms_mcp_members mm JOIN identities i ON i.id=mm.member_id ORDER BY mm.created_at`)).rows);
    }
    handler(req, res);
  } catch (error) { json(500, { error: String(error?.stack ?? error) }); }
});
await new Promise(done => server.listen(port, '127.0.0.1', done));
log(`Beeline proof server ${origin}. Paste into a running session: "Join my Beeline Room: ${origin}/room"`);
await new Promise(done => { process.once('SIGINT', done); process.once('SIGTERM', done); });
server.closeAllConnections(); server.close(); await db.close();
