/** Isolated built-service proof; no live daemon, repository or provider writes. */
import assert from 'node:assert/strict';
import { migrate } from '../apps/server/dist/database.js';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { TokenAuth } from '../apps/server/dist/auth.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { createBeelineServer } from '../apps/server/dist/server.js';
import { createAgentCommand, reconcileConfiguredCornerReviewers } from '../apps/server/dist/agent-command.js';
import { systemLine } from '../apps/server/dist/system-line.js';

const human = 'a'.repeat(64), worker = 'b'.repeat(64), reviewer = 'c'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const corner = '33333333-3333-4333-8333-333333333333';
const db = new PgliteDatabase();
let server;
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Worker','worker'),($3,'agent','Reviewer','reviewer')`, [human, worker, reviewer]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)', [worker, reviewer, human]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Room'),($2,$3,'Corner')`, [room, corner, workspace]);
  await db.query(`UPDATE rooms SET repository_key='owner/repo',repository_resolution='repository',reviewer_agent_id=$2 WHERE id=$1`, [room, reviewer]);
  await db.query('UPDATE rooms SET parent_id=$2,created_by=$3 WHERE id=$1', [corner, room, worker]);
  await db.query(`INSERT INTO corner_facts(corner_id,owner_agent_id,worker_agent_id,objective) VALUES($1,$2,$2,'Proof')`, [corner, worker]);
  for (const identity of [human, worker, reviewer]) for (const place of [null, room])
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`, [workspace, place, identity]);
  // This provenance is the path #2907's head-only fixtures missed: the
  // implementer's latest repair order came from the reviewer in this corner.
  const order = await createAgentCommand(db, { roomId: corner, agentId: worker, sourceMessageId: null,
    reason: 'order', privatePayload: { text: 'Repair this corner', authorId: reviewer, fromRoomId: corner, kind: 'order' } });
  await db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE id=$1`, [order.id]);
  const auth = new TokenAuth(db, async () => ({ subject: 'proof' }));
  const live = new LiveHub();
  server = createBeelineServer({ database: db, auth, phone: new PhoneService(db, 'http://proof'),
    daemon: new DaemonService(db, live), live, mediaMaximumBytes: 1024 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const tokens = new Map();
  for (const identity of [worker, reviewer]) {
    const exchange = await auth.createDaemonExchange(identity);
    tokens.set(identity, (await auth.exchangeDaemonToken(exchange.exchangeToken)).daemonToken);
  }
  const call = async (identity, name, input) => {
    const response = await fetch(`${origin}/v1/daemon/operations/${name}`, { method: 'POST',
      headers: { authorization: `Bearer ${tokens.get(identity)}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  const commands = async identity => (await call(identity, 'getAgentCommands', { roomId: corner })).commands;
  const finish = async (identity, command, text) => {
    await call(identity, 'claimAgentCommand', { roomId: corner, commandId: command.id, generationId: 'proof' });
    await call(identity, 'postAgentTurnReceipt', { roomId: corner, agentId: identity, requestId: command.turnRequestId, generationId: 'proof', status: 'working' });
    await call(identity, 'postRoomMessage', { roomId: corner, requestId: command.turnRequestId, generationId: 'proof', text });
  };
  const green = async headSha => {
    await db.query('UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1', [corner,
      JSON.stringify({ checks: 'passing', lifecycle: 'in-review', pr: { number: 81, headSha } })]);
    await systemLine(db, { roomId: corner, authorId: human, subject: { kind: 'github', name: 'GitHub' },
      verb: 'passed a check', kind: 'check-passed', object: { text: 'ci', headSha } });
  };
  await green('a'.repeat(40));
  await finish(reviewer, (await commands(reviewer))[0], 'FAIL: demonstrate the missing user path.');
  await reconcileConfiguredCornerReviewers(db, room);
  const repairs = (await commands(worker)).filter(c => c.reason === 'corner_review_needed');
  assert.equal(repairs.length, 1);
  assert.match(repairs[0].source.body, /FAIL: demonstrate the missing user path/);
  assert.equal((await commands(reviewer)).length, 0, 'unchanged findings must not return to reviewer');
  await finish(worker, repairs[0], 'Waiting for evidence before a new push.');
  await db.query('INSERT INTO corner_report_blockers(corner_id,person_id,return_room_id) VALUES($1,$2,$3)', [corner, human, room]);
  for (let cycle = 0; cycle < 3; cycle++) await reconcileConfiguredCornerReviewers(db, room);
  assert.equal((await commands(reviewer)).length, 0);
  assert.equal((await commands(worker)).length, 0);
  assert.equal((await db.query(`SELECT id FROM agent_commands WHERE room_id=$1 AND reason='corner_review_needed'`, [corner])).rowCount, 1);
  await green('b'.repeat(40));
  const next = await commands(reviewer);
  assert.equal(next.length, 1);
  assert.match(next[0].source.body, new RegExp('b'.repeat(40)));
  console.log('Demonstrated REVIEW-FAIL-HANDOFF-1: built HTTP service delivers FAIL findings to implementer once; no unchanged-target reviewer wake or false failure during wait; new head dispatches review.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await db.close();
  // PGlite's worker can outlive its closed database.
  process.exit(process.exitCode ?? 0);
}
