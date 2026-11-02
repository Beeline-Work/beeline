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
import { cornerMergeGate } from './corner-lifecycle.js';
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

async function setReviewer(id: string | null) {
  await phone.execute('updateRoom', { roomId: R, reviewerAgentId: id }, H);
}

describe('FALLBACK-GONE: a Room has one reviewer', () => {
  it('ignores fallback reviewers an older phone still sends', async () => {
    await phone.execute('updateRoom',
      { roomId: R, reviewerAgentId: REVIEWER_A, reviewerFallbackIds: [REVIEWER_B] } as never, H);
    expect((await db.query(`SELECT reviewer_agent_id,reviewer_fallback_ids FROM rooms WHERE id=$1`, [R])).rows[0])
      .toEqual({ reviewer_agent_id: REVIEWER_A, reviewer_fallback_ids: [] });
  });

  it('wakes the Room reviewer, and a failed review hands nothing to another agent', async () => {
    await db.query(`UPDATE rooms SET reviewer_fallback_ids=$2 WHERE id=$1`, [R, [REVIEWER_B]]);
    await setReviewer(REVIEWER_A);
    await greenCheck();
    const [review] = await reviews(REVIEWER_A);
    expect(review).toBeDefined();
    await failTurn(review!);
    expect(await reviews(REVIEWER_B)).toHaveLength(0);
  });

  it('hands review back without dispatching to its sole implementer reviewer', async () => {
    await reportPresence(OWNER_AGENT, 'online');
    await setReviewer(OWNER_AGENT);
    await greenCheck();
    expect(await reviews(OWNER_AGENT)).toHaveLength(0);
    const handback = await db.query(`SELECT private_payload FROM agent_commands
      WHERE room_id=$1 AND agent_id=$2 AND reason='corner_review_needed'`, [C, OWNER_AGENT]);
    expect(handback.rowCount).toBeGreaterThan(0);
  });

  it('accepts a PASS only from the configured reviewer, never a stored fallback', async () => {
    await db.query(`UPDATE rooms SET reviewer_fallback_ids=$2 WHERE id=$1`, [R, [REVIEWER_B]]);
    await setReviewer(REVIEWER_A);
    for (const agent of [REVIEWER_B, OUTSIDER])
      await expect(daemon.execute('approveCornerMerge', { cornerId: C, headSha: '1'.repeat(40) }, agent))
        .rejects.toThrow('NOT_CONFIGURED_REVIEWER');
    expect((await cornerMergeGate(db, C, { number: 7, headSha: '1'.repeat(40) })).approved).toBe(false);
  });
});
