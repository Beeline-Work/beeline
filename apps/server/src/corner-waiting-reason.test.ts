import { cornerWaitingReportSql } from './corner-waiting-report.js';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cornerBlockerSql, cornerRowState, chatCornerCounts } from './chat-corner-counts.js';

const db = new PGlite();
beforeAll(async () => {
  await db.exec(`CREATE TABLE rooms(id text,parent_id text,created_by text);
    CREATE TABLE corner_facts(corner_id text,worker_agent_id text,owner_agent_id text);
    CREATE TABLE agent_commands(id text,room_id text,agent_id text,private_payload jsonb,created_at timestamp);
    CREATE TABLE messages(id text,card_type text,room_id text,author_id text,text text,card jsonb,presentation text,system_event jsonb,deleted_at timestamp,request_id text,created_at timestamp);
    CREATE TABLE memberships(room_id text,identity_id text,removed_at timestamp);
    CREATE TABLE room_access(room_id text,identity_id text,removed_at timestamp);
    CREATE TABLE identities(id text,kind text,name text,handle text);
    CREATE TABLE corner_owed(corner_id text,message_id text,person_id text,created_at timestamp,blocking boolean,expires_at timestamp);
    CREATE TABLE corner_merge_holds(corner_id text,id text,actor_id text,set_at timestamp,released_at timestamp);
    INSERT INTO rooms VALUES('corner','room','worker');
    INSERT INTO corner_facts VALUES('corner','worker','worker');
    INSERT INTO memberships VALUES('room','person',NULL);`);
});
afterAll(() => db.close());

async function reportCard(reportId = 'report') {
  await db.query(`INSERT INTO messages(id,card_type,room_id,presentation,card)
    VALUES($1,'agent-command','corner','card','{"kind":"report"}')`,
    [createHash('sha256').update(`agent-command-card:${reportId}`).digest('hex')]);
}


it.each([
  ['squire-approval', 'approve'], ['permission', 'approve'], ['grant-request', 'approve'],
  ['connector-offer', 'connect'], ['app-sign-in', 'connect'], ['agent-sign-in', 'connect'],
  ['choice', 'question'], ['needs-decision:', 'question'], ['blocked:', 'question'],
])('R1: projects %s as waiting to %s from the indexed blocker', async (kind, reason) => {
  await db.exec('DELETE FROM corner_owed; DELETE FROM messages;');
  await db.query('INSERT INTO messages(id,card_type) VALUES($1,$2)', ['item', kind]);
  await db.exec("INSERT INTO corner_owed VALUES('corner','item','person',now(),true,NULL)");
  const result = await db.query<{ item_id: string; reason: 'approve' | 'connect' | 'question' }>(
    `SELECT blocker.* FROM rooms c ${cornerBlockerSql()}`,
  );
  const blocker = result.rows[0]!;
  const row = { id: 'corner', name: 'Corner', parent_id: 'room', archived_at: null,
    lifecycle: null, latest_turn_status: null, blocking: true,
    waiting_item_id: blocker.item_id, waiting_reason: blocker.reason };
  expect(cornerRowState(row)).toEqual({ state: 'waiting', reason, itemId: 'item' });
  expect(chatCornerCounts([row]).get('room')?.openCorners[0]?.state).toBe('waiting');
});

it('R1: chooses the oldest blocker deterministically', async () => {
  await db.exec(`DELETE FROM corner_owed; DELETE FROM messages;
    INSERT INTO messages(id,card_type) VALUES('older','permission'),('newer','connector-offer');
    INSERT INTO corner_owed VALUES('corner','older','person','2026-01-01',true,NULL),
      ('corner','newer','person','2026-01-02',true,NULL);`);
  const result = await db.query(`SELECT blocker.* FROM rooms c ${cornerBlockerSql()}`);
  expect(result.rows[0]).toMatchObject({ item_id: 'older', reason: 'approve' });
});

it.each(['done:', 'failed:', 'unreachable', 'addressed message'])(
  'R1: %s alone stays idle even when owed', () => {
    expect(cornerRowState({ archived_at: null, lifecycle: null, latest_turn_status: null,
      blocking: false })).toEqual({ state: 'idle' });
  },
);


