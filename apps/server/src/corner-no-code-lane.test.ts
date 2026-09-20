import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';

/**
 * The no-code lane is a durable corner fact, chosen once at open.
 *
 * A repository Room's corner used to have exactly one shape — worktree,
 * branch, pull request, merge — so an objective that produced no code change
 * still had to invent a commit to deliver anything. The lane is what lets the
 * same Room open a corner that delivers artifacts instead, and it has to
 * survive a helper restart, which is why it lives in `corner_facts` and comes
 * back out of `getCornerRestoreState` beside the handle to tag.
 */

const HUMAN = 'a'.repeat(64),
  AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111',
  CODE_ROOM = '22222222-2222-4222-8222-222222222222',
  CHAT_ROOM = '44444444-4444-4444-8444-444444444444';

let db: PgliteDatabase, phone: PhoneService, daemon: DaemonService;

beforeAll(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Ada','ada'),($2,'agent','Hoots','hoots')`,
    [HUMAN, AGENT],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, HUMAN]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Lanes')`, [WORKSPACE]);
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,repository_key,repository_remote,repository_resolution,repository_target_branch)
     VALUES($1,$2,'Widgets','owner/widgets','https://github.com/owner/widgets.git','repository','main')`,
    [CODE_ROOM, WORKSPACE],
  );
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Studio')`, [
    CHAT_ROOM,
    WORKSPACE,
  ]);
  for (const who of [HUMAN, AGENT])
    for (const room of [null, CODE_ROOM, CHAT_ROOM])
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,
        [WORKSPACE, room, who],
      );
  for (const room of [CODE_ROOM, CHAT_ROOM])
    await db.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}')`,
      [room, AGENT],
    );
  phone = new PhoneService(db, 'http://test');
  daemon = new DaemonService(db, new LiveHub());
}, 30_000);
afterAll(async () => db?.close());
beforeEach(async () => {
  await db.query(`DELETE FROM agent_commands`);
  await db.query(`DELETE FROM agent_turns`);
});

/** The human ask that authorizes the corner, claimed and ready to answer. */
async function commissioned(roomId: string): Promise<AgentCommand> {
  await phone.execute(
    'sendRoomMessage',
    { roomId, messageId: randomBytes(32).toString('hex'), text: '@hoots please do this' },
    HUMAN,
  );
  const [command] = (await daemon.execute('getAgentCommands', { roomId }, AGENT)).commands;
  await daemon.execute(
    'claimAgentCommand',
    { roomId, commandId: command!.id, generationId: 'g1' },
    AGENT,
  );
  return command!;
}

async function open(
  roomId: string,
  lane?: 'code' | 'no_code',
  repository?: string,
): Promise<string> {
  const command = await commissioned(roomId);
  const { cornerId } = await daemon.execute(
    'createCorner',
    {
      roomId,
      requestId: command.turnRequestId,
      generationId: 'g1',
      name: 'Market scan',
      objective: 'Survey the five nearest competitors and write it up',
      ...(lane ? { lane } : {}),
      ...(repository ? { repository, targetBranch: 'main' } : {}),
    },
    AGENT,
  );
  return cornerId;
}

const lane = (cornerId: string) =>
  db
    .query<{ lane: string }>(`SELECT lane FROM corner_facts WHERE corner_id=$1`, [cornerId])
    .then((result) => result.rows[0]?.lane);

it('records the no-code lane a repository Room asked for, and restores it with the handle to tag', async () => {
  const cornerId = await open(CODE_ROOM, 'no_code', 'owner/widgets');

  expect(await lane(cornerId)).toBe('no_code');
  // The restore read is what a restarted helper uses to decide it must not cut
  // a worktree. The handle beside it is this lane's whole completion signal:
  // there is no pull request and no merge card to announce the work.
  expect(await daemon.execute('getCornerRestoreState', { cornerId }, AGENT)).toMatchObject({
    cornerId,
    lane: 'no_code',
    requesterHandle: 'ada',
  });
});

it('leaves a repository Room on the code lane when the corner does not ask otherwise', async () => {
  const cornerId = await open(CODE_ROOM, undefined, 'owner/widgets');

  expect(await lane(cornerId)).toBe('code');
  expect(await daemon.execute('getCornerRestoreState', { cornerId }, AGENT)).toMatchObject({
    lane: 'code',
  });
});

it('records a Room with no repository as no-code however the corner asked', async () => {
  // Nothing to skip is still the no-code lane: the fact has to be truthful, or
  // a later reader of `corner_facts` would believe a commit was possible here.
  const asked = await open(CHAT_ROOM, 'code');
  const silent = await open(CHAT_ROOM);

  expect(await lane(asked)).toBe('no_code');
  expect(await lane(silent)).toBe('no_code');
  expect(
    await daemon.execute('getCornerRestoreState', { cornerId: asked }, AGENT),
  ).toMatchObject({ lane: 'no_code' });
});

it('restores a corner opened before the lane column as code', async () => {
  const cornerId = await open(CODE_ROOM, 'no_code', 'owner/widgets');
  // The deploy backfill gives every pre-existing row the column default. This
  // is that row, and it must not read back as an unknown third lane.
  await db.query(`UPDATE corner_facts SET lane=DEFAULT WHERE corner_id=$1`, [cornerId]);

  expect(await daemon.execute('getCornerRestoreState', { cornerId }, AGENT)).toMatchObject({
    lane: 'code',
  });
});

it('refuses a lane the constraint does not name', async () => {
  const cornerId = await open(CODE_ROOM, 'no_code', 'owner/widgets');

  await expect(
    db.query(`UPDATE corner_facts SET lane='artifacts' WHERE corner_id=$1`, [cornerId]),
  ).rejects.toThrow();
});
