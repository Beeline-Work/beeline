// Reproduction R1: isolated built HTTP service, synthetic text, no production writes.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
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
const tokens = new Map([[commander, 'bdt_answered_commander_fixture'], [worker, 'bdt_answered_worker_fixture']]);
const base = process.argv.includes('--base');
import { ConnectionPresence } from '../apps/server/dist/connection-presence.js';
import { createAgentCommand } from '../apps/server/dist/agent-command.js';
let server;
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Commander','commander'),($3,'agent','Worker','worker')`, [human, commander, worker]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [commander, worker, human]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Answered report proof')`, [workspace]);
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
  const opened = await call('createCorner', { ...authority(order), targetRoomId: room, name: 'answered-report',
    objective: 'Verify the publish', implementer: 'worker',
    brief: { spec: 'Verify the publish', repositoryWork: false, approval: { sourceMessageId: order.sourceMessageId } } });
  const turn = (await call('getAgentCommands', { roomId: opened.cornerId }, worker)).commands[0];
  const queued = await createAgentCommand(db, { roomId: opened.cornerId, agentId: worker,
    sourceMessageId: null, reason: 'corner_background_tool',
    privatePayload: { kind: 'lifecycle', text: 'Background tool completed', authorId: worker, fromRoomId: opened.cornerId } });
  await db.query(`UPDATE agent_commands SET wake_after=NULL WHERE id=$1`, [queued.id]);
  await claim(turn);
  // Exercise #3191's public restore projection while this worker is occupied.
  const waiting = await call('createCorner', { ...authority(order), targetRoomId: room, name: 'waiting-proof', idempotencyKey: 'waiting-proof',
    objective: 'Verify queued display', implementer: 'worker',
    brief: { spec: 'Verify queued display', repositoryWork: false, approval: { sourceMessageId: order.sourceMessageId } } });
  await db.query("INSERT INTO live_server_instances(instance_id) VALUES('proof-online')");
  await db.query("INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id) VALUES($1,1,'proof-online','proof-online')", [worker]);
  const queuedView = await call('getCornerRestoreState', { cornerId: waiting.cornerId }, worker);
  if (!base) {
    assert.equal(queuedView.queue, 'queued');
    assert.equal(queuedView.queueBehind, 'answered-report');
    console.log('R1 queued reason over HTTP:', queuedView.queue, queuedView.queueBehind);
  }

  await db.query(`UPDATE agent_turns SET created_at=now()-interval '2 minutes' WHERE request_id=$1`, [queued.turn_request_id]);
  const presence = new ConnectionPresence(db, live);
  try {
    await presence.start();
    await new Promise(resolve => setTimeout(resolve, 500));
  } finally { await presence.stop(); }
  const notices = (await db.query(`SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%did not claim%'`, [opened.cornerId])).rows;
  assert.equal(notices.length, base ? 1 : 0);
  const inbox = await call('getAgentCommands', { roomId: opened.cornerId }, worker);
  assert.ok(inbox.commands.some(command => command.id === queued.id));
  await call('postAgentTurnReceipt', { ...authority(turn), agentId: worker, status: 'complete' }, worker);
  const waitingCommand = (await call('getAgentCommands', { roomId: waiting.cornerId }, worker)).commands[0];
  await claim(waitingCommand);
  const runningView = await call('getCornerRestoreState', { cornerId: waiting.cornerId }, worker);
  assert.equal(runningView.queue, undefined);
  assert.equal(runningView.activity, 'running');
  await call('postAgentTurnReceipt', { ...authority(waitingCommand), agentId: worker, status: 'complete' }, worker);
  const next = inbox.commands.find(command => command.id === queued.id);
  await claim(next);
  assert.equal((await db.query(`SELECT status FROM agent_turns WHERE request_id=$1`, [next.turnRequestId])).rows[0].status, 'working');
  console.log(`R1 ${base ? 'BASELINE BUG' : 'PASS'}: pickup notices=${notices.length}; pending command delivered over HTTP and claimed after prior turn completion`);
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await db.close();
}
