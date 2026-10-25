/** Live providers, isolated owner/database/helper state. Stops before account authorization. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/src/database.ts';
import { PhoneService } from '../apps/server/src/phone-service.ts';
import { DaemonService } from '../apps/server/src/daemon-service.ts';
import { LiveHub } from '../apps/server/src/live.ts';
import { McpRegistryClient } from '../apps/server/src/mcp-registry.ts';
import { RegistryMcpOAuth } from '../apps/server/src/registry-mcp-oauth.ts';
import { applyVaultList } from '../apps/server/src/workbench.ts';
import { connectApp } from '../apps/server/src/app-connections.ts';
import { installRegistryMcp } from '../apps/body/src/registry-mcp.ts';

const database = new PgliteDatabase();
const home = await mkdtemp(join(tmpdir(), 'beeline-company-mcp-proof-'));
const owner = 'a'.repeat(64), helper = 'b'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
try {
  await migrate(database);
  await database.query(`INSERT INTO identities(id,kind,name,handle)
    VALUES($1,'human','Proof owner','owner'),($2,'agent','Proof helper','helper')`, [owner, helper]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
  await database.query(`INSERT INTO agents(agent_id,owner_id,machine_id,machine_name,squire_report)
    VALUES($1,$2,'proof-machine','Proof computer',$3::jsonb)`,
    [helper, owner, JSON.stringify({ status: 'connected', reportedAt: Date.now() / 1000 })]);
  await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member')`, [workspace, owner, helper]);
  const keys = Array.from({ length: 6 }, (_, index) => ({ reference: `vault:fly-${index}`,
    service: 'fly', label: `Proof Fly key ${index}`, fieldNames: ['token'], allowedHosts: ['api.fly.io'],
    createdAt: 1, stale: false, state: 'active' }));
  await applyVaultList(database, { machine_id: 'proof-machine', workspace_id: workspace, owner_identity_id: owner }, keys);
  const registry = new McpRegistryClient();
  const phone = new PhoneService(database, 'http://127.0.0.1:4187', undefined, undefined,
    undefined, false, database, undefined, undefined, registry);
  const daemon = new DaemonService(database, new LiveHub(), undefined, undefined, false,
    undefined, false, undefined, undefined, undefined, { enabled: false }, registry,
    new RegistryMcpOAuth(database, 'http://127.0.0.1:4187'));
  const automatic = await connectApp(database, registry, { workspaceId: workspace, ownerId: owner,
    machineId: 'proof-machine', helperAgentId: helper, requestedBy: helper, app: 'fly' });
  assert.equal(automatic.transport, 'squire-api');
  const search = await phone.execute('searchWorkbenchApps', { query: 'fly' }, owner);
  assert.equal(search.filter(row => row.companyId === 'fly').length, 1);
  let offered;
  for (let attempt = 0; attempt < 100; attempt++) {
    const view = await phone.execute('readWorkbench', { workspaceId: workspace }, owner);
    offered = view.companies.rows.find(row => row.id === 'fly').mcp;
    if (offered) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(offered);
  assert.equal(offered.registryServerName, 'io.fly/company-mcp');
  const connection = phone.execute('connectWorkbenchApp', { app: 'Fly.io', helperAgentId: helper,
    registryServerName: offered.registryServerName, registryVersion: offered.registryVersion }, owner);
  // Stand in for the already running helper consuming the committed assignment.
  let row;
  for (let attempt = 0; attempt < 100; attempt++) {
    row = (await database.query(`SELECT id,registry_server_name,registry_version,registry_manifest,pairing_generation
      FROM workspace_connectors WHERE connector_type='registry-mcp'`)).rows[0];
    if (row) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(row);
  const assignment = { kind: 'install', connectorId: row.id, connectorType: 'registry-mcp',
    registryServerName: row.registry_server_name, registryVersion: row.registry_version,
    registryManifest: row.registry_manifest, pairingGeneration: row.pairing_generation };
  const result = await installRegistryMcp({ agentId: helper, assignment, home,
    api: { execute: (operation, input) => daemon.execute(operation, input, helper) } });
  assert.equal(result.status, 'installing', result.errorMessage);
  assert.equal(new URL(result.authorizationUrl).origin, 'https://fly.io');
  assert.equal(new URL(result.authorizationUrl).pathname, '/mcp/oauth/authorize');
  await daemon.execute('postConnectorStatus', { agentId: helper, connectorId: row.id,
    pairingGeneration: row.pairing_generation, steps: result.steps,
    signIn: { method: 'oauth', url: result.authorizationUrl, attemptId: result.attemptId } }, helper);
  const selected = await connection;
  assert.equal(selected.authorizationUrl, result.authorizationUrl);
  const after = await phone.execute('readWorkbench', { workspaceId: workspace }, owner);
  assert.deepEqual(after.connections.map(key => key.reference).sort(), keys.map(key => key.reference).sort());
  assert.equal(after.companies.rows.find(company => company.id === 'fly').subtitle, '1 app · 6 keys');
  let notion;
  for (let attempt = 0; attempt < 100; attempt++) {
    notion = await phone.execute('searchWorkbenchApps', { query: 'notion' }, owner);
    if (notion.some(row => row.registryServerName === 'com.notion/mcp')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(notion.some(row => row.registryServerName === 'com.notion/mcp'));
  assert.ok(!notion.some(row => row.name === 'insightfulpipe.com'));
  console.log('MCP-DISCOVERY-1 PASS: one Fly search row, explicit MCP selection, live Fly OAuth link, six keys retained, official Notion Registry result. Account authorization was not performed.');
} finally {
  await database.close();
  await rm(home, { recursive: true, force: true });
}
