import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { systemLine } from './system-line.js';
import { cornerOwedSchemaSql } from './corner-owed.js';
import { migrate } from './database.js';
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
const commanderFlags = async () => (await readAgentCommands(db, ROOM, COMMANDER)).commands;

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
it('Reproduction CORNER-STATE: the Room list and corner inspection agree on all four states and CI target', async () => {
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
  expect(await state()).toBe('waiting');
  const row = (await phone.readCorners(ROOM, HUMAN))!.corners[0]!;
  expect(row).toMatchObject({
    state: 'waiting',
    blocker: { kind: 'ci', url: 'https://github.com/o/r/actions/runs/1' },
  });
  expect(
    (await phone.readChats(WS, HUMAN))!.chats.find((row) => row.room.id === ROOM)?.openCorners?.[0]
      ?.state,
  ).toBe('waiting');
  await ci('failing');
  expect(await state()).toBe('idle');
  console.info(
    'Demonstrated Reproduction CORNER-STATE: list + inspection Working, Review, Waiting with CI job target, then Idle after failure',
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
it('CI failure and the stuck-CI deadline each open exactly one Idle stretch', async () => {
  await ci('pending');
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(0);
  await ci('failing');
  await runCornerAttention(db);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(1);
  expect((await commanderFlags())[0]!.source.body).toMatchSnapshot('approved idle alert');
  await ci('pending');
  await runCornerAttention(db);
  await db.query(
    `UPDATE corner_attention_spans SET ci_started_at=now()-interval '31 minutes' WHERE corner_id=$1`,
    [C],
  );
  await runCornerAttention(db);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(2);
  expect(await state()).toBe('idle');
});
it('CI progress cannot reset its safety deadline; a new head resets it', async () => {
  await ci('pending');
  await db.query(
    `UPDATE corner_attention_spans SET ci_started_at=now()-interval '29 minutes' WHERE corner_id=$1`,
    [C],
  );
  await ci('pending');
  const before = await refreshCornerAttention(db, C);
  expect(before!.deadlines[0]! - Date.now()).toBeLessThan(61000);
  await db.query(
    `UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{pr,headSha}','"next"') WHERE corner_id=$1`,
    [C],
  );
  const after = await refreshCornerAttention(db, C);
  expect(after!.deadlines[0]! - Date.now()).toBeGreaterThan(29 * 60000);
});
it.each([WORKER, REVIEWER])(
  'self subscriptions and schedules never suppress Idle (%s)',
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
    expect(await commanderFlags()).toHaveLength(1);
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
it('recovers and fires the stuck CI deadline without a repeating timer', async () => {
  await ci('pending');
  vi.useFakeTimers();
  const live = new LiveHub();
  const errors: unknown[] = [];
  const deadlines = new CornerAttentionDeadlines(db, live, (error) => errors.push(error));
  try {
    await deadlines.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1801000);
    await db.query('SELECT 1');
    expect(await state()).toBe('idle');
    expect(await commanderFlags()).toHaveLength(1);
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
