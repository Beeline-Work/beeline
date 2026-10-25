// Isolated built HTTP service proof; no production daemon or external provider.
import assert from 'node:assert/strict';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { createAgentCommand } from '../apps/server/dist/agent-command.js';
import { systemLine } from '../apps/server/dist/system-line.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { TokenAuth, tokenHash } from '../apps/server/dist/auth.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { createBeelineServer } from '../apps/server/dist/server.js';
const db = new PgliteDatabase();
const owner = 'a'.repeat(64), agent = 'b'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const parent = '22222222-2222-4222-8222-222222222222';
const corner = '33333333-3333-4333-8333-333333333333';
const base = process.argv.includes('--base');
let server;
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Jellybean','jellybean')`, [owner, agent]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, owner]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Parent')`, [parent, workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Corner')`, [corner, workspace, parent, agent]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [workspace, parent, agent]);
  await db.query(`INSERT INTO corner_facts(corner_id,owner_agent_id,lifecycle) VALUES($1,$2,'{}')`, [corner, agent]);
  const live = new LiveHub();
  const daemon = new DaemonService(db, live);
  daemon.warmConnectorIndex = async () => {};
  await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [tokenHash('bdt_stale_wake_fixture'), agent]);
  server = createBeelineServer({database:db,daemon,live,auth:new TokenAuth(db, async () => {throw new Error('unused');}),phone:new PhoneService(db,'http://test'),mediaMaximumBytes:1});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  async function request(operation, input = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/daemon/operations/${operation}`, {method:'POST',headers:{authorization:'Bearer bdt_stale_wake_fixture','content-type':'application/json'},body:JSON.stringify({roomId:corner,...input})});
    return {status:response.status,body:await response.json()};
  }
  const revision = n => db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,content,spec,author_id,source_room_id) VALUES($1,$2,'Brief','Proof',$3,$4)`, [corner,n,agent,parent]);
  async function assignment(n) {
    const line = await systemLine(db, {roomId:corner,subject:{kind:'agent',id:agent,name:'Jellybean'},verb:'revised the corner brief',object:{text:`Revision ${n}`,id:corner}});
    return createAgentCommand(db, {roomId:corner,agentId:agent,sourceMessageId:line.id,reason:'corner_brief_revision'});
  }
  let old, current;
  // A replay can preserve identical timestamps for distinct revisions.
    await revision(1); old = await assignment(1);
    await revision(2); current = await assignment(2);
  await db.query(`UPDATE corner_brief_revisions SET created_at=(SELECT min(created_at) FROM agent_commands WHERE room_id=$1) WHERE corner_id=$1`, [corner]);
  await db.query(`UPDATE agent_commands SET created_at=(SELECT min(created_at) FROM agent_commands WHERE room_id=$1) WHERE room_id=$1`, [corner]);
  if (process.argv.includes('--claim-first')) {
    const first = await request('claimAgentCommand',{commandId:old.id,generationId:'proof-first'});
    assert.equal(first.status,409);
  }
  const response = await request('getAgentCommands');
  assert.equal(response.status,200);
  const ids = response.body.commands.map(c => c.id);
  assert.equal(ids.includes(old.id),base);
  assert.equal(ids.includes(current.id),true);
  const claim = await request('claimAgentCommand',{commandId:old.id,generationId:'proof'});
  assert.equal(claim.status === 200,base);
  console.log(`Reproduction STALE-CAUSE-1 (${base ? 'before' : 'after'}): HTTP inbox contains old revision=${ids.includes(old.id)}, current revision=${ids.includes(current.id)}; cached old claim HTTP ${claim.status}`);
} finally {
  if(server) await new Promise(resolve => server.close(resolve));
  await db.close();
}
