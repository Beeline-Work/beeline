/** Run built MCP tools against a built local server and an unfunded fake wallet. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { TokenAuth } from '../apps/server/dist/auth.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { createBeelineServer } from '../apps/server/dist/server.js';
import { createAgentCommand, claimAgentCommand } from '../apps/server/dist/agent-command.js';
import { AuthStore } from '../apps/auth/dist/store.js';
import { callAgentTool, workbenchStatus } from '../apps/body/dist/read-only-mcp.js';

// Never let this proof select a production wallet source.
for (const key of [
  'COINBASE_CDP_API_KEY_ID',
  'COINBASE_CDP_API_KEY_SECRET',
  'COINBASE_CDP_WALLET_SECRET',
])
  delete process.env[key];
const human = createHash('sha256').update('github:wallet-proof-owner').digest('hex');
const agent = 'b'.repeat(64);
const request = 'e'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const database = new PgliteDatabase();
const scratch = await mkdtemp(join(tmpdir(), 'beeline-wallet-proof-'));
let server;
try {
  await migrate(database);
  await new AuthStore(database).migrate();
  await database.query(
    `INSERT INTO identities(id,kind,name,handle,github_subject) VALUES($1,'human','Proof Owner','proofowner','wallet-proof-owner'),($2,'agent','Proof Agent','proofagent',NULL)`,
    [human, agent],
  );
  await database.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [agent, human]);
  await database.query("INSERT INTO workspaces(id,name) VALUES($1,'Wallet Proof')", [workspace]);
  await database.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Proof Room')", [
    room,
    workspace,
  ]);
  for (const [identity, role] of [
    [human, 'owner'],
    [agent, 'member'],
  ])
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,$3),($1,$4,$2,$3)`,
      [workspace, identity, role, room],
    );
  await database.query(
    "INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'test my wallet without funds')",
    [request, room, human],
  );
  const command = await createAgentCommand(database, {
    roomId: room,
    agentId: agent,
    sourceMessageId: request,
    reason: 'human_mention',
  });
  await claimAgentCommand(database, room, agent, command.id, 'wallet-proof');
  const auth = new TokenAuth(database, async () => ({
    subject: 'wallet-proof-owner',
    login: 'wallet-proof-owner',
    name: 'Proof Owner',
  }));
  const live = new LiveHub();
  server = createBeelineServer({
    database,
    auth,
    phone: new PhoneService(database, 'http://localhost', {}),
    daemon: new DaemonService(database, live),
    live,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const token = (await auth.exchangeGitHubOidc('proof')).accessToken;
  const helperToken = (
    await auth.exchangeDaemonToken((await auth.createDaemonExchange(agent)).exchangeToken)
  ).daemonToken;
  async function phone(name, input) {
    const response = await fetch(`${origin}/v1/phone/operations/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  const wallet = await phone('createWallet', { workspaceId: workspace });
  await phone('grantWalletDelegation', { workspaceId: workspace });
  const context = join(scratch, 'turn.json');
  await writeFile(
    context,
    JSON.stringify({ roomId: room, requestId: request, generationId: 'wallet-proof' }),
  );
  Object.assign(process.env, {
    BEELINE_DAEMON_BASE_URL: origin,
    BEELINE_DAEMON_TOKEN: helperToken,
    BEELINE_DAEMON_AGENT_ID: agent,
    BEELINE_DAEMON_ROOM_ID: room,
    BEELINE_DAEMON_CORNER_ID: '',
    BEELINE_TURN_CONTEXT_FILE: context,
  });
  const address = JSON.parse(await callAgentTool('wallet_address', {}, 'address-proof'));
  const chains = JSON.parse(await callAgentTool('wallet_chains', {}, 'chains-proof'));
  const balance = JSON.parse(await callAgentTool('wallet_balance', {}, 'balance-proof'));
  assert.equal(address.wallet.address, wallet.address);
  assert.ok(chains.chains.length > 0);
  assert.equal(balance.totalUsd, '$0.00');
  // Avoid unrelated Tailscale/Squire host probes; use the actual server Workbench DTO.
  const workbench = await workbenchStatus({
    roomId: room,
    execute: async (name, input) => {
      const response = await fetch(`${origin}/v1/daemon/operations/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${helperToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      assert.equal(response.status, 200);
      return response.json();
    },
  });
  assert.match(workbench, /Wallet\): connected/);
  const payload = {
    domain: {
      name: 'Exchange',
      version: '1',
      chainId: 1337,
      verifyingContract: `0x${'0'.repeat(40)}`,
    },
    types: { BeelineTest: [{ name: 'notice', type: 'string' }] },
    primaryType: 'BeelineTest',
    message: { notice: 'Harmless signing test; no order or transfer' },
  };
  const signed = JSON.parse(await callAgentTool('wallet_sign_typed_data', payload, 'sign-proof'));
  assert.equal(signed.outcome, 'signed');
  assert.match(signed.signature, /^0x[a-f0-9]{130}$/);
  const audit = (
    await database.query("SELECT card FROM messages WHERE card_type='wallet-signature'")
  ).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].card.domain.chainId, 1337);
  assert.equal((await database.query('SELECT id FROM wallet_transactions')).rows.length, 0);
  console.log(
    'Reproduction wallet-503 PASS: built wallet_address/chains/balance resolve the linked owner wallet; Workbench renders Wallet connected',
  );
  console.log(
    'Typed-data PASS (fake CDP): built wallet_sign_typed_data accepts harmless Exchange chainId 1337, returns a signature and writes one audit card; zero transfers',
  );
  console.log(
    'Live CDP chainId 1337 acceptance: NOT OBTAINED; this proof deliberately uses an unfunded fake source',
  );
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await database.close();
  await rm(scratch, { recursive: true, force: true });
}
