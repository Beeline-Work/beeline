import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { systemLine } from './system-line.js';
import { routeSystemCommand } from './agent-command.js';
import { cornerMergeGate } from './corner-workflow.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';

const H = 'a'.repeat(64);
const OWNER_AGENT = 'b'.repeat(64);
const REVIEWER_A = 'c'.repeat(64);
const REVIEWER_B = 'd'.repeat(64);
const OUTSIDER = 'e'.repeat(64);
const W = '11111111-1111-4111-8111-111111111112';
const R = '22222222-2222-4222-8222-222222222223';
const C = '33333333-3333-4333-8333-333333333334';

let db: PgliteDatabase;
let phone: PhoneService;
let daemon: DaemonService;

async function reportPresence(agentId: string, status: 'online' | 'offline') {
  await db.query(
    `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body,updated_at)
     VALUES($1,$2,'presence','presence',$3::jsonb,now())
     ON CONFLICT(room_id,agent_id,turn_id,kind) DO UPDATE SET body=EXCLUDED.body,updated_at=now()`,
    [R, agentId, JSON.stringify({ status, observedAt: Math.floor(Date.now() / 1000) })],
  );
}

/** An idle helper on its socket: still online, last heard from minutes ago. */
async function idleFor(agentId: string, minutes: number) {
  await db.query(
    `UPDATE live_outputs SET updated_at=now()-make_interval(mins => $2) WHERE agent_id=$1 AND kind='presence'`,
    [agentId, minutes],
  );
}

const commands = (agentId: string, roomId = C) =>
  daemon.execute('getAgentCommands', { roomId }, agentId).then((r) => r.commands);

async function claim(c: AgentCommand, generationId = 'g1') {
  await daemon.execute(
    'claimAgentCommand',
    { roomId: c.roomId, commandId: c.id, generationId },
    c.agentId,
  );
}

async function greenCheck() {
  await systemLine(db, {
    roomId: C,
    authorId: H,
    subject: { kind: 'github', name: 'GitHub' },
    verb: 'passed a check',
    kind: 'check-passed',
  });
}

beforeEach(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
       ($1,'human','Human','human'),($2,'agent','Owner','owner'),
       ($3,'agent','ReviewerA','reviewera'),($4,'agent','ReviewerB','reviewerb'),($5,'agent','Outsider','outsider')`,
    [H, OWNER_AGENT, REVIEWER_A, REVIEWER_B, OUTSIDER],
  );
  await db.query(
    `INSERT INTO agents(agent_id,owner_id,selected_model) VALUES
       ($1,$5,NULL),($2,$5,'opus-4-5'),($3,$5,'opus-4-5'),($4,$5,'some-light-model')`,
    [OWNER_AGENT, REVIEWER_A, REVIEWER_B, OUTSIDER, H],
  );
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Room'),($2,$3,'Corner')`, [
    R,
    C,
    W,
  ]);
  await db.query(`UPDATE rooms SET parent_id=$1 WHERE id=$2`, [R, C]);
  await db.query(
    `INSERT INTO corner_facts(corner_id,owner_agent_id,objective,lifecycle) VALUES($1,$2,'Do work',$3::jsonb)`,
    [
      C,
      OWNER_AGENT,
      JSON.stringify({
        checks: 'passing',
        lifecycle: 'in-review',
        pr: { number: 7, url: 'https://github.com/acme/repo/pull/7', headSha: '1'.repeat(40) },
      }),
    ],
  );
  for (const who of [H, OWNER_AGENT, REVIEWER_A, REVIEWER_B, OUTSIDER])
    for (const room of [null, R, C])
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,
        [W, room, who],
      );
  await reportPresence(REVIEWER_A, 'online');
  await reportPresence(REVIEWER_B, 'online');
  phone = new PhoneService(db, 'http://test');
  daemon = new DaemonService(db, new LiveHub());
});

async function failTurn(c: AgentCommand) {
  await claim(c);
  await daemon.execute(
    'postAgentTurnReceipt',
    { roomId: c.roomId, agentId: c.agentId, requestId: c.turnRequestId, generationId: 'g1', status: 'working' },
    c.agentId,
  );
  await daemon.execute(
    'postAgentTurnReceipt',
    {
      roomId: c.roomId,
      agentId: c.agentId,
      requestId: c.turnRequestId,
      generationId: 'g1',
      status: 'failed',
      reasonKind: 'wrong-model',
      reason: 'the selected model is no longer available',
    },
    c.agentId,
  );
}

const reviews = async (agentId: string) =>
  (await commands(agentId)).filter((c) => c.reason === 'subscribed_event');

const exhaustedNotices = () =>
  db
    .query<{ text: string }>(`SELECT text FROM messages WHERE room_id=$1 AND text LIKE 'No reviewer on the list%'`, [C])
    .then((r) => r.rows);

