import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { createAgentCommand } from './agent-command.js';
import { saveWorkflow, startWorkflow, handoff } from './workflow-runs.js';
import { readWorkflowOwnership, transferWorkflowOwner } from './workflow-ownership.js';
import { DaemonService } from './daemon-service.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import { AgentScheduleLoop } from './agent-schedules.js';

vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return { ...crypto, randomBytes: vi.fn(crypto.randomBytes) };
});

const ROOM = '20000000-0000-4000-8000-000000000001';
const CORNER = '20000000-0000-4000-8000-000000000002';
const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const HUMAN = 'a'.repeat(64),
  OWNER = 'b'.repeat(64),
  OTHER = 'c'.repeat(64),
  ADMIN = 'd'.repeat(64),
  MEMBER = 'e'.repeat(64);
const contract = {
  version: 1,
  name: 'daily',
  description: 'Daily scan',
  roles: ['scanner'],
  start: 'scan',
  handoffs: {
    scan: { role: 'scanner', requires: [], on: { done: 'done' } },
    done: { kind: 'terminal', status: 'done' },
  },
};
let snapshot: Blob | File;
let db: PgliteDatabase, daemon: DaemonService, phone: PhoneService;
beforeAll(async () => {
  const seed = new PgliteDatabase();
  await migrate(seed);
  await seed.query(
    `INSERT INTO identities(id,kind,name) VALUES($1,'human','Creator owner'),($2,'agent','Scanner'),($3,'agent','Peer'),($4,'human','Admin'),($5,'human','Member')`,
    [HUMAN, OWNER, OTHER, ADMIN, MEMBER],
  );
  await seed.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [
    OWNER,
    OTHER,
    HUMAN,
  ]);
  await seed.query(`INSERT INTO workspaces(id,name) VALUES($1,'Test')`, [WORKSPACE]);
  await seed.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`, [
    ROOM,
    WORKSPACE,
    HUMAN,
  ]);
  for (const identity of [HUMAN, OWNER, OTHER, ADMIN, MEMBER])
    await seed.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'member'),($1,NULL,$3,$4)`,
      [WORKSPACE, ROOM, identity, identity === ADMIN ? 'admin' : 'member'],
    );
  snapshot = await seed.snapshot();
  await seed.close();
});
beforeEach(async () => {
  vi.mocked(randomBytes).mockReset();
  const crypto = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  vi.mocked(randomBytes).mockImplementation(crypto.randomBytes);
  db = PgliteDatabase.fromSnapshot(snapshot);
  daemon = new DaemonService(db, new LiveHub());
  phone = new PhoneService(db, 'http://test');
});
afterEach(async () => {
  await db.close();
});
async function command(agentId = OWNER, roomId = ROOM) {
  const message = Math.random().toString(16);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'scan')`, [
    message,
    roomId,
    HUMAN,
  ]);
  return (await createAgentCommand(db, {
    roomId,
    agentId,
    sourceMessageId: message,
    reason: 'human_tag',
  }))!;
}
async function save() {
  await saveWorkflow(db, await command(), { contract });
}
async function surface(roomId: string, parentId: string | null, members = [OWNER, OTHER]) {
  await db.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name,parent_id) VALUES($1,$2,$3,'Run surface',$4)`,
    [roomId, WORKSPACE, HUMAN, parentId],
  );
  for (const member of members)
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [WORKSPACE, roomId, member],
    );
}
const start = (actor = OWNER) =>
  startWorkflow(
    db,
    { room_id: ROOM, agent_id: actor },
    { name: 'daily', roleBindings: { scanner: OTHER } },
  );
const schedule = (actor = OWNER) =>
  daemon.execute(
    'createAgentSchedule',
    {
      roomId: ROOM,
      agentId: actor,
      prompt: 'Start workflow daily',
      workflowName: 'daily',
      cadence: { kind: 'interval', everyMinutes: 1 },
    },
    actor,
  );

