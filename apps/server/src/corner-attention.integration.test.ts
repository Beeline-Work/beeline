import { cornerReportWaiting } from './corner-state.js';
import { cornerWaitingReportSql } from './corner-waiting-report.js';
import { recordStartupWakeOutcome } from './startup-wake-backoff.js';
import { cornerIdleSql } from './corner-idle.js';
import { cornerOwedAnswerTimesSql } from './corner-owed.js';
import { CommanderWakeDeadlines, flushDueCommanderWakes } from './commander-wakes.js';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { systemLine } from './system-line.js';
import { cornerOwedSchemaSql } from './corner-owed.js';
import { migrate, PostgresDatabase, type SqlDatabase } from './database.js';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { seedCornerOpening, PgliteDatabase, recordCornerRun } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import { createAgentCommand, readAgentCommands, noteBlockedCornerChecks } from './agent-command.js';
import {
  CORNER_ATTENTION_SCHEMA,
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
  await db.query('DELETE FROM agent_connections');
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
  await db.query(`INSERT INTO corner_facts(corner_id,owner_agent_id,worker_agent_id,objective) VALUES($1,$2,$3,'Truthful corner states')`, [C, WORKER, WORKER]);
  await seedCornerOpening(db, { cornerId: C, agentId: WORKER, commissionedBy: HUMAN });
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
  await db.query("UPDATE rooms SET created_at=now()-interval '1 day' WHERE id=$1", [C]);
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

it('MODEL-UNKNOWN: ended model work suppresses automatic idle but permits a new explicit human command', async () => {
  const command = (await wake())!;
  await db.query(`UPDATE agent_commands SET state='claimed',generation_id='unknown-model',
    turn_owner_connection_id='synthetic-ended-model',turn_owner_epoch=1,lease_expires_at=now()+interval '1 hour' WHERE id=$1`, [command.id]);
  await db.query(`DELETE FROM agent_turns WHERE room_id=$1`, [C]);
  expect((await db.query<{worker_active: boolean}>(cornerIdleSql('$1'), [C])).rows[0]?.worker_active).toBe(true);
  // Persisted owner-end evidence, as produced by the separately proved actual
  // model receipt transaction. Provider outcome is intentionally not changed.
  await db.query(`INSERT INTO agent_command_owner_ends(command_id,generation_id,model_request_id)
    VALUES($1,'unknown-model',NULL)`, [command.id]);
  const idle = (await db.query<{idle_eligible: boolean; suppressed: boolean; worker_active: boolean}>(cornerIdleSql('$1'), [C])).rows[0]!;
  expect(idle.worker_active).toBe(false);
  expect(idle.suppressed).toBe(true);
  expect(idle.idle_eligible).toBe(false);
  await refreshCornerAttention(db, C);
  expect(await commanderFlags()).toHaveLength(0);
  await post('explicit-after-unknown', 'Do this new task', HUMAN);
  const next = (await createAgentCommand(db, {
    id: 'explicit-after-unknown-command', roomId: C, agentId: WORKER,
    sourceMessageId: 'explicit-after-unknown', reason: 'human_tag',
  }))!;
  expect((await readAgentCommands(db, C, WORKER)).commands.map(item => item.id)).toContain(next.id);
  await daemon.execute('claimAgentCommand', {
    roomId: C, commandId: next.id, generationId: 'new-explicit-generation',
  }, WORKER);
  expect((await db.query('SELECT state,generation_id FROM agent_commands WHERE id=$1', [command.id])).rows)
    .toEqual([{state: 'claimed', generation_id: 'unknown-model'}]);
});

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
    `UPDATE agent_turns SET ended_at=clock_timestamp()-make_interval(secs=>$2) WHERE room_id=$1 AND status<>'working' AND agent_id=$3`,
    [C, age, agent],
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
  expect(await state()).toBe('idle');
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
  'Reproduction HEADER-STATE-4: a human merge-yes request with %s checks',
  async (checks) => {
    await ci(checks);
    await db.query(
      `UPDATE agent_commands SET private_payload=jsonb_build_object('kind','order','text','Work','authorId',$1::text,'fromRoomId',$2::text) WHERE id='opening-order'`,
      [HUMAN, ROOM],
    );
    const { reportToCommander } = await import('./commander.js');
    await reportToCommander(db, C, WORKER, 'needs-decision: Please approve this merge?');
    const expected = checks === 'pending' ? 'review' : 'waiting';
    expect(await state()).toBe(expected);
    const deck = await phone.liveChatCornerStatus(ROOM, HUMAN);
    expect(deck).toMatchObject({ waitingCornerCount: checks === 'pending' ? 0 : 1 });
    expect(deck!.openCorners[0].state).toBe(expected);
  },
);
it.each([
  ['agent', 'pending', 'review'],
  ['human', 'pending', 'review'],
  ['agent', 'unreported', 'review'],
  ['human', 'unreported', 'review'],
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
it.each(['pending', 'unreported'] as const)(
  'Reproduction R1: a lone human merge hold shows review during %s checks and waits once they pass',
  async (checks) => {
    if (checks === 'pending') await ci('pending');
    else await unreportedHead();
    await phone.execute('setCornerHold', { cornerId: C }, HUMAN);
    const shown = async () => ({
      state: await state(),
      row: (await phone.readCorners(ROOM, HUMAN))!.corners[0]!,
      chat: (await phone.readChats(WS, HUMAN))!.chats.find((chat) => chat.room.id === ROOM)?.openCorners?.[0],
      deck: (await phone.liveChatCornerStatus(ROOM, HUMAN))!,
    });
    const during = await shown();
    expect(during.state).toBe('review');
    expect(during.row).toMatchObject({ state: 'review' });
    expect(during.row.blocker).toBeUndefined();
    expect(during.chat?.state).toBe('review');
    expect(during.deck).toMatchObject({ waitingCornerCount: 0 });
    await ci('passing');
    const after = await shown();
    expect(after.state).toBe('waiting');
    expect(after.row).toMatchObject({ state: 'waiting', blocker: { kind: 'merge-hold', personId: HUMAN } });
    expect(after.chat?.state).toBe('waiting');
    expect(after.deck).toMatchObject({ waitingCornerCount: 1 });
    console.info(
      `Demonstrated Reproduction R1: a held corner reads ${during.row.state} during ${checks} checks and ${after.row.state} on the hold once they pass`,
    );
  },
);
it('Reproduction R1: a human hold beside an older agent-commander report stays review under pending CI', async () => {
  await ci('pending');
  const { reportToCommander } = await import('./commander.js');
  await reportToCommander(db, C, WORKER, 'blocked: awaiting CI and review');
  await db.query(
    `UPDATE agent_commands SET created_at=now()-interval '1 minute' WHERE private_payload->>'kind'='report' AND private_payload->>'fromRoomId'=$1::text`,
    [C],
  );
  await phone.execute('setCornerHold', { cornerId: C }, HUMAN);
  expect(await state()).toBe('review');
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]).toMatchObject({ state: 'review' });
  expect(
    (await phone.readChats(WS, HUMAN))!.chats.find((chat) => chat.room.id === ROOM)?.openCorners?.[0]
      ?.state,
  ).toBe('review');
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
    `UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{checksSummary,updatedAt}',to_jsonb(extract(epoch FROM now()-interval '31 minutes'))) WHERE corner_id=$1`,
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
  'Reproduction IDLE-1: a standing schedule shows Idle and suppresses alerts (%s)',
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
        `SELECT waiting.* FROM rooms waiting_corner CROSS JOIN LATERAL (${cornerWaitingReportSql('waiting_corner')}) waiting WHERE waiting_corner.id=$1`,
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
      `SELECT waiting.message_id FROM rooms waiting_corner CROSS JOIN LATERAL (${cornerWaitingReportSql('waiting_corner')}) waiting WHERE waiting_corner.id=$1 AND waiting.person_id=$2`,
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
  await refreshCornerAttention(db,C);
  vi.useFakeTimers();
  const live = new LiveHub();
  const errors: unknown[] = [];
  const a = new CommanderWakeDeadlines(db, live, (error) => errors.push(error));
  const b = new CommanderWakeDeadlines(db, live, (error) => errors.push(error));
  try {
    await a.start();
    await b.start();
    expect(vi.getTimerCount()).toBe(2);
    await db.query("UPDATE agent_commands SET wake_after=now()-interval '1 second' WHERE reason='report'");
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
    `UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{checksSummary,updatedAt}',to_jsonb(extract(epoch FROM now()-interval '31 minutes'))) WHERE corner_id=$1`,
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
  // A queued reviewer keeps the corner in review during its pickup window.
  expect(await serviceStates()).toEqual(['review','review']);
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
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(1);
  expect((await readAgentCommands(db, ROOM, REVIEWER)).commands).toHaveLength(0);
  expect((await readAgentCommands(db, C, WORKER)).commands).toHaveLength(0);
});
it.each(['archived', 'closed', 'landed'])('Reproduction IDLE-1: %s corners never alert', async (kind) => {
  if (kind === 'archived') await db.query('UPDATE rooms SET archived_at=now() WHERE id=$1', [C]);
  else {
    await db.query(`UPDATE corner_facts SET lifecycle=jsonb_build_object('lifecycle',$2::text) WHERE corner_id=$1`, [C, kind]);
    await recordCornerRun(db, C, kind);
  }
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
  await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{checksSummary,updatedAt}',to_jsonb(extract(epoch FROM now()-interval '31 minutes'))) WHERE corner_id=$1`, [C]);
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
    `UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{checksSummary,updatedAt}',to_jsonb(extract(epoch FROM now()-interval '60 minutes'))) WHERE corner_id=$1`,
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
  // Five shards are still pending, so the corner stays in review. The blocked
  // report waits until every check has settled.
  expect(await state()).toBe('review');
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
  await refreshCornerAttention(db, C);
  expect(await commanderFlags()).toHaveLength(1);
});

it('Reproduction IDLE-STORM: new worker work opens an episode after the automatic report cooldown', async () => {
  await refreshCornerAttention(db, C);
  expect(await commanderFlags()).toHaveLength(1);
  await db.query("UPDATE agent_commands SET state='complete' WHERE reason='report'");
  await turn(WORKER);
  await refreshCornerAttention(db, C);
  await end(WORKER,40);
  const deferred = await refreshCornerAttention(db, C);
  expect(deferred!.deadlines).toHaveLength(1);
  expect(await commanderFlags()).toHaveLength(0);
  await db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{automaticNotBefore}',to_jsonb(extract(epoch FROM now()-interval '4 minutes')*1000)),wake_after=NULL WHERE reason='report' AND private_payload->>'originCornerId'=$1::text`, [C]);
  await refreshCornerAttention(db, C);
  expect(await commanderFlags()).toHaveLength(1);
  expect((await db.query("SELECT id FROM agent_commands WHERE reason='report'")).rows).toHaveLength(2);
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
  await db.query("UPDATE agent_commands SET state='complete' WHERE reason='report'");
  await db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{automaticNotBefore}',to_jsonb(extract(epoch FROM now()-interval '4 minutes')*1000)),wake_after=NULL WHERE reason='report' AND private_payload->>'originCornerId'=$1::text`,[C]);
  if (event === 'human') await post('human-change','Continue this work',HUMAN);
  if (event === 'push') await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(jsonb_set(lifecycle,'{pr,headSha}','"new-head"'),'{checksSummary,updatedAt}',to_jsonb(extract(epoch FROM clock_timestamp()))) WHERE corner_id=$1`,[C]);
  if (event === 'check') await ci('failing');
  if (event === 'reviewer') {
    await turn(REVIEWER); await refreshCornerAttention(db,C); await end(REVIEWER);
    await refreshCornerAttention(db,C);
    await db.query("UPDATE agent_commands SET wake_after=NULL WHERE reason='report' AND state='pending'");
  }
  await refreshCornerAttention(db,C);
  expect(await commanderFlags()).toHaveLength(1);
  expect((await db.query("SELECT id FROM agent_commands WHERE reason='report'")).rows).toHaveLength(2);
});

it.each(['queued-review', 'hold-behind-report', 'pending-with-old-summary'])(
  'Reproduction REVIEW-LOOP: %s never alerts the commander', async kind => {
    await ci('passing');
    if (kind === 'queued-review') {
      const command = await wake(REVIEWER, 'queued-review');
      await db.query(`UPDATE agent_commands SET review_context=$2::jsonb WHERE id=$1`,
        [command!.id, JSON.stringify({ headSha: 'head', pullRequest: 1 })]);
      await db.query(`UPDATE agent_turns SET created_at=now()-interval '2 minutes' WHERE room_id=$1`, [C]);

    } else if (kind === 'hold-behind-report') {
      const { reportToCommander } = await import('./commander.js');
      await reportToCommander(db, C, WORKER, 'blocked: awaiting a decision');
      await db.query(`INSERT INTO corner_merge_holds(corner_id,actor_id,standing) VALUES($1,$2,'owner')`, [C,HUMAN]);
    } else {
      await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`, [C]);
    }
    for (let cycle=0;cycle<3;cycle++) await refreshCornerAttention(db,C);
    expect(await commanderFlags()).toHaveLength(0);
  });

