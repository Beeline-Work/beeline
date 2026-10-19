import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { systemLine } from './system-line.js';
import { cornerOwedSchemaSql } from './corner-owed.js';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import { createAgentCommand, readAgentCommands, noteBlockedCornerChecks } from './agent-command.js';
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
  expect(await createAgentCommand(db,{roomId:C,agentId:WORKER,sourceMessageId:null,reason:'schedule'})).toBeUndefined();
  expect((await phone.readCorners(ROOM,HUMAN))!.corners[0]!.state).toBe('waiting');
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
    expect((await commanderFlags())[0]).toMatchObject({ private: true });
    expect((await db.query('SELECT id FROM messages')).rows).toEqual([]);
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
it('a new worker command starts an episode but a head update alone does not', async () => {
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
  expect(await commanderFlags()).toHaveLength(2);
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
it('Reproduction waiting-tray: consumes reminders without messages or Needs-you changes', async () => {
  await post('decision', 'needs-decision: @owner Choose whether to continue.', WORKER, '25 hours');
  const tray = () => phone.execute('readNeedsYou', { workspaceId: WS }, HUMAN);
  const before = await tray();
  expect(before.items.map(item => item.messageId)).toContain('decision');
  const messages = (await db.query('SELECT id,text FROM messages')).rows;
  const marks = (await db.query('SELECT * FROM needs_you_marks')).rows;
  await runCornerAttention(db);
  await runCornerAttention(db);
  expect(await tray()).toEqual(before);
  expect((await db.query('SELECT id,text FROM messages')).rows).toEqual(messages);
  expect((await db.query('SELECT * FROM needs_you_marks')).rows).toEqual(marks);
  await phone.execute('clearNeedsYou', { workspaceId: WS, messageId: 'decision', dismissReminder: true }, HUMAN);
  await db.query("UPDATE corner_attention_flags SET due_at=now() WHERE kind='waiting'");
  await runCornerAttention(db);
  expect((await tray()).items).toHaveLength(0);
  expect((await db.query('SELECT id,text FROM messages')).rows).toEqual(messages);
  expect(await state()).toBe('waiting');
  console.info('Demonstrated Reproduction waiting-tray: zero new messages; original Needs-you entry and marks unchanged; dismissal stays cleared');
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

it('Reproduction reminder-supersession-2472: an older unanswered choice resumes after a newer request is answered', async () => {
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,created_at)
    VALUES('older-choice',$1,$2,'@owner Choose a scope.','card','choice',
      jsonb_build_object('mode','question','status','open','requester',jsonb_build_object('pubkey',$3::text)),now()-interval '25 hours')`,
    [C, WORKER, HUMAN]);
  await runCornerAttention(db);
  const flags = async () => (await db.query<{ deliveries: number; dismissed_at: string | null }>(
    `SELECT deliveries,dismissed_at FROM corner_attention_flags WHERE item_id='older-choice'`)).rows[0]!;
  expect((await flags()).deliveries).toBe(1);
  await post('newer-request', 'needs-decision: @owner Choose the newer scope.');
  await db.query(`UPDATE corner_attention_flags SET due_at=now() WHERE item_id='older-choice'`);
  await runCornerAttention(db);
  expect((await flags()).deliveries).toBe(1);
  expect((await flags()).dismissed_at).toBeNull();
  await phone.execute('sendRoomMessage', { roomId: C, messageId: 'f'.repeat(64), text: 'Use the newer scope.' }, HUMAN);
  const row = (await phone.readCorners(ROOM, HUMAN))!.corners.find(row => row.corner.id === C)!;
  expect(row.state).toBe('waiting');
  await db.query(`UPDATE corner_attention_flags SET due_at=now() WHERE item_id='older-choice'`);
  await runCornerAttention(db);
  expect((await flags()).deliveries).toBe(2);
  expect((await flags()).dismissed_at).toBeNull();
  await runCornerAttention(db);
  expect((await flags()).deliveries).toBe(2);
  console.log('Demonstrated Reproduction reminder-supersession-2472: choice reminded once; newer blocker pauses it; answer restores WAITING choice and second reminder; repeat=0');
});

it.each([false, true])('Reproduction bright-meadow-corner: a person commander receives no idle notice (person opened=%s)', async (personOpened) => {
  if (personOpened) await db.query('UPDATE rooms SET created_by=$1 WHERE id=$2', [HUMAN, C]);
  await db.query("UPDATE rooms SET name='bright-meadow-corner' WHERE id=$1", [C]);
  await db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{authorId}',to_jsonb($1::text)) WHERE id='opening-order'`, [HUMAN]);
  const before = (await db.query('SELECT id FROM agent_commands')).rows;
  await runCornerAttention(db);
  await runCornerAttention(db);
  expect((await db.query('SELECT id FROM agent_commands')).rows).toEqual(before);
  expect((await db.query("SELECT sent_at IS NOT NULL sent,dismissed_at IS NOT NULL dismissed FROM corner_attention_flags WHERE kind='idle'")).rows).toEqual([{ sent: false, dismissed: true }]);
  expect(await commanderFlags()).toHaveLength(0);
  expect((await db.query('SELECT id,text FROM messages WHERE room_id IN ($1,$2)', [ROOM,C])).rows).toEqual([]);
  console.info('Demonstrated Reproduction bright-meadow-corner: person commander: wakes=0; room transcript messages=0; repeated flag=0');
});


it('preserves already-posted reminders and honors their dismissal', async () => {
  await post('legacy-request', 'needs-decision: @owner Choose the next step.', WORKER, '25 hours');
  await runCornerAttention(db);
  const flag = (await db.query<{ id: string }>("SELECT id FROM corner_attention_flags WHERE kind='waiting'")).rows[0]!;
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card)
    VALUES('legacy-reminder',$1,$2,'Please resolve the waiting request.','message',jsonb_build_object('cornerReminderId',$3::text))`, [C, WORKER, flag.id]);
  await phone.execute('clearNeedsYou', { workspaceId: WS, messageId: 'legacy-reminder', dismissReminder: true }, HUMAN);
  await db.query("UPDATE corner_attention_flags SET due_at=now() WHERE id=$1", [flag.id]);
  await runCornerAttention(db);
  expect((await db.query("SELECT id FROM messages ORDER BY id")).rows).toEqual([{ id: 'legacy-reminder' }, { id: 'legacy-request' }]);
  expect((await db.query("SELECT deliveries,dismissed_at IS NOT NULL dismissed FROM corner_attention_flags WHERE id=$1", [flag.id])).rows).toEqual([{ deliveries: 1, dismissed: true }]);
});

it.each(['needs-decision','blocked'])('Reproduction idle-alert-churn: private %s reports remain waiting through check churn', async (status) => {
  await wake();
  const command = (await readAgentCommands(db, C, WORKER)).commands[0]!;
  await daemon.execute('claimAgentCommand', {roomId:C,commandId:command.id,generationId:'decision-proof'},WORKER);
  const authority = {roomId:C,requestId:command.turnRequestId,generationId:'decision-proof'};
  await daemon.execute('report', {...authority,status:status==='blocked'?'blocked':'needs_decision',text:status+': @owner Approve the pending proof.'},WORKER);
  await daemon.execute('postRoomMessage',{...authority,text:'Waiting for approval.'},WORKER);
  await daemon.execute('postAgentTurnReceipt',{...authority,agentId:WORKER,status:'complete'},WORKER);
  // A restart must recover private reports without creating visible messages.
  await db.query('DELETE FROM corner_report_blockers');
  await db.query(cornerOwedSchemaSql());
  expect(await state()).toBe('waiting');
  for (let i=0;i<3;i++) {
    await db.query(`UPDATE corner_attention_spans SET revision=revision+3 WHERE corner_id=$1`,[C]);
    await db.query(`UPDATE corner_facts SET lifecycle=jsonb_build_object('checks',CASE WHEN $2::int=1 THEN 'pending' ELSE 'passing' END,'activity',$2::int) WHERE corner_id=$1`,[C,i]);
    expect(await state()).toBe('waiting');
    expect((await phone.readCorners(ROOM,HUMAN))!.corners[0]!.state).toBe('waiting');
    await runCornerAttention(db);
  }
  expect((await db.query('SELECT kind FROM corner_attention_flags')).rows).toEqual([{kind:'waiting'}]);
  await post('decision-arrives','Approved, continue.',HUMAN);
  await wake(WORKER,'decision-resume');
  expect(await state()).toBe('working');
  console.info('Demonstrated Reproduction idle-alert-churn: private human decision + three check updates -> WAITING in list/inspect; waiting=1 idle=0; answer and resume -> WORKING');
});

it('Reproduction idle-alert-churn: idle revision churn sends once to the unchanged call site', async () => {
  for(let i=0;i<3;i++) {
    await db.query(`UPDATE corner_attention_spans SET revision=revision+3 WHERE corner_id=$1`,[C]);
    await runCornerAttention(db);
  }
  expect(await commanderFlags()).toHaveLength(1);
  expect((await db.query("SELECT kind FROM corner_attention_flags WHERE kind='idle'")).rows).toHaveLength(1);
  await wake();
  await runCornerAttention(db);
  await db.query(`UPDATE agent_commands SET state='complete' WHERE id='new-work'`);
  await runCornerAttention(db);
  expect((await db.query("SELECT kind FROM corner_attention_flags WHERE kind='idle'")).rows).toHaveLength(2);
  console.info('Demonstrated Reproduction idle-alert-churn: three revisions -> one private idle alert at the call site; real work and return to idle -> second episode');
});

it('does not deliver an old idle flag after worker activity between ticks', async () => {
  await recordCornerAttention(db);
  await wake();
  await db.query(`UPDATE agent_commands SET state='complete' WHERE id='new-work'`);
  await deliverCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(0);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(1);
});

it('Reproduction idle-alert-churn: a newer brief preserves the call-site recipient', async () => {
  const DM='77777777-7777-4777-8777-777777777777';
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Brief session')`,[DM,WS]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,[WS,DM,COMMANDER]);
  await db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,content,author_id,source_room_id)
    VALUES($1,1,'Approved work',$2,$3)`,[C,COMMANDER,DM]);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(1);
  expect((await readAgentCommands(db,DM,COMMANDER)).commands).toHaveLength(0);
});

it.each(['pending','active'] as const)('Reproduction idle-alert-churn: a dispatched %s reviewer remains in review after reviewer settings change', async phase => {
  const head='review-head';
  await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`,[C,JSON.stringify({lifecycle:'in-review',checks:'passing',pr:{headSha:head}})]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,system_event)
    VALUES('review-source',$1,$2,'Review requested','system',$3::jsonb)`,
    [C,COMMANDER,JSON.stringify({kind:'check-passed',object:{headSha:head}})]);
  const dispatch=await createAgentCommand(db,{id:'review-dispatch',roomId:C,agentId:REVIEWER,sourceMessageId:'review-source',reason:'corner_review_dispatch'});
  expect(dispatch).toBeTruthy();
  if(phase==='active') await daemon.execute('claimAgentCommand',{roomId:C,commandId:dispatch!.id,generationId:'review-proof'},REVIEWER);
  expect(await state()).toBe('review');
  // The dispatched recipient still owns this review even if settings change.
  await db.query(`UPDATE rooms SET reviewer_agent_id=NULL,reviewer_fallback_ids='{}' WHERE id=$1`,[ROOM]);
  for(let i=0;i<3;i++) {
    await db.query(`UPDATE corner_attention_spans SET revision=revision+3 WHERE corner_id=$1`,[C]);
    expect(await state()).toBe('review');
    expect((await phone.readCorners(ROOM,HUMAN))!.corners[0]!.state).toBe('review');
    await runCornerAttention(db);
  }
  expect((await db.query("SELECT id FROM corner_attention_flags WHERE kind='idle'")).rows).toHaveLength(0);
  expect(await commanderFlags()).toHaveLength(0);
  await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{pr,headSha}','"next-head"') WHERE corner_id=$1`,[C]);
  expect(await state()).toBe('idle');
  await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{pr,headSha}',$2::jsonb) WHERE corner_id=$1`,[C,JSON.stringify(head)]);
  expect(await state()).toBe('review');
  await db.query(`UPDATE agent_commands SET state='complete' WHERE id='review-dispatch'`);
  await db.query(`UPDATE agent_turns SET status='complete' WHERE room_id=$1 AND agent_id=$2`,[C,REVIEWER]);
  expect(await state()).toBe('idle');
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(1);
  console.info(`Demonstrated Reproduction idle-alert-churn: ${phase} review dispatch survives settings change; list/inspect REVIEW; three churn ticks produce zero idle flags; completed review permits idle`);
});

