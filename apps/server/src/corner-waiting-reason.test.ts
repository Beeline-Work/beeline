import type { CornerLifecycleView } from '@beeline/api-contract/phone';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { cornerBlockerSql, cornerRowState, chatCornerCounts } from './chat-corner-counts.js';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';

const C = '33333333-3333-4333-8333-333333333333', ROOM = '22222222-2222-4222-8222-222222222222';
const PERSON = 'a'.repeat(64), AGENT = 'b'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111';
let db: PgliteDatabase;
beforeAll(async () => {
  db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ('${PERSON}','human','Lunchbox','person'),('${AGENT}','agent','Ruby','ruby')`);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES('${AGENT}','${PERSON}')`);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Waiting')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,parent_id,created_by) VALUES($1,$3,'Room',NULL,NULL),($2,$3,'Corner',$1,'${AGENT}')`, [ROOM, C, W]);
  await db.query(`INSERT INTO corner_facts(corner_id,lifecycle) VALUES($1,'{}')`, [C]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,'${PERSON}','owner')`, [W, ROOM]);
});
afterAll(async () => db.close());
beforeEach(async () => {
  await db.query('DELETE FROM agent_commands');
  await db.query('DELETE FROM corner_merge_holds');
  await db.query('DELETE FROM messages');
  await db.query('DELETE FROM agent_grants');
  await db.query('DELETE FROM permission_authority');
});

async function ask(id: string, kind: string, at = 'now()') {
  let card: object = {};
  if (kind === 'choice')
    card = { mode: 'question', status: 'open', requester: { pubkey: PERSON } };
  if (kind === 'permission') {
    await db.query(`INSERT INTO permission_authority(permission_id,room_id,principal_id,request_id,scope,status)
      VALUES($1,$2,'${PERSON}','request','{}','pending')`, [id, C]);
    card = { permissionId: id };
  }
  if (kind === 'grant-request') {
    const grant = '99999999-9999-4999-8999-999999999999';
    await db.query(`INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status)
      VALUES($1,'${AGENT}',$2,'host','example.com','docs','${AGENT}',$3,'pending')`, [grant, W, C]);
    card = { grants: [{ grantId: grant }] };
  }
  if (kind === 'connector-offer')
    card = { status: 'pending', addressee: { pubkey: PERSON } };
  if (kind === 'app-sign-in' || kind === 'agent-sign-in')
    card = { status: 'pending', ownerId: PERSON };
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,created_at)
    VALUES($1,$2,'${AGENT}',$3,$6,$4,$5::jsonb,${at})`, [id, C, `${kind} @person choose`, kind, JSON.stringify(card), kind.endsWith(':') ? 'message' : 'card']);
}
const query = async (newest = false) => (await db.query<{
  item_id: string;
  kind: 'message' | 'merge-hold' | 'report';
  person_name: string;
  person_id: string;
  reason: 'approve' | 'question' | 'connect';
}>(`SELECT blocker.* FROM rooms c ${cornerBlockerSql('true', newest)} WHERE c.id=$1`, [C])).rows[0]!;
const project = (blocker: Awaited<ReturnType<typeof query>>, lifecycle: CornerLifecycleView | null = null) => cornerRowState({
  archived_at: null, lifecycle, latest_turn_status: null, blocking: true,
  waiting_item_id: blocker.item_id, waiting_reason: blocker.reason, waiting_kind: blocker.kind,
  waiting_person_id: blocker.person_id, waiting_person_name: blocker.person_name,
});

it.each([
  ['squire-approval', 'approve'], ['permission', 'approve'], ['grant-request', 'approve'],
  ['connector-offer', 'connect'], ['app-sign-in', 'connect'], ['agent-sign-in', 'connect'],
  ['choice', 'question'], ['needs-decision:', 'question'], ['blocked:', 'question'],
])('OWED-DERIVED: projects %s as waiting to %s from messages', async (kind, reason) => {
  await ask('item', kind);
  const blocker = await query();
  expect(project(blocker)).toMatchObject({ state: 'waiting', reason, itemId: 'item' });
  expect(chatCornerCounts([{ id: C, name: 'Corner', parent_id: ROOM, archived_at: null, lifecycle: null,
      latest_turn_status: null, blocking: true, waiting_item_id: blocker.item_id, waiting_reason: blocker.reason }])
    .get(ROOM)?.openCorners[0]?.state).toBe('waiting');
  expect((await db.query('SELECT * FROM corner_owed')).rows).toEqual([]);
});

