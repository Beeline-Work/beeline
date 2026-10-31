// HANDBACK-ROUTE-1: isolated built HTTP service; no production commands.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { TokenAuth, tokenHash } from '../apps/server/dist/auth.js';
import { createBeelineServer } from '../apps/server/dist/server.js';

for (const status of ['blocked', 'needs_decision', 'failed', 'done']) {
  const db = new PgliteDatabase();
  const human = 'a'.repeat(64), commander = 'b'.repeat(64), worker = 'c'.repeat(64), reviewer = 'd'.repeat(64);
  const workspace = '11111111-1111-4111-8111-111111111111';
  const room = '22222222-2222-4222-8222-222222222222';
  const dm = '33333333-3333-4333-8333-333333333333';
  const tokens = new Map([[commander, 'bdt_commander_fixture_token'], [worker, 'bdt_worker_fixture_token'], [reviewer, 'bdt_reviewer_fixture_token']]);
  let server;
  try {
    await migrate(db);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Owner','owner'),($2,'agent','Commander','commander'),($3,'agent','Worker','worker')`, [human, commander, worker]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [commander, worker, human]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Handback routing proof')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants,created_by) VALUES
      ($1,$3,'Work',NULL,$4),($2,$3,'Owner and commander',jsonb_build_array($4::text,$5::text),$4)`, [room, dm, workspace, human, commander]);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Reviewer','reviewer')`, [reviewer]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [reviewer, human]);
    for (const member of [human, commander, worker, reviewer]) {
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [workspace, member, room]);
      if (member !== worker) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,$2,$3,'member')`, [workspace, dm, member]);
    }
    for (const [agent, token] of tokens) await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [tokenHash(token), agent]);
    const live = new LiveHub(), daemon = new DaemonService(db, live);
    const phone = new PhoneService(db, 'http://proof');
    server = createBeelineServer({ database: db, daemon, phone, live,
      auth: new TokenAuth(db, async () => { throw new Error('unused'); }), mediaMaximumBytes: 1024 * 1024 });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const call = async (name, input, agent = commander) => {
      const response = await fetch(`${origin}/v1/daemon/operations/${name}`, {
        method: 'POST', headers: { authorization: `Bearer ${tokens.get(agent)}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const body = await response.json();
      assert.equal(response.status, 200, `${name}: ${JSON.stringify(body)}`);
      return body;
    };
    const authority = turn => ({ roomId: turn.roomId, requestId: turn.turnRequestId, generationId: 'proof' });
    const claim = turn => call('claimAgentCommand', { roomId: turn.roomId, commandId: turn.id, generationId: 'proof' }, turn.agentId);
    await phone.execute('sendRoomMessage', { roomId: dm, messageId: randomBytes(32).toString('hex'), text: 'Prove handback routing' }, human);
    const order = (await call('getAgentCommands', { roomId: dm })).commands[0];
    await claim(order);
    const opened = await call('createCorner', { ...authority(order), targetRoomId: room, name: 'handback-routing',
      objective: 'Prove handback routing', implementer: 'worker',
      brief: { spec: 'Prove routing', repositoryWork: false, approval: { sourceMessageId: order.sourceMessageId } } });
    const corner = opened.cornerId;
    await db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [room, reviewer]);
    await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`,
      [corner, JSON.stringify({ pr: { number: 42, headSha: 'head' } })]);
    await call('order', { ...authority(order), address: corner, agent: 'reviewer', text: 'Review the change' });
    const review = (await call('getAgentCommands', { roomId: corner }, reviewer)).commands.find(c => c.reason === 'order');
    await claim(review);
    await call('order', { ...authority(review), address: corner, text: 'FAIL: repair missing proof' }, reviewer);
    await db.query(`UPDATE agent_commands SET state='complete' WHERE room_id=$1 AND reason='corner_objective'`, [corner]);
    const repair = (await call('getAgentCommands', { roomId: corner }, worker)).commands.find(c => c.reason === 'order');
    await claim(repair);
    const text = `${status.replace('_', '-')}: repair result`;
    await call('report', { ...authority(repair), status, text }, worker);
    const recipient = status === 'done' ? reviewer : commander;
    const destination = status === 'done' ? corner : dm;
    const reports = (await call('getAgentCommands', { roomId: destination }, recipient)).commands.filter(c => c.reason === 'report');
    assert.equal(reports.length, 1);
    assert.equal(reports[0].source.body, text);
    assert.equal((await db.query(`SELECT 1 FROM agent_commands WHERE reason='report' AND agent_id=$1`,
      [status === 'done' ? commander : reviewer])).rowCount, 0);
    console.log(`HANDBACK-ROUTE-1 PASS: ${status} delivered through built HTTP service to ${status === 'done' ? 'reviewer' : 'commander'} only`);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await db.close();
  }
}
