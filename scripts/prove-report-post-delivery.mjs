// RETURN-ADDRESS, POST-ID, REPLY-ONCE: built HTTP service and phone read proof.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { TokenAuth, tokenHash } from '../apps/server/dist/auth.js';
import { createBeelineServer } from '../apps/server/dist/server.js';
import { flushDueCommanderWakes } from '../apps/server/dist/commander-wakes.js';
import { mentionReplyKey, mentionReplyId } from '../apps/server/dist/owed-mentions.js';

const db = new PgliteDatabase();
const human = 'a'.repeat(64), commander = 'b'.repeat(64), worker = 'c'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const dm = '33333333-3333-4333-8333-333333333333';
const tokens = new Map([[commander, 'bdt_commander_fixture_token'], [worker, 'bdt_worker_fixture_token']]);
let server;
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Commander','commander'),($3,'agent','Worker','worker')`, [human, commander, worker]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [commander, worker, human]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Delivery proof')`, [workspace]);
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
    auth: new TokenAuth(db, async () => { throw new Error('unused'); }), mediaMaximumBytes: 1024 * 1024 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (name, input, agent = commander) => {
    const response = await fetch(`${origin}/v1/daemon/operations/${name}`, {
      method: 'POST', headers: { authorization: `Bearer ${tokens.get(agent)}`, 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    const body = await response.json();
    assert.equal(response.status, 200, `${name}: ${JSON.stringify(body)}`);
    return body;
  };
  const authority = turn => ({ roomId: turn.roomId, requestId: turn.turnRequestId, generationId: 'proof' });
  const claim = turn => call('claimAgentCommand', { roomId: turn.roomId, commandId: turn.id, generationId: 'proof' }, turn.agentId);
  const commands = async (address, agent) => {
    await db.query('UPDATE agent_commands SET wake_after=now() WHERE wake_after IS NOT NULL');
    await flushDueCommanderWakes(db);
    return (await call('getAgentCommands', { roomId: address }, agent)).commands;
  };
  await phone.execute('sendRoomMessage', { roomId: dm, messageId: randomBytes(32).toString('hex'), text: 'Build the fix' }, human);
  const order = (await commands(dm, commander))[0];
  await claim(order);
  const legacyId = mentionReplyId(await mentionReplyKey(db, commander, dm, order.sourceMessageId));
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,reply_to_message_id,root_message_id)
    VALUES($1,$2,$3,'Opened the fix.',$4,$4)`, [legacyId, dm, commander, order.sourceMessageId]);
  const post = text => call('postCornerMessage', { ...authority(order), cornerId: dm, replyTo: order.sourceMessageId, text });
  const first = await post('Opened the fix.'), second = await post('The fix is complete.');
  assert.equal(first.id, legacyId);
  assert.notEqual(first.id, second.id);
  assert.equal((await post('The fix is complete.')).id, second.id);
  const view = await phone.readRoom(dm, human);
  for (const text of ['Opened the fix.', 'The fix is complete.']) assert.equal(view.messages.filter(m => m.text === text).length, 1);
  console.log('Demonstrated Reproduction POST-ID: different text appears in the phone read with its own receipt; retry appears once.');
  const replyId = randomBytes(32).toString('hex');
  for (let attempt = 0; attempt < 3; attempt++) await phone.execute('sendRoomReply', {
    roomId: dm, messageId: replyId, parentMessageId: first.id, text: '@commander Approved in that case',
  }, human);
  assert.equal((await phone.readRoom(dm, human)).messages.filter(m => m.id === replyId).length, 1);
  assert.equal((await db.query('SELECT id FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2', [replyId, commander])).rowCount, 1);
  console.log('Demonstrated Reproduction REPLY-ONCE stand-in: three submissions of one reply id produce one visible reply and one command. Incident with different ids remains unreproduced.');
  const opened = await call('createCorner', { ...authority(order), targetRoomId: room, name: 'Delivery', objective: 'Build the fix', implementer: 'worker',
    brief: { spec: 'Build the fix', repositoryWork: false, approval: { sourceMessageId: order.sourceMessageId } } });
  const turn = (await commands(opened.cornerId, worker))[0];
  await claim(turn);
  await db.query(`UPDATE agent_commands SET private_payload=private_payload-'fromRoomId' WHERE id=$1`, [turn.id]);
  await call('report', { ...authority(turn), status: 'blocked', text: 'blocked: decision needed' }, worker);
  const returned = (await commands(dm, commander)).find(c => c.reason === 'report');
  assert.equal(returned.source.body, 'blocked: decision needed');
  await claim(returned);
  await db.query('DELETE FROM agent_commands WHERE id=$1', [order.id]);
  await call('report', { ...authority(returned), status: 'needs_decision', text: 'needs-decision: approve the next step?' });
  assert.equal((await phone.readRoom(dm, human)).messages.filter(m => m.text === 'needs-decision: approve the next step?').length, 1);
  console.log('Demonstrated Reproduction RETURN-ADDRESS: agent receives and claims report without explicit return address; after parent expiry, escalation reaches original human once.');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await db.close();
}
