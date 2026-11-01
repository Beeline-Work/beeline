// Built HTTP stand-in for R-BRIEF-DEADLOCK; --base proves the pre-fix failure.
import assert from 'node:assert/strict';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { TokenAuth, tokenHash } from '../apps/server/dist/auth.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { createBeelineServer } from '../apps/server/dist/server.js';
import { createAgentCommand } from '../apps/server/dist/agent-command.js';
const db = new PgliteDatabase();
const human = 'a'.repeat(64), agent = 'b'.repeat(64), source = 'c'.repeat(64);
const ws = '11111111-1111-4111-8111-111111111111', room = '22222222-2222-4222-8222-222222222222';
let armed = false, attempts = 0;
const wrapped = {
  query: db.query.bind(db),
  transaction: work => db.transaction(async tx => {
    const result = await work(tx);
    if (armed && ++attempts === 1) throw Object.assign(new Error('injected deadlock'), { code: '40P01' });
    return result;
  }),
};
const live = new LiveHub(), daemon = new DaemonService(wrapped, live);
daemon.warmConnectorIndex = async () => {};
let server;
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Agent')`, [human,agent]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent,human]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Isolated proof')`, [ws]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Proof')`, [room,ws]);
  for (const id of [human,agent]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [ws,room,id]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Build the widget')`, [source,room,human]);
  const command = await createAgentCommand(db, {roomId:room,agentId:agent,sourceMessageId:source,reason:'human_tag'});
  await daemon.execute('claimAgentCommand', {roomId:room,commandId:command.id,generationId:'proof'}, agent);
  const turn = {roomId:room,requestId:command.turn_request_id,generationId:'proof'};
  const opened = await daemon.execute('createCorner', {...turn,name:'Widget',objective:'Build widget',brief:{spec:'Build widget',repositoryWork:false,approval:{sourceMessageId:source}}}, agent);
  await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [tokenHash('bdt_brief_proof_fixture_123456789'),agent]);
  server = createBeelineServer({database:wrapped,daemon,live,auth:new TokenAuth(db,async()=>{throw new Error('unused');}),phone:new PhoneService(db,'http://test'),mediaMaximumBytes:1});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  armed = true;
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/daemon/operations/reviseCornerBrief`, {
    method:'POST',headers:{authorization:'Bearer bdt_brief_proof_fixture_123456789','content-type':'application/json'},
    body:JSON.stringify({...turn,cornerId:opened.cornerId,expectedRevision:1,brief:{spec:'Build clarified widget',change:'Clarify scope'}}),
  });
  const base = process.argv.includes('--base');
  assert.equal(response.status,base?503:200);
  const body = await response.json();
  assert.equal(attempts,base?1:2);
  const restored = await daemon.execute('getCornerRestoreState',{cornerId:opened.cornerId},agent);
  assert.equal(restored.brief.revision,base?1:2);
  assert.equal(restored.brief.spec,base?'Build widget':'Build clarified widget');
  if (!base) assert.equal(body.revision,2);
  console.log(`R-BRIEF-DEADLOCK: built authenticated HTTP revision returned ${response.status}; restored revision ${restored.brief.revision}; owning attempts ${attempts}`);
} finally {
  if (server) await new Promise(resolve=>server.close(resolve));
  await db.close();
}
