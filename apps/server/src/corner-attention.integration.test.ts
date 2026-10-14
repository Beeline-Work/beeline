import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import { createAgentCommand, readAgentCommands } from './agent-command.js';
import {
  recordCornerAttention,
  deliverCornerAttention,
  runCornerAttention,
} from './corner-attention.js';

const WS = '11111111-1111-4111-8111-111111111111',
  ROOM = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const HUMAN = 'a'.repeat(64),
  COMMANDER = 'b'.repeat(64),
  WORKER = 'c'.repeat(64),
  REVIEWER = 'd'.repeat(64);
let db: PgliteDatabase, daemon: DaemonService, phone: PhoneService;
beforeAll(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Commander','commander'),
    ($3,'agent','Worker','worker'),($4,'agent','Reviewer','reviewer')`,
    [HUMAN, COMMANDER, WORKER, REVIEWER],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$4),($2,$4),($3,$4)`, [
    COMMANDER,
    WORKER,
    REVIEWER,
    HUMAN,
  ]);
  daemon = new DaemonService(db, new LiveHub());
  phone = new PhoneService(db, 'http://test');
}, 30_000);
afterAll(async () => db.close());
beforeEach(async () => {
  await db.query('DELETE FROM workspaces');
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Truthful states')`, [WS]);
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,created_by,reviewer_agent_id) VALUES($1,$2,'Room',$3,$4)`,
    [ROOM, WS, HUMAN, REVIEWER],
  );
  for (const identity of [HUMAN, COMMANDER, WORKER, REVIEWER])
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`,
      [WS, identity, ROOM],
    );
  await db.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'Corner',$4)`,
    [C, WS, ROOM, COMMANDER],
  );
  for (const identity of [HUMAN, COMMANDER, WORKER, REVIEWER])
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'member')`,
      [WS, C, identity],
    );
  await db.query(
    `INSERT INTO corner_facts(corner_id,owner_agent_id,worker_agent_id,commissioned_by,objective)
    VALUES($1,$2,$2,$3,'Truthful corner states')`,
    [C, WORKER, HUMAN],
  );
  await createAgentCommand(db, {
    id: 'opening-order',
    roomId: C,
    agentId: WORKER,
    sourceMessageId: null,
    reason: 'order',
    privatePayload: { kind: 'order', text: 'Do the work', authorId: COMMANDER, fromRoomId: ROOM },
  });
  await db.query(`UPDATE agent_commands SET state='complete' WHERE id='opening-order'`);
});
const state = async () =>
  (await daemon.execute('getCornerRestoreState', { cornerId: C }, WORKER)).state;
const wake = async (agentId = WORKER, id = 'new-work') =>
  createAgentCommand(db, {
    id,
    roomId: C,
    agentId,
    sourceMessageId: null,
    reason: 'order',
    privatePayload: { kind: 'order', text: 'Continue', authorId: COMMANDER, fromRoomId: ROOM },
  });
const post = async (id: string, text: string, author = WORKER, age = '0 hours') =>
  db.query(
    `INSERT INTO messages(id,room_id,author_id,text,presentation,created_at)
  VALUES($1,$2,$3,$4,'message',now()-$5::interval)`,
    [id, C, author, text, age],
  );
const commanderFlags = async () => (await readAgentCommands(db, ROOM, COMMANDER)).commands;

it('an untagged needs-decision report waits on the human who ordered the turn', async () => {
  await phone.execute(
    'sendRoomMessage',
    { roomId: C, messageId: 'e'.repeat(64), text: '@worker Continue the proof.' },
    HUMAN,
  );
  const command = (await readAgentCommands(db, C, WORKER)).commands[0]!;
  await daemon.execute(
    'claimAgentCommand',
    { roomId: C, commandId: command.id, generationId: 'proof' },
    WORKER,
  );
  const authority = { roomId: C, requestId: command.turnRequestId, generationId: 'proof' };
  await daemon.execute(
    'report',
    { ...authority, status: 'needs_decision', text: 'needs-decision: Choose the product scope.' },
    WORKER,
  );
  await daemon.execute(
    'postRoomMessage',
    { ...authority, text: 'Waiting for the scope decision.' },
    WORKER,
  );
  expect(await state()).toBe('waiting');
  await post('scope-answer', 'Use the approved scope.', HUMAN);
  expect(await state()).toBe('idle');
});

