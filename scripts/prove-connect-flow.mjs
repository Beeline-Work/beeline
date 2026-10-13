// Run after npm run build: node --import tsx scripts/prove-connect-flow.mjs.
// The HTTP service is built code; OAuth and storage are isolated fixtures.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { LinkAgentWallet } from '../apps/server/dist/link-agent-wallet.js';
import { McpRegistryClient } from '../apps/server/dist/mcp-registry.js';
import { createBeelineServer } from '../apps/server/dist/server.js';

const owner = 'a'.repeat(64);
const agent = 'b'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const database = new PgliteDatabase();
await migrate(database);
await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Demo owner'),($2,'agent','Demo agent')`, [owner, agent]);
await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Isolated demo')`, [workspace]);
await database.query(`INSERT INTO agents(agent_id,owner_id,machine_id) VALUES($1,$2,'demo-machine')`, [agent, owner]);
await database.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Connection demo')`, [room, workspace, owner]);
await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
  ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`, [workspace, owner, agent, room]);
await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('demo-source',$1,$2,'Connect Link')`, [room, owner]);
await database.query(`INSERT INTO agent_commands(id,room_id,agent_id,source_message_id,turn_request_id,action,reason,
  root_command_id,root_source_message_id,agent_depth,state,generation_id,lease_expires_at) VALUES
  ('demo-command',$1,$2,'demo-source','demo-request','input','human_tag','demo-command','demo-source',
   0,'claimed','demo-generation',now()+interval '10 minutes')`, [room, agent]);
const live = new LiveHub();
const registry = new McpRegistryClient(async () => Response.json({ servers: [] }));
const provider = { supportsOAuth: async () => false, catalog: async () => [] };
const wallet = new LinkAgentWallet(database, 'fixture-client', 'fixture-secret', 'pk_test_fixture',
  'https://server.usebeeline.app', randomBytes(32).toString('base64'), async url =>
    String(url).endsWith('/auth/token') ? Response.json({ access_token: 'fixture-access',
      refresh_token: 'fixture-refresh', expires_in: 3600, scope: 'payment_methods.agentic userinfo:read' })
      : Response.json({ address: { country: 'US' } }));
const daemon = new DaemonService(database, live, undefined, undefined, false, undefined, false,
  undefined, undefined, undefined, { enabled: false }, registry, undefined, provider, undefined, undefined, wallet);
const phone = new PhoneService(database, 'https://server.usebeeline.app', undefined, undefined,
  live, false, database, undefined, undefined, registry, provider, wallet);
const server = createBeelineServer({ database, daemon, phone, live, linkWallet: wallet, mediaMaximumBytes: 1,
  auth: { authenticateDaemon: async token => token === 'demo-agent-fixture-0001' ? agent : null,
    authenticatePhone: async token => token === 'demo-phone-fixture-0001' ? owner : null } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
async function operation(surface, name, input) {
  const response = await fetch(`${origin}/v1/${surface}/operations/${name}`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer demo-${surface === 'daemon' ? 'agent' : 'phone'}-fixture-0001` },
    body: JSON.stringify(input) });
  assert.equal(response.status, 200, `${name} failed`);
  return response.json();
}
try {
  const found = await operation('daemon', 'findConnectors', { roomId: room, query: 'add a card' });
  assert.equal(found.matches[0].key, 'link');
  console.log('find_connectors("add a card") -> Link, not connected');
  const input = { roomId: room, requestId: 'demo-request', generationId: 'demo-generation',
    service: 'Stripe Link (link.com)', reason: 'Add a payment card' };
  const pending = await operation('daemon', 'connect', input);
  assert.equal(pending.status, 'needs_sign_in');
  assert.equal((await database.query(`SELECT id FROM messages WHERE card_type='app-sign-in'`)).rows.length, 1);
  console.log('connect("Stripe Link (link.com)") -> one Link sign-in card');
  const signIn = await operation('phone', 'beginAppSignIn', { appId: pending.appId });
  const authorization = new URL(signIn.authorizationUrl);
  assert.equal(authorization.origin, 'https://login.link.com');
  console.log('Owner taps Sign in -> login.link.com');
  const callback = await fetch(`${origin}/v1/link/oauth/callback?${new URLSearchParams({
    state: authorization.searchParams.get('state'), code: 'fixture-code' })}`);
  assert.equal(callback.status, 200);
  assert.equal((await database.query(`SELECT id FROM agent_commands WHERE reason='app_connected'`)).rows.length, 1);
  console.log('Verified OAuth callback (fixture provider) -> original request resumed');
  const ready = await operation('daemon', 'connect', { ...input, service: 'Link' });
  assert.equal(ready.status, 'ready');
  assert.equal((await database.query(`SELECT id FROM messages WHERE card_type='app-sign-in'`)).rows.length, 1);
  console.log('connect("Link") -> ready; no new card');
} finally {
  await new Promise(resolve => server.close(resolve));
  await database.close();
}
