import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { systemLine } from './system-line.js';
import { reconcileConfiguredCornerReviewers } from './agent-command.js';

/**
 * A reconciled reviewer must be woken into a turn that can record a verdict.
 *
 * The body decides whether to mount `approve_merge` from two server answers
 * that meet in one session: `getAgentConfiguration` says whether this agent
 * holds the Room's reviewer post, and `listRoomCorners` says who opened the
 * corner. They must agree. When they disagreed, the reviewer was told to
 * approve a head and handed no tool to approve it with, so its PASS could only
 * be prose while the merge gate stayed at `approvalPending=true`.
 */
const H = 'a'.repeat(64),
  REVIEWER = 'b'.repeat(64),
  IMPLEMENTER = 'c'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111',
  R = '22222222-2222-4222-8222-222222222222',
  C = '33333333-3333-4333-8333-333333333333';
const HEAD = '1'.repeat(40);

let db: PgliteDatabase, phone: PhoneService, daemon: DaemonService;

/** What the body reads at session activation to decide the reviewer surface. */
async function activationFacts(agentId: string) {
  const [configuration, corners] = await Promise.all([
    daemon.execute('getAgentConfiguration', { agentId, roomId: C }, agentId),
    daemon.execute('listRoomCorners', { roomId: R }, agentId),
  ]);
  const corner = corners.corners.find((entry) => entry.cornerId === C);
  return {
    reviewerHandle: configuration.reviewerHandle,
    openedBy: corner?.createdBy,
    // `cornerReviewerInstruction` in apps/body refuses when either is missing,
    // and `room-session` only sets BEELINE_CORNER_REVIEWER when it returns one.
    reviewerSurface: Boolean(configuration.reviewerHandle) && corner?.createdBy !== agentId,
  };
}

beforeAll(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle)
     VALUES($1,'human','Human','human'),($2,'agent','Hoots','hoots'),($3,'agent','Goosy','goosy')`,
    [H, REVIEWER, IMPLEMENTER],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [
    REVIEWER,
    IMPLEMENTER,
    H,
  ]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Room',$3)`, [
    R,
    W,
    H,
  ]);
  await db.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'Corner',$4)`,
    [C, W, R, H],
  );
  await db.query(
    `INSERT INTO corner_facts(corner_id,owner_agent_id,objective,lifecycle)
     VALUES($1,$2,'Do work',$3::jsonb)`,
    [
      C,
      IMPLEMENTER,
      JSON.stringify({
        lifecycle: 'in-review',
        checks: 'passing',
        pr: { number: 7, url: 'https://github.com/acme/repo/pull/7', headSha: HEAD },
      }),
    ],
  );
  for (const who of [H, REVIEWER, IMPLEMENTER])
    for (const room of [null, R, C])
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,
        [W, room, who],
      );
  phone = new PhoneService(db, 'http://test');
  daemon = new DaemonService(db, new LiveHub());
}, 30_000);
afterAll(async () => db?.close());
beforeEach(async () => {
  await db.query(`UPDATE corner_facts SET owner_agent_id=$2 WHERE corner_id=$1`, [C, IMPLEMENTER]);
  await db.query(`UPDATE rooms SET created_by=$2 WHERE id=$1`, [C, H]);
  await phone.execute('updateRoom', { roomId: R, reviewerAgentId: REVIEWER }, H);
  await systemLine(db, {
    roomId: C,
    authorId: H,
    subject: { kind: 'github', name: 'GitHub' },
    verb: 'passed a check',
    kind: 'check-passed',
  });
  // Clear whatever the configuration tap and the check event already
  // dispatched, so each test measures the reconcile pass on its own.
  await db.query(`DELETE FROM agent_commands`);
});

/** The reconciled wake, as the reviewer's own command poll would see it. */
const reviewCommands = () =>
  daemon.execute('getAgentCommands', { roomId: C }, REVIEWER).then((r) => r.commands);

describe('the turn a reconciled reviewer is woken into', () => {
  it('carries a reviewer surface for a corner somebody else opened', async () => {
    await expect(reconcileConfiguredCornerReviewers(db)).resolves.toEqual(
      expect.objectContaining({ commands: 1 }),
    );
    expect(await reviewCommands()).toEqual([expect.objectContaining({ agentId: REVIEWER })]);
    await expect(activationFacts(REVIEWER)).resolves.toEqual({
      reviewerHandle: 'hoots',
      openedBy: IMPLEMENTER,
      reviewerSurface: true,
    });
  });

  it('still carries one when the corner owner was never recorded', async () => {
    // The population reconciliation exists for: green heads old enough that
    // `owner_agent_id` predates the corner-owner backfill. The listing must
    // fall back to the Room's recorded creator, exactly as the configuration
    // query does — never to whichever agent happens to be polling.
    await db.query(`UPDATE corner_facts SET owner_agent_id=NULL WHERE corner_id=$1`, [C]);
    await expect(reconcileConfiguredCornerReviewers(db)).resolves.toEqual(
      expect.objectContaining({ commands: 1 }),
    );
    expect(await reviewCommands()).toEqual([expect.objectContaining({ agentId: REVIEWER })]);
    const facts = await activationFacts(REVIEWER);
    expect(facts.openedBy).toBe(H);
    expect(facts.openedBy).not.toBe(REVIEWER);
    expect(facts).toEqual({ reviewerHandle: 'hoots', openedBy: H, reviewerSurface: true });
  });

  it('agrees with the configuration query when the reviewer opened the corner itself', async () => {
    await db.query(`UPDATE corner_facts SET owner_agent_id=$2 WHERE corner_id=$1`, [C, REVIEWER]);
    // Not a contradiction to fix: reviewing your own work is not reviewing, so
    // both answers withhold the post and the agent gets a plain author's turn.
    await expect(activationFacts(REVIEWER)).resolves.toEqual({
      reviewerHandle: undefined,
      openedBy: REVIEWER,
      reviewerSurface: false,
    });
  });
});
