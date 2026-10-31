/** Isolated built HTTP proof for REVIEW-RECOVERY-DEADLOCK; no production writes. */
import assert from 'node:assert/strict';
import { migrate } from '../apps/server/dist/database.js';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { TokenAuth } from '../apps/server/dist/auth.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { createBeelineServer } from '../apps/server/dist/server.js';
import { systemLine } from '../apps/server/dist/system-line.js';
import { workflowRunLockKey } from '../apps/server/dist/workflow-runs.js';

const human = 'a'.repeat(64), worker = 'b'.repeat(64), reviewer = 'c'.repeat(64), fallback = 'd'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const corner = '33333333-3333-4333-8333-333333333333';
const db = new PgliteDatabase();
let server;
try {
  await migrate(db);
  for (const [id, name, kind] of [[human, 'Human', 'human'], [worker, 'Worker', 'agent'],
    [reviewer, 'Reviewer', 'agent'], [fallback, 'Fallback', 'agent']]) {
    await db.query('INSERT INTO identities(id,kind,name,handle) VALUES($1,$2,$3,$4)', [id, kind, name, name.toLowerCase()]);
    if (kind === 'agent') await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [id, human]);
  }
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Proof')", [workspace]);
  await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Room'),($2,$3,'Corner')", [room, corner, workspace]);
  await db.query("UPDATE rooms SET repository_key='owner/repo',repository_resolution='repository',reviewer_agent_id=$2,reviewer_fallback_ids=$3 WHERE id=$1", [room, reviewer, [fallback]]);
  await db.query('UPDATE rooms SET parent_id=$2,created_by=$3 WHERE id=$1', [corner, room, worker]);
  await db.query("INSERT INTO corner_facts(corner_id,owner_agent_id,worker_agent_id,objective,lifecycle) VALUES($1,$2,$2,'Proof',$3::jsonb)",
    [corner, worker, JSON.stringify({ checks: 'passing', lifecycle: 'in-review', pr: { number: 7, headSha: 'a'.repeat(40) } })]);
  for (const id of [human, worker, reviewer, fallback]) for (const place of [null, room])
    await db.query("INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')", [workspace, place, id]);
  for (const id of [reviewer, fallback]) await db.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
    VALUES($1,$2,'presence','presence','{"status":"online"}')`, [room, id]);
  await systemLine(db, { roomId: corner, authorId: human, subject: { kind: 'github', name: 'GitHub' }, verb: 'passed a check', kind: 'check-passed' });
  const auth = new TokenAuth(db, async () => ({ subject: 'proof' }));
  const live = new LiveHub();
  server = createBeelineServer({ database: db, auth, phone: new PhoneService(db, 'http://proof'),
    daemon: new DaemonService(db, live), live, mediaMaximumBytes: 1024 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const tokens = new Map();
  for (const id of [reviewer, fallback]) {
    const exchange = await auth.createDaemonExchange(id);
    tokens.set(id, (await auth.exchangeDaemonToken(exchange.exchangeToken)).daemonToken);
  }
  const call = async (id, name, input, expectedStatus = 200) => {
    const response = await fetch(`${origin}/v1/daemon/operations/${name}`, { method: 'POST',
      headers: { authorization: `Bearer ${tokens.get(id)}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    const body = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(body));
    return body;
  };
  const commands = async id => (await call(id, 'getAgentCommands', { roomId: corner })).commands;
  const [review] = await commands(reviewer);
  assert.ok(review);
  await call(reviewer, 'claimAgentCommand', { roomId: corner, commandId: review.id, generationId: 'proof' });
  const receipt = { roomId: corner, requestId: review.turnRequestId, generationId: 'proof', status: 'working' };
  await call(reviewer, 'postAgentTurnReceipt', receipt);
  const original = db.transaction.bind(db);
  let failures = 0;
  db.transaction = work => original(async tx => {
    const wrapped = {
      query: async (sql, values) => {
        if (!failures && sql.includes('pg_advisory_xact_lock') && values?.[0] === workflowRunLockKey(corner)) {
          failures++;
          throw Object.assign(new Error('isolated deadlock injection'), { code: '40P01' });
        }
        return tx.query(sql, values);
      },
      transaction: async nested => nested(wrapped),
    };
    return work(wrapped);
  });
  const failed = { ...receipt, status: 'failed', reasonKind: 'wrong-model', reason: 'the selected model is no longer available' };
  await call(reviewer, 'postAgentTurnReceipt', failed);
  assert.equal(failures, 1);
  assert.equal((await commands(fallback)).length, 1);
  // The old failed command has spent its output authority; a replay stays refused.
  await call(reviewer, 'postAgentTurnReceipt', failed, 403);
  assert.equal((await commands(fallback)).length, 1);
  console.log('Demonstrated REVIEW-RECOVERY-DEADLOCK: built HTTP failed receipt returns 200 after deadlock rollback; fallback receives one review; replay creates no duplicate.');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await db.close();
}