it.each([
  ['truthful-state-2453', 'in-review', 'passing', '2 hours'],
  ['truthful-state-2454', 'in-review', 'passing', '1 hour'],
  ['truthful-state-screen-off', 'working', 'unknown', '2 hours'],
])(
  'Reproduction %s: stale lifecycle becomes IDLE and flags only the commander once',
  async (id, lifecycle, checks, age) => {
    await db.query(
      `UPDATE corner_facts SET lifecycle=$2::jsonb,updated_at=now()-$3::interval WHERE corner_id=$1`,
      [C, JSON.stringify({ lifecycle, checks }), age],
    );
    const row = (await phone.readCorners(ROOM, HUMAN))!.corners.find((row) => row.corner.id === C)!;
    expect(row.state).toBe('idle');
    expect(await state()).toBe('idle');
    await runCornerAttention(db);
    await runCornerAttention(db);
    expect(await commanderFlags()).toHaveLength(1);
    expect((await readAgentCommands(db, C, WORKER)).commands).toHaveLength(0);
    expect((await readAgentCommands(db, C, REVIEWER)).commands).toHaveLength(0);
    console.info(
      `Demonstrated Reproduction ${id}: ${lifecycle}/${checks}, ${age} stall -> list and inspect IDLE; commander=1, worker=0, reviewer=0; repeat=0`,
    );
  },
);
it('uses any worker/reviewer running or queued work rather than the newest turn', async () => {
  expect(await state()).toBe('idle');
  await wake();
  expect(await state()).toBe('working');
  await db.query(`UPDATE agent_commands SET state='complete' WHERE id='new-work'`);
  await wake(REVIEWER, 'review-work');
  expect(await state()).toBe('review');
  await db.query(`UPDATE agent_commands SET state='complete' WHERE id='review-work'`);
  await db.query(
    `INSERT INTO agent_turns(room_id,request_id,agent_id,status,created_at)
    VALUES($1,'older-worker',$2,'working',now()-interval '1 minute'),($1,'newer-reviewer',$3,'complete',now())`,
    [C, WORKER, REVIEWER],
  );
  expect(await state()).toBe('working');
  await db.query(`UPDATE agent_turns SET status='complete' WHERE room_id=$1`, [C]);
  await db.query(
    `UPDATE corner_facts SET lifecycle='{"lifecycle":"in-review","checks":"pending"}' WHERE corner_id=$1`,
    [C],
  );
  expect(await state()).toBe('review');
  await db.query(
    `UPDATE corner_facts SET lifecycle='{"lifecycle":"in-review","checks":"passing"}' WHERE corner_id=$1`,
    [C],
  );
  expect(await state()).toBe('idle');
});
it('records an idle flag before delivery and retries after restart without repeating', async () => {
  await recordCornerAttention(db);
  expect(
    (await db.query(`SELECT sent_at FROM corner_attention_flags WHERE kind='idle'`)).rows,
  ).toEqual([{ sent_at: null }]);
  expect(await commanderFlags()).toHaveLength(0);
  await deliverCornerAttention(db);
  await deliverCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(1);
});
it('a new turn or push creates a new idle span even between attention ticks', async () => {
  await runCornerAttention(db);
  await wake();
  await db.query(`UPDATE agent_commands SET state='complete' WHERE id='new-work'`);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(2);
  await db.query(
    `UPDATE corner_facts SET lifecycle='{"lifecycle":"in-review","checks":"passing","pr":{"number":2453,"url":"http://test/pr/2453","title":"PR","targetBranch":"main","headSha":"new-head"}}' WHERE corner_id=$1`,
    [C],
  );
  await runCornerAttention(db);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(3);
});
it('excludes the commander watch and commander schedules from worker waits', async () => {
  await db.query(
    `INSERT INTO corner_watches(watcher_room_id,agent_id,corner_id,kinds)
    VALUES($1,$2,$3,'["opened","merged"]')`,
    [ROOM, COMMANDER, C],
  );
  await db.query(
    `INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
    VALUES(gen_random_uuid(),$1,$2,$3,$4,'{"intervalMinutes":60}','Commander work',now()+interval '1 hour')`,
    [WS, C, COMMANDER, HUMAN],
  );
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(1);
});
it('suppresses a worker schedule until it is exhausted', async () => {
  await db.query(
    `INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at,max_runs)
    VALUES(gen_random_uuid(),$1,$2,$3,$4,'{"intervalMinutes":60}','Continue work',now()+interval '1 hour',1)`,
    [WS, C, WORKER, HUMAN],
  );
  await runCornerAttention(db);
  expect(await state()).toBe('idle');
  expect(await commanderFlags()).toHaveLength(0);
  await db.query(`UPDATE agent_schedules SET run_count=1 WHERE room_id=$1`, [C]);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(1);
});
it('suppresses only the worker event subscriptions', async () => {
  await db.query(
    `INSERT INTO agent_subscriptions(id,workspace_id,room_id,agent_id,source,event,prompt)
    VALUES(gen_random_uuid(),$1,$2,$3,'room','joined','Continue')`,
    [WS, C, COMMANDER],
  );
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(1);
  await wake();
  await db.query(`UPDATE agent_commands SET state='complete' WHERE id='new-work'`);
  await db.query(
    `INSERT INTO agent_subscriptions(id,workspace_id,room_id,agent_id,source,event,prompt)
    VALUES(gen_random_uuid(),$1,$2,$3,'room','joined','Continue')`,
    [WS, C, WORKER],
  );
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(1);
  await db.query(`DELETE FROM agent_subscriptions WHERE agent_id=$1`, [WORKER]);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(2);
});
it('counts the worker lifecycle watch in its own corner, not the commander auto-watch', async () => {
  await db.query(
    `INSERT INTO corner_watches(watcher_room_id,agent_id,corner_id,kinds)
    VALUES($1,$2,$1,'["merged"]')`,
    [C, WORKER],
  );
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(0);
  await db.query(`DELETE FROM corner_watches WHERE agent_id=$1`, [WORKER]);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(1);
});
it('reminds again only after a full 24-hour window when no dismissal occurs', async () => {
  await post('daily-decision', 'needs-decision: @owner Choose the next step.', WORKER, '25 hours');
  await runCornerAttention(db);
  await runCornerAttention(db);
  expect(
    (await db.query(`SELECT deliveries FROM corner_attention_flags WHERE kind='waiting'`)).rows,
  ).toEqual([{ deliveries: 1 }]);
  await db.query(
    `UPDATE corner_attention_flags SET due_at=now()-interval '1 second' WHERE kind='waiting'`,
  );
  await runCornerAttention(db);
  await runCornerAttention(db);
  expect(
    (await db.query(`SELECT deliveries FROM corner_attention_flags WHERE kind='waiting'`)).rows,
  ).toEqual([{ deliveries: 2 }]);
  expect((await readAgentCommands(db, C, WORKER)).commands).toHaveLength(0);
  expect((await readAgentCommands(db, C, REVIEWER)).commands).toHaveLength(0);
});
it('a resolved decision cannot produce a pending reminder after recording', async () => {
  await post(
    'resolved-decision',
    'needs-decision: @owner Choose the next step.',
    WORKER,
    '25 hours',
  );
  await recordCornerAttention(db);
  await post('resolve-before-delivery', 'Continue.', HUMAN);
  await deliverCornerAttention(db);
  expect(
    (await db.query(`SELECT id FROM messages WHERE card->>'cornerReminderId' IS NOT NULL`)).rows,
  ).toHaveLength(0);
});
it('indexes a pending approval sent through the owner System DM back to its source corner', async () => {
  const DM = '44444444-4444-4444-8444-444444444444',
    grant = '55555555-5555-4555-8555-555555555555';
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,direct_participants) VALUES($1,$2,'Approval DM',jsonb_build_array($3::text,$4::text))`,
    [DM, WS, HUMAN, WORKER],
  );
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
    [WS, DM, HUMAN],
  );
  await db.query(
    `INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status)
    VALUES($1,$2,$3,'host','example.test','Read docs',$2,$4,'pending')`,
    [grant, WORKER, WS, C],
  );
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
    VALUES('approval-card',$1,$2,'Allow docs','card','grant-request',$3::jsonb)`,
    [DM, WORKER, JSON.stringify({ sourceRoomId: C, grants: [{ grantId: grant }] })],
  );
  expect(await state()).toBe('waiting');
  await post('approval-chatter', 'I am checking.', HUMAN);
  expect(await state()).toBe('waiting');
  await db.query(`UPDATE agent_grants SET status='approved' WHERE id=$1`, [grant]);
  expect(await state()).toBe('idle');
});
it.each(['item', 'section'] as const)('keeps unanswered decisions waiting past 24h and stops reminders after %s dismissal', async (dismissal) => {
  await post('decision', 'needs-decision: @owner Choose whether to continue.');
  expect(await state()).toBe('waiting');
  await runCornerAttention(db);
  expect(
    (await db.query(`SELECT id FROM messages WHERE card->>'cornerReminderId' IS NOT NULL`)).rows,
  ).toHaveLength(0);
  await db.query(`UPDATE messages SET created_at=now()-interval '25 hours' WHERE id='decision'`);
  await db.query(`UPDATE corner_attention_flags SET due_at=now() WHERE kind='waiting'`);
  await runCornerAttention(db);
  expect(await state()).toBe('waiting');
  const reminder = (
    await db.query<{ id: string }>(
      `SELECT id FROM messages WHERE card->>'cornerReminderId' IS NOT NULL`,
    )
  ).rows[0]!;
  expect(reminder).toBeDefined();
  await runCornerAttention(db);
  expect(
    (await db.query(`SELECT id FROM messages WHERE card->>'cornerReminderId' IS NOT NULL`)).rows,
  ).toHaveLength(1);
  await phone.execute('clearNeedsYou', { workspaceId: WS, messageId: reminder.id }, HUMAN);
  expect((await db.query(`SELECT 1 FROM corner_attention_flags WHERE kind='waiting' AND dismissed_at IS NOT NULL`)).rowCount).toBe(0);
  await db.query(`UPDATE corner_attention_flags SET due_at=now() WHERE kind='waiting'`);
  await runCornerAttention(db);
  expect((await db.query(`SELECT id FROM messages WHERE card->>'cornerReminderId' IS NOT NULL`)).rows).toHaveLength(2);
  if (dismissal === 'item')
    await phone.execute('clearNeedsYou', { workspaceId: WS, messageId: reminder.id, dismissReminder: true }, HUMAN);
  else
    await phone.execute('clearNeedsYouSection', { workspaceId: WS }, HUMAN);
  console.log('Demonstrated Reproduction reminder-open-2472: open preserves daily repeat; explicit dismiss stops repeats; request stays WAITING');
  expect(
    (
      await db.query(
        `SELECT 1 FROM corner_attention_flags WHERE kind='waiting' AND dismissed_at IS NOT NULL`,
      )
    ).rowCount,
  ).toBe(1);
  await db.query(`UPDATE corner_attention_flags SET due_at=now() WHERE kind='waiting'`);
  await runCornerAttention(db);
  expect(
    (await db.query(`SELECT id FROM messages WHERE card->>'cornerReminderId' IS NOT NULL`)).rows,
  ).toHaveLength(2);
  expect(await state()).toBe('waiting'); // Dismissing a reminder does not decide the request.
  await post('answer', 'Continue.', HUMAN);
  expect(await state()).toBe('idle');
});
it('ordinary tags and failure stages are not human blockers; active holds are', async () => {
  await post('tag', '@owner Here is the current status.');
  expect(await state()).toBe('idle');
  await db.query(
    `INSERT INTO corner_merge_holds(corner_id,actor_id,standing) VALUES($1,$2,'owner')`,
    [C, HUMAN],
  );
  expect(await state()).toBe('waiting');
  await db.query(
    `UPDATE corner_merge_holds SET released_at=now(),released_by=$2 WHERE corner_id=$1`,
    [C, HUMAN],
  );
  expect(await state()).toBe('idle');
});
it('an answered tagged choice stops blocking even when its original human tag remains', async () => {
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
    VALUES('tagged-choice',$1,$2,'@owner Choose a scope.','card','choice',
      jsonb_build_object('mode','question','status','open','requester',jsonb_build_object('pubkey',$3::text)))`,
    [C, WORKER, HUMAN],
  );
  expect(await state()).toBe('waiting');
  await db.query(
    `UPDATE messages SET card=jsonb_set(card,'{status}','"answered"') WHERE id='tagged-choice'`,
  );
  expect(await state()).toBe('idle');
});
it('list_corners can return only open corners and keeps archived discovery available', async () => {
  expect(
    (await daemon.execute('listReachableCorners', { roomId: ROOM, activeOnly: true }, WORKER))
      .corners,
  ).toHaveLength(1);
  await db.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [C]);
  expect(
    (await daemon.execute('listReachableCorners', { roomId: ROOM, activeOnly: true }, WORKER))
      .corners,
  ).toHaveLength(0);
  expect(
    (await daemon.execute('listReachableCorners', { roomId: ROOM }, WORKER)).corners,
  ).toHaveLength(1);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(0);
});