it('R1: an agent-commander report retains selection when a human blocker is also open', async () => {
  await db.exec(`DELETE FROM corner_owed; DELETE FROM agent_commands; DELETE FROM messages; DELETE FROM identities;
    INSERT INTO identities(id,kind,name) VALUES('agent','agent','Ruby'),('person','human','Lunchbox');
    INSERT INTO messages(id,card_type) VALUES('ask','choice');
    INSERT INTO agent_commands VALUES('report','other','agent','{"kind":"report","fromRoomId":"corner","authorId":"worker","text":"blocked: choose"}','2026-01-01');
    INSERT INTO corner_owed VALUES('corner','ask','person','2026-01-02',true,NULL);`);
  await reportCard();
  const oldest = (await db.query<{ item_id: string }>(
    `SELECT blocker.* FROM rooms c ${cornerBlockerSql()}`,
  )).rows[0]!;
  expect(oldest).toMatchObject({ item_id: 'report' });
  await db.exec('DELETE FROM corner_owed');
  const only = (await db.query<{ item_id: string }>(
    `SELECT blocker.* FROM rooms c ${cornerBlockerSql()}`,
  )).rows[0]!;
  expect(only).toMatchObject({ item_id: 'report' });
  const pending = {
    archived_at: null, latest_turn_status: null, blocking: true,
    waiting_item_id: only.item_id, waiting_reason: 'question' as const, waiting_kind: 'report' as const,
    lifecycle: { lifecycle: 'in-review', checks: 'pending' as const },
  };
  expect(cornerRowState({ ...pending }).state).toBe('review');
  expect(cornerRowState({
    ...pending,
    lifecycle: { lifecycle: 'working', checks: 'unknown' },
  }).state).toBe('waiting');
});

it('R1: holds and messageless reports resolve selection IDs to real source message targets', async () => {
  await db.exec(`DELETE FROM corner_owed; DELETE FROM messages;
    INSERT INTO identities(id,kind,name) VALUES('person','human','Lunchbox');
    INSERT INTO room_access VALUES('corner','person',NULL);
    INSERT INTO corner_merge_holds VALUES('corner','hold','person','2026-01-01',NULL);
    DELETE FROM agent_commands;
    INSERT INTO agent_commands VALUES('report','other','person','{"kind":"report","fromRoomId":"corner","authorId":"worker","text":"blocked: choose"}','2026-01-02');`);
  await reportCard();
  const query = async (newest = false) => (await db.query<{
    item_id: string; kind: 'message' | 'merge-hold' | 'report'; person_name: string;
    person_id: string; reason: 'approve' | 'question';
  }>(`SELECT blocker.* FROM rooms c ${cornerBlockerSql('true', newest)}`)).rows[0]!;
  const project = (blocker: Awaited<ReturnType<typeof query>>) => cornerRowState({
    archived_at: null, lifecycle: null, latest_turn_status: null, blocking: true,
    waiting_item_id: blocker.item_id, waiting_reason: blocker.reason,
    waiting_kind: blocker.kind, waiting_person_id: blocker.person_id,
    waiting_person_name: blocker.person_name,
  });
  // The older hold ranks behind the report; it is selected once nothing else is open.
  expect((await query()).item_id).toBe('report');
  await db.exec("UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{fromRoomId}','\"elsewhere\"')");
  const hold = await query();
  expect(hold.item_id).toBe('hold');
  expect(project(hold)).toEqual({ state: 'waiting', reason: 'approve',
    itemId: createHash('sha256').update('corner-hold:hold').digest('hex'), blocker: { kind: 'merge-hold', personId: 'person', personName: 'Lunchbox' } });
  await db.exec("UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{fromRoomId}','\"corner\"')");
  const newest = await query(true);
  expect(newest.item_id).toBe('report');
  expect(project(newest)).toEqual({ state: 'waiting', reason: 'question',
    itemId: createHash('sha256').update('agent-command-card:report').digest('hex'), blocker: { kind: 'report', personId: 'person', personName: 'Lunchbox' } });
  await db.exec(`DELETE FROM agent_commands;
    INSERT INTO messages(id,room_id,author_id,text,card,presentation,created_at)
    VALUES('real-message','corner','worker','blocked: choose','{"reportToId":"person"}','message','2026-01-02')`);
  expect(project(await query(true))).toMatchObject({ itemId: 'real-message', blocker: { kind: 'message' } });
});

