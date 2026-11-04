/** Local-only browser/real-CLI fixture. Only the upstream identity provider is a double.
 * Run after npm run build: node --import tsx scripts/prove-unified-join.mjs
 * All state is ephemeral PGlite; no production credentials, daemon or Workspace.
 */
import assert from 'node:assert/strict';
import { AuthStore } from '../apps/auth/dist/store.js';
import { migrate } from '../apps/server/dist/database.js';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { TokenAuth, tokenHash } from '../apps/server/dist/auth.js';
import { createMonolithAuth } from '../apps/server/dist/monolith-auth.js';
import { RoomsMcp } from '../apps/server/dist/rooms-mcp.js';
import { RoomsMcpOAuth } from '../apps/server/dist/rooms-mcp-oauth.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { createBeelineServer } from '../apps/server/dist/server.js';

const db = new PgliteDatabase();
const port = Number(process.env.JOIN_PROOF_PORT ?? 18979);
const origin = process.env.JOIN_PROOF_ORIGIN ?? `http://localhost:${port}`;
const joinHost = process.env.BEELINE_JOIN_HOST ?? 'join.localtest.me';
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const person = tokenHash('github:unified-join-proof');
let mount, server;
try {
  await migrate(db); await new AuthStore(db).migrate();
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Local Join Reviewer','join-reviewer')`, [person]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Local Join Proof')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,visibility) VALUES($1,$2,'join-proof','public')`, [room, workspace]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner')`, [workspace, room, person]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Synthetic local Room content for the unified join proof.')`, ['b'.repeat(64), room, person]);
  const auth = new TokenAuth(db, ticket => mount.verifyGitHubTicket(ticket), () => new Date(), ticket => mount.verifyGoogleTicket(ticket));
  const live = new LiveHub();
  const options = { database: db, auth, live, daemon: new DaemonService(db, live), mediaMaximumBytes: 1024,
    phone: new PhoneService(db, origin, undefined, undefined, live),
    authHandler: (req, res) => {
      const url = new URL(req.url, origin);
      if (url.pathname === '/auth/proof-provider') {
        res.writeHead(302, { location: `/auth/github/callback?state=${encodeURIComponent(url.searchParams.get('state') ?? '')}&code=synthetic-provider-code` }); res.end();
      } else return mount.handle(req, res);
    },
  };
  mount = await createMonolithAuth(db, origin, {
    oauth: { config: { clientId: 'fixture-client', clientSecret: 'fixture-secret' },
      authorizationUrl: ({ state }) => `${origin}/auth/proof-provider?state=${encodeURIComponent(state)}`,
      exchangeCode: async code => {
        assert.equal(code, 'synthetic-provider-code');
        return { issuer: 'https://github.com', audience: 'fixture-client', subject: 'unified-join-proof', login: 'join-reviewer', displayName: 'Local Join Reviewer', accessToken: 'synthetic-provider-token' };
      } }, app: { installationUrl: () => 'https://provider.invalid/install' },
  }, { createDaemonExchange: (id, tx) => auth.createDaemonExchange(id, tx), env: {
    NODE_ENV: 'test', BEELINE_AUTH_TENANTS_JSON: JSON.stringify([{ host: new URL(origin).host, community: 'local-join-proof', origin, roomCommunityIds: ['local-join-proof'] }]),
    BEELINE_AUTH_OIDC_ISSUER: 'https://accounts.google.com', BEELINE_AUTH_OIDC_AUTHORIZATION_ENDPOINT: 'https://accounts.google.com/o/oauth2/v2/auth',
    BEELINE_AUTH_OIDC_TOKEN_ENDPOINT: 'https://oauth2.googleapis.com/token', BEELINE_AUTH_OIDC_JWKS_URI: 'https://www.googleapis.com/oauth2/v3/certs', BEELINE_AUTH_OIDC_CLIENT_ID: 'fixture-client',
  } });
  options.roomsMcp = new RoomsMcp(new RoomsMcpOAuth(db, origin, auth, joinHost), options.phone, live);
  server = createBeelineServer(options);
  server.on('request', (req, res) => {
    // Never log codes, cookies, tokens or user query strings.
    const path = new URL(req.url, origin).pathname;
    res.on('finish', () => console.log(JSON.stringify({ method: req.method, host: req.headers.host, path, status: res.statusCode })));
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  console.log(JSON.stringify({ ready: true, origin, short: `${new URL(origin).protocol}//${joinHost}${new URL(origin).port ? ':' + new URL(origin).port : ''}/`, room, workspace, identity: 'Local Join Reviewer', upstreamIdentityProvider: 'local double' }));
  await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
} finally {
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  await mount?.close(); await db.close();
}