it.each(['complete', 'failed', 'cancelled', 'unreported', 'unclaimed', 'running'])(
  'Reproduction stuck-review-silent: %s reviewer has truthful state and one idle alert',
  async outcome => {
    await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`,
      [C, JSON.stringify({lifecycle:'in-review', checks:'passing', pr:{headSha:'stuck-head'}})]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,system_event)
      VALUES('stuck-source',$1,$2,'Checks passed','system',$3::jsonb)`,
      [C, COMMANDER, JSON.stringify({kind:'check-passed',object:{headSha:'stuck-head'}})]);
    const dispatch = await createAgentCommand(db, {id:'stuck-dispatch',roomId:C,agentId:REVIEWER,
      sourceMessageId:'stuck-source',reason:'corner_review_dispatch'});
    expect(dispatch).toBeTruthy();
    if (outcome === 'unclaimed') {
      await db.query(`UPDATE agent_commands SET created_at=now()-interval '3 minutes' WHERE id='stuck-dispatch'`);
    } else {
      await daemon.execute('claimAgentCommand', {roomId:C,commandId:dispatch!.id,generationId:'stuck-proof'},REVIEWER);
      if (outcome !== 'running') {
        // A terminal receipt must outweigh a command left claimed by the ended turn.
        await db.query(`UPDATE agent_turns SET status=$3 WHERE room_id=$1 AND agent_id=$2`,[C,REVIEWER,outcome === 'unreported' ? 'complete' : outcome]);
        if (outcome === 'unreported') await db.query(`UPDATE agent_commands SET state='complete' WHERE id='stuck-dispatch'`);
      }
    }
    const expected = outcome === 'running' ? 'review' : 'idle';
    expect(await state()).toBe(expected);
    expect((await phone.readCorners(ROOM,HUMAN))!.corners[0]!.state).toBe(expected);
    await runCornerAttention(db);
    await runCornerAttention(db);
    expect(await commanderFlags()).toHaveLength(outcome === 'running' ? 0 : 1);
    console.info(`Demonstrated Reproduction stuck-review-silent: ${outcome} -> list/inspect ${expected}; commander alerts=${outcome === 'running' ? 0 : 1}; repeated tick adds zero`);
  },
);

