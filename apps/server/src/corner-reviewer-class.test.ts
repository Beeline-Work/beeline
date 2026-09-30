import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { systemLine } from './system-line.js';
import { createAgentCommand, routeSystemCommand } from './agent-command.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';

const H = 'a'.repeat(64);
const OWNER_AGENT = 'b'.repeat(64);
const HEAVY_A = 'c'.repeat(64);
const HEAVY_B = 'd'.repeat(64);
const LIGHT_ONE = 'e'.repeat(64);
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
       ($3,'agent','HeavyA','heavya'),($4,'agent','HeavyB','heavyb'),($5,'agent','Light','light')`,
    [H, OWNER_AGENT, HEAVY_A, HEAVY_B, LIGHT_ONE],
  );
  await db.query(
    `INSERT INTO agents(agent_id,owner_id,selected_model) VALUES
       ($1,$5,NULL),($2,$5,'opus-4-5'),($3,$5,'opus-4-5'),($4,$5,'some-light-model')`,
    [OWNER_AGENT, HEAVY_A, HEAVY_B, LIGHT_ONE, H],
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
  for (const who of [H, OWNER_AGENT, HEAVY_A, HEAVY_B, LIGHT_ONE])
    for (const room of [null, R, C])
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,
        [W, room, who],
      );
  await reportPresence(HEAVY_A, 'online');
  await reportPresence(HEAVY_B, 'online');
  phone = new PhoneService(db, 'http://test');
  daemon = new DaemonService(db, new LiveHub());
});

describe('updateRoom reviewerClass', () => {
  it('is mutually exclusive with reviewerAgentId', async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: HEAVY_A }, H);
    await phone.execute('updateRoom', { roomId: R, reviewerClass: 'heavy' }, H);
    const row = await db.query<{ reviewer_agent_id: string | null; reviewer_class: string | null }>(
      `SELECT reviewer_agent_id,reviewer_class FROM rooms WHERE id=$1`,
      [R],
    );
    expect(row.rows[0]).toEqual({ reviewer_agent_id: null, reviewer_class: 'heavy' });

    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: HEAVY_B }, H);
    const after = await db.query<{ reviewer_agent_id: string | null; reviewer_class: string | null }>(
      `SELECT reviewer_agent_id,reviewer_class FROM rooms WHERE id=$1`,
      [R],
    );
    expect(after.rows[0]).toEqual({ reviewer_agent_id: HEAVY_B, reviewer_class: null });
  });
});

describe('check-passed dispatch with a class-configured reviewer', () => {
  it('wakes a healthy current member carrying the class tag, never the corner owner', async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerClass: 'heavy' }, H);
    await greenCheck();
    const heavyACommands = await commands(HEAVY_A);
    const heavyBCommands = await commands(HEAVY_B);
    const dispatched = [...heavyACommands, ...heavyBCommands];
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.reason).toBe('subscribed_event');
    expect(await commands(LIGHT_ONE)).toHaveLength(0);
    expect(await commands(OWNER_AGENT)).toHaveLength(0);
  });

  it('names the exhausted class in the corner instead of falling back to the owner', async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerClass: 'heavy' }, H);
    await reportPresence(HEAVY_A, 'offline');
    await reportPresence(HEAVY_B, 'offline');
    await greenCheck();
    expect(await commands(HEAVY_A)).toHaveLength(0);
    expect(await commands(HEAVY_B)).toHaveLength(0);
    expect(await commands(OWNER_AGENT)).toHaveLength(0);
    const notice = await db.query<{ text: string }>(
      `SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%no healthy member%'`,
      [C],
    );
    expect(notice.rows).toHaveLength(1);
  });

  it('keys the exhaustion notice per episode (head SHA + triggering message), not per corner+class forever', async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerClass: 'heavy' }, H);
    await reportPresence(HEAVY_A, 'offline');
    await reportPresence(HEAVY_B, 'offline');
    const noticeCount = () =>
      db
        .query<{ id: string }>(
          `SELECT id FROM messages WHERE room_id=$1 AND text LIKE '%no healthy member%'`,
          [C],
        )
        .then((r) => r.rows.length);

    await routeSystemCommand(db, {
      roomId: C,
      sourceMessageId: 'episode-1-trigger',
      kind: 'check-passed',
      targets: [],
    });
    expect(await noticeCount()).toBe(1);

    // A retry of the exact same triggering check/command collapses into the
    // one already posted for this episode.
    await routeSystemCommand(db, {
      roomId: C,
      sourceMessageId: 'episode-1-trigger',
      kind: 'check-passed',
      targets: [],
    });
    expect(await noticeCount()).toBe(1);

    // A later green on a NEW head is an independent exhaustion episode and
    // must post its own notice, not be swallowed by the first.
    await db.query(
      `UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{pr,headSha}',to_jsonb($2::text)) WHERE corner_id=$1`,
      [C, '2'.repeat(40)],
    );
    await routeSystemCommand(db, {
      roomId: C,
      sourceMessageId: 'episode-2-trigger',
      kind: 'check-passed',
      targets: [],
    });
    expect(await noticeCount()).toBe(2);
  });
});

describe('approve_merge with a class-configured reviewer', () => {
  it('accepts an approval from a current member carrying the class tag', async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerClass: 'heavy' }, H);
    await greenCheck();
    const [review] = await commands(HEAVY_A).then((rows) =>
      rows.length ? rows : commands(HEAVY_B),
    );
    await claim(review!);
    const approver = review!.agentId;
    const result = await daemon.execute(
      'approveCornerMerge',
      { cornerId: C, briefRevision: 0, headSha: '1'.repeat(40) },
      approver,
    );
    expect(result.pullRequestNumber).toBe(7);
  });

  it('refuses an approval from an agent that does not carry the class tag', async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerClass: 'heavy' }, H);
    await expect(
      daemon.execute(
        'approveCornerMerge',
        { cornerId: C, briefRevision: 0, headSha: '1'.repeat(40) },
        LIGHT_ONE,
      ),
    ).rejects.toThrow('NOT_CONFIGURED_REVIEWER');
  });
});