it('Reproduction R1: a worker that ends its turn without a report reads idle at once and alerts its commander once', async () => {
  // free-credits-film: Baby held an open order, said "continuing next", and
  // ended its turn with no report and no wake. The corner kept saying working.
  await wake(WORKER, 'r1-order');
  await turn();
  await runCornerAttention(db);
  expect(await state()).toBe('working');
  await end(WORKER, 0);
  // The order was this turn. A still-pending order would correctly stay working.
  await db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE id='r1-order'`);
  expect(await state()).toBe('idle');
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]).toMatchObject({ state: 'idle' });
  expect(
    (await phone.readChats(WS, HUMAN))!.chats.find((chat) => chat.room.id === ROOM)?.openCorners?.[0]?.state,
  ).toBe('idle');
  // Inside the post-turn gap a late reply or order can still arrive: no alert yet.
  await runCornerAttention(db);
  expect((await commanderFlags()).filter((command) => command.source.body.includes('is idle'))).toHaveLength(0);
  await end(WORKER, 40);
  await runCornerAttention(db);
  await runCornerAttention(db);
  const stalls = (await commanderFlags()).filter((command) => command.source.body.includes('is idle'));
  expect(stalls).toHaveLength(1);
});

it('Reproduction R1: a report filed before the turn ends shows waiting and sends no stall alert', async () => {
  await turn();
  await runCornerAttention(db);
  const { reportToCommander } = await import('./commander.js');
  await reportToCommander(db, C, WORKER, 'blocked: The signup needs a deposit.');
  await end(WORKER, 40);
  expect(await state()).toBe('waiting');
  await runCornerAttention(db);
  await runCornerAttention(db);
  expect((await commanderFlags()).filter((command) => command.source.body.includes('is idle'))).toHaveLength(0);
});

it('Reproduction R1: a worker that ends its turn with a future schedule reads idle and sends no stall alert', async () => {
  await wake(WORKER, 'r1-scheduled-order');
  await turn();
  await db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE id='r1-scheduled-order'`);
  await db.query(
    `INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,message,cadence,next_run_at,max_runs)
    VALUES(gen_random_uuid(),$1,$2,$3,$3,'Continue the film','{"kind":"interval","everyMinutes":10}',now()+interval '10 minutes',1)`,
    [WS, C, WORKER],
  );
  await runCornerAttention(db);
  expect(await state()).toBe('working');
  await end(WORKER, 40);
  expect(await state()).toBe('idle');
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]).toMatchObject({ state: 'idle' });
  expect(
    (await phone.readChats(WS, HUMAN))!.chats.find((chat) => chat.room.id === ROOM)?.openCorners?.[0]?.state,
  ).toBe('idle');
  await runCornerAttention(db);
  await runCornerAttention(db);
  expect((await commanderFlags()).filter((command) => command.source.body.includes('is idle'))).toHaveLength(0);
  // Once the schedule is spent, the stall is real again.
  await db.query("UPDATE agent_schedules SET next_run_at=now()-interval '1 minute' WHERE room_id=$1", [C]);
  expect(await state()).toBe('idle');
  await runCornerAttention(db);
  expect((await commanderFlags()).filter((command) => command.source.body.includes('is idle'))).toHaveLength(1);
});

