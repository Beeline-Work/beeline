import { advanceCorner } from './corner-lifecycle.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { cornerReportWaiting } from './corner-state.js';
import { cornerWaitingReportSql } from './corner-waiting-report.js';

import { cornerIdleSql } from './corner-idle.js';
import { cornerOwedAnswerTimesSql } from './corner-owed.js';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { systemLine } from './system-line.js';
import { cornerOwedSchemaSql } from './corner-owed.js';
import { migrate, PostgresDatabase, type SqlDatabase } from './database.js';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { seedCornerOpening, PgliteDatabase, insertCornerFacts } from './test-support.js';
import { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import { createAgentCommand, readAgentCommands } from './agent-command.js';
import {
  CORNER_ATTENTION_SCHEMA,
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
  await insertCornerFacts(db, { cornerId: C, ownerAgentId: WORKER, commissionedBy: HUMAN, workerAgentId: WORKER });
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
const state = async () => {
  await refreshCornerAttention(db, C); // Drain the committed event in this isolated service fixture.
  return (await daemon.execute('getCornerRestoreState', { cornerId: C }, WORKER)).state;
};
const wake = async (agentId = WORKER, id = 'new-work') =>
  createAgentCommand(db, {
    id,
    roomId: C,
    agentId,
    sourceMessageId: null,
    reason: 'order',
    privatePayload: { kind: 'order', text: 'Continue', authorId: agentId === COMMANDER ? HUMAN : COMMANDER, fromRoomId: ROOM },
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

it('MODEL-UNKNOWN: a model owner end remains terminal while a new explicit command can run', async () => {
  const command=(await wake())!;
  await daemon.execute('claimAgentCommand',{roomId:C,commandId:command.id,generationId:'unknown-model'},WORKER);
  expect((await db.query<{worker_active:boolean}>(cornerIdleSql('$1'),[C])).rows[0]?.worker_active).toBe(true);
  await db.query(`INSERT INTO agent_command_owner_ends(command_id,generation_id,model_request_id)
    VALUES($1,'unknown-model',NULL)`,[command.id]);
  await db.query(`SELECT beeline_end_agent_turn($1,'unknown-model','failed','The model result could not be confirmed.')`,[command.id]);
  const idle=(await db.query<{worker_active:boolean;suppressed:boolean}>(cornerIdleSql('$1'),[C])).rows[0]!;
  expect(idle.worker_active).toBe(false);
  expect(idle.suppressed).toBe(false);
  await post('explicit-after-unknown','Do this new task',HUMAN);
  const next=(await createAgentCommand(db,{id:'explicit-after-unknown-command',roomId:C,agentId:WORKER,
    sourceMessageId:'explicit-after-unknown',reason:'human_tag'}))!;
  expect((await readAgentCommands(db,C,WORKER)).commands.map(item=>item.id)).toContain(next.id);
  await daemon.execute('claimAgentCommand',{roomId:C,commandId:next.id,generationId:'new-explicit-generation'},WORKER);
  expect((await db.query('SELECT state,generation_id FROM agent_commands WHERE id=$1',[command.id])).rows)
    .toEqual([{state:'complete',generation_id:'unknown-model'}]);
});

it('a pre-claim failure cannot end queued work; its owner can report a plain failure after claim', async () => {
  const command=(await wake())!;
  await expect(daemon.execute('postAgentTurnReceipt', {roomId:C,requestId:command.turn_request_id,
    status:'failed',reason:'git fetch failed: cannot lock ref'},WORKER)).rejects.toThrow('authority rejected');
  expect(await state()).toBe('working');
  await daemon.execute('claimAgentCommand',{roomId:C,commandId:command.id,generationId:'workspace-failure'},WORKER);
  await daemon.execute('postAgentTurnReceipt',{roomId:C,requestId:command.turn_request_id,generationId:'workspace-failure',
    status:'failed',reason:'git fetch failed: cannot lock ref'},WORKER);
  expect(await state()).toBe('idle');
  const failures=(await readAgentCommands(db,ROOM,COMMANDER)).commands.filter(item=>item.reason==='report');
  expect(failures).toHaveLength(1);
  expect(failures[0]!.source.body).toContain('cannot lock ref');
});

async function turn(agent = WORKER) {
  let command=agent===COMMANDER?undefined:(await readAgentCommands(db,C,agent)).commands[0];
  if(!command) {
    const queued=(await wake(agent,randomUUID()))!;
    command=(await readAgentCommands(db,C,agent)).commands.find(item=>item.id===queued.id)!;
  }
  await daemon.execute('claimAgentCommand',{roomId:C,commandId:command.id,generationId:'actual'},agent);
}
async function end(agent = WORKER, age = 0) {
  await db.query(`SELECT beeline_end_agent_turn(id,generation_id,'complete') FROM agent_commands
    WHERE room_id=$1 AND agent_id=$2 AND state='claimed'`,[C,agent]);
  await db.query(`UPDATE agent_turns SET ended_at=clock_timestamp()-make_interval(secs=>$2)
    WHERE room_id=$1 AND status<>'working' AND agent_id=$3`,[C,age,agent]);
}
/** Attention-only check facts have no current PR target; dispatch coverage uses explicit PR facts. */
async function ci(checks: string) {
  await db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
    C,
    JSON.stringify({
      lifecycle: 'in-review',
      checks,
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
  await db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
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
    const expected = 'waiting';
    expect(await state()).toBe(expected);
    const deck = await phone.liveChatCornerStatus(ROOM, HUMAN);
    expect(deck).toMatchObject({ waitingCornerCount: 1 });
    expect(deck!.openCorners[0].state).toBe(expected);
  },
);
it.each([
  ['agent', 'pending', 'waiting'],
  ['human', 'pending', 'waiting'],
  ['agent', 'unreported', 'waiting'],
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
it('Reproduction R1: a human hold beside an older agent-commander report stays waiting under pending CI', async () => {
  await ci('pending');
  const { reportToCommander } = await import('./commander.js');
  await reportToCommander(db, C, WORKER, 'blocked: awaiting CI and review');
  await db.query(
    `UPDATE agent_commands SET created_at=now()-interval '1 minute' WHERE private_payload->>'kind'='report' AND private_payload->>'fromRoomId'=$1::text`,
    [C],
  );
  await phone.execute('setCornerHold', { cornerId: C }, HUMAN);
  expect(await state()).toBe('waiting');
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]).toMatchObject({ state: 'waiting' });
  expect(
    (await phone.readChats(WS, HUMAN))!.chats.find((chat) => chat.room.id === ROOM)?.openCorners?.[0]
      ?.state,
  ).toBe('waiting');
});

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

it('two server instances observe one immediate idle notice without a deadline', async () => {
  await turn();await end();
  vi.useFakeTimers();
  const live = new LiveHub(), errors: unknown[] = [];
  const a = new CornerAttentionDeadlines(db,live,error=>errors.push(error));
  const b = new CornerAttentionDeadlines(db,live,error=>errors.push(error));
  try {
    await Promise.all([a.start(),b.start()]);
    expect(await commanderFlags()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(errors).toEqual([]);
  } finally {a.stop();b.stop();vi.useRealTimers();}
});

it('Reproduction IDLE-1: pending CI does not arm a deadline or an idle alert', async () => {
  await ci('pending');
  await db.query(
    `UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checksSummary,updatedAt}',to_jsonb(extract(epoch FROM now()-interval '31 minutes'))) WHERE corner_id=$1`,
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
  await db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
    [C,JSON.stringify({lifecycle:'in-review',checks:'passing',pr:{number:1,headSha:'review-head'}})]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,system_event)
    VALUES('review-source',$1,$2,'Review requested','system',$3::jsonb)`,
    [C,COMMANDER,JSON.stringify({kind:'check-passed',object:{headSha:'review-head'}})]);
  const dispatch=await createAgentCommand(db,{id:'review-dispatch',roomId:C,agentId:REVIEWER,
    sourceMessageId:'review-source',reason:'corner_review_dispatch'});
  expect(dispatch).toBeTruthy();
  await db.query(`UPDATE agent_commands SET review_context=$2::jsonb WHERE id=$1`, [dispatch!.id,
    JSON.stringify({cornerId:C,headSha:'review-head',pullRequest:1,briefRevision:0})]);
  const serviceStates=async()=>[await state(),(await phone.readCorners(ROOM,HUMAN))!.corners[0]!.state];
  // A queued reviewer keeps the corner in review during its pickup window.
  expect(await serviceStates()).toEqual(['review','review']);
  await daemon.execute('claimAgentCommand',{roomId:C,commandId:dispatch!.id,generationId:'review-proof'},REVIEWER);
  expect(await serviceStates()).toEqual(['review','review']);
  await db.query(`UPDATE rooms SET reviewer_agent_id=NULL WHERE id=$1`,[ROOM]);
  expect(await serviceStates()).toEqual(['review','review']);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(0);
  await end(REVIEWER,40);
  // A terminal review without a verdict returns ownership to the implementer.
  expect(await serviceStates()).toEqual(['working','working']);
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
    await advanceCorner(db, C, kind === 'closed' ? {kind:'closed'} : {kind:'merged',contents:{}});
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
  await db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checksSummary}',
    '{"status":"unknown","total":0}') WHERE corner_id=$1`, [C]);
  await db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checksSummary,updatedAt}',to_jsonb(extract(epoch FROM now()-interval '31 minutes'))) WHERE corner_id=$1`, [C]);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(0);
});

it('Reproduction IDLE-1: a running workflow label without a live turn still alerts', async () => {
  await db.query(`UPDATE corner_github_cache SET lifecycle='{"lifecycle":"running"}' WHERE corner_id=$1`, [C]);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(1);
});

async function checksHead(sha: string, checks: 'pending' | 'failing') {
  await db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
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
    `UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checksSummary,updatedAt}',to_jsonb(extract(epoch FROM now()-interval '60 minutes'))) WHERE corner_id=$1`,
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
  await db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
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
  // A genuine blocker stays visible while the remaining shards run.
  expect(await state()).toBe('waiting');
  expect((await commanderFlags()).filter(command => command.source.body.includes('is idle'))).toHaveLength(0);
});

it('Reproduction FIC-1: a blocked report stays visible during pending CI without an idle alert', async () => {
  await ci('pending');
  await runCornerAttention(db);
  expect(await state()).toBe('review');
  expect((await commanderFlags()).filter((command) => command.source.body.includes('is idle'))).toHaveLength(0);
  const { reportToCommander } = await import('./commander.js');
  await reportToCommander(db, C, WORKER, 'blocked: Waiting on the reviewer until checks are green.');
  expect(await state()).toBe('waiting');
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
  expect((await db.query(`SELECT id FROM agent_commands WHERE reason='report'`)).rows).toHaveLength(1);
});

it('Reproduction IDLE-STORM: a new worker result opens an idle episode immediately', async () => {
  await refreshCornerAttention(db,C);
  expect(await commanderFlags()).toHaveLength(1);
  await db.query("UPDATE agent_commands SET state='complete' WHERE reason='report'");
  await turn();await refreshCornerAttention(db,C);await end();
  const immediate=await refreshCornerAttention(db,C);
  expect(immediate).toEqual({parentId:ROOM});
  expect(await commanderFlags()).toHaveLength(1);
  expect((await db.query("SELECT id FROM agent_commands WHERE reason='report'")).rows).toHaveLength(2);
});

it.each(['human','push','check','reviewer'])('Reproduction IDLE-STORM: a real %s event can open a fresh idle episode', async (event) => {
  await ci('passing');
  await refreshCornerAttention(db,C);
  await db.query("UPDATE agent_commands SET state='complete' WHERE reason='report'");
  if (event === 'human') await post('human-change','Continue this work',HUMAN);
  if (event === 'push') await db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(jsonb_set(lifecycle,'{pr,headSha}','"new-head"'),'{checksSummary,updatedAt}',to_jsonb(extract(epoch FROM clock_timestamp()))) WHERE corner_id=$1`,[C]);
  if (event === 'check') await ci('failing');
  if (event === 'reviewer') {
    await turn(REVIEWER); await refreshCornerAttention(db,C); await end(REVIEWER);
    await refreshCornerAttention(db,C);

  }
  await refreshCornerAttention(db,C);
  expect(await commanderFlags()).toHaveLength(1);
  expect((await db.query("SELECT id FROM agent_commands WHERE reason='report'")).rows).toHaveLength(2);
});

it.each(['queued-review', 'hold-behind-report', 'pending-with-old-summary'])(
  'Reproduction REVIEW-LOOP: %s never alerts the commander', async kind => {
    await ci('passing');
    if (kind === 'queued-review') {
      await db.query(`UPDATE corner_github_cache SET lifecycle=lifecycle||'{"pr":{"number":1,"headSha":"head"}}'::jsonb WHERE corner_id=$1`,[C]);
      const command = await wake(REVIEWER, 'queued-review');
      await db.query(`UPDATE agent_commands SET review_context=$2::jsonb WHERE id=$1`,
        [command!.id, JSON.stringify({ headSha: 'head', pullRequest: 1 })]);
      await db.query(`UPDATE agent_turns SET created_at=now()-interval '2 minutes' WHERE room_id=$1`, [C]);

    } else if (kind === 'hold-behind-report') {
      const { reportToCommander } = await import('./commander.js');
      await reportToCommander(db, C, WORKER, 'blocked: awaiting a decision');
      await db.query(`INSERT INTO corner_merge_holds(corner_id,actor_id,standing) VALUES($1,$2,'owner')`, [C,HUMAN]);
    } else {
      await db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`, [C]);
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
  // The committed end is the idle signal; no grace timer runs.
  await runCornerAttention(db);
  expect((await commanderFlags()).filter((command) => command.source.body.includes('is idle'))).toHaveLength(1);
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

it('Reproduction HEADER-STATE-4: a human question stays visible during pending CI with a hold', async () => {
  await post('scope-question', 'needs-decision: @owner Which scope should I implement?');
  await phone.execute('setCornerHold', { cornerId: C }, HUMAN);
  await ci('pending');
  expect(await state()).toBe('waiting');
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]!.state).toBe('waiting');
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

  expect(await state()).toBe('working');
  await db.query("UPDATE agent_commands SET state='complete',completed_at=now() WHERE id='queued-implementer'");
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
        privatePayload: { kind: 'lifecycle', authorId: SYSTEM_IDENTITY_ID, fromRoomId: C, text: 'Continue automatically' } });
      expect(automatic).toBeDefined();
      expect((await db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2`, [C,automatic!.turn_request_id])).rows)
        .toEqual([{ status: 'working' }]);
      changes.length = 0;
      const report = await reportToCommander(db, C, WORKER, 'blocked: choose the next direction', undefined, `report-${input}`);
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
        await db.query(`UPDATE corner_github_cache SET lifecycle='{"pr":{"headSha":"new-head"},"checks":"failing"}'::jsonb WHERE corner_id=$1`, [C]);
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
    }
  } finally { await unlisten?.(); }
});


it('REPORT-WAITING-DERIVED: automatic blocked prose preserves the committed turn end', async () => {
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

it('IDLE-SCOPE: another corner’s answered report never changes this corner’s idle episode', async () => {
  const other = '44444444-4444-4444-8444-444444444444';
  const idleSince = async () => (await db.query<{ idle_since: string }>(cornerIdleSql('$1'), [C])).rows[0]!.idle_since;
  const before = await idleSince();
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by)
    VALUES($1,$2,$3,'Unrelated corner',$4)`, [other, WS, ROOM, COMMANDER]);
  await insertCornerFacts(db, { cornerId: other, ownerAgentId: WORKER, workerAgentId: WORKER });
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,card,created_at)
    VALUES($1,$2,$3,'blocked: Choose a scope.',
      jsonb_build_object('sourceRoomId',$4::text,'reportToId',$5::text,'waitingAnswered',true),now()-interval '2 minutes')`,
    ['e'.repeat(64), ROOM, WORKER, other, COMMANDER]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
    VALUES($1,$2,$3,'Proceed with that scope.',now()-interval '1 minute')`, ['f'.repeat(64), ROOM, COMMANDER]);
  expect(await idleSince()).toBe(before);
  await db.query('UPDATE rooms SET archived_at=now() WHERE id=$1', [other]);
  expect((await db.query(cornerIdleSql('$1'), [other])).rows).toEqual([]);
  expect(await idleSince()).toBe(before);
});
