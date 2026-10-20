/** Reproduction SR-1: isolated service path, with no production check delivery. */
import assert from 'node:assert/strict';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { systemLine } from '../apps/server/dist/system-line.js';

const human = 'a'.repeat(64), worker = 'b'.repeat(64), fallback = 'c'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const corner = '33333333-3333-4333-8333-333333333333';
const db = new PgliteDatabase();
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Builder','builder'),($3,'agent','Reviewer','reviewer')`, [human, worker, fallback]);
  const usage = { updatedAt: 1000, plan: 'pro', windows: [{ rateLimitType: 'weekly', utilization: 0.25, status: 'allowed', updatedAt: 1000 }] };
  await db.query(`INSERT INTO agents(agent_id,owner_id,selected_model,usage_snapshot) VALUES
    ($1,$3,'test-model',$4::jsonb),($2,$3,'test-model',NULL)`, [worker, fallback, human, JSON.stringify(usage)]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Room'),($2,$3,'Corner')`, [room, corner, workspace]);
  await db.query(`UPDATE rooms SET parent_id=$1,created_by=$3 WHERE id=$2`, [room, corner, worker]);
  await db.query(`INSERT INTO corner_facts(corner_id,owner_agent_id,objective,lifecycle) VALUES($1,$2,'Proof',$3::jsonb)`, [corner, worker, JSON.stringify({ lifecycle: 'in-review', checks: 'passing', pr: { number: 1, headSha: '1'.repeat(40), url: 'https://github.com/example/proof/pull/1' } })]);
  for (const who of [human, worker, fallback]) {
    for (const address of [null, room]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`, [workspace, address, who]);
    if (who !== human) await db.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online","held":true}')`, [room, who]);
  }
  const phone = new PhoneService(db, 'http://test');
  const daemon = new DaemonService(db, new LiveHub());
  const commands = async who => (await daemon.execute('getAgentCommands', { roomId: corner }, who)).commands;
  const reviews = async who => (await commands(who)).filter(c => ['subscribed_event', 'corner_review_dispatch'].includes(c.reason));
  await phone.execute('updateRoom', { roomId: room, reviewerAgentId: worker, reviewerFallbackIds: [] }, human);
  await systemLine(db, { roomId: corner, authorId: human, subject: { kind: 'github', name: 'GitHub' }, verb: 'passed a check', kind: 'check-passed' });
  console.log(`SR-1 sole reviewer: implementer review commands=${(await reviews(worker)).length}`);
  assert.equal((await reviews(worker)).length, 0);
  const handback = (await commands(worker)).find(c => c.reason === 'corner_review_needed');
  assert.ok(handback, 'existing review handback must reach the implementer');
  console.log('SR-1 sole reviewer: existing handback delivered');
  await phone.execute('updateRoom', { roomId: room, reviewerAgentId: worker, reviewerFallbackIds: ['', fallback] }, human);
  await systemLine(db, { roomId: corner, authorId: human, subject: { kind: 'github', name: 'GitHub' }, verb: 'passed a check', kind: 'check-passed' });
  assert.equal((await reviews(worker)).length, 0);
  assert.ok((await reviews(fallback)).length > 0, 'healthy fallback receives review');
  console.log('SR-1 fallback: review delivered to fallback; no self-review');
  const roster = await daemon.execute('listRoomMembers', { roomId: corner }, worker);
  const builder = roster.members.find(m => m.id === worker);
  assert.equal(builder.model, 'test-model');
  assert.equal(builder.billing, 'subscription');
  assert.equal(builder.reviewer, 'primary');
  assert.equal(builder.remainingAllowance.windows[0].remaining, 0.75);
  assert.equal(roster.members.find(m => m.id === fallback).reviewer, 'fallback');
  assert.equal(roster.members.find(m => m.id === fallback).remainingAllowance, undefined);
  const stored = await db.query(`SELECT reviewer_fallback_ids FROM rooms WHERE id=$1`, [room]);
  assert.deepEqual(stored.rows[0].reviewer_fallback_ids, [fallback]);
  console.log('SR-1 members: model, billing, remaining allowance and reviewer roles returned; unknown allowance absent; empty fallback removed');
} finally {
  await db.close();
}