// Isolated service reads stand in for the production phone and agent surfaces.
it('Reproduction HEADER-STATE-1: reviewer on failing checks displays review', async () => {
  await ci('failing');
  await turn(REVIEWER);
  expect(await state()).toBe('review');
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]!.state).toBe('review');
});
it('Reproduction HEADER-STATE-2: scheduled corner displays idle without an idle alert', async () => {
  await db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,message,cadence,next_run_at,max_runs,run_count)
    VALUES(gen_random_uuid(),$1,$2,$3,$3,'Continue','{"kind":"interval","everySeconds":86400}',now()+interval '1 day',1,0)`, [WS,C,WORKER]);
  expect(await state()).toBe('idle');
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]!.state).toBe('idle');
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(0);
});

it('Reproduction idle-1: an opening idle alert is discarded when delivered during pending CI', async () => {
  await refreshCornerAttention(db,C);
  const queued=(await daemon.execute('getAgentCommands',{roomId:C},COMMANDER)).commands;
  expect(queued.some(c=>c.source.body.includes('is idle'))).toBe(true);
  await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`,[C,JSON.stringify({checks:'pending',pr:{number:3101,headSha:'0db9eaa0713c7dc8d3027b7c045bbe1760cd391a'},checksSummary:{status:'pending',total:14,checks:[{name:'SHARED PACKAGE TESTS',status:'pending'},{name:'Build auth container',status:'pending'}]}})]);
  expect((await daemon.execute('getAgentCommands',{roomId:C},COMMANDER)).commands).toEqual([]);
});


