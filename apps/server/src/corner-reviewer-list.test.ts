import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, PostgresDatabase, type SqlDatabase } from './database.js';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { workflowRunLockKey } from './workflow-runs.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { systemLine } from './system-line.js';
import { routeSystemCommand } from './agent-command.js';
import { advanceCorner, claimCornerMergeAttempt, cornerMergeGate, reassignFailedCornerReviewer } from './corner-lifecycle.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';

const H = 'a'.repeat(64);
const OWNER_AGENT = 'b'.repeat(64);
const REVIEWER_A = 'c'.repeat(64);
const REVIEWER_B = 'd'.repeat(64);
const OUTSIDER = 'e'.repeat(64);
const W = '11111111-1111-4111-8111-111111111112';
const R = '22222222-2222-4222-8222-222222222223';
const C = '33333333-3333-4333-8333-333333333334';

let db: SqlDatabase;
let closeDatabase: () => Promise<void>;
const postgresUrl = process.env.BEELINE_REVIEW_RECOVERY_TEST_POSTGRES_URL;
if (postgresUrl && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(postgresUrl).hostname))
  throw new Error('review recovery proof requires isolated loopback PostgreSQL');
afterEach(async () => { vi.restoreAllMocks(); await closeDatabase?.(); }, 30_000);
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
  if (postgresUrl) {
    const databaseName = `review_recovery_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: postgresUrl });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const isolatedUrl = new URL(postgresUrl);
    isolatedUrl.pathname = `/${databaseName}`;
    const pg = new PostgresDatabase('', 5, { mode: 'migration', pool: new Pool({
      connectionString: isolatedUrl.toString(),
    }) });
    db = pg;
    closeDatabase = async () => { await pg.close(); await admin.query(`DROP DATABASE ${databaseName}`); await admin.end(); };
  } else {
    const lite = new PgliteDatabase(); db = lite; closeDatabase = () => lite.close();
  }
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
  await db.query(`UPDATE rooms SET parent_id=$1,created_by=$3 WHERE id=$2`, [R, C, OWNER_AGENT]);
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
    for (const room of [null, R])
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,
        [W, room, who],
      );
  await reportPresence(REVIEWER_A, 'online');
  await reportPresence(REVIEWER_B, 'online');
  phone = new PhoneService(db, 'http://test');
  daemon = new DaemonService(db, new LiveHub());
  // These lifecycle fixtures model an independent PR author; provider checks have separate coverage.
  Object.assign(daemon, { github: { assertCornerReviewerNotAuthor: async () => {} } });
}, 30_000);

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
    .query<{ text: string }>(`SELECT private_payload->>'text' text FROM agent_commands WHERE room_id=$1 AND reason='report' AND private_payload->>'text' LIKE 'blocked: no reviewer on the configured list%'`, [R])
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

  it('drops empty fallback entries on write and migration', async () => {
    await setReviewers(REVIEWER_A, '', REVIEWER_B);
    await db.query(`UPDATE rooms SET reviewer_fallback_ids=array_append(reviewer_fallback_ids,'') WHERE id=$1`, [R]);
    await migrate(db);
    const row = await db.query(`SELECT reviewer_fallback_ids FROM rooms WHERE id=$1`, [R]);
    expect(row.rows[0]?.reviewer_fallback_ids).toEqual([REVIEWER_B]);
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

  it('skips the implementer and unhealthy agents for a healthy fallback', async () => {
    await reportPresence(REVIEWER_A, 'offline');
    await reportPresence(OWNER_AGENT, 'online');
    await setReviewers(OWNER_AGENT, REVIEWER_A, REVIEWER_B);
    await greenCheck();
    expect(await reviews(OWNER_AGENT)).toHaveLength(0);
    expect(await reviews(REVIEWER_A)).toHaveLength(0);
    expect(await reviews(REVIEWER_B)).toHaveLength(1);
  });

  it('excludes the current implementer after a handoff, while allowing the opener to review', async () => {
    await db.query(`UPDATE corner_facts SET worker_agent_id=$2 WHERE corner_id=$1`, [C, REVIEWER_A]);
    await reportPresence(OWNER_AGENT, 'online');
    await setReviewers(REVIEWER_A, OWNER_AGENT);
    await greenCheck();
    expect(await reviews(REVIEWER_A)).toHaveLength(0);
    expect(await reviews(OWNER_AGENT)).toHaveLength(1);
  });

  it('hands review back without dispatching to its sole implementer reviewer', async () => {
    await reportPresence(OWNER_AGENT, 'online');
    await setReviewers(OWNER_AGENT);
    await greenCheck();
    expect(await reviews(OWNER_AGENT)).toHaveLength(0);
    const handback = await db.query(`SELECT private_payload FROM agent_commands
      WHERE room_id=$1 AND agent_id=$2 AND reason='corner_review_needed'`, [C, OWNER_AGENT]);
    expect(handback.rowCount).toBeGreaterThan(0);
  });

  it('reports the gap privately when nobody on the list is healthy, once per episode', async () => {
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
    expect((await commands(OWNER_AGENT)).some(command => command.reason === 'corner_review_needed')).toBe(true);

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

  it('passes a recovered review dispatch through the same fallback list', async () => {
    await setReviewers(REVIEWER_A, REVIEWER_B);
    await greenCheck();
    await db.query(`DELETE FROM agent_commands WHERE room_id=$1`, [C]);
    await advanceCorner(db, C, { kind: 'checks', result: 'passing', sourceMessageId: 'replay' });
    const [recovered] = (await commands(REVIEWER_A)).filter(c => c.reason === 'corner_review_dispatch');
    expect(recovered).toBeDefined();
    await failTurn(recovered!);
    const [next] = await commands(REVIEWER_B);
    expect(next).toBeDefined();
    expect(next!.turnRequestId).toBe(recovered!.turnRequestId);
    await failTurn(next!);
    expect(await exhaustedNotices()).toHaveLength(1);
  });

  it('names the gap once the last agent on the list has failed too', async () => {
    await setReviewers(REVIEWER_A, REVIEWER_B);
    await greenCheck();
    await failTurn((await reviews(REVIEWER_A))[0]!);
    await failTurn((await reviews(REVIEWER_B))[0]!);
    expect(await exhaustedNotices()).toHaveLength(1);
    expect(await reviews(OWNER_AGENT)).toHaveLength(0);
    expect((await commands(OWNER_AGENT)).some(command => command.reason === 'corner_review_needed')).toBe(true);
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
  it('Reproduction R5e: a fallback approval opens the gate after the primary reviewer leaves', async () => {
    await setReviewers(REVIEWER_A, REVIEWER_B);
    await db.query(
      `UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,
      [R, REVIEWER_A],
    );
    await daemon.execute(
      'approveCornerMerge',
      { cornerId: C, headSha: '1'.repeat(40) },
      REVIEWER_B,
    );
    expect(await cornerMergeGate(db, C, { number: 7, headSha: '1'.repeat(40) })).toMatchObject({
      reviewerExists: true,
      approved: true,
      open: true,
    });
    // The claim also requires a brief; this one predates repositoryWork, so it may merge.
    await db.query(
      `INSERT INTO corner_brief_revisions(corner_id,revision,content,author_id,source_room_id)
       VALUES($1,1,'Do work',$2,$3)`,
      [C, OWNER_AGENT, R],
    );
    expect(await claimCornerMergeAttempt(db, C, '1'.repeat(40))).toBe(true);
    expect(await claimCornerMergeAttempt(db, C, '1'.repeat(40))).toBe(false);
  });

  it('accepts an approval from a fallback reviewer', async () => {
    await setReviewers(REVIEWER_A, REVIEWER_B);
    const result = await daemon.execute(
      'approveCornerMerge',
      { cornerId: C, headSha: '1'.repeat(40) },
      REVIEWER_B,
    );
    expect(result.pullRequestNumber).toBe(7);
    expect(
      (await cornerMergeGate(db, C, { number: 7, headSha: '1'.repeat(40) })).approved,
    ).toBe(true);
  });

  it('refuses an approval from an agent not on the list', async () => {
    await setReviewers(REVIEWER_A, REVIEWER_B);
    await expect(
      daemon.execute(
        'approveCornerMerge',
        { cornerId: C, headSha: '1'.repeat(40) },
        OUTSIDER,
      ),
    ).rejects.toThrow('NOT_CONFIGURED_REVIEWER');
  });

  it('refuses the implementer even when configured as a Room fallback', async () => {
    await setReviewers(REVIEWER_A, OWNER_AGENT);
    await expect(daemon.execute('approveCornerMerge',
      { cornerId: C, headSha: '1'.repeat(40) }, OWNER_AGENT)).rejects.toThrow('implementer cannot review');
    expect((await cornerMergeGate(db, C, { number: 7, headSha: '1'.repeat(40) })).approved).toBe(false);
  });
});