async function setReviewers(...ids: string[]) {
  await phone.execute(
    'updateRoom',
    { roomId: R, reviewerAgentId: ids[0] ?? null, reviewerFallbackIds: ids.slice(1) },
    H,
  );
}

describe('updateRoom reviewer list', () => {
  it('stores the reviewer and its fallbacks in order, and clearing the reviewer clears them', async () => {
    await setReviewers(REVIEWER_B, REVIEWER_A);
    const row = () =>
      db
        .query<{ reviewer_agent_id: string | null; reviewer_fallback_ids: string[] }>(
          `SELECT reviewer_agent_id,reviewer_fallback_ids FROM rooms WHERE id=$1`,
          [R],
        )
        .then((r) => r.rows[0]);
    expect(await row()).toEqual({ reviewer_agent_id: REVIEWER_B, reviewer_fallback_ids: [REVIEWER_A] });

    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: null }, H);
    expect(await row()).toEqual({ reviewer_agent_id: null, reviewer_fallback_ids: [] });
  });

  it('refuses a fallback that is not an agent member of the Room, or a repeated one', async () => {
    await expect(setReviewers(REVIEWER_A, H)).rejects.toThrow('reviewer agent Room membership required');
    await expect(
      phone.execute(
        'updateRoom',
        { roomId: R, reviewerAgentId: REVIEWER_A, reviewerFallbackIds: [REVIEWER_B, REVIEWER_B] },
        H,
      ),
    ).rejects.toThrow('distinct agent ids');
  });

  it('refuses a reviewer list on a corner', async () => {
    await expect(
      phone.execute('updateRoom', { roomId: C, reviewerFallbackIds: [REVIEWER_A] }, H),
    ).rejects.toThrow('room lifecycle cannot target a corner');
  });
});

describe('check-passed dispatch with a reviewer list', () => {
  it('wakes the first agent on the list', async () => {
    await setReviewers(REVIEWER_A, REVIEWER_B);
    await greenCheck();
    expect(await reviews(REVIEWER_A)).toHaveLength(1);
    expect(await reviews(REVIEWER_B)).toHaveLength(0);
  });

  it('skips an unhealthy agent and the corner\'s own author', async () => {
    await reportPresence(REVIEWER_A, 'offline');
    await setReviewers(OWNER_AGENT, REVIEWER_A, REVIEWER_B);
    await greenCheck();
    expect(await reviews(OWNER_AGENT)).toHaveLength(0);
    expect(await reviews(REVIEWER_A)).toHaveLength(0);
    expect(await reviews(REVIEWER_B)).toHaveLength(1);
  });

  it('names the gap in the corner when nobody on the list is healthy, once per episode', async () => {
    await reportPresence(REVIEWER_A, 'offline');
    await reportPresence(REVIEWER_B, 'offline');
    // Setting the list re-reports the corner's green head, which already finds nobody.
    await setReviewers(REVIEWER_A, REVIEWER_B);
    const before = (await exhaustedNotices()).length;
    expect(before).toBe(1);
    const route = (sourceMessageId: string) =>
      routeSystemCommand(db, { roomId: C, sourceMessageId, kind: 'check-passed', targets: [] });
    await route('episode-1-trigger');
    await route('episode-1-trigger');
    expect(await exhaustedNotices()).toHaveLength(before + 1);
    expect((await exhaustedNotices())[0]!.text).not.toMatch(/class|tag|tier/i);
    expect(await reviews(REVIEWER_A)).toHaveLength(0);
    expect(await reviews(OWNER_AGENT)).toHaveLength(0);

    await db.query(
      `UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{pr,headSha}',to_jsonb($2::text)) WHERE corner_id=$1`,
      [C, '2'.repeat(40)],
    );
    await route('episode-2-trigger');
    expect(await exhaustedNotices()).toHaveLength(before + 2);
  });
});

describe('idle reviewers on the list', () => {
  it('wakes the first agent when both reviewers have been idle for hours', async () => {
    await idleFor(REVIEWER_A, 300);
    await idleFor(REVIEWER_B, 300);
    await setReviewers(REVIEWER_A, REVIEWER_B);
    await greenCheck();
    expect(await reviews(REVIEWER_A)).toHaveLength(1);
    expect(await exhaustedNotices()).toHaveLength(0);
  });

  it('passes a failed review to an idle second reviewer', async () => {
    await setReviewers(REVIEWER_A, REVIEWER_B);
    await greenCheck();
    await idleFor(REVIEWER_B, 300);
    await failTurn((await reviews(REVIEWER_A))[0]!);
    expect(await reviews(REVIEWER_B)).toHaveLength(1);
    expect(await exhaustedNotices()).toHaveLength(0);
  });

  it('still skips an idle reviewer whose last presence event was offline', async () => {
    await reportPresence(REVIEWER_A, 'offline');
    await idleFor(REVIEWER_A, 300);
    await setReviewers(REVIEWER_A, REVIEWER_B);
    await greenCheck();
    expect(await reviews(REVIEWER_A)).toHaveLength(0);
    expect(await reviews(REVIEWER_B)).toHaveLength(1);
  });
});