it('Reproduction HEADER-STATE-3: simultaneous implementer and reviewer display working', async () => {
  await turn(WORKER);
  await turn(REVIEWER);
  expect(await state()).toBe('working');
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]!.state).toBe('working');
});
it('Reproduction HEADER-STATE-5: a queued reviewer stays review until that command is done', async () => {
  await wake(REVIEWER, 'queued-review');
  expect(await state()).toBe('review');
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]!.state).toBe('review');
  await db.query("UPDATE agent_turns SET created_at=now()-interval '31 seconds' WHERE room_id=$1", [C]);
  await db.query(`DELETE FROM agent_turns WHERE room_id=$1`, [C]);
  expect(await state()).toBe('review');
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]).toMatchObject({ state: 'review' });
  await db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE id='queued-review'`);
  expect(await state()).toBe('idle');
});

it('Reproduction HEADER-STATE-4: pending CI wins over a human question with a hold', async () => {
  await post('scope-question', 'needs-decision: @owner Which scope should I implement?');
  await phone.execute('setCornerHold', { cornerId: C }, HUMAN);
  await ci('pending');
  expect(await state()).toBe('review');
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]!.state).toBe('review');
  await ci('passing');
  expect(await state()).toBe('waiting');
});
it('Reproduction R1: a worker order waiting on an offline helper stays working', async () => {
  await wake(WORKER, 'queued-implementer');
  await db.query("UPDATE agent_turns SET created_at=now()-interval '31 seconds' WHERE room_id=$1", [C]);
  await db.query(`DELETE FROM agent_turns WHERE room_id=$1`, [C]);
  const restore = await daemon.execute('getCornerRestoreState', { cornerId: C }, WORKER);
  expect(restore).toMatchObject({ state: 'working', activity: 'running' });
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]).toMatchObject({ state: 'working' });
  expect(
    (await phone.readChats(WS, HUMAN))!.chats.find((chat) => chat.room.id === ROOM)?.openCorners?.[0],
  ).toMatchObject({ state: 'working' });
  await db.query(`INSERT INTO live_server_instances(instance_id) VALUES('r1-online') ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id)
    VALUES($1,1,'r1-online','r1-online')`, [WORKER]);
  expect(await daemon.execute('getCornerRestoreState', { cornerId: C }, WORKER)).toMatchObject({
    state: 'working', activity: 'running',
  });
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]).toMatchObject({ state: 'working' });
  const behind = '44444444-4444-4444-8444-444444444444';
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'codex-dot-connect',$3)`,
    [behind, WS, HUMAN],
  );
  await db.query(
    `INSERT INTO agent_turns(room_id,request_id,agent_id,status,generation_id)
     VALUES($1,$2,$3,'working','g-live')`,
    [behind, 'f'.repeat(64), WORKER],
  );
  expect(await daemon.execute('getCornerRestoreState', { cornerId: C }, WORKER)).toMatchObject({
    state: 'working', activity: 'running',
  });
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]).toMatchObject({
    state: 'working',
  });
  expect(
    (await phone.readChats(WS, HUMAN))!.chats.find((chat) => chat.room.id === ROOM)?.openCorners?.[0],
  ).toMatchObject({ state: 'working' });
  await db.query(`DELETE FROM agent_turns WHERE room_id=$1`, [behind]);
  await db.query(
    `UPDATE agent_commands SET state='claimed',lease_expires_at=now()+interval '90 seconds',
       claimed_at=now(),generation_id='g-hold' WHERE id='queued-implementer'`,
  );
  expect(await daemon.execute('getCornerRestoreState', { cornerId: C }, WORKER)).toMatchObject({
    state: 'working', activity: 'running',
  });
  await db.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,lease_expires_at=NULL,claimed_at=NULL WHERE id='queued-implementer'`);
  await db.query(`UPDATE agent_commands SET wake_after=now()+interval '1 hour' WHERE id='queued-implementer'`);
  expect(await state()).toBe('idle');
  await db.query(`UPDATE agent_commands SET wake_after=NULL,state='complete',completed_at=now() WHERE id='queued-implementer'`);
  expect(await state()).toBe('idle');
});


it.each(['agent', 'human'] as const)('REPORT-WAITING-DERIVED: %s report quiets wakes and clears on each authorized input', async recipientKind => {
  const { reportToCommander } = await import('./commander.js');
  const recipient = recipientKind === 'agent' ? COMMANDER : HUMAN;
  await db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{authorId}',to_jsonb($1::text))
    WHERE id='opening-order'`, [recipient]);
  const changes: string[] = [];
  const unlisten = db instanceof PgliteDatabase ? await db.client.listen('beeline_live_v1', raw => {
    const event = JSON.parse(raw);
    if (event.table === 'corner_state') changes.push(event.roomId);
  }) : undefined;
  try {
    for (const input of ['return-room-answer', 'commander-order', 'new-head'] as const) {
      const automatic = await createAgentCommand(db, { id: `automatic-${input}`, roomId: C, agentId: WORKER,
        sourceMessageId: null, reason: 'corner_lifecycle',
        privatePayload: { kind: 'lifecycle', authorId: WORKER, fromRoomId: C, text: 'Continue automatically' } });
      expect(automatic).toBeDefined();
      expect((await db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2`, [C,automatic!.turn_request_id])).rows)
        .toEqual([{ status: 'working' }]);
      changes.length = 0;
      const report = await reportToCommander(db, C, WORKER, 'blocked: choose the next direction', undefined, `report-${input}`);
      expect((await db.query('SELECT 1 FROM corner_report_blockers WHERE corner_id=$1', [C])).rowCount).toBe(0);
      expect(await cornerReportWaiting(db, C)).toBe(true);
      expect(await state()).toBe('waiting');
      if (unlisten) expect(changes).toContain(C);
      expect((await db.query(`SELECT state,cancellation_reason FROM agent_commands WHERE id=$1`, [automatic!.id])).rows)
        .toEqual([{ state: 'cancelled', cancellation_reason: 'corner_waiting' }]);
      expect((await db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND status='working'`, [C,automatic!.turn_request_id])).rows)
        .toEqual([]);
      // An unrelated agent's prose and order cannot answer this report.
      await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation)
        VALUES($1,$2,$3,'Proceed','message')`, [`unrelated-${input}`, ROOM, REVIEWER]);
      await createAgentCommand(db, { id: `unrelated-order-${input}`, roomId: C, agentId: REVIEWER,
        sourceMessageId: null, reason: 'order', privatePayload: { kind: 'order', authorId: REVIEWER, fromRoomId: ROOM, text: 'Other work' } });
      expect(await cornerReportWaiting(db, C)).toBe(true);
      await db.query(`UPDATE agent_commands SET state='complete' WHERE id=$1`, [`unrelated-order-${input}`]);
      await db.query(`UPDATE agent_turns SET status='complete' WHERE room_id=$1 AND agent_id=$2`, [C,REVIEWER]);
      changes.length = 0;
      if (input === 'return-room-answer') {
        // A current human member may answer even when the commander is an agent.
        await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation)
          VALUES('derived-answer',$1,$2,'Proceed','message')`, [ROOM,HUMAN]);
      } else if (input === 'commander-order') {
        const next = await createAgentCommand(db, { id: 'derived-order', roomId: C, agentId: WORKER,
          sourceMessageId: null, reason: 'order', privatePayload: { kind: 'order', authorId: recipient, fromRoomId: ROOM, text: 'Proceed' } });
        await db.query(`UPDATE agent_commands SET state='complete' WHERE id=$1`, [next!.id]);
        await db.query(`UPDATE agent_turns SET status='complete' WHERE room_id=$1 AND request_id=$2`, [C,next!.turn_request_id]);
      } else {
        await db.query(`UPDATE corner_facts SET lifecycle='{"pr":{"headSha":"new-head"},"checks":"failing"}'::jsonb WHERE corner_id=$1`, [C]);
      }
      expect(await cornerReportWaiting(db, C)).toBe(false);
      if (unlisten) expect(changes).toContain(C);
      const saved = recipientKind === 'agent'
        ? (await db.query(`SELECT private_payload->>'waitingAnswered' answered FROM agent_commands WHERE id=$1`, [report.id])).rows
        : (await db.query(`SELECT card->>'waitingAnswered' answered FROM messages WHERE id=$1`, [report.id])).rows;
      expect(saved).toEqual([{ answered: 'true' }]);
      const cardId = (await db.query<{ card_id: string }>(`SELECT encode(sha256(convert_to('agent-command-card:'||$1::text,'UTF8')),'hex') card_id`, [report.id])).rows[0]!.card_id;
      expect((await db.query(`SELECT card->>'waitingAnswered' answered FROM messages WHERE id=$1`, [cardId])).rows)
        .toEqual([{ answered: 'true' }]);
      expect((await db.query('SELECT 1 FROM corner_report_blockers WHERE corner_id=$1', [C])).rowCount).toBe(0);
    }
  } finally { await unlisten?.(); }
});


