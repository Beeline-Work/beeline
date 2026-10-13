// Defensive lifecycle check only: in-memory SQL, synthetic identities, no network.
import { strict as assert } from 'node:assert';
import { migrate } from '../../apps/server/src/database.js';
import { PgliteDatabase } from '../../apps/server/src/test-support.js';
import { TokenAuth } from '../../apps/server/src/auth.js';
import { PhoneService } from '../../apps/server/src/phone-service.js';
import { retireAgentFromWorkspace } from '../../apps/server/src/agent-retirement.js';
const db = new PgliteDatabase();
const owner = 'a'.repeat(64), agent = 'b'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Fixture owner'),($2,'agent','Fixture agent')`, [owner, agent]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, owner]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Fixture')`, [workspace]);
  await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner'),($1,$3,'member')`, [workspace, owner, agent]);
  const auth = new TokenAuth(db, async () => { throw new Error('unused verifier'); });
  const pending = await auth.createDaemonExchange(agent);
  await db.transaction(tx => retireAgentFromWorkspace(tx, {
    workspaceId: workspace, agentId: agent,
    remover: { pubkey: owner, kind: 'human', name: 'Fixture owner' },
    removed: { pubkey: agent, kind: 'agent', name: 'Fixture agent' },
  }));
  assert.equal((await db.query(`SELECT 1 FROM memberships WHERE identity_id=$1 AND removed_at IS NULL`, [agent])).rowCount, 0);
  assert.equal((await db.query<{ hidden_from_roster: boolean }>(`SELECT hidden_from_roster FROM identities WHERE id=$1`, [agent])).rows[0]!.hidden_from_roster, true);
  const result = await auth.exchangeDaemonToken(pending.exchangeToken);
  console.log(JSON.stringify({ retired: true, pendingOrdinaryExchangeIssuedToken: Boolean(result), issuedTokenAuthenticates: result ? (await auth.authenticateDaemon(result.daemonToken)) === agent : false }));
  const issuer = 'c'.repeat(64), paired = 'd'.repeat(64);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Fixture issuer')`, [issuer]);
  await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`, [workspace, issuer]);
  const phone = new PhoneService(db, 'http://fixture.invalid');
  const pairing = await phone.execute('createAgentPairingCode', { workspaceId: workspace }, issuer);
  await phone.execute('removeWorkspaceMember', { workspaceId: workspace, memberId: issuer }, owner);
  const claimed = await phone.claimAgentConnectPairing({ code: pairing.code, agentPubkey: paired, model: 'fixture' });
  console.log(JSON.stringify({ issuerRemoved: true, pendingPairingClaimStatus: claimed.status,
    pairedAgentHasWorkspaceMembership: Boolean((await db.query(`SELECT 1 FROM memberships WHERE workspace_id=$1 AND identity_id=$2 AND room_id IS NULL AND removed_at IS NULL`, [workspace, paired])).rowCount) }));
} finally { await db.close(); }