it.each(['blocked', 'needs_decision'] as const)('Reproduction waiting-answer: untagged %s stops automatic retries and idle alerts', async status => {
  await db.query(`UPDATE corner_facts SET lifecycle=jsonb_build_object('checks','failing','pr',jsonb_build_object('headSha','proof-head')) WHERE corner_id=$1`,[C]);
  await systemLine(db,{roomId:C,authorId:WORKER,subject:{kind:'github',name:'GitHub'},verb:'found failing checks on',kind:'check-failed',object:{text:'Proof PR',headSha:'proof-head'}});
  const command = (await readAgentCommands(db,C,WORKER)).commands[0]!;
  await daemon.execute('claimAgentCommand',{roomId:C,commandId:command.id,generationId:'waiting-proof'},WORKER);
  const authority = {roomId:C,requestId:command.turnRequestId,generationId:'waiting-proof'};
  await daemon.execute('report',{...authority,status,text:`${status === 'blocked' ? 'blocked' : 'needs-decision'}: Owner must approve the proof.`},WORKER);
  await daemon.execute('postRoomMessage',{...authority,text:'Waiting for approval.'},WORKER);
  await daemon.execute('postAgentTurnReceipt',{...authority,agentId:WORKER,status:'complete'},WORKER);
  const messagesBefore = (await db.query('SELECT id FROM messages')).rows;
  let wakes = 0;
  for (let i=0;i<3;i++) {
    await db.query(`UPDATE agent_commands SET completed_at=now()-interval '3 minutes' WHERE room_id=$1 AND state='complete'`,[C]);
    await noteBlockedCornerChecks(db);
    const retry = (await readAgentCommands(db,C,WORKER)).commands[0];
    if (retry) {
      wakes++;
      await daemon.execute('claimAgentCommand',{roomId:C,commandId:retry.id,generationId:`retry-${i}`},WORKER);
      await daemon.execute('postRoomMessage',{roomId:C,requestId:retry.turnRequestId,generationId:`retry-${i}`,text:'Still waiting.'},WORKER);
      await daemon.execute('postAgentTurnReceipt',{roomId:C,requestId:retry.turnRequestId,generationId:`retry-${i}`,agentId:WORKER,status:'complete'},WORKER);
    }
    await runCornerAttention(db);
  }
  const idle = (await db.query("SELECT id FROM corner_attention_flags WHERE kind='idle'")).rowCount;
  console.info(`Reproduction waiting-answer: worker wakes=${wakes}; idle alerts=${idle}; state=${await state()}`);
  expect({wakes,idle,state:await state()}).toEqual({wakes:0,idle:0,state:'waiting'});
  expect((await db.query('SELECT id FROM messages')).rows).toEqual(messagesBefore);
  for (const reason of ['schedule','subscribed_event','corner_review_dispatch'])
    expect(await createAgentCommand(db,{roomId:C,agentId:WORKER,sourceMessageId:null,reason})).toBeUndefined();
  expect((await commanderFlags()).filter(command => command.source.body.includes('idle'))).toHaveLength(0);
  expect((await phone.readCorners(ROOM,HUMAN))!.corners[0]!.state).toBe('waiting');
});