it('REPORT-WAITING-DERIVED: automatic blocked prose preserves the post-turn grace period', async () => {
  await turn();
  await end(WORKER, 10);
  const idle = async () => (await db.query<{ last_turn_ended_at: Date | null; idle_since: string }>(
    cornerIdleSql('$1'), [C])).rows.map(row => ({ ended: row.last_turn_ended_at, since: row.idle_since }));
  const before = await idle();
  expect(before[0]!.ended).not.toBeNull();
  const { reportToCommander } = await import('./commander.js');
  await reportToCommander(db, C, WORKER, 'blocked: an automatic completion', undefined, 'automatic-report', { automatic: true });
  expect(await cornerReportWaiting(db, C)).toBe(false);
  expect(await idle()).toEqual(before);
});

it('IDLE-DERIVED: concurrent recomputations claim one command with no span rows', async () => {
  await Promise.all([refreshCornerAttention(db,C),refreshCornerAttention(db,C)]);
  const reports = (await db.query<{ id: string }>(`SELECT id FROM agent_commands
    WHERE reason='report' AND private_payload->>'idleSince' IS NOT NULL`)).rows;
  expect(reports).toHaveLength(1);
  expect((await db.query('SELECT 1 FROM corner_attention_spans')).rows).toEqual([]);
  expect(await commanderFlags()).toHaveLength(1);
  await refreshCornerAttention(db,C);
  expect((await db.query(`SELECT id FROM agent_commands WHERE reason='report'`)).rows).toEqual(reports);
});