describe('the end of a fallback reviewer\'s review', () => {
  it('leaves a head without a PASS in review and hands nothing back', async () => {
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
    expect(await commands(OWNER_AGENT)).toEqual([]);
    const state = await db.query<{ workflow_state: string; workflow_outcome: string }>(
      `SELECT workflow_state,workflow_outcome FROM corner_facts WHERE corner_id=$1`,
      [C],
    );
    expect(state.rows[0]).toEqual({ workflow_state: 'review', workflow_outcome: 'passing' });
  });
});


describe('Reproduction REVIEW-RECOVERY-DEADLOCK', () => {
  async function receiptFixture() {
    await setReviewers(REVIEWER_A, REVIEWER_B);
    await greenCheck();
    const [first] = await reviews(REVIEWER_A);
    await claim(first!);
    await daemon.execute('postAgentTurnReceipt', { roomId: C, requestId: first!.turnRequestId,
      generationId: 'g1', status: 'working' }, REVIEWER_A);
    return { roomId: C, requestId: first!.turnRequestId, generationId: 'g1', status: 'failed' as const,
      reasonKind: 'wrong-model' as const, reason: 'the selected model is no longer available' };
  }

  it.each(['lock', 'after-wake', 'exhausted', 'other-error'])('rolls back the owning receipt transaction: %s', async point => {
    const input = await receiptFixture();
    const original = db.transaction.bind(db);
    const fault = Object.assign(new Error('injected recovery contention'), { code: point === 'other-error' ? '57014' : '40P01' });
    let attempts = 0;
    let faults = 0;
    const statements: { sql: string; values?: unknown[] }[][] = [];
    const spy = vi.spyOn(db, 'transaction').mockImplementation(work => original(async tx => {
      attempts++;
      const sqls: { sql: string; values?: unknown[] }[] = []; statements.push(sqls);
      const wrapped: SqlDatabase = {
        query: async (sql, values) => {
          sqls.push({ sql, values });
          if (sql.includes('pg_advisory_xact_lock') && values?.[0] === workflowRunLockKey(C) &&
              point !== 'after-wake' && (faults === 0 || point === 'exhausted')) {
            faults++; throw fault;
          }
          return tx.query(sql, values);
        },
        transaction: async nested => nested(wrapped),
      };
      const result = await work(wrapped);
      if (point === 'after-wake' && faults === 0) {
        expect((await tx.query('SELECT 1 FROM agent_commands WHERE room_id=$1 AND agent_id=$2', [C, REVIEWER_B])).rowCount).toBe(1);
        faults++; throw fault;
      }
      return result;
    }));
    if (point === 'exhausted' || point === 'other-error') {
      await expect(daemon.execute('postAgentTurnReceipt', input, REVIEWER_A)).rejects.toBe(fault);
      expect(attempts).toBe(point === 'exhausted' ? 3 : 1);
      spy.mockRestore();
      expect((await db.query('SELECT status FROM agent_turns WHERE room_id=$1 AND agent_id=$2', [C, REVIEWER_A])).rows[0]?.status).toBe('working');
      expect(await reviews(REVIEWER_B)).toHaveLength(0);
    } else {
      await daemon.execute('postAgentTurnReceipt', input, REVIEWER_A);
      expect(attempts).toBe(2);
      spy.mockRestore();
      expect((await db.query('SELECT status FROM agent_turns WHERE room_id=$1 AND agent_id=$2', [C, REVIEWER_A])).rows[0]?.status).toBe('failed');
      expect(await reviews(REVIEWER_B)).toHaveLength(1);
      await reassignFailedCornerReviewer(db, { roomId: C, requestId: input.requestId, agentId: REVIEWER_A });
      expect(await reviews(REVIEWER_B)).toHaveLength(1);
      expect(statements[1]![0]).toMatchObject({
        sql: expect.stringContaining('pg_advisory_xact_lock'), values: [workflowRunLockKey(C)],
      });
    }
    console.info(`Reproduction REVIEW-RECOVERY-DEADLOCK: ${point}, attempts=${attempts}; rollback and reviewer assignment verified`);
  });

  it.runIf(Boolean(postgresUrl))('serializes a lifecycle holder updating the receipt turn', async () => {
    const input = await receiptFixture();
    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>(resolve => { ready = resolve; });
    const proceed = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [workflowRunLockKey(C)]);
      ready(); await proceed;
      await tx.query("UPDATE agent_turns SET created_at=now() WHERE room_id=$1 AND agent_id=$2", [C, REVIEWER_A]);
    });
    await held;
    const receipt = daemon.execute('postAgentTurnReceipt', input, REVIEWER_A);
    // Wait until the receipt actually waits on the held lifecycle lock.
    try {
      await vi.waitFor(async () => {
        const waits = await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock%'");
        expect(waits.rowCount).toBeGreaterThan(0);
      });
    } finally { release(); }
    await Promise.all([holder, receipt]);
    expect(await reviews(REVIEWER_B)).toHaveLength(1);
    console.info('Reproduction REVIEW-RECOVERY-DEADLOCK: concurrent lifecycle/receipt transactions both committed; one fallback wake');
  });
});