it.each(['human message','commander message','commander order','push'] as const)('Reproduction waiting-answer: %s ends waiting once', async answer => {
  await wake();
  const command = (await readAgentCommands(db,C,WORKER)).commands[0]!;
  await daemon.execute('claimAgentCommand',{roomId:C,commandId:command.id,generationId:'answer-proof'},WORKER);
  const authority = {roomId:C,requestId:command.turnRequestId,generationId:'answer-proof'};
  await daemon.execute('report',{...authority,status:'blocked',text:'blocked: Owner must approve the proof.'},WORKER);
  await daemon.execute('postRoomMessage',{...authority,text:'Waiting for approval.'},WORKER);
  await daemon.execute('postAgentTurnReceipt',{...authority,agentId:WORKER,status:'complete'},WORKER);
  expect(await state()).toBe('waiting');
  // A receipt from an automatic turn, including a restart of the same row, is not an answer.
  await db.query(`INSERT INTO agent_turns(room_id,agent_id,request_id,status) VALUES($1,$2,'automatic-receipt','working')`,[C,WORKER]);
  await db.query(`UPDATE agent_turns SET started_at=now() WHERE request_id='automatic-receipt'`);
  expect((await db.query('SELECT 1 FROM corner_report_blockers WHERE corner_id=$1',[C])).rowCount).toBe(1);
  await db.query(`UPDATE agent_turns SET status='complete' WHERE request_id='automatic-receipt'`);
  await db.query(cornerOwedSchemaSql());
  expect(await state()).toBe('waiting');
  if (answer === 'human message') {
    await phone.execute('sendRoomMessage',{roomId:C,messageId:'f'.repeat(64),text:'@worker Approved, continue.'},HUMAN);
  } else if (answer === 'commander message' || answer === 'commander order') {
    const report = (await commanderFlags()).find(command => command.reason === 'report')!;
    await daemon.execute('claimAgentCommand',{roomId:ROOM,commandId:report.id,generationId:'commander-answer'},COMMANDER);
    const commanderAuthority = {roomId:ROOM,requestId:report.turnRequestId,generationId:'commander-answer'};
    if (answer === 'commander message')
      await daemon.execute('postCornerMessage',{...commanderAuthority,cornerId:C,text:'@worker Approved, continue.'},COMMANDER);
    else
      await daemon.execute('order',{...commanderAuthority,address:C,text:'Approved, continue.'},COMMANDER);
  } else {
    await db.query(`UPDATE corner_facts SET lifecycle=jsonb_build_object('pr',jsonb_build_object('headSha','new-head')) WHERE corner_id=$1`,[C]);
    await createAgentCommand(db,{id:'push-wake',roomId:C,agentId:WORKER,sourceMessageId:null,reason:'corner_check'});
  }
  expect((await db.query('SELECT 1 FROM corner_report_blockers WHERE corner_id=$1',[C])).rowCount).toBe(0);
  expect((await readAgentCommands(db,C,WORKER)).commands).toHaveLength(1);
  await db.query(cornerOwedSchemaSql());
  expect((await db.query('SELECT 1 FROM corner_report_blockers WHERE corner_id=$1',[C])).rowCount).toBe(0);
  expect((await readAgentCommands(db,C,WORKER)).commands).toHaveLength(1);
  expect(await state()).toBe('working');
});


