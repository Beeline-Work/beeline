import { recordStartupWakeOutcome } from './startup-wake-backoff.js';
import { flushDueCommanderWakes } from './commander-wakes.js';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { systemLine } from './system-line.js';
import { cornerOwedSchemaSql } from './corner-owed.js';
import { migrate, PostgresDatabase, type SqlDatabase } from './database.js';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { PgliteDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import { createAgentCommand, readAgentCommands, noteBlockedCornerChecks } from './agent-command.js';
import {
  refreshCornerAttention,
  CornerAttentionDeadlines,
  runCornerAttention,
} from './corner-attention.js';

const WS = '11111111-1111-4111-8111-111111111111',
  ROOM = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const HUMAN = 'a'.repeat(64),
  COMMANDER = 'b'.repeat(64),
  WORKER = 'c'.repeat(64),
  REVIEWER = 'd'.repeat(64);
let db: SqlDatabase, closeDatabase: () => Promise<void>, daemon: DaemonService, phone: PhoneService;
beforeAll(async () => {
  if (process.env.BEELINE_ATTENTION_TEST_POSTGRES_URL) {
    const url = process.env.BEELINE_ATTENTION_TEST_POSTGRES_URL;
    const schema = `attention_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pg = new PostgresDatabase('', 5, { pool: new Pool({ connectionString: url,
      options: `-c search_path=${schema},public` }), mode: 'migration' });
    db = pg;
    closeDatabase = async () => { await pg.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); };
  } else {
    const pg = new PgliteDatabase(); db = pg; closeDatabase = () => pg.close();
  }
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
afterAll(async () => closeDatabase());
beforeEach(async () => {
  await db.query('DELETE FROM workspaces');
  await db.query('DELETE FROM agent_startup_backoff');
  await db.query('UPDATE agents SET wake_batch_minutes=0');
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
  await db.query(`DELETE FROM agent_turns WHERE room_id=$1`,[C]);
  await db.query(`UPDATE corner_attention_spans SET last_turn_ended_at=NULL WHERE corner_id=$1`,[C]);
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
// The idle alert now wakes its opening commander inside the corner whenever
// the commander has effective access (inherited parent-roster access counts).
const commanderFlags = async () => (await readAgentCommands(db, C, COMMANDER)).commands;

it('STARTUP-FAILURE-1: a bootstrap failure is idle immediately and visible in its corner', async () => {
  const command = await wake();
  expect(await state()).toBe('working');
  await daemon.execute('postAgentTurnReceipt', {
    roomId: C, requestId: command!.turn_request_id, status: 'failed',
    reason: 'git fetch failed: cannot lock ref', reasonKind: 'workspace-failure',
  }, WORKER);
  expect(await state()).toBe('idle');
  const failures = await db.query<{ text: string }>(
    `SELECT text FROM messages WHERE room_id=$1 AND card_type='turn-failed'`, [C],
  );
  expect(failures.rows).toHaveLength(1);
  expect(failures.rows[0]!.text).toContain('cannot lock ref');
});

async function turn(agent = WORKER) {
  await db.query(
    `INSERT INTO agent_turns(room_id,request_id,agent_id,status,generation_id)
    VALUES($1,$2,$3,'working','actual') ON CONFLICT(room_id,request_id,agent_id) DO UPDATE SET status='working'`,
    [C, agent, agent],
  );
}
async function end(agent = WORKER, age = 0) {
  await db.query(`UPDATE agent_turns SET status='complete' WHERE room_id=$1 AND agent_id=$2`, [
    C,
    agent,
  ]);
  await db.query(
    `UPDATE corner_attention_spans SET last_turn_ended_at=clock_timestamp()-make_interval(secs=>$2) WHERE corner_id=$1`,
    [C, age],
  );
}
async function ci(checks: string) {
  await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
    C,
    JSON.stringify({
      lifecycle: 'in-review',
      checks,
      pr: { number: 1, url: 'https://github.com/o/r/pull/1', headSha: 'head' },
      checksSummary: {
        status: checks,
        total: 1,
        updatedAt: Date.now() / 1000,
        checks: [
          {
            name: 'tests',
            status: checks === 'pending' ? 'pending' : 'failed',
            url: 'https://github.com/o/r/actions/runs/1',
          },
        ],
        failing: [],
      },
    }),
  ]);
}
async function unreportedHead() {
  await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
    C,
    JSON.stringify({
      lifecycle: 'in-review',
      checks: 'unknown',
      pr: { number: 1, url: 'https://github.com/o/r/pull/1', headSha: 'head', title: 'Fix', targetBranch: 'main' },
      checksSummary: { status: 'unknown', total: 0, failing: [], checks: [], updatedAt: Date.now() / 1000 },
    }),
  ]);
}
it('Reproduction CORNER-STATE: the Room list and corner inspection agree that CI is Review without human attention', async () => {
  await turn();
  expect(await state()).toBe('working');
  await end(WORKER, 10);
  expect(await state()).toBe('working');
  await end(WORKER, 40);
  expect(await state()).toBe('idle');
  await turn(REVIEWER);
  expect(await state()).toBe('review');
  await end(REVIEWER, 40);
  await ci('pending');
  expect(await state()).toBe('review');
  const row = (await phone.readCorners(ROOM, HUMAN))!.corners[0]!;
  expect(row).toMatchObject({
    state: 'review',
  });
  expect(
    (await phone.readChats(WS, HUMAN))!.chats.find((row) => row.room.id === ROOM)?.openCorners?.[0]
      ?.state,
  ).toBe('review');
  expect(row.blocker).toBeUndefined();
  const deck = await phone.liveChatCornerStatus(ROOM, HUMAN);
  expect(deck).toMatchObject({ waitingCornerCount: 0, agentState: null });
  expect(deck!.openCorners[0]).not.toHaveProperty('attention', true);
  await ci('failing');
  expect(await state()).toBe('idle');
  console.info('Demonstrated CORNER-STATE: live work is Working, pending CI is Review, failing checks alone are Idle');
});
it.each(['pending', 'passing'])(
  'Reproduction CI-REVIEW: a human merge-yes request stays Waiting with %s checks',
  async (checks) => {
    await ci(checks);
    await db.query(
      `UPDATE agent_commands SET private_payload=jsonb_build_object('kind','order','text','Work','authorId',$1::text,'fromRoomId',$2::text) WHERE id='opening-order'`,
      [HUMAN, ROOM],
    );
    const { reportToCommander } = await import('./commander.js');
    await reportToCommander(db, C, WORKER, 'needs-decision: Please approve this merge?');
    expect(await state()).toBe('waiting');
    const deck = await phone.liveChatCornerStatus(ROOM, HUMAN);
    expect(deck).toMatchObject({ waitingCornerCount: 1 });
    expect(deck!.openCorners[0]).toMatchObject({ state: 'waiting', blocker: { kind: 'message' } });
  },
);
it.each([
  ['agent', 'pending', 'review'],
  ['human', 'pending', 'waiting'],
  ['agent', 'unreported', 'review'],
  ['human', 'unreported', 'waiting'],
] as const)(
  'Reproduction R1: a %s commander blocked report during %s checks is %s',
  async (kind, checks, expected) => {
    if (checks === 'pending') await ci('pending');
    else await unreportedHead();
    const recipient = kind === 'agent' ? COMMANDER : HUMAN;
    await db.query(
      `UPDATE agent_commands SET private_payload=jsonb_build_object('kind','order','text','Work','authorId',$1::text,'fromRoomId',$2::text) WHERE id='opening-order'`,
      [recipient, ROOM],
    );
    const { reportToCommander } = await import('./commander.js');
    await reportToCommander(db, C, WORKER, 'blocked: awaiting CI and review');
    expect(await state()).toBe(expected);
    const row = (await phone.readCorners(ROOM, HUMAN))!.corners[0]!;
    expect(row.state).toBe(expected);
    expect(
      (await phone.readChats(WS, HUMAN))!.chats.find((chat) => chat.room.id === ROOM)?.openCorners?.[0]
        ?.state,
    ).toBe(expected);
    const deck = await phone.liveChatCornerStatus(ROOM, HUMAN);
    expect(deck!.openCorners[0]?.state).toBe(expected);
    if (expected === 'waiting') {
      expect(deck).toMatchObject({ waitingCornerCount: 1 });
    } else {
      expect(row.blocker).toBeUndefined();
      expect(deck).toMatchObject({ waitingCornerCount: 0 });
    }
    console.info(
      `Demonstrated Reproduction R1: ${kind} commander blocked report during ${checks} checks is ${expected}`,
    );
  },
);
it('Reproduction R1: a human hold still waits when an older agent-commander report sits under pending CI', async () => {
  await ci('pending');
  const { reportToCommander } = await import('./commander.js');
  await reportToCommander(db, C, WORKER, 'blocked: awaiting CI and review');
  await db.query(
    `UPDATE corner_report_blockers SET created_at=now()-interval '1 minute' WHERE corner_id=$1`,
    [C],
  );
  await phone.execute('setCornerHold', { cornerId: C }, HUMAN);
  expect(await state()).toBe('waiting');
  const row = (await phone.readCorners(ROOM, HUMAN))!.corners[0]!;
  expect(row).toMatchObject({ state: 'waiting' });
  expect(
    (await phone.readChats(WS, HUMAN))!.chats.find((chat) => chat.room.id === ROOM)?.openCorners?.[0]
      ?.state,
  ).toBe('waiting');
  console.info(
    'Demonstrated Reproduction R1: human hold stays waiting while an older agent-commander report sits under pending CI',
  );
});
it('single-use gap deadlines survive restart and a resume inside the gap sends no alert', async () => {
  await turn();
  await runCornerAttention(db);
  await end(WORKER, 20);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(0);
  const live = new LiveHub();
  const errors: unknown[] = [];
  const recovered = new CornerAttentionDeadlines(db, live, (error) => errors.push(error));
  await recovered.start();
  recovered.stop();
  expect(errors).toEqual([]);
  await turn();
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(0);
  await end(WORKER, 40);
  await runCornerAttention(db);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(1);
});
it('failing checks alone are idle immediately with one alert and no repair deadline', async () => {
  await ci('failing');
  expect(await state()).toBe('idle');
  const attention = await refreshCornerAttention(db, C);
  expect(attention!.deadlines).toEqual([]);
  await runCornerAttention(db);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(1);
  expect((await commanderFlags())[0]!.source.body).toBe('blocked: Corner Corner is idle. Resume it, set a hold, or close it.');
});
it('an agent commander with inherited corner access wakes inside it, not the parent Room', async () => {
  await ci('failing');
  expect(await state()).toBe('idle');
  // Access comes only from the parent Room roster; no legacy corner-membership row.
  await refreshCornerAttention(db, C);
  const inCorner = (await readAgentCommands(db, C, COMMANDER)).commands
    .filter(command => command.source.body.includes('is idle. Resume it'));
  const inRoom = (await readAgentCommands(db, ROOM, COMMANDER)).commands
    .filter(command => command.source.body.includes('is idle. Resume it'));
  expect(inCorner).toHaveLength(1);
  expect(inRoom).toHaveLength(0);
});

it('pending CI past 30 minutes schedules no expiry, including after a new head', async () => {
  await ci('pending');
  await db.query(
    `UPDATE corner_attention_spans SET ci_started_at=now()-interval '31 minutes' WHERE corner_id=$1`,
    [C],
  );
  const before = await refreshCornerAttention(db, C);
  expect(before!.deadlines).toEqual([]);
  expect(await state()).toBe('review');
  expect(await commanderFlags()).toHaveLength(0);
  await db.query(
    `UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{pr,headSha}','"next"') WHERE corner_id=$1`,
    [C],
  );
  const after = await refreshCornerAttention(db, C);
  expect(after!.deadlines).toEqual([]);
  expect(await state()).toBe('review');
});
it.each([WORKER, REVIEWER])(
  'Reproduction IDLE-1: a standing schedule suppresses alerts without changing Idle (%s)',
  async (agent) => {
    await db.query(
      `INSERT INTO agent_subscriptions(id,workspace_id,room_id,agent_id,source,event,prompt)
    VALUES(gen_random_uuid(),$1,$2,$3,'room','check-passed','Continue')`,
      [WS, C, agent],
    );
    await db.query(
      `INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,message,cadence,next_run_at)
    VALUES(gen_random_uuid(),$1,$2,$3,$3,'Continue','{"kind":"interval","everySeconds":86400}',now()+interval '1 day')`,
      [WS, C, agent],
    );
    await runCornerAttention(db);
    expect(await state()).toBe('idle');
    expect(await commanderFlags()).toHaveLength(0);
  },
);
it('a merge hold shows Waiting with its real message and sends no extra wake', async () => {
  const { holdId } = await phone.execute('setCornerHold', { cornerId: C }, HUMAN);
  const row = (await phone.readCorners(ROOM, HUMAN))!.corners[0]!;
  expect(row).toMatchObject({ state: 'waiting', blocker: { kind: 'merge-hold' } });
  expect(
    (await db.query('SELECT text FROM messages WHERE id=$1', [row.itemId])).rows[0],
  ).toMatchSnapshot('approved hold source line');
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(0);
  await phone.execute('setCornerHold', { cornerId: C, releaseHoldId: holdId }, HUMAN);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(1);
});
it.each([['agent','blocked'],['agent','needs-decision'],['human','blocked'],['human','needs-decision']] as const)(
  'an unanswered %s commander %s report waits even outside corner membership',
  async (kind,status) => {
    const recipient = kind === 'agent' ? COMMANDER : HUMAN;
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
      ROOM,
      recipient,
    ]);
    // Its return address is another member Room; access to the corner is intentionally absent.
    const returnRoom = '44444444-4444-4444-8444-444444444444';
    await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Return',$3)`, [
      returnRoom,
      WS,
      HUMAN,
    ]);
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [WS, returnRoom, recipient],
    );
    await db.query(
      `UPDATE agent_commands SET private_payload=jsonb_build_object('kind','order','text','Work','authorId',$1::text,'fromRoomId',$2::text)
    WHERE id='opening-order'`,
      [recipient, returnRoom],
    );
    const { reportToCommander } = await import('./commander.js');
    await reportToCommander(db, C, WORKER, `${status}: Choose a direction.`);
    // A remaining Room member can inspect the same server-owned state.
    expect(await state()).toBe('waiting');
    const blocker = (
      await db.query<{ message_id: string; report_id: string }>(
        `SELECT * FROM corner_report_blockers WHERE corner_id=$1`,
        [C],
      )
    ).rows[0]!;
    expect(blocker).toBeDefined();
    await runCornerAttention(db);
    expect(
      (
        await db.query(
          `SELECT 1 FROM agent_commands WHERE private_payload->>'text' LIKE '%is idle.%'`,
        )
      ).rowCount,
    ).toBe(0);
    await db.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES('answer',$1,$2,'Proceed','message')`,
      [returnRoom, recipient],
    );
    expect(await state()).toBe('idle');
  },
);

it.each(['blocked', 'needs-decision'] as const)(
  'Reproduction CORNER-STATE-SAME-REPORT: %s to an agent in this corner opens its persisted report card',
  async (status) => {
    await db.query(
      `UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{fromRoomId}',to_jsonb($1::text))
       WHERE id='opening-order'`, [C],
    );
    const { reportToCommander } = await import('./commander.js');
    const text = `${status}: Choose a direction.`;
    const report = await reportToCommander(db, C, WORKER, text);
    await db.query(`UPDATE agent_turns SET status='complete' WHERE room_id=$1`, [C]);
    const row = (await phone.readCorners(ROOM, HUMAN))!.corners[0]!;
    expect(row).toMatchObject({ state: 'waiting', blocker: { kind: 'message' } });
    expect(row.itemId).toBeDefined();
    expect(row.itemId).not.toBe(report.id);
    const source = await db.query<{ id: string; card: { text: string } }>(
      `SELECT id,card FROM messages WHERE room_id=$1 AND id=$2`, [C, row.itemId],
    );
    expect(source.rows).toHaveLength(1);
    expect(source.rows[0]!.card).toMatchObject({ kind: 'report', status, text });
    const page = await phone.readRoom(C, HUMAN);
    expect(page!.messages.find(item => item.id === row.itemId)).toMatchObject({
      agentCommand: { kind: 'report', status, text },
    });
    const blocker = (await db.query<{ message_id: string }>(
      `SELECT message_id FROM corner_report_blockers WHERE corner_id=$1 AND person_id=$2`,
      [C, COMMANDER],
    )).rows[0]!;
    expect(blocker.message_id).toBe(row.itemId);
    console.info(`Demonstrated CORNER-STATE-SAME-REPORT ${status}: Waiting target resolves to the persisted report card in the corner conversation`);
  },
);

it('recovers and fires the gap deadline once across two server instances', async () => {
  await turn();
  await runCornerAttention(db);
  await end();
  vi.useFakeTimers();
  const live = new LiveHub();
  const errors: unknown[] = [];
  const a = new CornerAttentionDeadlines(db, live, (error) => errors.push(error));
  const b = new CornerAttentionDeadlines(db, live, (error) => errors.push(error));
  try {
    await a.start();
    await b.start();
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(31000);
    await db.query('SELECT 1');
    expect(await commanderFlags()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    a.stop();
    b.stop();
    vi.useRealTimers();
  }
});
it('Reproduction IDLE-1: pending CI does not arm a deadline or an idle alert', async () => {
  await ci('pending');
  await db.query(
    `UPDATE corner_attention_spans SET ci_started_at=now()-interval '31 minutes' WHERE corner_id=$1`,
    [C],
  );
  vi.useFakeTimers();
  const live = new LiveHub();
  const errors: unknown[] = [];
  const deadlines = new CornerAttentionDeadlines(db, live, (error) => errors.push(error));
  try {
    await deadlines.start();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1801000);
    await db.query('SELECT 1');
    expect(await state()).toBe('review');
    expect(await commanderFlags()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    deadlines.stop();
    vi.useRealTimers();
  }
});

it('Reproduction CORNER-REVIEW-ROLE: a dispatched reviewer stays Review after Room settings change until its turn ends', async () => {
  await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`,
    [C,JSON.stringify({lifecycle:'in-review',checks:'passing',pr:{headSha:'review-head'}})]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,system_event)
    VALUES('review-source',$1,$2,'Review requested','system',$3::jsonb)`,
    [C,COMMANDER,JSON.stringify({kind:'check-passed',object:{headSha:'review-head'}})]);
  const dispatch=await createAgentCommand(db,{id:'review-dispatch',roomId:C,agentId:REVIEWER,
    sourceMessageId:'review-source',reason:'corner_review_dispatch'});
  expect(dispatch).toBeTruthy();
  const serviceStates=async()=>[await state(),(await phone.readCorners(ROOM,HUMAN))!.corners[0]!.state];
  // A queued dispatch is not an active reviewer turn.
  expect(await serviceStates()).toEqual(['working','working']);
  await daemon.execute('claimAgentCommand',{roomId:C,commandId:dispatch!.id,generationId:'review-proof'},REVIEWER);
  expect(await serviceStates()).toEqual(['review','review']);
  await db.query(`UPDATE rooms SET reviewer_agent_id=NULL,reviewer_fallback_ids='{}' WHERE id=$1`,[ROOM]);
  expect(await serviceStates()).toEqual(['review','review']);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(0);
  await end(REVIEWER,40);
  // Its still-claimed command cannot preserve Review after the terminal receipt.
  expect(await serviceStates()).toEqual(['idle','idle']);
  console.info('Demonstrated CORNER-REVIEW-ROLE: getCornerRestoreState and PhoneService.readCorners preserve Review across reviewer settings changes, then leave Review on turn completion');
});

// The production attention entrypoint and command inbox are the stand-in for a
// background production alert; no live corner is deliberately stalled here.
it('Reproduction IDLE-1: incidental orders cannot redirect an idle alert from its opening commander', async () => {
  await createAgentCommand(db, {
    id: 'incidental-order', roomId: C, agentId: WORKER, sourceMessageId: null, reason: 'order',
    privatePayload: { kind: 'order', text: 'Check something', authorId: REVIEWER, fromRoomId: ROOM },
  });
  await db.query("UPDATE agent_commands SET state='complete' WHERE id='incidental-order'");
  await db.query('DELETE FROM agent_turns WHERE room_id=$1', [C]);
  await db.query('UPDATE corner_attention_spans SET last_turn_ended_at=NULL WHERE corner_id=$1', [C]);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(1);
  expect((await readAgentCommands(db, ROOM, REVIEWER)).commands).toHaveLength(0);
  expect((await readAgentCommands(db, C, WORKER)).commands).toHaveLength(0);
});
it.each(['archived', 'closed', 'landed'])('Reproduction IDLE-1: %s corners never alert', async (kind) => {
  if (kind === 'archived') await db.query('UPDATE rooms SET archived_at=now() WHERE id=$1', [C]);
  else await db.query(`UPDATE corner_facts SET workflow_state=$2,lifecycle=jsonb_build_object('lifecycle',$2::text) WHERE corner_id=$1`, [C, kind]);
  await refreshCornerAttention(db, C);
  expect(await commanderFlags()).toHaveLength(0);
});
it.each([WORKER, REVIEWER])('Reproduction IDLE-1: live turns suppress alerts (%s)', async (agent) => {
  await turn(agent);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(0);
  await end(agent, 40);
  await runCornerAttention(db);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(1);
});

it('Reproduction IDLE-1: subscriptions alone do not hide real idle work', async () => {
  await db.query(`INSERT INTO agent_subscriptions(id,workspace_id,room_id,agent_id,source,event,prompt)
    VALUES(gen_random_uuid(),$1,$2,$3,'room','check-passed','Continue')`, [WS,C,WORKER]);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(1);
});
it.each(['expired', 'exhausted', 'removed'])('Reproduction IDLE-1: %s scheduled waits still allow real idle alerts', async (kind) => {
  await db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,message,cadence,next_run_at,max_runs,run_count)
    VALUES(gen_random_uuid(),$1,$2,$3,$3,'Continue','{"kind":"interval","everySeconds":86400}',now()+interval '1 day',1,0)`, [WS,C,WORKER]);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(0);
  if (kind === 'removed') await db.query('DELETE FROM agent_schedules WHERE room_id=$1',[C]);
  else if (kind === 'expired') await db.query("UPDATE agent_schedules SET next_run_at=now()-interval '1 minute' WHERE room_id=$1",[C]);
  else await db.query('UPDATE agent_schedules SET run_count=max_runs WHERE room_id=$1',[C]);
  await runCornerAttention(db);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(1);
});
it('Reproduction IDLE-1: an unfetched new PR head stays quiet beyond the display deadline', async () => {
  await ci('pending');
  await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{checksSummary}',
    '{"status":"unknown","total":0}') WHERE corner_id=$1`, [C]);
  await db.query("UPDATE corner_attention_spans SET ci_started_at=now()-interval '31 minutes' WHERE corner_id=$1", [C]);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(0);
});

it('Reproduction IDLE-1: a running workflow label without a live turn still alerts', async () => {
  await db.query(`UPDATE corner_facts SET lifecycle='{"lifecycle":"running"}' WHERE corner_id=$1`, [C]);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(1);
});

async function checksHead(sha: string, checks: 'pending' | 'failing') {
  await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
    C,
    JSON.stringify({
      lifecycle: 'in-review',
      checks,
      pr: { number: 2890, url: 'https://github.com/o/r/pull/2890', headSha: sha },
      checksSummary: {
        status: checks,
        total: 34,
        updatedAt: Date.now() / 1000,
        checks: [{
          name: 'SERVER SUITE',
          status: checks === 'pending' ? 'pending' : 'failed',
          url: 'https://github.com/o/r/actions/runs/1',
        }],
        failing: checks === 'failing' ? ['SERVER SUITE'] : [],
      },
    }),
  ]);
}

it('Reproduction FIC-1: a live repair stays Working after an hour with no idle alert', async () => {
  await ci('failing');
  await turn(WORKER);
  expect(await state()).toBe('working');
  await db.query(
    `UPDATE corner_attention_spans SET ci_started_at=now()-interval '60 minutes' WHERE corner_id=$1`,
    [C],
  );
  await runCornerAttention(db);
  expect(await state()).toBe('working');
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]!.state).toBe('working');
  expect((await phone.liveChatCornerStatus(ROOM, HUMAN))!.openCorners[0]!.state).toBe('working');
  const stalls = (await commanderFlags()).filter((command) => command.source.body.includes('is idle'));
  expect(stalls).toHaveLength(0);
  await runCornerAttention(db);
  expect((await commanderFlags()).filter((command) => command.source.body.includes('is idle'))).toHaveLength(0);
  const reviewer = (await readAgentCommands(db, C, REVIEWER)).commands;
  expect(reviewer.filter((command) =>
    command.reason === 'corner_review_dispatch' || command.reason === 'subscribed_event')).toHaveLength(0);
});

it('Reproduction RED-STALL-PARTIAL: three failed checks wake the implementer while five shards are still pending', async () => {
  const heads = [1, 2, 3, 4].map((n) => n.toString(16).padStart(40, '0'));
  for (const sha of heads) await checksHead(sha, 'pending');
  const { reportToCommander } = await import('./commander.js');
  await reportToCommander(
    db,
    C,
    WORKER,
    'blocked: Four pushes without PASS. The reviewer cannot start until checks are green.',
  );
  const sha = heads[3]!;
  await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
    C,
    JSON.stringify({
      lifecycle: 'in-review',
      checks: 'failing',
      pr: { number: 2890, url: 'https://github.com/o/r/pull/2890', headSha: sha },
      checksSummary: {
        status: 'failing',
        total: 8,
        updatedAt: Date.now() / 1000,
        failing: ['MOBILE SUITE', 'FRAME-BUDGET', 'STATE-UPGRADE'],
        checks: [
          { name: 'MOBILE SUITE', status: 'failed' },
          { name: 'FRAME-BUDGET', status: 'failed' },
          { name: 'STATE-UPGRADE', status: 'failed' },
          { name: 'SERVER SUITE SHARD 1', status: 'pending' },
          { name: 'SERVER SUITE SHARD 2', status: 'pending' },
          { name: 'SERVER SUITE SHARD 3', status: 'pending' },
          { name: 'SERVER SUITE SHARD 4', status: 'pending' },
          { name: 'SERVER SUITE SHARD 5', status: 'pending' },
        ],
      },
    }),
  ]);
  await systemLine(db, {
    roomId: C,
    authorId: WORKER,
    subject: { kind: 'github', name: 'GitHub' },
    verb: 'found failing checks on',
    kind: 'check-failed',
    object: { text: 'MOBILE SUITE, FRAME-BUDGET, STATE-UPGRADE', headSha: sha },
    payload: { runInProgress: true },
  });
  const worker = (await readAgentCommands(db, C, WORKER)).commands;
  const repair = worker.find((command) => command.reason === 'corner_check');
  expect(repair?.source.body).toContain('MOBILE SUITE');
  expect(repair?.source.body).toContain('FRAME-BUDGET');
  expect(repair?.source.body).toContain('STATE-UPGRADE');
  expect(repair?.source.body).toContain('Fix them and push now');
  expect(repair?.source.body).toContain('still running');
  const reviewer = (await readAgentCommands(db, C, REVIEWER)).commands;
  expect(reviewer.filter((command) =>
    command.reason === 'corner_review_dispatch' || command.reason === 'subscribed_event')).toHaveLength(0);
  await daemon.execute('claimAgentCommand', {
    roomId: C, commandId: repair!.id, generationId: 'partial-red',
  }, WORKER);
  await daemon.execute('postAgentTurnReceipt', {
    roomId: C, requestId: repair!.turnRequestId, generationId: 'partial-red', status: 'complete',
  }, WORKER);
  await runCornerAttention(db);
  await runCornerAttention(db);
  expect(await state()).toBe('waiting');
  expect((await commanderFlags()).filter(command => command.source.body.includes('is idle'))).toHaveLength(0);
});

it('Reproduction FIC-1: a blocked report with pending CI stays Review without an idle alert', async () => {
  await ci('pending');
  await runCornerAttention(db);
  expect(await state()).toBe('review');
  expect((await commanderFlags()).filter((command) => command.source.body.includes('is idle'))).toHaveLength(0);
  const { reportToCommander } = await import('./commander.js');
  await reportToCommander(db, C, WORKER, 'blocked: Waiting on the reviewer until checks are green.');
  expect(await state()).toBe('review');
  await runCornerAttention(db);
  await runCornerAttention(db);
  const stalls = (await commanderFlags()).filter((command) => command.source.body.includes('is idle'));
  expect(stalls).toHaveLength(0);
  const reviewer = (await readAgentCommands(db, C, REVIEWER)).commands;
  expect(reviewer.filter((command) =>
    command.reason === 'corner_review_dispatch' || command.reason === 'subscribed_event')).toHaveLength(0);
});

it.each(['blocked:', 'needs-decision:'])('FIC-1: red checks with an open %s report stay Waiting', async (prefix) => {
  await ci('failing');
  const { reportToCommander } = await import('./commander.js');
  await reportToCommander(db, C, WORKER, `${prefix} Please resolve this decision.`);
  expect(await state()).toBe('waiting');
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]!.state).toBe('waiting');
  await runCornerAttention(db);
  await runCornerAttention(db);
  expect((await commanderFlags()).filter(command => command.source.body.includes('is idle'))).toHaveLength(0);
});


it.each(['failed', 'complete'])('Reproduction IDLE-STORM: commander %s does not reopen its own idle episode', async (status) => {
  await ci('passing');
  await refreshCornerAttention(db, C);
  expect(await commanderFlags()).toHaveLength(1);
  await turn(COMMANDER);
  await refreshCornerAttention(db, C);
  await db.query(`UPDATE agent_turns SET status=$2 WHERE room_id=$1 AND agent_id=$3`, [C,status,COMMANDER]);
  await db.query(`UPDATE corner_attention_spans SET last_turn_ended_at=NULL WHERE corner_id=$1`, [C]);
  await refreshCornerAttention(db, C);
  expect(await commanderFlags()).toHaveLength(1);
});

it('Reproduction IDLE-STORM: new worker work opens an episode after the automatic report cooldown', async () => {
  await refreshCornerAttention(db, C);
  expect(await commanderFlags()).toHaveLength(1);
  await turn(WORKER);
  await refreshCornerAttention(db, C);
  await end(WORKER,40);
  const deferred = await refreshCornerAttention(db, C);
  expect(deferred!.deadlines).toHaveLength(1);
  expect(await commanderFlags()).toHaveLength(1);
  await db.query(`UPDATE automatic_report_wakes SET next_at=now()-interval '1 second' WHERE corner_id=$1`, [C]);
  await refreshCornerAttention(db, C);
  expect(await commanderFlags()).toHaveLength(2);
});

it.each(['success','expiry'])('Reproduction STARTUP-STORM: startup failures across Rooms pause automatic inbox delivery and claims, with one owner notice and %s recovery', async (recovery) => {
  for (let i=0;i<5;i++) {
    const roomId = i%2 ? ROOM : C;
    const command = await createAgentCommand(db, { id:`startup-${i}`,roomId,agentId:WORKER,
      sourceMessageId:null,reason:'order',privatePayload:{kind:'order',authorId:COMMANDER,fromRoomId:ROOM,text:'Work'} });
    await daemon.execute('claimAgentCommand',{roomId,commandId:command!.id,generationId:`startup-${i}`},WORKER);
    await daemon.execute('postAgentTurnReceipt',{roomId,requestId:command!.turn_request_id,
      generationId:`startup-${i}`,status:'failed',toolCalls:0,reason:'activation failed',reasonKind:'workspace-failure',
      trace:{totalMs:5000,attempts:[{attempt:1,phases:{activation:5000},tools:[]}]}},WORKER);
  }
  // The failure handler can requeue the very command that opened the pause.
  await db.query(`UPDATE agent_commands SET state='pending' WHERE id='startup-4'`);
  expect((await db.query(`SELECT startup_wake_after FROM agent_commands WHERE id='startup-4'`)).rows[0]!.startup_wake_after).not.toBeNull();
  const auto = await createAgentCommand(db,{id:'paused-auto',roomId:C,agentId:WORKER,sourceMessageId:null,
    reason:'order',privatePayload:{kind:'order',authorId:COMMANDER,fromRoomId:ROOM,text:'Automatic work'}});
  expect((await readAgentCommands(db,C,WORKER)).commands).toHaveLength(0);
  expect((await db.query(`SELECT 1 FROM agent_turns WHERE request_id=$1`,[auto!.turn_request_id])).rowCount).toBe(0);
  await expect(daemon.execute('claimAgentCommand',{roomId:C,commandId:auto!.id,generationId:'cached'},WORKER)).rejects.toThrow();
  await db.query('UPDATE agents SET wake_batch_minutes=1 WHERE agent_id=$1',[WORKER]);
  const batched = await createAgentCommand(db,{id:'paused-batch',roomId:C,agentId:WORKER,sourceMessageId:null,
    reason:'order',privatePayload:{kind:'order',authorId:COMMANDER,fromRoomId:ROOM,text:'Batched automatic work'}});
  await db.query(`UPDATE agent_commands SET wake_after=now()-interval '1 second' WHERE id=$1`,[batched!.id]);
  await flushDueCommanderWakes(db);
  expect((await db.query(`SELECT wake_after FROM agent_commands WHERE id=$1`,[batched!.id])).rows[0]!.wake_after).not.toBeNull();
  const notices = await db.query(`SELECT id FROM messages WHERE text LIKE '%Automatic wakes are paused for 5 minutes.%'`);
  expect(notices.rows).toHaveLength(1);
  // A replayed terminal receipt must not add failures or notices.
  await db.transaction(tx=>recordStartupWakeOutcome(tx,{roomId:C,requestId:'startup-4',generationId:'startup-4',
    status:'failed',toolCalls:0,reasonKind:'workspace-failure'},WORKER));
  expect((await db.query(`SELECT id FROM messages WHERE text LIKE '%Automatic wakes are paused for 5 minutes.%'`)).rows).toHaveLength(1);
  await post('human-recovery-source','Try again',HUMAN);
  const human = await createAgentCommand(db,{id:'human-recovery',roomId:C,agentId:WORKER,
    sourceMessageId:'human-recovery-source',reason:'human_tag'});
  expect((await readAgentCommands(db,C,WORKER)).commands.map(command=>command.id)).toContain(human!.id);
  if (recovery === 'expiry') {
    await db.query(`UPDATE agent_startup_backoff SET paused_until=now()-interval '1 second' WHERE agent_id=$1`,[WORKER]);
    await db.query(`UPDATE agent_commands SET startup_wake_after=now()-interval '1 second' WHERE agent_id=$1 AND startup_wake_after IS NOT NULL`,[WORKER]);
    await flushDueCommanderWakes(db);
    expect((await readAgentCommands(db,C,WORKER)).commands.map(command=>command.id)).toContain(auto!.id);
    expect((await db.query(`SELECT startup_wake_after FROM agent_commands WHERE id=$1`,[auto!.id])).rows[0]!.startup_wake_after).toBeNull();
    return;
  }
  await daemon.execute('claimAgentCommand',{roomId:C,commandId:human!.id,generationId:'recovered'},WORKER);
  await daemon.execute('postAgentTurnReceipt',{roomId:C,requestId:human!.turn_request_id,generationId:'recovered',status:'complete'},WORKER);
  expect((await readAgentCommands(db,C,WORKER)).commands.map(command=>command.id)).toContain(auto!.id);
  expect((await db.query(`SELECT paused_until FROM agent_startup_backoff WHERE agent_id=$1`,[WORKER])).rows[0]!.paused_until).toBeNull();
});


it.each(['human','push','check','reviewer'])('Reproduction IDLE-STORM: a real %s event can open a fresh idle episode', async (event) => {
  await ci('passing');
  await refreshCornerAttention(db,C);
  await db.query(`UPDATE automatic_report_wakes SET next_at=now()-interval '1 second' WHERE corner_id=$1`,[C]);
  if (event === 'human') await post('human-change','Continue this work',HUMAN);
  if (event === 'push') await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{pr,headSha}','"new-head"') WHERE corner_id=$1`,[C]);
  if (event === 'check') await ci('failing');
  if (event === 'reviewer') { await turn(REVIEWER); await refreshCornerAttention(db,C); await end(REVIEWER,40); }
  await refreshCornerAttention(db,C);
  expect(await commanderFlags()).toHaveLength(2);
});
