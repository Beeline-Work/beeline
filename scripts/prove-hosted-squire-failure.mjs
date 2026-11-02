// Run after npm run build -w @beeline/server: node --import tsx scripts/prove-hosted-squire-failure.mjs.
// The HTTP service is built code; storage and the failed helper report are isolated fixtures.
import assert from 'node:assert/strict';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
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
const daemon = new DaemonService(database, live);
const phone = new PhoneService(database, 'http://proof', undefined, undefined, live);
const server = createBeelineServer({ database, daemon, phone, live, mediaMaximumBytes: 1,
  auth: { authenticateDaemon: async token => token === 'demo-agent-fixture-0001' ? agent : null,
    authenticatePhone: async token => token === 'demo-phone-fixture-0001' ? owner : null } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
async function operation(surface, name, input) {
  const response = await fetch(`${origin}/v1/${surface}/operations/${name}`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer demo-${surface === 'daemon' ? 'agent' : 'phone'}-fixture-0001` },
    body: JSON.stringify(input) });
  assert.equal(response.status, 200, `${name}: ${await response.clone().text()}`);
  return response.json();
}
async function visibleOffer(offerId) {
  const response = await fetch(`${origin}/v1/phone/rooms/${room}`, {
    headers: { authorization: 'Bearer demo-phone-fixture-0001' } });
  assert.equal(response.status, 200);
  const view = await response.json();
  return view.messages.find(message => message.connectorOffer?.offerId === offerId)?.connectorOffer;
}
try {
  const offer = await operation('daemon', 'connect', { roomId: room, requestId: 'demo-request',
    generationId: 'demo-generation', service: 'Trusty Squire', reason: 'make the welcome video' });
  assert.equal(offer.status, 'needs_approval');
  const offerId = (await database.query("SELECT id FROM connector_offers WHERE status='pending'")).rows[0].id;
  const accepted = await operation('phone', 'acceptConnectorOffer', { offerId });
  const { assignments } = await operation('daemon', 'getConnectorAssignments', {});
  const install = assignments.find(item => item.kind === 'install');
  assert(install);
  await operation('daemon', 'postConnectorStatus', { connectorId: accepted.connectorId,
    pairingGeneration: install.pairingGeneration, steps: [], errorMessage: 'Squire MCP connection closed' });
  assert.equal((await visibleOffer(offerId)).status, 'failed');
  assert.equal((await operation('daemon', 'getConnectorAssignments', {})).assignments.length, 0);
  const decision = (await database.query("SELECT id FROM messages WHERE card_type='connector-offer-decision' AND card->>'status'='failed'")).rows[0];
  assert(decision);
  assert.equal((await database.query("SELECT count(*)::int n FROM agent_commands WHERE source_message_id=$1 AND action='resume'", [decision.id])).rows[0].n, 1);
  await operation('phone', 'acceptConnectorOffer', { offerId });
  assert.equal((await visibleOffer(offerId)).status, 'connecting');
  const retry = (await operation('daemon', 'getConnectorAssignments', {})).assignments.find(item => item.kind === 'install');
  assert(retry.pairingGeneration > install.pairingGeneration);
  console.log('PASS Reproduction fb_32e642993b10b09e8a03bb7f: connect → accept → reported MCP failure → phone reads failed card → original request resumes → Retry → connecting card and a new helper assignment.');
  console.log('Built HTTP service; PGlite and simulated helper failure stand in for production. Live signup, sign-in and Android proof remain separate.');
} finally {
  await new Promise(resolve => server.close(resolve));
  await database.close();
}
