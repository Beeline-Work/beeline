// Isolated built-service proof; no production credentials or helper lifecycle.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { migrate } from '../apps/server/dist/database.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { ConnectionPresence } from '../apps/server/dist/connection-presence.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { flushDueCommanderWakes } from '../apps/server/dist/commander-wakes.js';
const client = new PGlite({ extensions: { vector } });
function executor(connection) {
  const db = {
    async query(sql, values = []) {
      if (!values.length && sql.split(';').filter(part => part.trim()).length > 1) {
        await connection.exec(sql); return { rows: [], rowCount: 0 };
      }
      const result = await connection.query(sql, values);
      return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0 };
    },
    transaction: work => connection === client
      ? client.transaction(tx => work(executor(tx))) : work(db),
  };
  return db;
}
const db = executor(client), live = new LiveHub();
const daemon = new DaemonService(db, live), phone = new PhoneService(db, 'http://isolated');
const human = 'a'.repeat(64), commander = 'b'.repeat(64), worker = 'c'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const dm = '33333333-3333-4333-8333-333333333333';
const authority = command => ({ roomId: command.roomId, requestId: command.turnRequestId, generationId: 'proof' });
const commands = async (roomId, agentId) => (await daemon.execute('getAgentCommands', { roomId }, agentId)).commands;
const claim = command => daemon.execute('claimAgentCommand', { roomId: command.roomId, commandId: command.id, generationId: 'proof' }, command.agentId);
const presence = new ConnectionPresence(db, live, 100);
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Commander','commander'),($3,'agent','Worker','worker')`, [human, commander, worker]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [commander, worker, human]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Isolated stall proof')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants,created_by) VALUES($1,$3,'Proof',NULL,$4),($2,$3,'Command',jsonb_build_array($4::text,$5::text),$4)`, [room, dm, workspace, human, commander]);
  for (const identity of [human, commander, worker]) {
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [workspace, identity, room]);
    if (identity !== worker) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [workspace, dm, identity]);
  }
  await phone.execute('sendRoomMessage', { roomId: dm, messageId: randomBytes(32).toString('hex'), text: 'Complete the proof' }, human);
  const order = (await commands(dm, commander))[0]; await claim(order);
  const opened = await daemon.execute('createCorner', { ...authority(order), targetRoomId: room, name: 'Proof', objective: 'Complete the proof', implementer: 'worker', brief: { spec: 'Complete the proof', repositoryWork: false, approval: { sourceMessageId: order.sourceMessageId } } }, commander);
  const turn = (await commands(opened.cornerId, worker))[0]; await claim(turn);
  await daemon.execute('report', { ...authority(turn), status: 'done', text: 'done: proof delivered' }, worker);
  await db.query(`UPDATE agent_turns SET created_at=now()-interval '2 minutes' WHERE room_id=$1`, [opened.cornerId]);
  await presence.start();
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await db.query(`SELECT status FROM agent_turns WHERE room_id=$1`, [opened.cornerId])).rows[0]?.status === 'complete') break;
    await new Promise(done => setTimeout(done, 20));
  }
  assert.deepEqual((await db.query(`SELECT status,failure_reason FROM agent_turns WHERE room_id=$1`, [opened.cornerId])).rows, [{ status: 'complete', failure_reason: null }]);
  await db.query(`UPDATE agent_commands SET wake_after=now() WHERE wake_after IS NOT NULL`);
  await flushDueCommanderWakes(db);
  assert.deepEqual((await commands(dm, commander)).filter(command => command.reason === 'report').map(command => command.source.body), ['done: proof delivered']);
  console.log('reported-stall PASS: delivered done remains complete after the presence deadline; commander has no failure report');
} finally {
  await presence.stop(); await client.close();
}
