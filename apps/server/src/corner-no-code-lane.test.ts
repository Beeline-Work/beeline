import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createAgentCommand } from './agent-command.js';
import { migrate, type SqlDatabase } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { GitHubOperations } from './github-operations.js';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { CORNER_BRIEF_SPEC_MAX_LENGTH, type AgentCommand } from '@beeline/api-contract/daemon';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { readRoomView } from '@beeline/api-contract/phone';

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

function brief(sourceMessageId: string, spec: string) {
  return { spec, approval: { sourceMessageId } };
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
      // Repository corners open from a typed brief; the no-code
      // lane is the one that may open without one.
      ...(lane !== 'no_code' && roomId === CODE_ROOM
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

it('refuses a research lane at open and lets the agent close a code corner with nothing to ship', async () => {
  await expect(open(CODE_ROOM, 'research' as never, 'owner/widgets')).rejects.toThrow();
  const cornerId = await open(CODE_ROOM, 'code', 'owner/widgets');
  await daemon.execute('archiveCorner', { cornerId }, AGENT);
  expect(
    (await db.query(`SELECT 1 FROM rooms WHERE id=$1 AND archived_at IS NOT NULL`, [cornerId]))
      .rowCount,
  ).toBe(1);
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

it('restores a generated human-corner title as generated until the corner is renamed', async () => {
  const generated = ((await phone.execute(
    'createHumanCorner',
    { roomId: CHAT_ROOM, title: 'still harbor corner', titleGenerated: true },
    HUMAN,
  )) as { id: string }).id;
  const chosen = await humanCorner(CHAT_ROOM, 'Reading corner');

  expect(
    await daemon.execute('getCornerRestoreState', { cornerId: generated }, AGENT),
  ).toMatchObject({ title: 'still harbor corner', titleGenerated: true });
  expect(
    await daemon.execute('getCornerRestoreState', { cornerId: chosen }, AGENT),
  ).not.toHaveProperty('titleGenerated');

  const command = await commissioned(generated);
  await daemon.execute(
    'renameCorner',
    {
      cornerId: generated,
      requestId: command.turnRequestId,
      generationId: 'g1',
      name: 'rename after steer',
      objective: 'Answer the steering request',
      brief: brief(command.sourceMessageId, 'Answer the steering request in this corner.'),
    },
    AGENT,
  );
  const renamed = await daemon.execute('getCornerRestoreState', { cornerId: generated }, AGENT);
  expect(renamed.title).toBe('rename after steer');
  expect(renamed).not.toHaveProperty('titleGenerated');
});

it('saves the first human-opened corner objective and brief when an agent names the work', async () => {
  const cornerId = ((await phone.execute(
    'createHumanCorner',
    { roomId: CHAT_ROOM, title: 'still harbor corner', titleGenerated: true },
    HUMAN,
  )) as { id: string }).id;
  const before = await phone.readRoom(cornerId, HUMAN);
  expect(before?.room.about).toBeFalsy();
  expect(before?.cornerBrief).toBeUndefined();

  const command = await commissioned(cornerId);
  await expect(daemon.execute('renameCorner', {
    cornerId,
    requestId: command.turnRequestId,
    generationId: 'g1',
    name: 'Readable briefs',
  }, AGENT)).rejects.toThrow('requires its objective and first brief');
  expect((await phone.readRoom(cornerId, HUMAN))?.room.name).toBe('still harbor corner');
  const details = {
    cornerId,
    requestId: command.turnRequestId,
    generationId: 'g1',
    name: 'Readable briefs',
    objective: 'Make the corner brief readable above its workflow',
    brief: brief(command.sourceMessageId, 'Show the request in the corner panel.'),
  };
  await expect(daemon.execute('renameCorner', {
    ...details,
    brief: brief('f'.repeat(64), details.brief.spec),
  }, AGENT)).rejects.toThrow('corner brief approval must name a human Room message');
  expect((await phone.readRoom(cornerId, HUMAN))?.room.name).toBe('still harbor corner');
  await daemon.execute('renameCorner', details, AGENT);
  const viewed = await phone.readRoom(cornerId, HUMAN);
  expect(viewed?.room.name).toBe('Readable briefs');
  expect(viewed?.room.about).toBe(details.objective);
  expect(viewed?.cornerBrief).toMatchObject({
    revision: 1,
    spec: 'Show the request in the corner panel.',
    approval: { sourceMessageId: command.sourceMessageId, text: '@hoots please do this' },
  });
  // Both clients project the response before the objective panel sees it.
  expect(readRoomView(viewed)?.cornerBrief).toEqual(viewed?.cornerBrief);
  await daemon.execute('renameCorner', details, AGENT);
  expect((await db.query(`SELECT revision FROM corner_brief_revisions WHERE corner_id=$1`, [cornerId])).rows)
    .toEqual([{ revision: 1 }]);
  await daemon.execute('reviseCornerBrief', {
    cornerId,
    requestId: command.turnRequestId,
    generationId: 'g1',
    expectedRevision: 1,
    brief: { ...brief(command.sourceMessageId, 'Show the updated request in the corner panel.'),
      change: 'Clarify the panel copy.' },
  }, AGENT);
  expect((await phone.readRoom(cornerId, HUMAN))?.cornerBrief).toMatchObject({
    revision: 2,
    spec: 'Show the updated request in the corner panel.',
  });
  const revised = await phone.readRoom(cornerId, HUMAN);
  expect(readRoomView(revised)?.cornerBrief).toEqual(revised?.cornerBrief);
  await daemon.execute('renameCorner', {
    cornerId,
    requestId: command.turnRequestId,
    generationId: 'g1',
    name: 'Readable briefs',
    objective: 'Read the latest brief above the workflow',
  }, AGENT);
  expect((await phone.readRoom(cornerId, HUMAN))?.room.about)
    .toBe('Read the latest brief above the workflow');
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
    // The corner's workflow cards are hidden bookkeeping, not conversation.
    `SELECT id,text FROM messages WHERE room_id=$1
       AND card_type IS DISTINCT FROM 'corner-workflow-handoff' ORDER BY created_at,id`,
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
    feature_branch: `feature/corner-${cornerId.replaceAll('-', '').slice(0, 12)}`,
  });
  const afterMessages = await db.query<{ id: string; text: string }>(
    // The corner's workflow cards are hidden bookkeeping, not conversation.
    `SELECT id,text FROM messages WHERE room_id=$1
       AND card_type IS DISTINCT FROM 'corner-workflow-handoff' ORDER BY created_at,id`,
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

it('rejects an upgrade backed by an agent-authored ask, however live the command', async () => {
  // An exact agent tag in a committed agent reply dispatches that agent, so a
  // command can be live and claimed with no human behind it. Only a person may
  // put this corner on the code lane.
  const cornerId = await humanCorner(CODE_ROOM);
  const messageId = randomBytes(32).toString('hex');
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@hoots go edit the widget renderer')`,
    [messageId, cornerId, AGENT2],
  );
  const command = await createAgentCommand(db, {
    roomId: cornerId,
    agentId: AGENT,
    sourceMessageId: messageId,
    turnRequestId: messageId,
    reason: 'agent_tag',
  });
  await daemon.execute(
    'claimAgentCommand',
    { roomId: cornerId, commandId: command!.id, generationId: 'g1' },
    AGENT,
  );

  await expect(
    daemon.execute(
      'upgradeCornerLane',
      { cornerId, requestId: messageId, generationId: 'g1' },
      AGENT,
    ),
  ).rejects.toThrow('requires an explicit human request in this corner');
  expect(await lane(cornerId)).toBe('no_code');
  expect(
    (await daemon.execute('listCornerBriefRevisions', { cornerId }, AGENT)).revisions,
  ).toHaveLength(0);
});

it('answers a second upgrade of an already fully-upgraded corner with an idempotent no-op, never a restart', async () => {
  // A corner that is ALREADY fully upgraded (lane='code', feature_branch
  // already recorded) is not the interrupted-retry case this fix targets:
  // a stale tool mount, a retry after success, or a model mistake calling
  // upgrade_corner_to_code again must get a harmless idempotent result, not
  // a fresh resume that re-delivers the request and restarts the corner's
  // session a second time.
  const cornerId = await humanCorner(CODE_ROOM);
  const first = await upgrade(cornerId);
  const branch = `feature/corner-${cornerId.replaceAll('-', '').slice(0, 12)}`;
  expect(first).toEqual({ cornerId, lane: 'code' });
  expect(await lane(cornerId)).toBe('code');

  const beforeCommands = (
    await db.query<{ id: string; state: string; action: string }>(
      `SELECT id,state,action FROM agent_commands WHERE room_id=$1 ORDER BY created_at,id`,
      [cornerId],
    )
  ).rows;
  const command = await commissioned(cornerId);

  const second = await daemon.execute(
    'upgradeCornerLane',
    { cornerId, requestId: command.turnRequestId, generationId: 'g1' },
    AGENT,
  );

  expect(second).toEqual({ cornerId, lane: 'code' });
  expect(
    (
      await db.query<{ feature_branch: string }>(
        `SELECT feature_branch FROM corner_facts WHERE corner_id=$1`,
        [cornerId],
      )
    ).rows[0]?.feature_branch,
  ).toBe(branch);
  // No duplicate brief revision from converging twice.
  expect(
    (await daemon.execute('listCornerBriefRevisions', { cornerId }, AGENT)).revisions,
  ).toHaveLength(1);
  // No new resume command, and the command that authorized this call is
  // left exactly as it was: untouched, not completed, nothing to deliver.
  const afterCommands = (
    await db.query<{ id: string; state: string; action: string }>(
      `SELECT id,state,action FROM agent_commands WHERE room_id=$1 ORDER BY created_at,id`,
      [cornerId],
    )
  ).rows;
  expect(afterCommands).toEqual([
    ...beforeCommands,
    { id: command.id, state: 'claimed', action: 'input' },
  ]);
  // Exactly the one 'resume' row the FIRST upgrade created - none added now.
  const resumeCountBefore = beforeCommands.filter((row) => row.action === 'resume').length;
  const resumeCountAfter = afterCommands.filter((row) => row.action === 'resume').length;
  expect(resumeCountAfter).toBe(resumeCountBefore);
});

it('converges a corner stuck with lane=code but no recorded feature branch', async () => {
  // Simulates the state an interrupted upgrade (or a row touched some other
  // way) could leave behind before this fix: the lane flipped but the branch
  // write never landed. A retry must finish the job, not throw.
  const cornerId = await humanCorner(CODE_ROOM);
  await db.query(`UPDATE corner_facts SET lane='code' WHERE corner_id=$1`, [cornerId]);
  expect(
    (
      await db.query<{ feature_branch: string | null }>(
        `SELECT feature_branch FROM corner_facts WHERE corner_id=$1`,
        [cornerId],
      )
    ).rows[0]?.feature_branch,
  ).toBeNull();

  const result = await upgrade(cornerId);

  const branch = `feature/corner-${cornerId.replaceAll('-', '').slice(0, 12)}`;
  expect(result).toEqual({ cornerId, lane: 'code' });
  expect(
    (
      await db.query<{ feature_branch: string }>(
        `SELECT feature_branch FROM corner_facts WHERE corner_id=$1`,
        [cornerId],
      )
    ).rows[0]?.feature_branch,
  ).toBe(branch);
  expect(
    (await daemon.execute('listCornerBriefRevisions', { cornerId }, AGENT)).revisions,
  ).toHaveLength(1);
});

/** Wraps a database so the next query matching `shouldFail` throws instead of
 *  running, at any transaction nesting depth - proving a mid-write failure
 *  rolls back everything in the same transaction, not just that one query. */
function withInjectedFailure(
  inner: SqlDatabase,
  shouldFail: (sql: string) => boolean,
  message: string,
): SqlDatabase {
  let fired = false;
  const wrap = (target: SqlDatabase): SqlDatabase => ({
    query: async (sql: string, values: unknown[] = []) => {
      if (!fired && shouldFail(sql)) {
        fired = true;
        throw new Error(message);
      }
      return target.query(sql, values);
    },
    transaction: async (work) => target.transaction((nested) => work(wrap(nested))),
  });
  return wrap(inner);
}

it('rolls a failure between the lane flip and the branch write back to no_code', async () => {
  // Proves the two writes are one transaction: an error thrown after the
  // lane flip (but before the function returns) must undo the flip too, so a
  // retry sees a clean no_code corner rather than a half-upgraded one.
  const cornerId = await humanCorner(CODE_ROOM);
  const command = await commissioned(cornerId);
  const failing = withInjectedFailure(
    db,
    (sql) => sql.includes('SET feature_branch=$2'),
    'injected failure between the lane flip and the branch write',
  );
  const failingDaemon = new DaemonService(failing, new LiveHub());

  await expect(
    failingDaemon.execute(
      'upgradeCornerLane',
      { cornerId, requestId: command.turnRequestId, generationId: 'g1' },
      AGENT,
    ),
  ).rejects.toThrow('injected failure between the lane flip and the branch write');

  expect(await lane(cornerId)).toBe('no_code');
  expect(
    (
      await db.query<{ feature_branch: string | null }>(
        `SELECT feature_branch FROM corner_facts WHERE corner_id=$1`,
        [cornerId],
      )
    ).rows[0]?.feature_branch,
  ).toBeNull();
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

it("delivers GitHub's pull request to a corner another agent upgraded", async () => {
  // The upgrading agent is not the recorded opener, so its restart never
  // records the branch; the upgrade itself has to.
  const cornerId = await open(CODE_ROOM, 'no_code', 'owner/widgets');
  await upgrade(cornerId, AGENT2);
  await db.query(
    `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
     VALUES(77,$1,'42','owner','User','selected','active') ON CONFLICT DO NOTHING`,
    [HUMAN],
  );
  await db.query(
    `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
     VALUES(101,77,'owner/widgets','main') ON CONFLICT DO NOTHING`,
  );
  await db.query(`UPDATE rooms SET github_installation_id=77 WHERE id=$1`, [CODE_ROOM]);
  const branch = `feature/corner-${cornerId.replaceAll('-', '').slice(0, 12)}`;
  const app = {
    installationToken: async () => ({ token: 'room-token' }),
    readCommitCheckRollup: async (_token: string, repository: string, headSha: string) => {
      expect(repository).toBe('owner/widgets');
      expect(headSha).toBe('1'.repeat(40));
      return { state: 'pending', total: 0, passed: 0, failed: 0, pending: 0 };
    },
  } as unknown as GitHubAppClient;
  const github = new GitHubOperations(db, {} as GitHubOAuthClient, app, 's');

  await github.processWebhook('pull_request', {
    action: 'opened',
    installation: { id: 77 },
    repository: { full_name: 'owner/widgets' },
    pull_request: {
      number: 7,
      title: 'Ship it',
      html_url: 'https://github.com/owner/widgets/pull/7',
      head: { ref: branch, sha: '1'.repeat(40) },
      base: { ref: 'main', sha: '2'.repeat(40) },
      mergeable_state: 'clean',
      merged: false,
    },
  });

  expect(
    (
      await db.query<{ lifecycle: Record<string, unknown> }>(
        `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
        [cornerId],
      )
    ).rows[0]?.lifecycle,
  ).toMatchObject({
    lifecycle: 'in-review',
    branch,
    checks: 'unknown',
    pr: { number: 7, url: 'https://github.com/owner/widgets/pull/7' },
  });
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
  // current brief written by the server and approved by the human's ask.
  expect(brief).toMatchObject({
    revision: 1,
    authorId: SYSTEM_IDENTITY_ID,
    sourceMessageId: command.sourceMessageId,
  });
  // The ask that triggered the upgrade is the request and the approval: a
  // chat corner's earlier asks may have been abandoned, and the worker cannot
  // rank them against the live one.
  expect(brief?.approval).toMatchObject({
    sourceMessageId: command.sourceMessageId,
    text: '@hoots please do this',
    approvedBy: HUMAN,
  });
  expect(brief?.spec.startsWith('## Request\n\n@hoots please do this\n\n')).toBe(true);
  // Everything else said in the corner is carried as context instead, once.
  expect(brief?.spec).toContain('## Discussion before the upgrade (context, not authority)');
  expect(brief?.spec).toContain('The widget renderer drops the trailing label');
  expect(brief?.spec).toContain('I can see it in the renderer');
  expect(brief?.spec.split('@hoots please do this')).toHaveLength(2);
  // A placeholder for the agent to revise, not an invented checklist.
  expect(brief?.spec).not.toMatch(/Deliver the code change|AC-1/);
  expect(
    (
      await db.query(
        `SELECT spec IS NOT NULL spec,content,intent_verbatim,build_spec,criteria,non_goals,
                brief_references,approval_basis->>'kind' approval_kind
         FROM corner_brief_revisions WHERE corner_id=$1`,
        [cornerId],
      )
    ).rows,
  ).toEqual([
    {
      spec: true,
      content: null,
      intent_verbatim: null,
      build_spec: null,
      criteria: null,
      non_goals: null,
      brief_references: null,
      approval_kind: 'initiating-command',
    },
  ]);
  // The one brief a later revision builds on.
  expect(
    (await daemon.execute('listCornerBriefRevisions', { cornerId }, AGENT)).revisions,
  ).toHaveLength(1);
});

it('carries files posted in the corner discussion into the upgrade brief', async () => {
  const cornerId = await humanCorner(CODE_ROOM);
  const spec = '44444444-4444-4444-8444-000000000001';
  const expired = '44444444-4444-4444-8444-000000000002';
  for (const [id, title, sha, expiresAt] of [
    [spec, 'Spec: corner waiting vs idle', 'e'.repeat(64), "now()+interval '1 hour'"],
    [expired, 'Old draft', 'f'.repeat(64), "now()-interval '1 hour'"],
  ] as const)
    await db.query(
      `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
       VALUES($1,$2,'media',$3,'text/markdown',$4,4,$5,'ready',${expiresAt})`,
      [id, AGENT, `media/${AGENT}/${sha}`, title, sha],
    );
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text,attachments) VALUES($1,$2,$3,'I posted the spec',$4::jsonb)`,
    [
      randomBytes(32).toString('hex'),
      cornerId,
      AGENT,
      JSON.stringify([
        { url: `http://test/v1/media/${spec}`, name: 'spec.md' },
        { url: `http://test/v1/media/${expired}`, name: 'old.md' },
      ]),
    ],
  );

  await upgrade(cornerId);

  const { brief } = await daemon.execute('getCornerRestoreState', { cornerId }, AGENT);
  // The spec doc posted before the upgrade reaches the code agent as a brief
  // file; the expired one is skipped instead of failing the upgrade.
  expect(brief?.attachments).toEqual([
    {
      objectId: spec,
      title: 'Spec: corner waiting vs idle',
      purpose: 'Posted in the corner discussion before the upgrade',
      required: false,
      mime: 'text/markdown',
      sha256: 'e'.repeat(64),
      size: 4,
    },
  ]);
  // The person opening the corner's Brief sees the same doc listed.
  expect((await phone.readRoom(cornerId, HUMAN))?.cornerBrief?.attachments).toEqual([
    {
      title: 'Spec: corner waiting vs idle',
      purpose: 'Posted in the corner discussion before the upgrade',
      required: false,
      url: expect.stringMatching(new RegExp(`/v1/media/${spec}$`)),
    },
  ]);
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
    spec: 'Scan the market and write it up',
  });
  expect(await lane(cornerId)).toBe('code');
});

it("refuses the upgrade when the asking message cannot be the brief's approval", async () => {
  const cornerId = await humanCorner(CODE_ROOM);
  const messageId = randomBytes(32).toString('hex');
  await phone.execute(
    'sendRoomMessage',
    { roomId: cornerId, messageId, text: `@hoots ${'x'.repeat(16_000)}` },
    HUMAN,
  );
  const command = (
    await daemon.execute('getAgentCommands', { roomId: cornerId }, AGENT)
  ).commands.at(-1);
  await daemon.execute(
    'claimAgentCommand',
    { roomId: cornerId, commandId: command!.id, generationId: 'g1' },
    AGENT,
  );

  // The refusal names the real cause and what to do, rather than surfacing an
  // internal brief-validation error for a lane operation.
  await expect(
    daemon.execute(
      'upgradeCornerLane',
      { cornerId, requestId: command!.turnRequestId, generationId: 'g1' },
      AGENT,
    ),
  ).rejects.toThrow('ask again in a shorter message');
  expect(await lane(cornerId)).toBe('no_code');
  expect(
    (await daemon.execute('listCornerBriefRevisions', { cornerId }, AGENT)).revisions,
  ).toHaveLength(0);
});

it('keeps the discussion that fits when one message is too long for the brief', async () => {
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
  // An agent report far past the whole build spec's budget. Dropping it must
  // not drop the human's diagnosis behind it.
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
    randomBytes(32).toString('hex'),
    cornerId,
    AGENT,
    `analysis ${'y'.repeat(70_000)}`,
  ]);
  const command = await commissioned(cornerId);

  await daemon.execute(
    'upgradeCornerLane',
    { cornerId, requestId: command.turnRequestId, generationId: 'g1' },
    AGENT,
  );

  const { brief } = await daemon.execute('getCornerRestoreState', { cornerId }, AGENT);
  expect(brief?.spec).toContain('The widget renderer drops the trailing label');
  expect(brief?.spec).not.toContain('yyyy');
  expect(brief?.spec).toContain('1 message(s) omitted for length');
  expect(brief!.spec.length).toBeLessThanOrEqual(CORNER_BRIEF_SPEC_MAX_LENGTH);
});

it('reads only the newest slice of a long corner and says the rest was left out', async () => {
  const cornerId = await humanCorner(CODE_ROOM);
  // Past the 200-message candidate window the brief composes from.
  const rows = Array.from({ length: 220 }, (_, index) => index);
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text,created_at)
     SELECT * FROM unnest($1::text[],$2::uuid[],$3::text[],$4::text[],$5::timestamptz[])`,
    [
      rows.map(() => randomBytes(32).toString('hex')),
      rows.map(() => cornerId),
      rows.map(() => HUMAN),
      rows.map((index) => `note ${index}`),
      rows.map((index) => new Date(Date.now() - (rows.length - index) * 1000).toISOString()),
    ],
  );
  const command = await commissioned(cornerId);

  await daemon.execute(
    'upgradeCornerLane',
    { cornerId, requestId: command.turnRequestId, generationId: 'g1' },
    AGENT,
  );

  const { brief } = await daemon.execute('getCornerRestoreState', { cornerId }, AGENT);
  expect(brief?.spec).toContain('note 219');
  expect(brief?.spec).not.toContain('note 0\n');
  expect(brief?.spec).toContain('earlier history omitted for length');
});
