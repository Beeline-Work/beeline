// TOKEN-WORKFLOW: wrong role bindings through the built HTTP input boundary.
import assert from 'node:assert/strict';
import { PgliteDatabase, describedWorkflow } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { TokenAuth, tokenHash } from '../apps/server/dist/auth.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { createBeelineServer } from '../apps/server/dist/server.js';
import { createAgentCommand, claimAgentCommand } from '../apps/server/dist/agent-command.js';
import { saveWorkflow } from '../apps/server/dist/workflow-runs.js';
const db = new PgliteDatabase();
const human = 'a'.repeat(64), agent = 'b'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111', room = '22222222-2222-4222-8222-222222222222';
const token = 'bdt_token_workflow_fixture';
let server;
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Worker','worker')`, [human, agent]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, human]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Proof',$3)`, [room, workspace, human]);
  for (const member of [human, agent]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [workspace, member, room]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('root',$1,$2,'Start the proof')`, [room, human]);
  const command = await createAgentCommand(db, { roomId: room, agentId: agent, sourceMessageId: 'root', reason: 'test' });
  await claimAgentCommand(db, room, agent, command.id, 'proof');
  await saveWorkflow(db, command, { contract: describedWorkflow({ version: 1, name: 'token-proof', description: 'Proof',
    roles: ['maker', 'checker', 'closer'], start: 'make', handoffs: {
      make: { role: 'maker', requires: ['summary'], on: { done: 'check' } },
      check: { role: 'checker', requires: ['summary'], on: { done: 'close' } },
      close: { role: 'closer', requires: ['summary'], on: { done: 'finished' } },
      finished: { kind: 'terminal', status: 'done' },
    } }) });
  await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [tokenHash(token), agent]);
  const live = new LiveHub();
  const daemon = new DaemonService(db, live);
  server = createBeelineServer({ database: db, daemon, live, phone: new PhoneService(db, 'http://proof'),
    auth: new TokenAuth(db, async () => { throw Error('unused'); }), mediaMaximumBytes: 1 });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/daemon/operations/startWorkflow`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ roomId: room, requestId: command.turn_request_id, generationId: 'proof', name: 'token-proof',
      roleBindings: { maker: '@absent', checker: human } }),
  });
  const body = await response.json();
  assert.equal(response.status, 400, JSON.stringify(body));
  assert.match(body.error, /maker: given "@absent"/);
  assert.ok(body.error.includes(`checker: given "${human}"`));
  assert.match(body.error, /closer: given missing/);
  assert.equal(body.error.match(/allowed members:/g).length, 3);
  assert.match(body.error, /@worker/);
  console.log('Demonstrated TOKEN-WORKFLOW: built HTTP start returns one input refusal (400), all missing/invalid roles, and allowed agents.');
} finally {
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  await db.close();
}
