// Isolated built-service proof. No production database, Machine, provider, or login is used.
import assert from 'node:assert/strict';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { noteFirstSilence } from '../apps/server/dist/turn-silence-notice.js';
import { claimAgentCommand } from '../apps/server/dist/agent-command.js';

const before = process.argv.includes('--before');
const db = new PgliteDatabase();
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const agent = 'b'.repeat(64), person = 'a'.repeat(64);
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Person','person'),($2,'agent','Beebee','beebee')`, [person, agent]);
  await db.query(`INSERT INTO agents(agent_id,owner_id,harness) VALUES($1,$2,'pi')`, [agent, person]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Isolated failure proof')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [room, workspace]);
  for (const id of [person, agent]) for (const target of [null, room]) {
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,$4)`, [workspace, target, id, id === person ? 'owner' : 'member']);
  }
  await db.query(`INSERT INTO free_agents(agent_id,workspace_id,owner_id,sealed_keys)
    VALUES($1,$2,$3,'isolated-test')`, [agent, workspace, person]);
  const live = new LiveHub(), phone = new PhoneService(db, 'http://isolated-proof', undefined, undefined, live);
  const daemon = new DaemonService(db, live);
  let sequence = 0;
  for (const free of [true, false]) {
    await db.query(`UPDATE free_agents SET removed_at=CASE WHEN $2 THEN NULL ELSE now() END WHERE agent_id=$1`, [agent, free]);
    for (const [kind, reason] of [
      ['not-signed-in', 'ACP error -32000: Authentication required'],
      ['offline', 'its helper is offline'],
      ['helper-out-of-date', 'helper is out of date'],
      ['hiccup', 'turn_backstop: the turn stalled'],
      ['resource-limit', 'resource_limit: session exceeded memory'],
      ['wrong-model', 'model selection unavailable'],
      ['workspace-failure', 'repository not found'],
      ['context-overflow', 'maximum context length exceeded'],
      ['update-interrupted', 'helper update interrupted this turn'],
    ]) {
      const messageId = String(++sequence).padStart(64, '0');
      const generationId = `proof-${sequence}`;
      await phone.execute('sendRoomMessage', { roomId: room, messageId, text: '@beebee Please reply to my first message' }, person);
      const command = (await db.query(`SELECT id FROM agent_commands WHERE turn_request_id=$1 AND agent_id=$2`, [messageId, agent])).rows[0];
      assert.ok(command, 'the phone message queued an agent turn');
      await claimAgentCommand(db, room, agent, command.id, generationId);
      const result = await daemon.execute('postAgentTurnReceipt', {
        roomId: room, requestId: messageId, generationId, status: 'failed', reason, reasonKind: kind,
      }, agent);
      const stored = (await db.query(`SELECT id FROM messages WHERE card_type='turn-failed' AND card->>'requestId'=$1`, [messageId])).rows[0];
      assert.ok(stored, 'a visible failure line was committed');
      const view = await phone.readRoom(room, person);
      const line = view.messages.find(message => message.id === stored.id)?.text;
      assert.ok(line, 'the phone read includes the committed line');
      const state = (await db.query(`SELECT state FROM agent_commands WHERE id=$1`, [command.id])).rows[0].state;
      const failure = (await db.query(`SELECT failure_reason FROM agent_turns WHERE request_id=$1 AND agent_id=$2`, [messageId, agent])).rows[0].failure_reason;
      assert.equal(failure, reason, 'operator failure detail survives');
      if (!before && free) {
        assert.match(line, /hit a problem on Beeline's side/);
        if (result.updateRequeued) {
          assert.equal(state, 'pending');
          assert.match(line, /Beeline will retry your message; you do not need to do anything/);
        } else {
          assert.equal(state, 'complete');
          assert.match(line, /not retried; please send it again/);
        }
        assert.doesNotMatch(line, /login|provider key|machine|beeline connect|beeline start/);
      }
      if (!free && kind === 'not-signed-in') assert.match(line, /send @beebee login here/);
      console.log(`${before ? 'BEFORE' : 'AFTER'} ${free ? 'free' : 'owned'} ${kind}: ${line} (${state})`);
      // End any queued retry before moving to the next independent message.
      await db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE id=$1`, [command.id]);
    }
  }
  if (!before) {
    await db.query(`UPDATE free_agents SET removed_at=NULL WHERE agent_id=$1`, [agent]);
    const messageId = String(++sequence).padStart(64, '0');
    await phone.execute('sendRoomMessage', { roomId: room, messageId, text: '@beebee Please answer when healthy' }, person);
    const command = (await db.query(`SELECT id FROM agent_commands WHERE turn_request_id=$1 AND agent_id=$2`, [messageId, agent])).rows[0];
    await noteFirstSilence(db, live, { roomId: room, requestId: messageId, agentId: agent,
      reason: 'its helper is offline', reasonKind: 'offline' });
    const view = await phone.readRoom(room, person);
    assert.ok(view.messages.some(message => message.text.includes('Beeline will retry your message; you do not need to do anything.')));
    const generationId = 'healthy-again';
    assert.ok(await claimAgentCommand(db, room, agent, command.id, generationId));
    const reply = 'Here is your reply after Beeline recovered.';
    await daemon.execute('postRoomMessage', { roomId: room, requestId: messageId, generationId, text: reply }, agent);
    assert.ok((await phone.readRoom(room, person)).messages.some(message => message.text === reply));
    console.log('AFTER pending free message: the healthy helper claimed the original message and the phone received its reply, with no second send');
  }
  console.log('Reproduction free-agent-failure-wording PASS: phone message -> claimed turn -> failure receipt -> phone-visible line');
} finally {
  await db.close();
}