it('Reproduction waiting-answer: a queued automatic wake is cancelled when the worker reports blocked', async () => {
  await wake();
  const command = (await readAgentCommands(db,C,WORKER)).commands[0]!;
  await daemon.execute('claimAgentCommand',{roomId:C,commandId:command.id,generationId:'queued-proof'},WORKER);
  const queued = await createAgentCommand(db,{id:'queued-automatic',roomId:C,agentId:WORKER,sourceMessageId:null,reason:'schedule'});
  expect(queued).toBeDefined();
  const authority = {roomId:C,requestId:command.turnRequestId,generationId:'queued-proof'};
  await daemon.execute('report',{...authority,status:'blocked',text:'blocked: Need approval.'},WORKER);
  await daemon.execute('postRoomMessage',{...authority,text:'Waiting for approval.'},WORKER);
  await daemon.execute('postAgentTurnReceipt',{...authority,agentId:WORKER,status:'complete'},WORKER);
  expect((await readAgentCommands(db,C,WORKER)).commands).toHaveLength(0);
  await expect(daemon.execute('claimAgentCommand',{roomId:C,commandId:queued!.id,generationId:'stale-wake'},WORKER)).rejects.toThrow();
  expect(await state()).toBe('waiting');
});

it.each(['blocked','needs_decision'] as const)('Reproduction waiting-answer: human-directed %s stays quiet until each answer path', async status => {
  await db.query(`UPDATE corner_facts SET lifecycle=jsonb_build_object('checks','failing','pr',jsonb_build_object('headSha','human-proof-head')) WHERE corner_id=$1`,[C]);
  await systemLine(db,{roomId:C,authorId:WORKER,subject:{kind:'github',name:'GitHub'},verb:'found failing checks on',kind:'check-failed',object:{text:'Human proof PR',headSha:'human-proof-head'}});
  await db.query(`UPDATE agent_commands SET state='complete',completed_at=now()-interval '3 minutes' WHERE room_id=$1`,[C]);
  for (const answer of ['human message','commander order','push']) {
    await phone.execute('sendRoomMessage',{roomId:C,messageId:createHash('sha256').update(`human-request-${answer}`).digest('hex'),text:'@worker Continue the proof.'},HUMAN);
    const command = (await readAgentCommands(db,C,WORKER)).commands[0]!;
    await daemon.execute('claimAgentCommand',{roomId:C,commandId:command.id,generationId:answer},WORKER);
    const authority = {roomId:C,requestId:command.turnRequestId,generationId:answer};
    const text = `${status === 'blocked' ? 'blocked' : 'needs-decision'}: Choose the product scope.`;
    await daemon.execute('report',{...authority,status,text},WORKER);
    await daemon.execute('postRoomMessage',{...authority,text:'Waiting for the scope decision.'},WORKER);
    await daemon.execute('postAgentTurnReceipt',{...authority,agentId:WORKER,status:'complete'},WORKER);
    expect(await state()).toBe('waiting');
    expect((await db.query('SELECT text,card FROM messages WHERE text=$1 ORDER BY created_at DESC LIMIT 1',[text])).rows[0])
      .toMatchObject({text,card:{reportToId:HUMAN}});
    await db.query('DELETE FROM corner_report_blockers WHERE corner_id=$1',[C]);
    await db.query(cornerOwedSchemaSql());
    for(let i=0;i<3;i++) {
      expect(await noteBlockedCornerChecks(db)).toBe(0);
      for(const reason of ['schedule','subscribed_event','corner_check'])
        expect(await createAgentCommand(db,{roomId:C,agentId:WORKER,sourceMessageId:null,reason})).toBeUndefined();
      await runCornerAttention(db);
      expect((await phone.readCorners(ROOM,HUMAN))!.corners[0]!.state).toBe('waiting');
    }
    expect((await db.query("SELECT id FROM corner_attention_flags WHERE kind='idle'")).rowCount).toBe(0);
    if(answer === 'human message')
      await phone.execute('sendRoomMessage',{roomId:C,messageId:'f'.repeat(64),text:'@worker Use the approved scope.'},HUMAN);
    else if(answer === 'commander order')
      await createAgentCommand(db,{id:'human-commander-order',roomId:C,agentId:WORKER,sourceMessageId:null,reason:'order',privatePayload:{kind:'order',authorId:HUMAN,fromRoomId:ROOM,text:'Use the approved scope.'}});
    else {
      await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{pr,headSha}','"human-proof-next-head"') WHERE corner_id=$1`,[C]);
      await createAgentCommand(db,{roomId:C,agentId:WORKER,sourceMessageId:null,reason:'corner_check'});
    }
    await db.query(cornerOwedSchemaSql());
    expect((await db.query('SELECT 1 FROM corner_report_blockers WHERE corner_id=$1',[C])).rowCount).toBe(0);
    expect((await readAgentCommands(db,C,WORKER)).commands).toHaveLength(1);
    expect(await state()).toBe('working');
    await db.query(`UPDATE agent_commands SET state='complete' WHERE room_id=$1`,[C]);
    await db.query(`UPDATE agent_turns SET status='complete' WHERE room_id=$1`,[C]);
  }
});

