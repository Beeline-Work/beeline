import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { migrate } from '../apps/server/dist/database.js';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { AuthStore } from '../apps/auth/dist/store.js';
import { createMonolithAuth } from '../apps/server/dist/monolith-auth.js';
import { createBeelineServer } from '../apps/server/dist/server.js';
import { TokenAuth, verifierFromEnvironment } from '../apps/server/dist/auth.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { compactSigninAttempts } from '../apps/server/dist/signin-attempts.js';

// Isolated built-service proof: no live provider, production DB, helper or device.
const database = new PgliteDatabase();
const tenant = { host: 'proof.example', origin: 'https://proof.example', community: 'proof', roomCommunityIds: ['proof-room-community'] };
let mount;
let server;
try {
  await migrate(database);
  await new AuthStore(database).migrate();
  const auth = new TokenAuth(database, verifierFromEnvironment(ticket => mount.verifyGitHubTicket(ticket)));
  mount = await createMonolithAuth(database, tenant.origin, {
    oauth: {
      config: { clientId: 'proof-client', clientSecret: 'proof-secret' },
      authorizationUrl: ({ state }) => `https://provider.example/authorize?state=${state}`,
      exchangeCode: async () => ({ issuer: 'https://github.com', audience: 'github', subject: '42',
        login: 'proofuser', displayName: 'Proof User', accessToken: 'fixture-provider-token' }),
    },
    app: {},
  }, {
    createDaemonExchange: (id, tx) => auth.createDaemonExchange(id, tx),
    env: { NODE_ENV: 'test', BEELINE_AUTH_TENANTS_JSON: JSON.stringify([tenant]),
      BEELINE_AUTH_OIDC_ISSUER: 'https://accounts.example',
      BEELINE_AUTH_OIDC_AUTHORIZATION_ENDPOINT: 'https://accounts.example/authorize',
      BEELINE_AUTH_OIDC_TOKEN_ENDPOINT: 'https://accounts.example/token',
      BEELINE_AUTH_OIDC_JWKS_URI: 'https://accounts.example/jwks',
      BEELINE_AUTH_OIDC_CLIENT_ID: 'proof' },
  });
  const live = new LiveHub();
  server = createBeelineServer({ database, auth, phone: new PhoneService(database, tenant.origin),
    daemon: new DaemonService(database, live), live, mediaMaximumBytes: 1024, authHandler: mount.handle });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (path, cookie) => new Promise((resolve, reject) => {
    const outgoing = request(new URL(path, origin), { headers: { host: tenant.host, ...(cookie ? { cookie } : {}) } }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks).toString() }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
  const context = { event: 'provider_tapped', installId: '00000000-0000-4000-8000-000000000001',
    attemptId: '00000000-0000-4000-8000-000000000002', provider: 'github', platform: 'android',
    version: '0.2.22', environment: 'production', timestamp: new Date().toISOString() };
  const begin = () => get(`/auth/github/start?funnel=${encodeURIComponent(JSON.stringify(context))}`);
  const complete = async start => {
    assert.equal(start.status, 302);
    const state = new URL(start.headers.location).searchParams.get('state');
    const callback = await get(`/auth/github/callback?state=${state}&code=fixture-code`, String(start.headers['set-cookie']).split(';')[0]);
    assert.equal(callback.status, 200);
    return JSON.parse(callback.body).ticket;
  };
  const exchange = async ticket => {
    const result = await fetch(`${origin}/v1/auth/github/exchange`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oidcToken: ticket }) });
    assert.equal(result.status, 200);
    assert.ok((await result.json()).accessToken);
  };
  await exchange(await complete(await begin()));
  const denied = await begin();
  const state = new URL(denied.headers.location).searchParams.get('state');
  assert.equal((await get(`/auth/github/callback?state=${state}&error=access_denied`, String(denied.headers['set-cookie']).split(';')[0])).status, 401);
  await begin();
  await complete(await begin());
  // Advance the whole ceremony relative to its deadline, not just the deadline.
  await database.query("UPDATE signin_attempt_events SET occurred_at=occurred_at-interval '10 minutes'");
  await database.query("UPDATE signin_attempt_correlations SET expires_at=now()-interval '1 second'");
  const readme = await readFile(new URL('../apps/auth/README.md', import.meta.url), 'utf8');
  const query = readme.match(/```sql\n(WITH history AS[\s\S]*?)```/)[1];
  const before = (await database.query(query)).rows;
  assert.deepEqual(before.map(row => row.last_stage).sort(), ['expired', 'expired', 'provider_returned', 'ticket_exchanged']);
  await compactSigninAttempts(database);
  const after = (await database.query(query)).rows;
  assert.deepEqual(after.map(row => row.last_stage).sort(), before.map(row => row.last_stage).sort());
  assert.deepEqual(after.filter(row => row.last_stage === 'expired').map(row => row.last_checkpoint).sort(), ['started', 'ticket_issued']);
  assert.equal(after.find(row => row.last_stage === 'provider_returned').error_code, 'access_denied');
  await database.query('UPDATE signin_funnel_installs SET internal=true WHERE install_id=$1', [context.installId]);
  assert.equal((await database.query(query)).rows.length, 0);
  await database.query('DROP TABLE signin_attempt_events');
  await exchange(await complete(await begin()));
  console.log('PASS: built HTTP sign-in issues a session; SQL distinguishes denial, missing callback and missing exchange before/after cleanup; internal installs disappear; broken logging still issues a session.');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  if (mount) await mount.close();
  await database.close();
}
