import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { systemLine } from './system-line.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';
const H = 'a'.repeat(64),
  A = 'b'.repeat(64),
  B = 'c'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111',
  R = '22222222-2222-4222-8222-222222222222',
  C = '33333333-3333-4333-8333-333333333333';
let db: PgliteDatabase, phone: PhoneService, daemon: DaemonService;
const commands = (agentId = A, roomId = R) =>
  daemon.execute('getAgentCommands', { roomId }, agentId).then((r) => r.commands);
async function claim(c: AgentCommand, generationId = 'g1') {
  await daemon.execute(
    'claimAgentCommand',
    { roomId: c.roomId, commandId: c.id, generationId },
    c.agentId,
  );
  await daemon.execute(
    'postAgentTurnReceipt',
    {
      roomId: c.roomId,
      agentId: c.agentId,
      requestId: c.turnRequestId,
      generationId,
      status: 'working',
    },
    c.agentId,
  );
}
const result = (c: AgentCommand, text: string, generationId = 'g1', extra = {}) =>
  daemon.execute(
    'postRoomMessage',
    {
      roomId: c.roomId,
      requestId: c.turnRequestId,
      generationId,
      text,
      ...extra,
    },
    c.agentId,
  );
beforeAll(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Human','human'),($2,'agent','Hoots','hoots'),($3,'agent','Goosy','goosy')`,
    [H, A, B],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [A, B, H]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Attribution')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Room'),($2,$3,'Corner')`, [
    R,
    C,
    W,
  ]);
  await db.query(`UPDATE rooms SET parent_id=$1 WHERE id=$2`, [R, C]);
  await db.query(
    `INSERT INTO corner_facts(corner_id,owner_agent_id,objective,lifecycle) VALUES($1,$2,'Do work','{"checks":"unknown"}')`,
    [C, A],
  );
  for (const who of [H, A, B])
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
  await db.query(`DELETE FROM agent_commands`);
  await db.query(`DELETE FROM agent_turns`);
  await db.query(`DELETE FROM messages WHERE room_id=$1`, [C]);
  await db.query(`UPDATE agents SET access_policy='{"type":"everyone"}'::jsonb`);
  await db.query(`UPDATE memberships SET removed_at=NULL`);
  await db.query(`UPDATE memberships SET event_subscriptions='[]'::jsonb`);
  await db.query(`UPDATE rooms SET reviewer_agent_id=NULL`);
  await db.query(
    `UPDATE corner_facts SET lifecycle='{"checks":"unknown"}'::jsonb,command_check_state=NULL`,
  );
});

describe('corner message attribution', () => {
  it('stores the REVIEWER as author when the reviewer posts the review into a corner it does not own', async () => {
    // Corner owned by Hoots (A); Goosy (B) is the configured reviewer on the
    // parent Room and a member of parent + corner with a check-passed
    // subscription — the production review flow.
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await db.query(
      `UPDATE corner_facts SET lifecycle=$2::jsonb,command_check_state=NULL WHERE corner_id=$1`,
      [
        C,
        JSON.stringify({
          checks: 'passing',
          lifecycle: 'in-review',
          pr: { number: 7, url: 'https://github.com/acme/repo/pull/7', headSha: '1'.repeat(40) },
        }),
      ],
    );
    await systemLine(db, {
      roomId: C,
      authorId: H,
      subject: { kind: 'github', name: 'GitHub' },
      verb: 'passed a check',
      kind: 'check-passed',
    });
    const [review] = await commands(B, C);
    expect(review?.reason).toBe('subscribed_event');
    await claim(review!);
    await result(review!, 'Review complete: the race is fixed, approved.');
    const rows = (
      await db.query<{ author_id: string; text: string }>(
        `SELECT author_id,text FROM messages WHERE room_id=$1 AND text LIKE 'Review complete%'`,
        [C],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.author_id).toBe(B);
  });

  // Reproduction REVIEW-HANDOFF-1: the reviewer's verdict named nobody, so the
  // corner's worker was never woken and the corner stopped on a finished review.
  for (const verdict of [
    'Review complete: the reproduction is missing. Fix that and push.',
    `Review complete: PASS at ${'1'.repeat(40)}. Approved, merge it.`,
  ])
    it(`wakes the corner's worker when a review ending "${verdict.slice(19, 32)}" tags nobody`, async () => {
      await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
      await db.query(
        `UPDATE corner_facts SET lifecycle=$2::jsonb,command_check_state=NULL WHERE corner_id=$1`,
        [
          C,
          JSON.stringify({
            checks: 'passing',
            lifecycle: 'in-review',
            pr: { number: 11, url: 'https://github.com/acme/repo/pull/11', headSha: '1'.repeat(40) },
          }),
        ],
      );
      await systemLine(db, {
        roomId: C,
        authorId: H,
        subject: { kind: 'github', name: 'GitHub' },
        verb: 'passed a check',
        kind: 'check-passed',
      });
      const [review] = await commands(B, C);
      await claim(review!);
      await result(review!, verdict);
      const handoff = await commands(A, C);
      expect(handoff.map((command) => command.reason)).toEqual(['corner_review']);
      expect(handoff[0]!.source.body).toBe(verdict);
    });

  it("wakes the worker when the verdict tags a person instead of it", async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await db.query(
      `UPDATE corner_facts SET lifecycle=$2::jsonb,command_check_state=NULL WHERE corner_id=$1`,
      [
        C,
        JSON.stringify({
          checks: 'passing',
          lifecycle: 'in-review',
          pr: { number: 13, url: 'https://github.com/acme/repo/pull/13', headSha: '1'.repeat(40) },
        }),
      ],
    );
    await systemLine(db, {
      roomId: C,
      authorId: H,
      subject: { kind: 'github', name: 'GitHub' },
      verb: 'passed a check',
      kind: 'check-passed',
    });
    const [review] = await commands(B, C);
    await claim(review!);
    // A typed mention takes the routed write path, but it reaches a person by
    // push and highlight — it hands the branch to nobody.
    await result(review!, '@human the findings are confirmed, this one fails.');
    const handoff = await commands(A, C);
    expect(handoff.map((command) => command.reason)).toEqual(['corner_review']);
  });

  it('leaves the reviewer a single turn when its verdict tags the worker itself', async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await db.query(
      `UPDATE corner_facts SET lifecycle=$2::jsonb,command_check_state=NULL WHERE corner_id=$1`,
      [
        C,
        JSON.stringify({
          checks: 'passing',
          lifecycle: 'in-review',
          pr: { number: 12, url: 'https://github.com/acme/repo/pull/12', headSha: '1'.repeat(40) },
        }),
      ],
    );
    await systemLine(db, {
      roomId: C,
      authorId: H,
      subject: { kind: 'github', name: 'GitHub' },
      verb: 'passed a check',
      kind: 'check-passed',
    });
    const [review] = await commands(B, C);
    await claim(review!);
    await result(review!, '@hoots approved, merge it.');
    // The typed tag routes first and keeps the row; the handoff must not add a
    // second turn for the same reply.
    const handoff = await commands(A, C);
    expect(handoff.map((command) => command.reason)).toEqual(['agent_tag']);
  });

  it('keeps a configured reviewer as the review target even when it is not a corner member', async () => {
    // Remove Goosy (B) from the CORNER (it stays a parent-Room member and the
    // configured reviewer). The check passes. Where does the review command go?
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
      C,
      B,
    ]);
    await db.query(
      `UPDATE corner_facts SET lifecycle=$2::jsonb,command_check_state=NULL WHERE corner_id=$1`,
      [
        C,
        JSON.stringify({
          checks: 'passing',
          lifecycle: 'in-review',
          pr: { number: 8, url: 'https://github.com/acme/repo/pull/8', headSha: '2'.repeat(40) },
        }),
      ],
    );
    await systemLine(db, {
      roomId: C,
      authorId: H,
      subject: { kind: 'github', name: 'GitHub' },
      verb: 'passed a check',
      kind: 'check-passed',
    });
    const routed = (
      await db.query<{ agent_id: string; reason: string }>(
        `SELECT agent_id,reason FROM agent_commands WHERE room_id=$1`,
        [C],
      )
    ).rows;
    console.log('routed:', JSON.stringify(routed));
    expect(routed).toHaveLength(1);
    expect(routed[0]!.agent_id).toBe(B);
  });

  it('does not wake the author or consume green when the reviewer is not a parent member', async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
      R,
      B,
    ]);
    await db.query(
      `UPDATE corner_facts SET lifecycle=$2::jsonb,command_check_state=NULL WHERE corner_id=$1`,
      [
        C,
        JSON.stringify({
          checks: 'passing',
          lifecycle: 'in-review',
          pr: { number: 9, url: 'https://github.com/acme/repo/pull/9', headSha: '3'.repeat(40) },
        }),
      ],
    );
    await systemLine(db, {
      roomId: C,
      authorId: H,
      subject: { kind: 'github', name: 'GitHub' },
      verb: 'passed a check',
      kind: 'check-passed',
    });
    const routed = (
      await db.query<{ agent_id: string; reason: string }>(
        `SELECT agent_id,reason FROM agent_commands WHERE room_id=$1`,
        [C],
      )
    ).rows;
    expect(routed).toEqual([]);
    expect(
      (
        await db.query<{ command_check_state: string | null }>(
          `SELECT command_check_state FROM corner_facts WHERE corner_id=$1`,
          [C],
        )
      ).rows[0]?.command_check_state,
    ).toBeNull();
    expect(
      (
        await db.query<{ text: string }>(
          `SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%could not be reached%'`,
          [C],
        )
      ).rows.map((row) => row.text),
    ).toEqual(['@goosy could not be reached · not a current member of the parent Room']);
  });

  it('names a parent-member reviewer it cannot deliver into the corner and still retries', async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
      C,
      B,
    ]);
    await db.query(`
      CREATE FUNCTION keep_reviewer_off_corner() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.room_id='${C}' AND NEW.identity_id='${B}' THEN
          NEW.removed_at := now();
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER keep_reviewer_off_corner BEFORE INSERT OR UPDATE ON memberships
        FOR EACH ROW EXECUTE FUNCTION keep_reviewer_off_corner();
    `);
    try {
      await db.query(
        `UPDATE corner_facts SET lifecycle=$2::jsonb,command_check_state=NULL WHERE corner_id=$1`,
        [
          C,
          JSON.stringify({
            checks: 'passing',
            lifecycle: 'in-review',
            pr: { number: 10, url: 'https://github.com/acme/repo/pull/10', headSha: '4'.repeat(40) },
          }),
        ],
      );
      await systemLine(db, {
        roomId: C,
        authorId: H,
        subject: { kind: 'github', name: 'GitHub' },
        verb: 'passed a check',
        kind: 'check-passed',
      });
      expect(
        (
          await db.query<{ agent_id: string }>(
            `SELECT agent_id FROM agent_commands WHERE room_id=$1`,
            [C],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await db.query<{ command_check_state: string | null }>(
            `SELECT command_check_state FROM corner_facts WHERE corner_id=$1`,
            [C],
          )
        ).rows[0]?.command_check_state,
      ).toBeNull();
      expect(
        (
          await db.query<{ text: string }>(
            `SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%could not be reached%'`,
            [C],
          )
        ).rows.map((row) => row.text),
      ).toEqual(['@goosy could not be reached · not a current member of this corner']);
    } finally {
      await db.query(`
        DROP TRIGGER IF EXISTS keep_reviewer_off_corner ON memberships;
        DROP FUNCTION IF EXISTS keep_reviewer_off_corner();
      `);
    }
  });
});