it.each(['human','worker'] as const)('IDLE-DERIVED: a %s event replaces the episode and fences its cached claim', async event => {
  await refreshCornerAttention(db,C);
  const first = (await commanderFlags())[0]!;
  // The delivered report still spends its budget after it becomes stale.
  if (event === 'human') await post('new-idle-human','Please continue',HUMAN);
  else { await turn(); await refreshCornerAttention(db,C); await end(); }
  await refreshCornerAttention(db,C);
  await expect(daemon.execute('claimAgentCommand', {
    roomId:C,commandId:first.id,generationId:'obsolete-idle',
  },COMMANDER)).rejects.toThrow();
  expect(await commanderFlags()).toHaveLength(0);
  const current = (await db.query<{ id: string; wake_after: Date }>(`SELECT id,wake_after
    FROM agent_commands WHERE reason='report' AND state='pending'`)).rows;
  expect(current).toHaveLength(1);
  expect(current[0]!.id).not.toBe(first.id);
  expect(new Date(current[0]!.wake_after).getTime()).toBeGreaterThan(Date.now()+120_000);
  await db.query(`UPDATE agent_commands SET wake_after=now()-interval '1 second' WHERE id=$1`,[current[0]!.id]);
  await flushDueCommanderWakes(db);
  expect((await commanderFlags()).map(command=>command.id)).toEqual([current[0]!.id]);
  expect((await db.query('SELECT 1 FROM corner_attention_spans')).rows).toEqual([]);
});

it('IDLE-DERIVED: a commander reply and turn do not change the idle command', async () => {
  await refreshCornerAttention(db,C);
  const first = (await commanderFlags())[0]!;
  await post('commander-idle-reply','I will pick this up',COMMANDER);
  await turn(COMMANDER);
  await end(COMMANDER);
  await refreshCornerAttention(db,C);
  expect((await commanderFlags()).map(command=>command.id)).toEqual([first.id]);
  expect((await db.query(`SELECT id FROM agent_commands WHERE reason='report'`)).rows).toHaveLength(1);
});

