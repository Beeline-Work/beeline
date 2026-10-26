// STEER-1: isolated built HTTP service and helper intake; no production agent is interrupted.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { TokenAuth, tokenHash } from '../apps/server/dist/auth.js';
import { createBeelineServer } from '../apps/server/dist/server.js';
import { CommandExecutionContext, runServerCommandIntake } from '../apps/body/dist/server-command-intake.js';
const db = new PgliteDatabase();
const human = 'a'.repeat(64), commander = 'b'.repeat(64), worker = 'c'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const root = await mkdtemp(join(tmpdir(), 'beeline-steer-proof-'));
const id = () => randomBytes(32).toString('hex');
let server;
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Commander','commander'),($3,'agent','Worker','worker')`, [human, commander, worker]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)', [commander, worker, human]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Steer proof')", [workspace]);
  await db.query("INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Parent',$3)", [room, workspace, human]);
  for (const member of [human, commander, worker]) {
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [workspace, member, room]);
  }
  const live = new LiveHub();
  const daemon = new DaemonService(db, live);
  daemon.warmConnectorIndex = async () => {};
  const phone = new PhoneService(db, 'http://test');
  for (const agent of [commander, worker]) {
    await db.query('INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)', [tokenHash(`bdt_steer_fixture_${agent}`), agent]);
  }
  server = createBeelineServer({ database: db, daemon, live, phone,
    auth: new TokenAuth(db, async () => { throw new Error('unused'); }), mediaMaximumBytes: 1 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  async function request(agent, operation, input) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/daemon/operations/${operation}`, {
      method: 'POST', headers: { authorization: `Bearer bdt_steer_fixture_${agent}`, 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    const body = await response.json();
    assert.equal(response.status, 200, `${operation}: ${JSON.stringify(body)}`);
    return body;
  }
  await phone.execute('sendRoomMessage', { roomId: room, messageId: id(), text: '@commander Build the widget' }, human);
  const order = (await request(commander, 'getAgentCommands', { roomId: room })).commands[0];
  await request(commander, 'claimAgentCommand', { roomId: room, commandId: order.id, generationId: 'proof' });
  const authority = { roomId: room, requestId: order.turnRequestId, generationId: 'proof' };
  for (const kind of ['order', 'brief', 'human']) {
    const opened = await request(commander, 'createCorner', { ...authority, idempotencyKey: `steer-${kind}`, targetRoomId: room,
      name: `steer-${kind}`, objective: 'Build the widget', implementer: 'worker',
      brief: { spec: 'Build the widget', repositoryWork: false, approval: { sourceMessageId: order.sourceMessageId } } });
    const cornerId = opened.cornerId;
    await db.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
      VALUES($1,$2,'presence','presence','{"status":"online"}')`, [cornerId, worker]);
    const abort = new AbortController();
    const context = new CommandExecutionContext(join(root, kind));
    const prompts = [], stops = [];
    let push, entered, replaced, release;
    const started = new Promise(resolve => { entered = resolve; });
    const finished = new Promise(resolve => { replaced = resolve; });
    const old = new Promise(resolve => { release = resolve; });
    // The socket transports this exact server-authorized command snapshot.
    // Driving its callback explicitly avoids a production LISTEN connection.
    const api = { execute: (operation, input) => request(worker, operation, input),
      liveSubscribe: (_room, _cursor, _items, _state, _presence, onCommands) => { push = onCommands; return () => {}; } };
    const running = runServerCommandIntake({ api, roomId: cornerId, agentId: worker, context,
      signal: abort.signal, stop: requestId => { stops.push(requestId); release(); },
      run: async command => {
        const restore = await request(worker, 'getCornerRestoreState', { cornerId });
        prompts.push({ command, text: `${restore.brief.spec}\n${command.source.body}` });
        if (prompts.length === 1) { entered(); await old; }
        else { replaced(); abort.abort(); }
      } });
    try {
      await started;
      const steer = `Use the approved ${kind} widget`;
      if (kind === 'order') await request(commander, 'order', { ...authority, address: cornerId, text: steer });
      else if (kind === 'brief') await request(commander, 'reviseCornerBrief', { ...authority, cornerId, expectedRevision: 1,
        brief: { spec: steer, repositoryWork: false, approval: { sourceMessageId: order.sourceMessageId }, change: steer } });
      else await phone.execute('sendRoomMessage', { roomId: cornerId, messageId: id(), text: `@worker ${steer}` }, human);
      const delivered = await request(worker, 'getAgentCommands', { roomId: cornerId });
      assert(delivered.commands.some(command => command.action === 'stop'), `${kind}: old turn did not receive stop`);
      push(delivered.commands);
      await finished;
      await running;
      assert.equal(prompts.length, 2);
      assert(stops.includes(prompts[0].command.turnRequestId));
      assert(prompts[1].text.includes(steer));
      assert(prompts[1].text.includes('interrupted'));
      assert.equal((await db.query('SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2',
        [cornerId, prompts[0].command.turnRequestId])).rows[0].status, 'cancelled');
      console.log(`STEER-1 ${kind}: built HTTP service cancelled the old turn; built helper started one replacement with the steer and interruption context.`);
    } finally { abort.abort(); release(); await running; }
  }
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await db.close();
  await rm(root, { recursive: true, force: true });
}