describe('workflow ownership', () => {
  it('S05-1 excludes a same-transaction terminal card whose ID sorts below the start', async () => {
    await save();
    const worker = await command(OTHER);
    await db.transaction(async (tx) => {
      vi.mocked(randomBytes).mockImplementationOnce(() => Buffer.alloc(32, 0xff));
      const { runId } = await startWorkflow(
        tx,
        { room_id: ROOM, agent_id: OWNER },
        {
          name: 'daily',
          roleBindings: { scanner: OTHER },
        },
      );
      vi.mocked(randomBytes).mockImplementationOnce(() => Buffer.alloc(32, 0));
      await handoff(tx, worker, { runId, outcome: 'done', contents: {} });
      expect(
        (
          await tx.query<{ count: string }>(
            `SELECT count(DISTINCT created_at)::text count FROM messages WHERE card->>'runId'=$1`,
            [runId],
          )
        ).rows[0]!.count,
      ).toBe('1');
      expect((await readWorkflowOwnership(tx, ROOM, 'daily', OTHER)).activeRunIds).toEqual([]);
      // Sequenced cards also outrank legacy cards with a later timestamp.
      await tx.query(
        `UPDATE messages SET card=card-'seq',created_at=now()+interval '1 day' WHERE id=$1`,
        [runId],
      );
      expect((await readWorkflowOwnership(tx, ROOM, 'daily', OTHER)).activeRunIds).toEqual([]);
    });
  });
  it('shows parent Room active run IDs in corner start errors, reads and schedules', async () => {
    await save();
    await surface(CORNER, ROOM);
    const { runId } = await start();
    await expect(
      startWorkflow(
        db,
        { room_id: CORNER, agent_id: OTHER },
        { name: 'daily', roleBindings: { scanner: OTHER } },
      ),
    ).rejects.toThrow(
      `Only Scanner can start runs of daily. Ask them, or hand off to the active run by its run ID. Owner: ${OWNER}. Active run IDs: ${runId}.`,
    );
    expect(await readWorkflowOwnership(db, CORNER, 'daily', OTHER)).toMatchObject({
      owner: { id: OWNER, name: 'Scanner' },
      activeRunIds: [runId],
    });
    const created = await daemon.execute(
      'createAgentSchedule',
      {
        roomId: CORNER,
        agentId: OWNER,
        prompt: 'Start workflow daily',
        workflowName: 'daily',
        cadence: { kind: 'interval', everyMinutes: 1 },
      },
      OWNER,
    );
    const listed = await daemon.execute('listAgentSchedules', { roomId: CORNER }, OTHER);
    expect(listed.schedules.find((entry) => entry.scheduleId === created.scheduleId)).toMatchObject(
      {
        owner: { id: OWNER },
        activeRunIds: [runId],
      },
    );
  });
  it('limits corner active runs to readable parent and sibling surfaces and excludes ended runs', async () => {
    await save();
    const sibling = '20000000-0000-4000-8000-000000000003';
    const privateCorner = '20000000-0000-4000-8000-000000000004';
    const unrelatedRoom = '20000000-0000-4000-8000-000000000005';
    await surface(CORNER, ROOM);
    await surface(sibling, ROOM);
    await surface(privateCorner, ROOM, [OWNER]);
    await surface(unrelatedRoom, null);
    const parentRun = await start();
    const startHere = (roomId: string) =>
      startWorkflow(
        db,
        { room_id: roomId, agent_id: OWNER },
        { name: 'daily', roleBindings: { scanner: OWNER } },
      );
    const cornerRun = await startHere(CORNER);
    const siblingRun = await startHere(sibling);
    const privateRun = await startHere(privateCorner);
    await startHere(unrelatedRoom);
    const visible = [parentRun.runId, cornerRun.runId, siblingRun.runId].sort();
    expect((await readWorkflowOwnership(db, CORNER, 'daily', OTHER)).activeRunIds).toEqual(visible);
    expect((await readWorkflowOwnership(db, ROOM, 'daily', OTHER)).activeRunIds).toEqual(visible);
    expect((await readWorkflowOwnership(db, CORNER, 'daily', OWNER)).activeRunIds).toEqual(
      [...visible, privateRun.runId].sort(),
    );
    await handoff(db, await command(OWNER, sibling), {
      runId: siblingRun.runId,
      outcome: 'done',
      contents: {},
    });
    expect((await readWorkflowOwnership(db, CORNER, 'daily', OTHER)).activeRunIds).toEqual(
      [parentRun.runId, cornerRun.runId].sort(),
    );
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
      ROOM,
      OTHER,
    ]);
    expect((await readWorkflowOwnership(db, CORNER, 'daily', OTHER)).activeRunIds).toEqual([
      cornerRun.runId,
    ]);
  });
  it('defaults to the saving agent, preserves creator/owner on revisions and exposes active runs to peers', async () => {
    await save();
    const { runId } = await start();
    const info = await readWorkflowOwnership(db, ROOM, 'daily', OTHER);
    expect(info.owner).toMatchObject({ id: OWNER, name: 'Scanner' });
    expect(info.activeRunIds).toEqual([runId]);
    await expect(start(OTHER)).rejects.toThrow(
      `You are already in run ${runId} of daily. Continue it or hand off within it.`,
    );
    await saveWorkflow(db, await command(OTHER), { contract });
    expect((await readWorkflowOwnership(db, ROOM, 'daily', OTHER)).owner?.id).toBe(OWNER);
    // The role holder can join the existing run without being the workflow owner.
    await handoff(db, await command(OTHER), { runId, outcome: 'done', contents: {} });
    expect((await readWorkflowOwnership(db, ROOM, 'daily', OTHER)).activeRunIds).toEqual([]);
  });
  it('reads definitions and the no-owner/no-run catalog through the phone without creator filtering', async () => {
    await save();
    await db.query(`UPDATE workspace_skills SET owner_agent_id=NULL`);
    const catalog = await phone.execute('listWorkflowDefinitions', { roomId: ROOM }, MEMBER);
    expect(catalog.workflows).toContainEqual({
      name: 'daily',
      ownership: { owner: null, activeRunIds: [], canTransfer: false },
    });
    const detail = await phone.execute(
      'readWorkflowDefinition',
      { roomId: ROOM, name: 'daily' },
      ADMIN,
    );
    expect(detail.ownership).toMatchObject({ owner: null, canTransfer: true });
    expect(detail.runs).toEqual([]);
    await expect(
      phone.execute('listWorkflowDefinitions', { roomId: ROOM }, 'f'.repeat(64)),
    ).rejects.toThrow('access denied');
  });
  it('allows human admins to start through the phone API and records the human actor', async () => {
    await save();
    const run = await phone.execute(
      'startOwnedWorkflow',
      { roomId: ROOM, name: 'daily', roleBindings: { scanner: OTHER } },
      ADMIN,
    );
    const detail = await phone.execute(
      'readWorkflowRun',
      { roomId: ROOM, runId: run.runId },
      ADMIN,
    );
    expect(detail.run.startedBy).toEqual({ id: ADMIN, name: 'Admin', kind: 'human' });
    expect(detail.run.startKind).toBe('human_admin');
    await expect(start(MEMBER)).rejects.toThrow('Only Scanner');
    await expect(
      phone.execute(
        'startOwnedWorkflow',
        { roomId: ROOM, name: 'daily', roleBindings: { scanner: OTHER } },
        HUMAN,
      ),
    ).rejects.toThrow();
  });
  it('gates schedule create/update including old and replacement prompts, and lists owner/active IDs across agents', async () => {
    await save();
    const { runId } = await start();
    await expect(schedule(OTHER)).rejects.toThrow('Only Scanner');
    const created = await schedule();
    await expect(
      daemon.execute(
        'updateAgentSchedule',
        { roomId: ROOM, scheduleId: created.scheduleId, prompt: 'unchanged' },
        OTHER,
      ),
    ).rejects.toThrow('Only Scanner');
    const plain = await daemon.execute(
      'createAgentSchedule',
      { roomId: ROOM, prompt: 'plain task', cadence: { kind: 'interval', everyMinutes: 1 } },
      OTHER,
    );
    await expect(
      daemon.execute(
        'updateAgentSchedule',
        { roomId: ROOM, scheduleId: plain.scheduleId, prompt: 'start_workflow daily' },
        OTHER,
      ),
    ).rejects.toThrow('Only Scanner');
    await daemon.execute(
      'updateAgentSchedule',
      { roomId: ROOM, scheduleId: created.scheduleId, prompt: 'scan daily' },
      OWNER,
    );
    const listed = await daemon.execute('listAgentSchedules', { roomId: ROOM }, OTHER);
    expect(listed.schedules.find((s) => s.scheduleId === created.scheduleId)).toMatchObject({
      workflowName: 'daily',
      owner: { id: OWNER },
      activeRunIds: [runId],
    });
  });
  it('runs schedules as the current owner after transfer, attributing scheduled starts to that owner', async () => {
    await save();
    const created = await schedule();
    await transferWorkflowOwner(db, ROOM, 'daily', HUMAN, OTHER);
    await db.query(`UPDATE agent_schedules SET next_run_at=now()-interval '1 minute' WHERE id=$1`, [
      created.scheduleId,
    ]);
    expect(await new AgentScheduleLoop(db).runOnce()).toBe(1);
    const row = (
      await db.query<{ agent_id: string; reason: string }>(
        `SELECT agent_id,reason FROM agent_commands WHERE reason='schedule'`,
      )
    ).rows[0]!;
    expect(row.agent_id).toBe(OTHER);
    const run = await startWorkflow(
      db,
      { room_id: ROOM, agent_id: row.agent_id, reason: row.reason },
      { name: 'daily', roleBindings: { scanner: OTHER } },
    );
    const detail = await phone.execute(
      'readWorkflowRun',
      { roomId: ROOM, runId: run.runId },
      ADMIN,
    );
    expect(detail.run.startKind).toBe('schedule');
    expect(detail.run.startedBy?.id).toBe(OTHER);
  });
  it('allows human admins to create/edit schedules with human attribution', async () => {
    await save();
    const created = await phone.execute(
      'createRoomSchedule',
      {
        roomId: ROOM,
        workspaceId: WORKSPACE,
        agentId: OTHER,
        workflowName: 'daily',
        message: 'Start workflow daily',
        cadence: { kind: 'interval', everyMinutes: 1 },
      },
      ADMIN,
    );
    expect(created.creatorId).toBe(ADMIN);
    expect(created.agentId).toBe(OWNER);
    await phone.execute(
      'updateRoomSchedule',
      { roomId: ROOM, scheduleId: created.id, message: 'daily run' },
      ADMIN,
    );
    expect(
      (
        await db.query<{ updated_by: string }>(
          `SELECT updated_by FROM agent_schedules WHERE id=$1`,
          [created.id],
        )
      ).rows[0]?.updated_by,
    ).toBe(ADMIN);
    await db.query(`UPDATE agent_schedules SET next_run_at=now()-interval '1 minute' WHERE id=$1`, [
      created.id,
    ]);
    expect(await new AgentScheduleLoop(db).runOnce()).toBe(1);
    expect(
      (
        await db.query<{ agent_id: string }>(
          `SELECT agent_id FROM agent_commands WHERE reason='schedule'`,
        )
      ).rows[0]?.agent_id,
    ).toBe(OWNER);
  });
  it('uses Room admin rights as well as Workspace admin rights for starts, schedules and transfers', async () => {
    await save();
    await db.query(
      `UPDATE memberships SET role='member' WHERE identity_id=$1 AND room_id IS NULL`,
      [ADMIN],
    );
    await db.query(`UPDATE memberships SET role='admin' WHERE identity_id=$1 AND room_id=$2`, [
      ADMIN,
      ROOM,
    ]);
    const run = await phone.execute(
      'startOwnedWorkflow',
      { roomId: ROOM, name: 'daily', roleBindings: { scanner: OTHER } },
      ADMIN,
    );
    expect(run.runId).toHaveLength(64);
    const created = await phone.execute(
      'createRoomSchedule',
      {
        roomId: ROOM,
        workspaceId: WORKSPACE,
        agentId: OWNER,
        workflowName: 'daily',
        message: 'daily',
        cadence: { kind: 'interval', everyMinutes: 1 },
      },
      ADMIN,
    );
    await phone.execute(
      'updateRoomSchedule',
      { roomId: ROOM, scheduleId: created.id, message: 'scan' },
      ADMIN,
    );
    await phone.execute(
      'transferWorkflowOwner',
      { roomId: ROOM, name: 'daily', ownerId: OTHER },
      ADMIN,
    );
    expect((await readWorkflowOwnership(db, ROOM, 'daily', ADMIN)).owner?.id).toBe(OTHER);
  });
  it('transfers only for the creator’s human owner or admins, auditing old/new owner, actor and time', async () => {
    await save();
    await expect(transferWorkflowOwner(db, ROOM, 'daily', OWNER, OTHER)).rejects.toThrow(
      'Agents cannot transfer',
    );
    await expect(transferWorkflowOwner(db, ROOM, 'daily', MEMBER, OTHER)).rejects.toThrow('Only');
    await expect(transferWorkflowOwner(db, ROOM, 'daily', ADMIN, MEMBER)).rejects.toThrow(
      'current agent',
    );
    expect((await readWorkflowOwnership(db, ROOM, 'daily', OWNER)).canTransfer).toBe(false);
    expect((await readWorkflowOwnership(db, ROOM, 'daily', HUMAN)).canTransfer).toBe(true);
    await phone.execute(
      'transferWorkflowOwner',
      { roomId: ROOM, name: 'daily', ownerId: OTHER },
      HUMAN,
    );
    await phone.execute(
      'transferWorkflowOwner',
      { roomId: ROOM, name: 'daily', ownerId: OWNER },
      ADMIN,
    );
    const audit = (
      await db.query(
        `SELECT actor_id,previous_owner_id,new_owner_id,created_at FROM workflow_owner_transfers ORDER BY id`,
      )
    ).rows;
    expect(audit).toEqual([
      {
        actor_id: HUMAN,
        previous_owner_id: OWNER,
        new_owner_id: OTHER,
        created_at: expect.any(Date),
      },
      {
        actor_id: ADMIN,
        previous_owner_id: OTHER,
        new_owner_id: OWNER,
        created_at: expect.any(Date),
      },
    ]);
  });
  it('migrates recorded creators, latest schedule creator fallback, and unresolved definitions once', async () => {
    await save();
    const created = await schedule();
    await db.query(
      `INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at,created_at)
      VALUES('90000000-0000-4000-8000-000000000001',$1,$2,$3,$3,'{"kind":"interval","everyMinutes":1}','Start workflow daily',now(),now()+interval '1 minute')`,
      [WORKSPACE, ROOM, OTHER],
    );
    await db.query(`UPDATE workspace_skills SET owner_agent_id=NULL,ownership_initialized=false`);
    await migrate(db);
    expect((await readWorkflowOwnership(db, ROOM, 'daily', ADMIN)).owner?.id).toBe(OWNER);
    await db.query(
      `UPDATE workspace_skills SET owner_agent_id=NULL,creator_agent_id=NULL,ownership_initialized=false`,
    );
    await migrate(db);
    expect((await readWorkflowOwnership(db, ROOM, 'daily', ADMIN)).owner?.id).toBe(OTHER);
    await db.query(`DELETE FROM agent_schedules`);
    await db.query(
      `UPDATE workspace_skills SET owner_agent_id=NULL,creator_agent_id=NULL,ownership_initialized=false`,
    );
    await migrate(db);
    expect((await readWorkflowOwnership(db, ROOM, 'daily', ADMIN)).owner).toBe(null);
    await expect(start()).rejects.toThrow('no owner, starts blocked');
    await phone.execute(
      'transferWorkflowOwner',
      { roomId: ROOM, name: 'daily', ownerId: OWNER },
      ADMIN,
    );
    await migrate(db);
    expect((await readWorkflowOwnership(db, ROOM, 'daily', ADMIN)).owner?.id).toBe(OWNER);
    expect(created.scheduleId).toBeTruthy();
  });
});