it.each(['hold','owed','expiry'] as const)('IDLE-DERIVED: ending a %s opens an episode without a worker turn', async wait => {
  await refreshCornerAttention(db,C);
  const first = (await commanderFlags())[0]!;
  await db.query(`UPDATE agent_commands SET state='complete',
    private_payload=jsonb_set(private_payload,'{automaticNotBefore}',to_jsonb(extract(epoch FROM now()-interval '4 minutes')*1000)) WHERE id=$1`,[first.id]);
  if (wait === 'hold') await db.query(`INSERT INTO corner_merge_holds(corner_id,actor_id,standing)
    VALUES($1,$2,'owner')`,[C,HUMAN]);
  if (wait === 'owed' || wait === 'expiry') {
    await post('derived-question','@owner Which scope?',WORKER);
    expect((await db.query('SELECT 1 FROM corner_owed WHERE corner_id=$1',[C])).rows.length).toBeGreaterThan(0);
  }
  await refreshCornerAttention(db,C);
  expect(await commanderFlags()).toHaveLength(0);
  if (wait === 'hold') await db.query('UPDATE corner_merge_holds SET released_at=clock_timestamp(),released_by=$2 WHERE corner_id=$1',[C,HUMAN]);
  if (wait === 'owed') await post('derived-answer','The narrow scope',HUMAN);
  if (wait === 'expiry') await db.query("UPDATE corner_owed SET expires_at=clock_timestamp()-interval '1 second' WHERE corner_id=$1",[C]);
  await Promise.all([refreshCornerAttention(db,C),refreshCornerAttention(db,C)]);
  const current = await commanderFlags();
  expect(current).toHaveLength(1);
  expect(current[0]!.id).not.toBe(first.id);
  expect((await db.query('SELECT 1 FROM agent_turns WHERE room_id=$1 AND agent_id=$2',[C,WORKER])).rows).toEqual([]);
  expect((await db.query('SELECT 1 FROM corner_attention_spans')).rows).toEqual([]);
});

it.each(['expired','removed','exhausted'] as const)('IDLE-DERIVED: a schedule ending (%s) alone does not reopen a reported episode', async ending => {
  await refreshCornerAttention(db,C);
  const first = (await commanderFlags())[0]!;
  await db.query(`UPDATE agent_commands SET state='complete',
    private_payload=jsonb_set(private_payload,'{automaticNotBefore}',to_jsonb(extract(epoch FROM now()-interval '4 minutes')*1000)) WHERE id=$1`,[first.id]);
  await db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,message,cadence,next_run_at,max_runs)
    VALUES(gen_random_uuid(),$1,$2,$3,$3,'Wait','{"kind":"interval","everySeconds":86400}',now()+interval '1 day',1)`,[WS,C,WORKER]);
  await refreshCornerAttention(db,C);
  expect(await commanderFlags()).toHaveLength(0);
  if (ending === 'removed') await db.query('DELETE FROM agent_schedules WHERE room_id=$1',[C]);
  if (ending === 'expired') await db.query("UPDATE agent_schedules SET next_run_at=now()-interval '1 minute' WHERE room_id=$1",[C]);
  if (ending === 'exhausted') await db.query('UPDATE agent_schedules SET run_count=max_runs WHERE room_id=$1',[C]);
  await Promise.all([refreshCornerAttention(db,C),refreshCornerAttention(db,C)]);
  expect(await commanderFlags()).toHaveLength(0);
  expect((await db.query(`SELECT id FROM agent_commands WHERE reason='report'`)).rows).toEqual([{id:first.id}]);
  await post('after-schedule','Continue',HUMAN);
  await refreshCornerAttention(db,C);
  expect(await commanderFlags()).toHaveLength(1);
});

it.each(['message','order','same-time order'] as const)('IDLE-DERIVED: a report resolution uses the first commander %s timestamp', async kind => {
  const { reportToCommander } = await import('./commander.js');
  const report = await reportToCommander(db,C,WORKER,'blocked: Choose the scope.');
  expect(await state()).toBe('waiting');
  await refreshCornerAttention(db,C);
  expect((await db.query(`SELECT id FROM agent_commands WHERE private_payload->>'idleSince' IS NOT NULL`)).rows).toEqual([]);
  // Explicit past timestamps prove no deletion/refresh time is substituted.
  const at = new Date(Date.now()-60_000);
  await db.query('UPDATE agent_commands SET created_at=$2 WHERE id=$1',[report.id,kind === 'same-time order' ? at : new Date(at.getTime()-60_000)]);
  if (kind === 'message') await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,created_at)
    VALUES('report-answer',$1,$2,'The narrow scope','message',$3)`,[ROOM,COMMANDER,at]);
  else await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,root_command_id,root_source_message_id,agent_depth,private_payload,created_at,state)
    VALUES('report-answer',$1,$2,'report-answer','input','order','report-answer','report-answer',0,jsonb_build_object('kind','order','authorId',$3::text,'text','The narrow scope'),$4,'complete')`,[C,WORKER,COMMANDER,at]);
  expect((await db.query('SELECT 1 FROM corner_report_blockers WHERE corner_id=$1',[C])).rows).toEqual([]);
  const idleSince = async () => (await db.query<{idle_since:string}>(cornerIdleSql('$1'),[C])).rows[0]!.idle_since;
  expect(Number(await idleSince())).toBeCloseTo(at.getTime()/1000,3);
  await refreshCornerAttention(db,C);
  const first = (await commanderFlags()).filter(command=>command.source.body.includes('is idle'));
  expect(first).toHaveLength(1);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation)
    VALUES('later-commander-reply',$1,$2,'One more detail','message')`,[ROOM,COMMANDER]);
  expect(Number(await idleSince())).toBeCloseTo(at.getTime()/1000,3);
  await refreshCornerAttention(db,C);
  expect((await commanderFlags()).filter(command=>command.source.body.includes('is idle')).map(command=>command.id)).toEqual(first.map(command=>command.id));
});