it('Reproduction R1: a lone merge hold shows review while checks run and waits once they pass', async () => {
  await db.exec(`DELETE FROM corner_owed; DELETE FROM agent_commands; DELETE FROM corner_merge_holds;
    DELETE FROM messages; DELETE FROM identities;
    INSERT INTO identities(id,kind,name) VALUES('agent','agent','Ruby'),('person','human','Lunchbox');
    INSERT INTO corner_merge_holds VALUES('corner','hold','person','2026-01-01',NULL);`);
  type Blocker = {
    item_id: string; kind: 'message' | 'merge-hold' | 'report'; reason: 'approve' | 'question';
    person_id: string; person_name: string;
  };
  const query = async () =>
    (await db.query<Blocker>(`SELECT blocker.* FROM rooms c ${cornerBlockerSql()}`)).rows[0]!;
  const project = (blocker: Blocker, lifecycle: NonNullable<Parameters<typeof cornerRowState>[0]['lifecycle']>) =>
    cornerRowState({
      archived_at: null, latest_turn_status: null, blocking: true, lifecycle,
      waiting_item_id: blocker.item_id, waiting_reason: blocker.reason, waiting_kind: blocker.kind,
      waiting_person_id: blocker.person_id, waiting_person_name: blocker.person_name,
    });
  const pr = { number: 1, url: 'https://github.com/o/r/pull/1', title: 'Fix', targetBranch: 'main', headSha: '2'.repeat(40) };
  const pending = { lifecycle: 'in-review' as const, checks: 'pending' as const, pr };
  const unreported = { lifecycle: 'in-review' as const, checks: 'unknown' as const, pr,
    checksSummary: { status: 'unknown' as const, total: 0, failing: [], checks: [], updatedAt: 1 } };
  const passing = { lifecycle: 'in-review' as const, checks: 'passing' as const, pr };

  const hold = await query();
  expect(hold).toMatchObject({ item_id: 'hold', kind: 'merge-hold' });
  expect(project(hold, pending).state).toBe('review');
  expect(project(hold, unreported).state).toBe('review');
  expect(project(hold, passing)).toEqual({ state: 'waiting', reason: 'approve',
    itemId: createHash('sha256').update('corner-hold:hold').digest('hex'),
    blocker: { kind: 'merge-hold', personId: 'person', personName: 'Lunchbox' } });

  // A later agent-commander report still defers to pending checks beside a hold.
  await db.exec(`INSERT INTO agent_commands VALUES('report','other','agent','{"kind":"report","fromRoomId":"corner","authorId":"worker","text":"blocked: choose"}','2026-01-02')`);
  await reportCard();
  const report = await query();
  expect(report).toMatchObject({ item_id: 'report' });
  expect(project(report, pending).state).toBe('review');

  // A later human question is not shadowed by the older hold.
  await db.exec(`DELETE FROM agent_commands; INSERT INTO messages(id,card_type) VALUES('ask','choice');
    INSERT INTO corner_owed VALUES('corner','ask','person','2026-01-03',true,NULL);`);
  const question = await query();
  expect(question).toMatchObject({ item_id: 'ask', kind: 'message' });
  expect(project(question, pending)).toEqual({ state: 'review' });
});


it('REPORT-WAITING-DERIVED: derives only the worker wait and its commander/tagged human audience', async () => {
  await db.exec(`DELETE FROM corner_owed; DELETE FROM agent_commands; DELETE FROM messages;
    DELETE FROM identities; DELETE FROM memberships; DELETE FROM room_access; DELETE FROM corner_merge_holds;
    INSERT INTO identities(id,kind,name,handle) VALUES('commander','agent','Commander','commander'),
      ('tagged','human','Tagged','tagged'),('other','human','Other','other'),('worker','agent','Worker','worker');
    INSERT INTO room_access VALUES('corner','tagged',NULL),('corner','other',NULL);
    INSERT INTO memberships VALUES('room','tagged',NULL),('room','other',NULL);
    INSERT INTO agent_commands VALUES('worker-wait','other','commander',
      '{"kind":"report","fromRoomId":"corner","authorId":"worker","text":"blocked: @tagged choose"}','2026-01-01'),
      ('other-wait','other','other','{"kind":"report","fromRoomId":"corner","authorId":"other","text":"blocked: unrelated"}','2026-01-02'),
      ('done','other','commander','{"kind":"report","fromRoomId":"corner","authorId":"worker","text":"done: update"}','2026-01-03');`);
  await reportCard('worker-wait');
  await reportCard('other-wait');
  const waiting = () => db.query<{ report_id: string; person_id: string }>(
    `SELECT waiting.* FROM rooms c CROSS JOIN LATERAL (${cornerWaitingReportSql('c')}) waiting ORDER BY person_id`);
  expect((await waiting()).rows.map(row => [row.report_id,row.person_id]))
    .toEqual([['worker-wait','commander'],['worker-wait','tagged']]);
  // A newest answered wait never uncovers an older unanswered report.
  await db.exec(`INSERT INTO agent_commands VALUES('answered','other','commander',
    '{"kind":"report","fromRoomId":"corner","authorId":"worker","text":"needs-decision: choose","waitingAnswered":true}','2026-01-04');`);
  await reportCard('answered');
  expect((await waiting()).rows).toHaveLength(0);
  // All readers share the same implementer fallback, including the opener.
  await db.exec(`DELETE FROM agent_commands WHERE id='answered';
    UPDATE corner_facts SET worker_agent_id=NULL,owner_agent_id=NULL;`);
  expect((await waiting()).rows.map(row => row.person_id)).toEqual(['commander','tagged']);
});


it('REPORT-WAITING-DERIVED: automatic blocked final prose does not create an explicit wait', async () => {
  await db.exec(`DELETE FROM agent_commands; DELETE FROM messages;
    INSERT INTO agent_commands VALUES('automatic','other','commander',
      '{"kind":"report","fromRoomId":"corner","authorId":"worker","text":"blocked: progress note"}',now());`);
  const waiting = () => db.query(`SELECT waiting.* FROM rooms c CROSS JOIN LATERAL (${cornerWaitingReportSql('c')}) waiting`);
  expect((await waiting()).rows).toHaveLength(0);
  await reportCard('automatic');
  expect((await waiting()).rows).toHaveLength(1);
});
