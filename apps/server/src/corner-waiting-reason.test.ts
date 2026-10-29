import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cornerBlockerSql, cornerRowState, chatCornerCounts } from './chat-corner-counts.js';

const db = new PGlite();
beforeAll(async () => {
  await db.exec(`CREATE TABLE rooms(id text,parent_id text);
    CREATE TABLE messages(id text,card_type text);
    CREATE TABLE memberships(room_id text,identity_id text,removed_at timestamp);
    CREATE TABLE effective_memberships(room_id text,identity_id text,removed_at timestamp);
    CREATE TABLE identities(id text,kind text,name text);
    CREATE TABLE corner_owed(corner_id text,message_id text,person_id text,created_at timestamp,blocking boolean,expires_at timestamp);
    CREATE TABLE corner_report_blockers(corner_id text,message_id text,report_id text,person_id text,created_at timestamp,commander_id text,return_room_id text);
    CREATE TABLE corner_merge_holds(corner_id text,id text,actor_id text,set_at timestamp,released_at timestamp);
    INSERT INTO rooms VALUES('corner','room');
    INSERT INTO memberships VALUES('room','person',NULL);`);
});
afterAll(() => db.close());

it.each([
  ['squire-approval', 'approve'], ['permission', 'approve'], ['grant-request', 'approve'],
  ['connector-offer', 'connect'], ['app-sign-in', 'connect'], ['agent-sign-in', 'connect'],
  ['choice', 'question'], ['needs-decision:', 'question'], ['blocked:', 'question'],
])('R1: projects %s as waiting to %s from the indexed blocker', async (kind, reason) => {
  await db.exec('DELETE FROM corner_owed; DELETE FROM messages;');
  await db.query('INSERT INTO messages VALUES($1,$2)', ['item', kind]);
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
    INSERT INTO messages VALUES('older','permission'),('newer','connector-offer');
    INSERT INTO corner_owed VALUES('corner','older','person','2026-01-01',true,NULL),
      ('corner','newer','person','2026-01-02',true,NULL);`);
  const result = await db.query(`SELECT blocker.* FROM rooms c ${cornerBlockerSql()}`);
  expect(result.rows[0]).toMatchObject({ item_id: 'older', reason: 'approve' });
});

it.each(['done:', 'failed:', 'unreachable', 'addressed message'])(
  'R1: %s alone stays idle even when owed', () => {
    expect(cornerRowState({ archived_at: null, lifecycle: null, latest_turn_status: null,
      blocking: false, owed: true })).toEqual({ state: 'idle' });
  },
);


it('R1: an agent-commander report is marked, and a human blocker stays visible beside it', async () => {
  await db.exec(`DELETE FROM corner_owed; DELETE FROM corner_report_blockers; DELETE FROM messages; DELETE FROM identities;
    INSERT INTO identities VALUES('agent','agent','Ruby'),('person','human','Lunchbox');
    INSERT INTO messages VALUES('ask','choice');
    INSERT INTO corner_report_blockers VALUES('corner',NULL,'report','agent','2026-01-01','agent','other');
    INSERT INTO corner_owed VALUES('corner','ask','person','2026-01-02',true,NULL);`);
  const oldest = (await db.query<{ item_id: string; agent_commander: boolean; human_blocker: boolean }>(
    `SELECT blocker.* FROM rooms c ${cornerBlockerSql()}`,
  )).rows[0]!;
  expect(oldest).toMatchObject({ item_id: 'report', agent_commander: true, human_blocker: true });
  await db.exec('DELETE FROM corner_owed');
  const only = (await db.query<{ item_id: string; agent_commander: boolean; human_blocker: boolean }>(
    `SELECT blocker.* FROM rooms c ${cornerBlockerSql()}`,
  )).rows[0]!;
  expect(only).toMatchObject({ item_id: 'report', agent_commander: true, human_blocker: false });
  const now = new Date();
  const pending = {
    archived_at: null, latest_turn_status: null, blocking: true, ci_started_at: now,
    waiting_item_id: only.item_id, waiting_reason: 'question' as const, waiting_kind: 'report' as const,
    lifecycle: { lifecycle: 'in-review', checks: 'pending' as const },
  };
  expect(cornerRowState({ ...pending, agent_commander: true, human_blocker: false }).state).toBe('review');
  expect(cornerRowState({ ...pending, agent_commander: true, human_blocker: true }).state).toBe('waiting');
  expect(cornerRowState({ ...pending, agent_commander: false, human_blocker: true }).state).toBe('waiting');
  expect(cornerRowState({
    ...pending, agent_commander: true, human_blocker: false,
    lifecycle: { lifecycle: 'working', checks: 'unknown' },
  }).state).toBe('waiting');
});

it('R1: holds and messageless reports resolve selection IDs to real source message targets', async () => {
  await db.exec(`DELETE FROM corner_owed; DELETE FROM messages;
    INSERT INTO identities VALUES('person','human','Lunchbox');
    INSERT INTO effective_memberships VALUES('corner','person',NULL);
    INSERT INTO corner_merge_holds VALUES('corner','hold','person','2026-01-01',NULL);
    INSERT INTO corner_report_blockers VALUES('corner',NULL,'report','person','2026-01-02','person','other');`);
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
  await db.exec("UPDATE corner_report_blockers SET corner_id='elsewhere'");
  const hold = await query();
  expect(hold.item_id).toBe('hold');
  expect(project(hold)).toEqual({ state: 'waiting', reason: 'approve',
    itemId: createHash('sha256').update('corner-hold:hold').digest('hex'), blocker: { kind: 'merge-hold', personId: 'person', personName: 'Lunchbox' } });
  await db.exec("UPDATE corner_report_blockers SET corner_id='corner'");
  const newest = await query(true);
  expect(newest.item_id).toBe('report');
  expect(project(newest)).toEqual({ state: 'waiting', reason: 'question',
    itemId: createHash('sha256').update('agent-command-card:report').digest('hex'), blocker: { kind: 'report', personId: 'person', personName: 'Lunchbox' } });
  await db.exec("UPDATE corner_report_blockers SET message_id='real-message',return_room_id='corner'");
  expect(project(await query(true))).toMatchObject({ itemId: 'real-message', blocker: { kind: 'message' } });
});

it('Reproduction R1: a lone merge hold shows review while checks run and waits once they pass', async () => {
  await db.exec(`DELETE FROM corner_owed; DELETE FROM corner_report_blockers; DELETE FROM corner_merge_holds;
    DELETE FROM messages; DELETE FROM identities;
    INSERT INTO identities VALUES('agent','agent','Ruby'),('person','human','Lunchbox');
    INSERT INTO corner_merge_holds VALUES('corner','hold','person','2026-01-01',NULL);`);
  type Blocker = {
    item_id: string; kind: 'message' | 'merge-hold' | 'report'; reason: 'approve' | 'question';
    person_id: string; person_name: string; agent_commander: boolean; human_blocker: boolean;
  };
  const query = async () =>
    (await db.query<Blocker>(`SELECT blocker.* FROM rooms c ${cornerBlockerSql()}`)).rows[0]!;
  const project = (blocker: Blocker, lifecycle: NonNullable<Parameters<typeof cornerRowState>[0]['lifecycle']>) =>
    cornerRowState({
      archived_at: null, latest_turn_status: null, blocking: true, lifecycle,
      waiting_item_id: blocker.item_id, waiting_reason: blocker.reason, waiting_kind: blocker.kind,
      waiting_person_id: blocker.person_id, waiting_person_name: blocker.person_name,
      agent_commander: blocker.agent_commander, human_blocker: blocker.human_blocker,
    });
  const pr = { number: 1, url: 'https://github.com/o/r/pull/1', title: 'Fix', targetBranch: 'main', headSha: '2'.repeat(40) };
  const pending = { lifecycle: 'in-review' as const, checks: 'pending' as const, pr };
  const unreported = { lifecycle: 'in-review' as const, checks: 'unknown' as const, pr,
    checksSummary: { status: 'unknown' as const, total: 0, failing: [], checks: [], updatedAt: 1 } };
  const passing = { lifecycle: 'in-review' as const, checks: 'passing' as const, pr };

  const hold = await query();
  expect(hold).toMatchObject({ item_id: 'hold', kind: 'merge-hold', human_blocker: false });
  expect(project(hold, pending).state).toBe('review');
  expect(project(hold, unreported).state).toBe('review');
  expect(project(hold, passing)).toEqual({ state: 'waiting', reason: 'approve',
    itemId: createHash('sha256').update('corner-hold:hold').digest('hex'),
    blocker: { kind: 'merge-hold', personId: 'person', personName: 'Lunchbox' } });

  // A later agent-commander report still defers to pending checks beside a hold.
  await db.exec("INSERT INTO corner_report_blockers VALUES('corner',NULL,'report','agent','2026-01-02','agent','other')");
  const report = await query();
  expect(report).toMatchObject({ item_id: 'report', agent_commander: true, human_blocker: false });
  expect(project(report, pending).state).toBe('review');

  // A later human question is not shadowed by the older hold.
  await db.exec(`DELETE FROM corner_report_blockers; INSERT INTO messages VALUES('ask','choice');
    INSERT INTO corner_owed VALUES('corner','ask','person','2026-01-03',true,NULL);`);
  const question = await query();
  expect(question).toMatchObject({ item_id: 'ask', kind: 'message', human_blocker: true });
  expect(project(question, pending)).toEqual({ state: 'waiting', reason: 'question', itemId: 'ask',
    blocker: { kind: 'message', personId: 'person', personName: 'Lunchbox' } });
});
