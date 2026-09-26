import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createAgentCommand } from './agent-command.js';
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
  AGENT = 'b'.repeat(64),
  AGENT2 = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111',
  CODE_ROOM = '22222222-2222-4222-8222-222222222222',
  CHAT_ROOM = '44444444-4444-4444-8444-444444444444';

let db: PgliteDatabase, phone: PhoneService, daemon: DaemonService;

beforeAll(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Ada','ada'),($2,'agent','Hoots','hoots'),($3,'agent','Wren','wren')`,
    [HUMAN, AGENT, AGENT2],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [
    AGENT,
    AGENT2,
    HUMAN,
  ]);
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
  for (const who of [HUMAN, AGENT, AGENT2])
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
async function commissioned(roomId: string, agentId = AGENT): Promise<AgentCommand> {
  await phone.execute(
    'sendRoomMessage',
    {
      roomId,
      messageId: randomBytes(32).toString('hex'),
      text: `@${agentId === AGENT ? 'hoots' : 'wren'} please do this`,
    },
    HUMAN,
  );
  const command = (await daemon.execute('getAgentCommands', { roomId }, agentId)).commands.at(-1);
  await daemon.execute(
    'claimAgentCommand',
    { roomId, commandId: command!.id, generationId: 'g1' },
    agentId,
  );
  return command!;
}

function brief(sourceMessageId: string, buildSpec: string) {
  const intent = { sourceMessageId, snapshot: '@hoots please do this' };
  return {
    buildSpec,
    intentVerbatim: [intent],
    criteria: [{ id: 'AC-1', text: 'Publish the result' }],
    references: [],
    approvalBasis: { kind: 'initiating-command' as const, ...intent },
  };
}

async function open(
  roomId: string,
  lane?: 'code' | 'no_code' | 'research',
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
      // Repository and research corners open from a typed brief; the no-code
      // lane is the one that may open without one.
      ...(lane !== 'no_code' && (lane === 'research' || roomId === CODE_ROOM)
        ? { brief: brief(command.sourceMessageId, 'Survey the competitors') }
        : {}),
    },
    AGENT,
  );
  return cornerId;
}

async function humanCorner(roomId: string, title = 'Release notes'): Promise<string> {
  return ((await phone.execute('createHumanCorner', { roomId, title }, HUMAN)) as { id: string })
    .id;
}

async function upgrade(cornerId: string, agentId = AGENT) {
  const command = await commissioned(cornerId, agentId);
  return daemon.execute(
    'upgradeCornerLane',
    { cornerId, requestId: command.turnRequestId, generationId: 'g1' },
    agentId,
  );
}

/** Commands the corner is still holding for its agent, oldest first. */
const pending = (cornerId: string, agentId = AGENT) =>
  db
    .query<{ source_message_id: string; reason: string; turn_request_id: string }>(
      `SELECT source_message_id,reason,turn_request_id FROM agent_commands
       WHERE room_id=$1 AND agent_id=$2 AND state='pending' ORDER BY created_at,id`,
      [cornerId, agentId],
    )
    .then((result) => result.rows);

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

it('restores a research worktree lane and refuses agent closure while allowing human closure', async () => {
  const cornerId = await open(CODE_ROOM, 'research', 'owner/widgets');
  expect(await lane(cornerId)).toBe('research');
  expect(await daemon.execute('getCornerRestoreState', { cornerId }, AGENT)).toMatchObject({
    lane: 'research',
    closeRequested: false,
  });
  await expect(daemon.execute('archiveCorner', { cornerId }, AGENT)).rejects.toThrow(
    'research corners require a human to close them',
  );
  await phone.execute('requestCornerClose', { roomId: cornerId }, HUMAN);
  expect(await daemon.execute('getCornerRestoreState', { cornerId }, AGENT)).toMatchObject({
    closeRequested: true,
  });
});

