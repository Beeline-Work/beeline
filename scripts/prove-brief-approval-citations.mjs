// Isolated HTTP proof against the built service. No production state is changed.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { createAgentCommand, claimAgentCommand } from '../apps/server/dist/agent-command.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { TokenAuth, tokenHash } from '../apps/server/dist/auth.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { createBeelineServer } from '../apps/server/dist/server.js';

const db = new PgliteDatabase();
const human = 'a'.repeat(64), commander = 'b'.repeat(64), worker = 'c'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const parent = '22222222-2222-4222-8222-222222222222';
const baseline = process.argv.includes('--baseline');
let server;
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Commander','commander'),($3,'agent','Worker','worker')`, [human, commander, worker]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [commander, worker, human]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Parent')`, [parent, workspace]);
  for (const identity of [human, commander, worker])
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`, [workspace, identity, parent]);
  const source = randomBytes(32).toString('hex');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Build the widget')`, [source, parent, human]);
  const command = await createAgentCommand(db, { roomId: parent, agentId: commander, sourceMessageId: source, reason: 'human_tag' });
  await claimAgentCommand(db, parent, commander, command.id, 'proof-generation');
  const live = new LiveHub(), daemon = new DaemonService(db, live);
  daemon.warmConnectorIndex = async () => {};
  for (const agent of [commander, worker])
    await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [tokenHash(`bdt_fixture_${agent}`), agent]);
  server = createBeelineServer({ database: db, daemon, live, auth: new TokenAuth(db, async () => { throw new Error('unused'); }), phone: new PhoneService(db, 'http://test'), mediaMaximumBytes: 1 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  async function request(agent, operation, input) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/daemon/operations/${operation}`, {
      method: 'POST', headers: { authorization: `Bearer bdt_fixture_${agent}`, 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    return { status: response.status, body: await response.json() };
  }
  const authority = { roomId: parent, requestId: command.turn_request_id, generationId: 'proof-generation' };
  const opened = await request(commander, 'createCorner', { ...authority, targetRoomId: parent, name: 'Widget', objective: 'Build widget', implementer: 'worker',
    brief: { spec: 'Build widget', repositoryWork: false, approval: { sourceMessageId: source } } });
  assert.equal(opened.status, 200, JSON.stringify(opened));
  const corner = opened.body.cornerId;
  const queued = await request(commander, 'order', { ...authority, address: corner, text: 'Use the revised endpoint.' });
  assert.equal(queued.status, 200, JSON.stringify(queued));
  const workerCommand = (await request(worker, 'getAgentCommands', { roomId: corner })).body.commands.find(item => item.id === queued.body.id);
  assert.ok(workerCommand);
  assert.equal((await request(worker, 'claimAgentCommand', { roomId: corner, commandId: workerCommand.id, generationId: 'proof-generation' })).status, 200);
  const card = (await db.query(`SELECT id FROM messages WHERE room_id=$1 AND card_type='agent-command' AND card->>'text'=$2`, [corner, 'Use the revised endpoint.'])).rows[0];
  const workerAuthority = { roomId: corner, requestId: workerCommand.turnRequestId, generationId: 'proof-generation' };
  async function revise(sourceMessageId, expectedRevision) {
    return request(worker, 'reviseCornerBrief', { ...workerAuthority, cornerId: corner, expectedRevision,
      brief: { spec: 'Use the revised endpoint', repositoryWork: false, change: 'Clarify endpoint', approval: { sourceMessageId } } });
  }
  const ordered = await revise(card.id, 1);
  assert.equal(ordered.status, baseline ? 403 : 200, JSON.stringify(ordered));
  console.log(`APPROVAL-CITATIONS order card: HTTP ${ordered.status} ${JSON.stringify(ordered.body.approval ?? ordered.body)}`);
  const approval = randomBytes(32).toString('hex');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Approved endpoint revision')`, [approval, parent, human]);
  const approved = await revise(approval, baseline ? 1 : 2);
  assert.equal(approved.status, 200, JSON.stringify(approved));
  const restored = await request(worker, 'getCornerRestoreState', { cornerId: corner });
  assert.deepEqual(restored.body.brief.approval, { sourceMessageId: approval, text: 'Approved endpoint revision', approvedBy: human, approverName: 'Owner' });
  if (!baseline) assert.deepEqual(ordered.body.approval, { sourceMessageId: card.id, text: 'Use the revised endpoint.', approvedBy: commander, approverName: 'Commander' });
  console.log(`APPROVAL-CITATIONS parent Room: HTTP ${approved.status}; restored exact human text and author`);
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await db.close();
}
