// STALE-ANSWERED-REPORT: isolated built HTTP service, synthetic text, no production writes.
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
const delegatePath = process.argv.includes('--delegate');
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
  await claim(turn);
  if (delegatePath) {
    // The implementer orders another member in its corner. That member is a
    // delegate, so the primary-worker attention index does not track its report.
    await call('order', { ...authority(turn), address: opened.cornerId, agent: 'commander', text: 'Recover input' }, worker);
    const delegated = (await call('getAgentCommands', { roomId: opened.cornerId })).commands[0];
    await claim(delegated);
    await call('report', { ...authority(delegated), status: 'blocked', text: 'blocked: input is missing' });
    const blocked = (await call('getAgentCommands', { roomId: opened.cornerId }, worker)).commands.find(command => command.reason === 'report');
    assert.ok(blocked);
    await call('order', { ...authority(turn), address: opened.cornerId, agent: 'commander', text: 'Use recovered input' }, worker);
    const cached = await request('claimAgentCommand', { roomId: opened.cornerId, commandId: blocked.id, generationId: 'cached' }, worker);
    assert.equal(cached.status, base ? 200 : 409);
    if (base) await db.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,lease_expires_at=NULL WHERE id=$1`, [blocked.id]);
    const inbox = await call('getAgentCommands', { roomId: opened.cornerId }, worker);
    assert.equal(inbox.commands.some(command => command.id === blocked.id), base);
    console.log(`STALE-DELEGATE-REPORT ${base ? 'BASELINE BUG' : 'PASS'}: delegate blocker → newer commander order → cached claim HTTP ${cached.status}; stale blocker in inbox=${base}`);
  } else {
  await call('report', { ...authority(turn), status: 'blocked', text: 'blocked: publish job is running' }, worker);
  const report = (await call('getAgentCommands', { roomId: dm })).commands.find(command => command.reason === 'report');
  assert.ok(report);
  await call('postRoomMessage', { ...authority(order), text: 'done: publish verified' });
  assert.equal((await db.query(`SELECT private_payload->>'waitingAnswered' answered FROM agent_commands WHERE id=$1`, [report.id])).rows[0].answered, 'true');
  // Claim first to exercise an already pushed snapshot, before another inbox read.
  const cached = await request('claimAgentCommand', { roomId: dm, commandId: report.id, generationId: 'cached' });
  assert.equal(cached.status, base ? 200 : 409);
  if (base) await db.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,lease_expires_at=NULL WHERE id=$1`, [report.id]);
  const inbox = await call('getAgentCommands', { roomId: dm });
  const delivered = inbox.commands.some(command => command.id === report.id);
  assert.equal(delivered, base);
  console.log(`STALE-ANSWERED-REPORT ${base ? 'BASELINE BUG' : 'PASS'}: worker blocker → commander resolved reply → answered marker; cached claim HTTP ${cached.status}; stale blocker in inbox=${delivered}`);
  }
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await db.close();
}
