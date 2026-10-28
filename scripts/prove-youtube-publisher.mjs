// Run after npm run build: node --import tsx scripts/prove-youtube-publisher.mjs.
// The HTTP service is built code; OAuth and storage are isolated fixtures.
// Use --before with the original build to demonstrate the unsafe route.
import assert from 'node:assert/strict';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
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
const before = process.argv.includes('--before');
const entry = { name: 'click.myagents/youtube', version: '1.0.2', title: 'YouTube',
  websiteUrl: 'https://ciromaciel.click', remotes: [{ type: 'streamable-http', url: 'https://youtube.mcp.myagents.click/mcp' }] };
const registry = new McpRegistryClient(async url => String(url).includes('/versions/')
  ? Response.json({ server: entry }) : Response.json({ servers: [{ server: entry }] }));
// Keep discovery isolated and deterministic.
registry.companies.discover = async () => undefined;
const provider = { supportsOAuth: async toolkit => toolkit === 'youtube',
  toolkit: async slug => ({ slug }), catalog: async () => [],
  link: async () => ({ url: 'https://verified-provider.example/sign-in', accountId: 'fixture-account', expiresAt: new Date(Date.now() + 600000) }) };
const daemon = new DaemonService(database, live, undefined, undefined, false, undefined, false,
  undefined, undefined, undefined, { enabled: false }, registry, undefined, provider);
const phone = new PhoneService(database, 'https://server.usebeeline.app', undefined, undefined,
  live, false, database, undefined, undefined, registry, provider);
const server = createBeelineServer({ database, daemon, phone, live, mediaMaximumBytes: 1,
  auth: { authenticateDaemon: async () => agent, authenticatePhone: async () => owner } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
async function operation(name, input) {
  const response = await fetch(`${origin}/v1/daemon/operations/${name}`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-agent-token-0001' },
    body: JSON.stringify(input) });
  assert.equal(response.status, 200, `${name} failed`);
  return response.json();
}
const turn = { roomId: room, requestId: 'demo-request', generationId: 'demo-generation' };
try {
  const install = await operation('connectMcpServer', { ...turn, serverName: entry.name,
    version: entry.version, reason: 'Upload a YouTube video' });
  assert.equal(install.status, before ? 'connecting' : 'unsupported');
  if (before) {
    await operation('postConnectorStatus', { agentId: agent, connectorId: install.connectorId,
      steps: [], signIn: { method: 'oauth', url: 'https://youtube.mcp.myagents.click/authorize', attemptId: 'fixture-attempt' } });
    // Remove the direct-install stand-in so connect exercises the fresh-account path.
    await database.query(`DELETE FROM workspace_apps`);
    await database.query(`DELETE FROM workspace_connectors`);
  }
  const pending = operation('connect', { ...turn, service: 'youtube', reason: 'Upload a YouTube video' });
  if (before) {
    let row;
    for (let attempt = 0; attempt < 500; attempt++) {
      row = (await database.query(`SELECT id FROM workspace_connectors WHERE registry_server_name=$1`, [entry.name])).rows[0];
      if (row) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(row, 'connect created the third-party connector');
    await operation('postConnectorStatus', { agentId: agent, connectorId: row.id,
      steps: [], signIn: { method: 'oauth', url: 'https://youtube.mcp.myagents.click/authorize', attemptId: 'fixture-connect' } });
  }
  const result = await pending;
  assert.equal(result.transport, before ? 'registry-mcp' : 'composio');
  const view = await phone.readRoom(room, owner);
  const card = view.messages.find(message => message.appSignIn)?.appSignIn;
  assert.ok(card, 'owner sees a sign-in card');
  if (!before) {
    assert.equal(card.appKey, 'youtube');
    assert.equal((await database.query(`SELECT id FROM workspace_connectors WHERE connector_type='registry-mcp'`)).rows.length, 0);
  }
  console.log(`Reproduction R-YOUTUBE-PUBLISHER: HTTP connect YouTube -> ${result.transport}; owner Room shows sign-in card; direct install -> ${install.status}`);
} finally {
  await new Promise(resolve => server.close(resolve));
  await database.close();
}