it('R1: chooses the oldest blocker deterministically', async () => {
  await ask('older', 'choice', "now()-interval '2 days'");
  await ask('newer', 'connector-offer', "now()-interval '1 day'");
  expect(await query()).toMatchObject({ item_id: 'older', reason: 'question' });
});

it.each(['done:', 'failed:', 'unreachable', 'addressed message'])('R1: %s alone stays idle even when owed', () => {
  expect(cornerRowState({ archived_at: null, lifecycle: null, latest_turn_status: null, blocking: false })).toEqual({ state: 'idle' });
});

/** A worker's explicit `blocked:` report to `person`, sent from the corner to the parent Room. */
async function report(person = AGENT) {
  await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,root_command_id,
      root_source_message_id,agent_depth,state,completed_at,private_payload,created_at)
    VALUES('report',$1,$2,'report','input','report','report','report',0,'complete',now(),$3::jsonb,now()-interval '3 days')`,
  [ROOM, person, JSON.stringify({ kind: 'report', text: 'blocked: choose', fromRoomId: C, authorId: AGENT })]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
    VALUES($1,$2,'${AGENT}','Report','card','agent-command','{"kind":"report"}')`,
  [createHash('sha256').update('agent-command-card:report').digest('hex'), ROOM]);
}
it('R1: an agent commander report retains selection when a human blocker is open', async () => {
  await report();
  await ask('ask', 'choice');
  expect(await query()).toMatchObject({ item_id: 'report', kind: 'report' });
  await db.query("DELETE FROM messages WHERE id='ask'");
  const only = await query();
  expect(project(only, { lifecycle: 'in-review', checks: 'pending' }).state).toBe('review');
  expect(project(only, { lifecycle: 'working', checks: 'unknown' }).state).toBe('waiting');
});

it('R1: holds and reports resolve selection IDs to real source message targets', async () => {
  await report(PERSON);
  await db.query(`INSERT INTO corner_merge_holds(corner_id,actor_id,standing,set_at)
    VALUES($1,'${PERSON}','owner',now()-interval '4 days')`, [C]);
  expect((await query()).item_id).toBe('report');
  await db.query('DELETE FROM agent_commands');
  const hold = await query();
  expect(project(hold)).toMatchObject({ state: 'waiting', reason: 'approve',
    itemId: createHash('sha256').update(`corner-hold:${hold.item_id}`).digest('hex'),
    blocker: { kind: 'merge-hold', personId: PERSON, personName: 'Lunchbox' } });
  await db.query('DELETE FROM messages');
  await db.query('DELETE FROM agent_commands');
  await report(PERSON);
  expect(project(await query(true))).toMatchObject({
    itemId: createHash('sha256').update('agent-command-card:report').digest('hex'), blocker: { kind: 'report' }
  });
  await db.query('DELETE FROM agent_commands');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,card,presentation)
    VALUES('real-message',$1,'${AGENT}','blocked: choose','{"reportToId":"${PERSON}"}','message')`, [C]);
  expect(project(await query(true))).toMatchObject({ itemId: 'real-message', blocker: { kind: 'message' } });
});

it('Reproduction R1: pending CI precedes holds, reports and human questions', async () => {
  await db.query(`INSERT INTO corner_merge_holds(corner_id,actor_id,standing) VALUES($1,'${PERSON}','owner')`, [C]);
  const pr = { number: 1, url: 'https://github.com/o/r/pull/1', title: 'Fix', targetBranch: 'main', headSha: '2'.repeat(40) };
  const pending: CornerLifecycleView = { lifecycle: 'in-review', checks: 'pending', pr };
  const unreported: CornerLifecycleView = { lifecycle: 'in-review', checks: 'unknown', pr,
    checksSummary: { status: 'unknown', total: 0, failing: [], checks: [], updatedAt: 1 } };
  const hold = await query();
  expect(project(hold, pending).state).toBe('review');
  expect(project(hold, unreported).state).toBe('review');
  expect(project(hold, { lifecycle: 'in-review', checks: 'passing', pr }).state).toBe('waiting');
  await report();
  expect(project(await query(), pending).state).toBe('review');
  await db.query('DELETE FROM agent_commands');
  await ask('ask', 'choice');
  expect(await query()).toMatchObject({ item_id: 'ask', kind: 'message' });
  expect(project(await query(), pending)).toEqual({ state: 'review' });
});