it('records a Room with no repository as no-code however the corner asked', async () => {
  // Nothing to skip is still the no-code lane: the fact has to be truthful, or
  // a later reader of `corner_facts` would believe a commit was possible here.
  const asked = await open(CHAT_ROOM, 'code');
  const silent = await open(CHAT_ROOM);

  expect(await lane(asked)).toBe('no_code');
  expect(await lane(silent)).toBe('no_code');
  expect(await daemon.execute('getCornerRestoreState', { cornerId: asked }, AGENT)).toMatchObject({
    lane: 'no_code',
  });
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

it('upgrades one repository-backed human corner on its explicit human code request', async () => {
  const cornerId = await humanCorner(CODE_ROOM);
  const beforeMessages = await db.query<{ id: string; text: string }>(
    `SELECT id,text FROM messages WHERE room_id=$1 ORDER BY created_at,id`,
    [cornerId],
  );
  const beforeMembers = await db.query<{ identity_id: string }>(
    `SELECT identity_id FROM memberships WHERE room_id=$1 ORDER BY identity_id`,
    [cornerId],
  );

  const result = await upgrade(cornerId);

  expect(result).toEqual({ cornerId, lane: 'code' });
  expect(
    (
      await db.query<{
        lane: string;
        owner_agent_id: string;
        commissioned_by: string;
        feature_branch: string | null;
      }>(
        `SELECT lane,owner_agent_id,commissioned_by,feature_branch
         FROM corner_facts WHERE corner_id=$1`,
        [cornerId],
      )
    ).rows[0],
  ).toMatchObject({
    lane: 'code',
    owner_agent_id: AGENT,
    commissioned_by: HUMAN,
    feature_branch: null,
  });
  const afterMessages = await db.query<{ id: string; text: string }>(
    `SELECT id,text FROM messages WHERE room_id=$1 ORDER BY created_at,id`,
    [cornerId],
  );
  expect(afterMessages.rows.slice(0, beforeMessages.rows.length)).toEqual(beforeMessages.rows);
  expect(afterMessages.rows.at(-1)?.text).toBe('@hoots please do this');
  expect(
    (
      await db.query<{
        action: string;
        reason: string;
        state: string;
        source_message_id: string;
        turn_request_id: string;
      }>(
        `SELECT action,reason,state,source_message_id,turn_request_id FROM agent_commands
         WHERE room_id=$1 AND action='resume' ORDER BY created_at DESC LIMIT 1`,
        [cornerId],
      )
    ).rows[0],
  ).toMatchObject({
    action: 'resume',
    reason: 'corner_lane_upgrade',
    state: 'pending',
    source_message_id: afterMessages.rows.at(-1)?.id,
  });
  expect(
    (
      await db.query<{ state: string }>(
        `SELECT state FROM agent_commands WHERE room_id=$1 AND action='input'
         ORDER BY created_at DESC LIMIT 1`,
        [cornerId],
      )
    ).rows[0]?.state,
  ).toBe('complete');
  expect(
    (
      await db.query<{ identity_id: string }>(
        `SELECT identity_id FROM memberships WHERE room_id=$1 ORDER BY identity_id`,
        [cornerId],
      )
    ).rows,
  ).toEqual(beforeMembers.rows);
});

it('rejects an agent-initiated upgrade without an active human command', async () => {
  const cornerId = await humanCorner(CODE_ROOM);

  await expect(daemon.execute('upgradeCornerLane', { cornerId }, AGENT)).rejects.toThrow();
  expect(await lane(cornerId)).toBe('no_code');
});

it('rejects every second or non-no-code lane transition', async () => {
  const cornerId = await humanCorner(CODE_ROOM);
  await upgrade(cornerId);
  await expect(upgrade(cornerId)).rejects.toThrow('requires no_code, found code');

  const research = await open(CODE_ROOM, 'research', 'owner/widgets');
  await expect(upgrade(research)).rejects.toThrow('requires no_code, found research');
});

it('rejects a no-code corner whose parent Room has no repository', async () => {
  const cornerId = await humanCorner(CHAT_ROOM);

  await expect(upgrade(cornerId)).rejects.toThrow('requires a repository-backed parent Room');
  expect(await lane(cornerId)).toBe('no_code');
});

it('re-delivers a human ask whose own command was already a resume', async () => {
  const cornerId = await humanCorner(CODE_ROOM);
  const messageId = randomBytes(32).toString('hex');
  await phone.execute(
    'sendRoomMessage',
    { roomId: cornerId, messageId, text: 'go edit the widget renderer' },
    HUMAN,
  );
  // The retry path records the human's ask as a resume on that same message.
  const resume = await createAgentCommand(db, {
    roomId: cornerId,
    agentId: AGENT,
    sourceMessageId: messageId,
    turnRequestId: messageId,
    action: 'resume',
    reason: 'tagged_lifecycle_retry',
  });
  await daemon.execute(
    'claimAgentCommand',
    { roomId: cornerId, commandId: resume!.id, generationId: 'g1' },
    AGENT,
  );

  await daemon.execute(
    'upgradeCornerLane',
    { cornerId, requestId: messageId, generationId: 'g1' },
    AGENT,
  );

  expect(await lane(cornerId)).toBe('code');
  expect(await pending(cornerId)).toEqual([
    {
      source_message_id: messageId,
      reason: 'corner_lane_upgrade',
      turn_request_id: `lane-upgrade:${messageId}`,
    },
  ]);
});

it('leaves an agent-opened corner with its original opener when another agent upgrades it', async () => {
  const cornerId = await open(CODE_ROOM, 'no_code', 'owner/widgets');

  await upgrade(cornerId, AGENT2);

  expect(
    (
      await db.query<{ owner_agent_id: string; lane: string }>(
        `SELECT owner_agent_id,lane FROM corner_facts WHERE corner_id=$1`,
        [cornerId],
      )
    ).rows[0],
  ).toMatchObject({ owner_agent_id: AGENT, lane: 'code' });
  expect(await pending(cornerId, AGENT2)).toMatchObject([{ reason: 'corner_lane_upgrade' }]);
});

it('carries the corner discussion into a first brief the human ask approves', async () => {
  const cornerId = await humanCorner(CODE_ROOM);
  await phone.execute(
    'sendRoomMessage',
    {
      roomId: cornerId,
      messageId: randomBytes(32).toString('hex'),
      text: 'The widget renderer drops the trailing label',
    },
    HUMAN,
  );
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'I can see it in the renderer')`,
    [randomBytes(32).toString('hex'), cornerId, AGENT],
  );
  const command = await commissioned(cornerId);

  await daemon.execute(
    'upgradeCornerLane',
    { cornerId, requestId: command.turnRequestId, generationId: 'g1' },
    AGENT,
  );

  const { brief } = await daemon.execute('getCornerRestoreState', { cornerId }, AGENT);
  // The upgraded corner is a repository corner, so it must read like one: a
  // current structured brief, not the legacy "no assigned brief" fallback.
  expect(brief).toMatchObject({
    revision: 1,
    legacy: false,
    sourceMessageId: command.sourceMessageId,
  });
  expect(brief?.approvalBasis).toMatchObject({
    kind: 'initiating-command',
    sourceMessageId: command.sourceMessageId,
    snapshot: '@hoots please do this',
    approvedBy: HUMAN,
  });
  // Verbatim intent is the human side of the discussion, approval last; the
  // agent's own words are discussion, never authority.
  expect(brief?.intentVerbatim.map((item) => item.snapshot)).toEqual([
    'The widget renderer drops the trailing label',
    '@hoots please do this',
  ]);
  expect(brief?.buildSpec).toContain('The widget renderer drops the trailing label');
  expect(brief?.buildSpec).toContain('I can see it in the renderer');
  expect(brief?.criteria).toEqual([
    { id: 'AC-1', text: expect.stringContaining('@hoots please do this') },
  ]);
  // The one brief a later revision builds on.
  expect(
    (await daemon.execute('listCornerBriefRevisions', { cornerId }, AGENT)).revisions,
  ).toHaveLength(1);
});

it('keeps the brief a no-code corner already had when it upgrades', async () => {
  const command = await commissioned(CODE_ROOM);
  const { cornerId } = await daemon.execute(
    'createCorner',
    {
      roomId: CODE_ROOM,
      requestId: command.turnRequestId,
      generationId: 'g1',
      name: 'Market scan',
      objective: 'Survey the five nearest competitors and write it up',
      lane: 'no_code',
      repository: 'owner/widgets',
      targetBranch: 'main',
      brief: brief(command.sourceMessageId, 'Scan the market and write it up'),
    },
    AGENT,
  );

  await upgrade(cornerId);

  const restored = await daemon.execute('getCornerRestoreState', { cornerId }, AGENT);
  expect(restored.brief).toMatchObject({
    revision: 1,
    buildSpec: 'Scan the market and write it up',
  });
  expect(await lane(cornerId)).toBe('code');
});