it('IDLE-DERIVED: a human-directed report resolves from the message log once answered', async () => {
  await db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{authorId}',to_jsonb($1::text)) WHERE id='opening-order'`,[HUMAN]);
  const { reportToCommander } = await import('./commander.js');
  const report = await reportToCommander(db,C,WORKER,'blocked: Which scope?');
  expect(await cornerReportWaiting(db, C)).toBe(true);
  const at = new Date(Date.now()-60_000);
  await db.query('UPDATE messages SET created_at=$2 WHERE id=$1',[report.id,new Date(at.getTime()-60_000)]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,created_at)
    VALUES('human-report-answer',$1,$2,'Narrow scope','message',$3)`,[ROOM,HUMAN,at]);
  expect(await cornerReportWaiting(db, C)).toBe(false);
  const row = (await db.query<{idle_since:string}>(cornerIdleSql('$1'),[C])).rows[0]!;
  expect(Number(row.idle_since)).toBeCloseTo(at.getTime()/1000,3);
});

it('IDLE-DERIVED: an owed item in the return Room resolves at its first answering message', async () => {
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card,created_at)
    VALUES('return-question',$1,$2,'@owner Which scope?','message',jsonb_build_object('sourceRoomId',$3::text),now()-interval '2 minutes')`,[ROOM,WORKER,C]);
  expect((await db.query('SELECT 1 FROM corner_owed WHERE corner_id=$1',[C])).rows).toHaveLength(1);
  const at = new Date(Date.now()-60_000);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,created_at)
    VALUES('return-answer',$1,$2,'The narrow scope','message',$3)`,[ROOM,HUMAN,at]);
  expect((await db.query('SELECT 1 FROM corner_owed WHERE corner_id=$1',[C])).rows).toEqual([]);
  const idleSince = async () => (await db.query<{idle_since:string}>(cornerIdleSql('$1'),[C])).rows[0]!.idle_since;
  expect(Number(await idleSince())).toBeCloseTo(at.getTime()/1000,3);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation)
    VALUES('later-return-answer',$1,$2,'More context','message')`,[ROOM,HUMAN]);
  expect(Number(await idleSince())).toBeCloseTo(at.getTime()/1000,3);
  await db.query(`UPDATE messages SET deleted_at=now() WHERE id IN ('return-answer','later-return-answer')`);
  expect((await db.query(cornerOwedAnswerTimesSql('$1'),[C])).rows).toEqual([]);
});

it('IDLE-DERIVED: pending checks invalidate deferred delivery and a cached claim', async () => {
  await turn(); await end();
  await refreshCornerAttention(db,C);
  const pending = (await db.query<{ id: string }>(`SELECT id FROM agent_commands WHERE reason='report'`)).rows[0]!;
  await ci('pending');
  await db.query(`UPDATE agent_commands SET wake_after=now()-interval '1 second' WHERE id=$1`,[pending.id]);
  await flushDueCommanderWakes(db);
  expect(await commanderFlags()).toHaveLength(0);
  await expect(daemon.execute('claimAgentCommand',{roomId:C,commandId:pending.id,generationId:'ci-idle'},COMMANDER)).rejects.toThrow();
  await refreshCornerAttention(db,C);
  expect((await db.query(`SELECT id FROM agent_commands WHERE reason='report' AND state='pending'`)).rows).toEqual([]);
});

it('IDLE-DERIVED: migration preserves historical spans without maintaining them', async () => {
  await db.query(`INSERT INTO corner_attention_spans(corner_id,revision,last_state,episode,reported_episode)
    VALUES($1,7,'idle',3,2)`,[C]);
  const before = (await db.query('SELECT * FROM corner_attention_spans WHERE corner_id=$1',[C])).rows;
  await db.query(CORNER_ATTENTION_SCHEMA);
  await turn(); await end();
  await post('retired-span-human','Continue',HUMAN);
  await ci('pending');
  await refreshCornerAttention(db,C);
  expect((await db.query('SELECT * FROM corner_attention_spans WHERE corner_id=$1',[C])).rows).toEqual(before);
  expect((await db.query(`SELECT proname FROM pg_proc WHERE proname IN (
    'corner_attention_push','corner_attention_human','corner_state_changed')`)).rows).toEqual([]);
});

it('IDLE-DERIVED: CI completing during the post-turn grace keeps the remaining grace', async () => {
  await turn(); await end();
  await ci('pending'); await refreshCornerAttention(db,C);
  await ci('failing'); await refreshCornerAttention(db,C);
  expect(await state()).toBe('idle');
  expect(await commanderFlags()).toHaveLength(0);
  const pending = (await db.query<{ wake_after: Date }>(`SELECT wake_after FROM agent_commands
    WHERE reason='report' AND state='pending'`)).rows;
  expect(pending).toHaveLength(1);
  expect(new Date(pending[0]!.wake_after).getTime()).toBeGreaterThan(Date.now()+20_000);
  expect(new Date(pending[0]!.wake_after).getTime()).toBeLessThanOrEqual(Date.now()+30_000);
});
