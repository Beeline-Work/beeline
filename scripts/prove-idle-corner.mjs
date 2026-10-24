// Production-timed stalls are unsafe to manufacture; exercise the built service
// with an isolated database and read the same command inbox helpers consume.
import assert from 'node:assert/strict';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { runCornerAttention } from '../apps/server/dist/corner-attention.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { createAgentCommand } from '../apps/server/dist/agent-command.js';
import { LiveHub } from '../apps/server/dist/live.js';

const db = new PgliteDatabase();
const human = 'a'.repeat(64), commander = 'b'.repeat(64), worker = 'c'.repeat(64), peer = 'd'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const corner = '33333333-3333-4333-8333-333333333333';
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Commander'),($3,'agent','Worker'),($4,'agent','Peer')`, [human,commander,worker,peer]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$4),($2,$4),($3,$4)`, [commander,worker,peer,human]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Parent',$3)`, [room,workspace,human]);
  for (const agent of [commander,worker,peer]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [workspace,room,agent]);
  const daemon = new DaemonService(db, new LiveHub());
  for (const scenario of ['scheduled','pending-ci','live-turn','closed','archived','idle']) {
    await db.query('DELETE FROM rooms WHERE id=$1', [corner]);
    await db.query('DELETE FROM agent_commands WHERE room_id=$1', [room]);
    await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'Corner',$4)`, [corner,workspace,room,commander]);
    await db.query(`INSERT INTO corner_facts(corner_id,owner_agent_id,worker_agent_id) VALUES($1,$2,$2)`, [corner,worker]);
    // A later incidental peer order must not take ownership of attention.
    await createAgentCommand(db, {id:`peer-${scenario}`,roomId:corner,agentId:worker,sourceMessageId:null,reason:'order',
      privatePayload:{kind:'order',text:'Check',authorId:peer,fromRoomId:room}});
    await db.query("UPDATE agent_commands SET state='complete' WHERE room_id=$1", [corner]);
    await db.query("DELETE FROM agent_turns WHERE room_id=$1 AND generation_id LIKE 'pending:%'", [corner]);
    await db.query('UPDATE corner_attention_spans SET last_turn_ended_at=NULL WHERE corner_id=$1', [corner]);
    if (scenario === 'scheduled') await db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,message,cadence,next_run_at) VALUES(gen_random_uuid(),$1,$2,$3,$3,'Continue','{"kind":"interval","everySeconds":86400}',now()+interval '1 day')`, [workspace,corner,worker]);
    if (scenario === 'pending-ci') {
      await db.query(`UPDATE corner_facts SET lifecycle='{"pr":{"headSha":"head","number":1},"checks":"pending"}' WHERE corner_id=$1`, [corner]);
      await db.query(`UPDATE corner_attention_spans SET ci_started_at=now()-interval '31 minutes' WHERE corner_id=$1`, [corner]);
    }
    if (scenario === 'live-turn') await db.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status,generation_id) VALUES($1,'live',$2,'working','actual')`, [corner,worker]);
    if (scenario === 'closed') await db.query(`UPDATE corner_facts SET lifecycle='{"lifecycle":"closed"}' WHERE corner_id=$1`, [corner]);
    if (scenario === 'archived') await db.query('UPDATE rooms SET archived_at=now() WHERE id=$1', [corner]);
    await runCornerAttention(db);
    await runCornerAttention(db);
    const alerts = await daemon.execute('getAgentCommands', {roomId:room}, commander);
    const others = await daemon.execute('getAgentCommands', {roomId:room}, peer);
    assert.equal(alerts.commands.length, scenario === 'idle' ? 1 : 0, scenario);
    assert.equal(others.commands.length, 0, `${scenario}: peer inbox`);
    console.log(`Reproduction IDLE-1 ${scenario}: commander alerts=${alerts.commands.length}; peer alerts=${others.commands.length}`);
  }
} finally {
  await db.close();
}