describe('a failed review turn', () => {
  it('passes the review to the next healthy agent on the list', async () => {
    await setReviewers(REVIEWER_A, REVIEWER_B);
    await greenCheck();
    const [first] = await reviews(REVIEWER_A);
    expect(await reviews(REVIEWER_B)).toHaveLength(0);
    await failTurn(first!);
    const [next] = await reviews(REVIEWER_B);
    expect(next).toBeDefined();
    expect(next!.turnRequestId).toBe(first!.turnRequestId);
    expect(await exhaustedNotices()).toHaveLength(0);
  });

  it('names the gap once the last agent on the list has failed too', async () => {
    await setReviewers(REVIEWER_A, REVIEWER_B);
    await greenCheck();
    await failTurn((await reviews(REVIEWER_A))[0]!);
    await failTurn((await reviews(REVIEWER_B))[0]!);
    expect(await exhaustedNotices()).toHaveLength(1);
    expect(await reviews(OWNER_AGENT)).toHaveLength(0);
  });

  it('never moves back up the list to an agent that recovered after being skipped', async () => {
    await reportPresence(REVIEWER_A, 'offline');
    await setReviewers(REVIEWER_A, REVIEWER_B);
    await greenCheck();
    const [first] = await reviews(REVIEWER_B);
    expect(first).toBeDefined();
    await reportPresence(REVIEWER_A, 'online');
    await failTurn(first!);
    expect(await reviews(REVIEWER_A)).toHaveLength(0);
    expect(await exhaustedNotices()).toHaveLength(1);
  });

  it('leaves a single reviewer alone, as before', async () => {
    await setReviewers(REVIEWER_A);
    await greenCheck();
    await failTurn((await reviews(REVIEWER_A))[0]!);
    expect(await reviews(REVIEWER_B)).toHaveLength(0);
    expect(await exhaustedNotices()).toHaveLength(0);
  });
});

describe('approve_merge with a reviewer list', () => {
  it('accepts an approval from a fallback reviewer', async () => {
    await setReviewers(REVIEWER_A, REVIEWER_B);
    const result = await daemon.execute(
      'approveCornerMerge',
      { cornerId: C, briefRevision: 0, headSha: '1'.repeat(40) },
      REVIEWER_B,
    );
    expect(result.pullRequestNumber).toBe(7);
    expect(
      (await cornerMergeGate(db, C, { number: 7, headSha: '1'.repeat(40) })).approvalPending,
    ).toBe(false);
  });

  it('refuses an approval from an agent not on the list', async () => {
    await setReviewers(REVIEWER_A, REVIEWER_B);
    await expect(
      daemon.execute(
        'approveCornerMerge',
        { cornerId: C, briefRevision: 0, headSha: '1'.repeat(40) },
        OUTSIDER,
      ),
    ).rejects.toThrow('NOT_CONFIGURED_REVIEWER');
  });

  it('never counts the corner author\'s own approval, even when it is on the list', async () => {
    await setReviewers(REVIEWER_A, OWNER_AGENT);
    await daemon
      .execute('approveCornerMerge', { cornerId: C, briefRevision: 0, headSha: '1'.repeat(40) }, OWNER_AGENT)
      .catch(() => undefined);
    expect(
      (await cornerMergeGate(db, C, { number: 7, headSha: '1'.repeat(40) })).approvalPending,
    ).toBe(true);
  });
});

describe('the end of a fallback reviewer\'s review', () => {
  it('hands a changes-requested head back to the implementer through the workflow', async () => {
    await reportPresence(REVIEWER_A, 'offline');
    await setReviewers(REVIEWER_A, REVIEWER_B);
    await greenCheck();
    const [review] = await reviews(REVIEWER_B);
    await claim(review!);
    await daemon.execute(
      'postRoomMessage',
      { roomId: C, requestId: review!.turnRequestId, generationId: 'g1', text: 'Please fix the race.' },
      review!.agentId,
    );
    const handbacks = (await commands(OWNER_AGENT)).filter((c) => c.reason === 'corner_review');
    expect(handbacks).toHaveLength(1);
    const state = await db.query<{ workflow_state: string; workflow_outcome: string }>(
      `SELECT workflow_state,workflow_outcome FROM corner_facts WHERE corner_id=$1`,
      [C],
    );
    expect(state.rows[0]).toEqual({ workflow_state: 'implement', workflow_outcome: 'changes_requested' });
  });
});