it.each([
  ['agent',false],['agent',true],['human',false],['human',true],
] as const)('Reproduction waiting-answer: upgrade quiets a legacy retry for %s reports (existing blocker=%s)', async (commander, retained) => {
  if(commander === 'human')
    await phone.execute('sendRoomMessage',{roomId:C,messageId:'e'.repeat(64),text:'@worker Continue the proof.'},HUMAN);
  else await wake();
  const command = (await readAgentCommands(db,C,WORKER)).commands[0]!;
  await daemon.execute('claimAgentCommand',{roomId:C,commandId:command.id,generationId:'upgrade-proof'},WORKER);
  const authority = {roomId:C,requestId:command.turnRequestId,generationId:'upgrade-proof'};
  await daemon.execute('report',{...authority,status:'blocked',text:'blocked: Owner must approve the proof.'},WORKER);
  await daemon.execute('postRoomMessage',{...authority,text:'Waiting for approval.'},WORKER);
  await daemon.execute('postAgentTurnReceipt',{...authority,agentId:WORKER,status:'complete'},WORKER);
  // Model the pre-upgrade database and a retry queued by its old writer.
  await db.query('DROP TRIGGER IF EXISTS corner_report_quiet ON corner_report_blockers');
  if(!retained) await db.query('DELETE FROM corner_report_blockers WHERE corner_id=$1',[C]);
  await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,source_message_id,turn_request_id,action,reason,root_command_id,root_source_message_id,agent_depth)
    VALUES('legacy-retry',$1,$2,NULL,'legacy-retry','input','corner_check','legacy-retry','legacy-retry',0)`,[C,WORKER]);

  expect((await phone.readCorners(ROOM,HUMAN))!.corners[0]!.state).toBe('working');
  const transcript = (await db.query('SELECT id,text FROM messages ORDER BY id')).rows;
  for(let i=0;i<2;i++) {
    await db.query(cornerOwedSchemaSql());
    expect((await db.query("SELECT state FROM agent_commands WHERE id='legacy-retry'")).rows).toEqual([{state:'cancelled'}]);
    expect((await db.query("SELECT status FROM agent_turns WHERE request_id='legacy-retry' AND status='working'")).rows).toEqual([]);
    expect((await phone.readCorners(ROOM,HUMAN))!.corners[0]!.state).toBe('waiting');
    expect((await readAgentCommands(db,C,WORKER)).commands).toHaveLength(0);
    await runCornerAttention(db);
    expect((await db.query("SELECT id FROM corner_attention_flags WHERE kind='idle'")).rowCount).toBe(0);
    expect((await db.query('SELECT id,text FROM messages ORDER BY id')).rows).toEqual(transcript);
  }
  await phone.execute('sendRoomMessage',{roomId:C,messageId:'f'.repeat(64),text:'@worker Approved, continue.'},HUMAN);
  expect((await readAgentCommands(db,C,WORKER)).commands).toHaveLength(1);
  expect((await phone.readCorners(ROOM,HUMAN))!.corners[0]!.state).toBe('working');
});
