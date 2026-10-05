/**
 * Workflow notice acceptance proof against the built HTTP server and an
 * isolated in-memory database. Build the server first, then run with tsx.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PgliteDatabase, describedWorkflow } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { TokenAuth } from '../apps/server/dist/auth.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { createBeelineServer } from '../apps/server/dist/server.js';
import { createAgentCommand } from '../apps/server/dist/agent-command.js';

const owner = createHash('sha256').update('github:notice-proof-owner').digest('hex');
const agent = 'b'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const db = new PgliteDatabase();
let server;
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Worker','worker')`, [owner, agent]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, owner]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Notice proof')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Notice proof')`, [room, workspace, owner]);
  for (const id of [owner, agent]) {
    for (const scope of [null, room]) {
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,$4)`, [workspace, scope, id, id === owner ? 'owner' : 'member']);
    }
  }
  const auth = new TokenAuth(db, async () => ({ subject: 'notice-proof-owner', login: 'owner', name: 'Owner' }));
  const live = new LiveHub();
  server = createBeelineServer({ database: db, auth, phone: new PhoneService(db, 'http://localhost'),
    daemon: new DaemonService(db, live), live, mediaMaximumBytes: 1024 * 1024 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const exchange = await auth.createDaemonExchange(agent);
  const daemonToken = (await auth.exchangeDaemonToken(exchange.exchangeToken)).daemonToken;
  const call = async (name, payload) => {
    const response = await fetch(`${origin}/v1/daemon/operations/${name}`, { method: 'POST',
      headers: { authorization: `Bearer ${daemonToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload) });
    const body = await response.json();
    assert.equal(response.status, 200, `${name}: ${JSON.stringify(body)}`);
    return body;
  };
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('notice-kickoff',$1,$2,'Start the workflow')`, [room, owner]);
  const command = await createAgentCommand(db, { roomId: room, agentId: agent, sourceMessageId: 'notice-kickoff', reason: 'human_tag' });
  const turn = { roomId: room, agentId: agent, requestId: command.turn_request_id, generationId: 'notice-proof-generation' };
  await call('claimAgentCommand', { roomId: room, commandId: command.id, generationId: turn.generationId });
  await call('postAgentTurnReceipt', { ...turn, status: 'working' });
  await call('saveWorkflow', { ...turn, contract: describedWorkflow({ version: 1, name: 'notice-proof',
    description: 'Workflow notice proof', roles: ['worker'], start: 'work', handoffs: {
      work: { role: 'worker', requires: [], on: { done: 'finished' } },
      finished: { kind: 'terminal', status: 'done' },
    } }) });
  const started = await call('startWorkflow', { ...turn, name: 'notice-proof', roleBindings: { worker: agent } });
  await call('handoff', { ...turn, runId: started.runId, outcome: 'done', contents: {} });
  const token = (await auth.exchangeGitHubOidc('fixture')).accessToken;
  const response = await fetch(`${origin}/v1/phone/rooms/${room}`, { headers: { authorization: `Bearer ${token}` } });
  const view = await response.json();
  assert.equal(response.status, 200, JSON.stringify(view));
  const notices = view.messages.filter(message => message.systemEvent?.verb === 'started workflow' || message.systemEvent?.verb === 'handed off');
  assert.equal(notices.length, 2);
  assert.deepEqual(notices.map(message => message.presentation), ['system', 'system']);
  for (const message of notices) assert.ok(message.text.includes(started.runId.slice(0, 8)));
  console.log('Reproduction workflow-notice-1 Demonstrated on the built HTTP service: start_workflow → handoff to terminal → GET Room');
  console.log(JSON.stringify(notices.map(({ text, presentation }) => ({ text, presentation })), null, 2));
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await db.close();
}
