// HOLD-CITATION: isolated built HTTP service replay; production is read-only.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { cornerMergeGate } from '../apps/server/dist/corner-lifecycle.js';
import { migrate } from '../apps/server/dist/database.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { TokenAuth, tokenHash } from '../apps/server/dist/auth.js';
import { createBeelineServer } from '../apps/server/dist/server.js';

const db = new PgliteDatabase();
const human = 'a'.repeat(64), commander = 'b'.repeat(64), worker = 'c'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const dm = '33333333-3333-4333-8333-333333333333';
const tokens = new Map([[commander, 'bdt_hold_commander_fixture'], [worker, 'bdt_hold_worker_fixture']]);
let server;
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Commander','commander'),($3,'agent','Worker','worker')`, [human, commander, worker]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [commander, worker, human]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Agent hold proof')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants,created_by) VALUES
    ($1,$3,'Work',NULL,$4),($2,$3,'Owner and commander',jsonb_build_array($4::text,$5::text),$4)`, [room, dm, workspace, human, commander]);
  for (const member of [human, commander, worker]) {
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [workspace, member, room]);
    if (member !== worker) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'member')`, [workspace, dm, member]);
  }
  for (const [agent, token] of tokens) await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [tokenHash(token), agent]);
  const live = new LiveHub(), daemon = new DaemonService(db, live), phone = new PhoneService(db, 'http://proof');
  server = createBeelineServer({ database: db, daemon, phone, live,
    auth: new TokenAuth(db, async () => { throw new Error('unused'); }), mediaMaximumBytes: 1024 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  async function request(name, input, agent = commander) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/daemon/operations/${name}`, {
      method: 'POST', headers: { authorization: `Bearer ${tokens.get(agent)}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: await response.json() };
  }
  async function call(name, input, agent = commander) {
    const result = await request(name, input, agent);
    assert.equal(result.status, 200, `${name}: ${JSON.stringify(result.body)}`);
    return result.body;
  }
  const authority = turn => ({ roomId: turn.roomId, requestId: turn.turnRequestId, generationId: 'proof' });
  const claim = turn => call('claimAgentCommand', { roomId: turn.roomId, commandId: turn.id, generationId: 'proof' }, turn.agentId);
  await phone.execute('sendRoomMessage', { roomId: dm, messageId: randomBytes(32).toString('hex'), text: 'Verify the publish' }, human);
  const order = (await call('getAgentCommands', { roomId: dm })).commands[0];
  await claim(order);
  const opened = await call('createCorner', { ...authority(order), targetRoomId: room, name: 'agent-hold-proof',
    objective: 'Verify the publish', implementer: 'commander',
    brief: { spec: 'Verify the publish', repositoryWork: false, approval: { sourceMessageId: order.sourceMessageId } } });
  const turn = (await call('getAgentCommands', { roomId: opened.cornerId })).commands[0];
  await claim(turn);
  // Exercise the authenticated refusal from the opening control surface.
  const hold = await request('setCornerHold', { ...authority(order), cornerId:opened.cornerId });
  assert.equal(hold.status, 403, JSON.stringify(hold.body));
  assert.match(hold.body.error, /close the PR/);
  const heldOpen = await request('createCorner', { ...authority(order), targetRoomId:room,
    idempotencyKey:'refused-open', name:'held-refusal', objective:'Must refuse', hold:true });
  assert.equal(heldOpen.status, 403, JSON.stringify(heldOpen.body));
  assert.match(heldOpen.body.error, /close the PR/);
  const sourceMessageId = order.sourceMessageId;
  const cited = await call('setCornerHold', { ...authority(order), cornerId: opened.cornerId, sourceMessageId });
  const status = await call('getCornerRestoreState', { cornerId: opened.cornerId });
  assert.equal(status.holds[0].sourceMessageId, sourceMessageId);
  assert.equal(status.holds[0].sourceAuthorName, 'Owner');
  assert.equal(status.holds[0].sourceText, 'Verify the publish');
  const line = (await db.query(`SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%set a merge hold%'`, [opened.cornerId])).rows[0];
  assert.match(line.text, /Owner.*Verify the publish/);
  console.log(`HOLD-CITATION DISPLAY: ${line.text}`);
  await call('setCornerHold', { ...authority(order), cornerId: opened.cornerId, releaseHoldId: cited.holdId });
  const held = await call('createCorner', { ...authority(order), targetRoomId:room,
    idempotencyKey:'cited-open', name:'cited-hold', objective:'Cite the human', hold:true, sourceMessageId });
  assert.equal((await call('getCornerRestoreState', {cornerId:held.cornerId})).holds[0].sourceAuthorName, 'Owner');
  const retryWithoutConsent = await request('createCorner', { ...authority(order), targetRoomId:room,
    idempotencyKey:'cited-open', name:'cited-hold', objective:'Cite the human', hold:true });
  assert.equal(retryWithoutConsent.status, 403);
  await phone.execute('setCornerHold', {cornerId:opened.cornerId}, human);
  const gate = await cornerMergeGate(db, opened.cornerId, {number:1,headSha:'head'});
  assert.equal(gate.held, true);
  assert.equal(gate.open, false);
  console.log('HOLD-CITATION PASS: uncited HTTP hold and held-open refused; cited hold and held-open accepted with author and excerpt visible; citation-free release works; human hold blocks merge.');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await db.close();
}
