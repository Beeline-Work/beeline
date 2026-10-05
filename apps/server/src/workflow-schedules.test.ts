import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { describedWorkflow, PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { AgentScheduleLoop } from './agent-schedules.js';
import { saveWorkflow, startWorkflow, cancelWorkflowRun, getWorkflowRun } from './workflow-runs.js';
import { createAgentCommand, type CommandRow } from './agent-command.js';
import { scheduleWorkflowName } from './workflow-admin.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const ROOM = '20000000-0000-4000-8000-000000000001';
const OTHER_ROOM = '20000000-0000-4000-8000-000000000002';
const OWNER = 'a'.repeat(64),
  ADMIN = 'b'.repeat(64),
  AGENT = 'c'.repeat(64);
let snapshot: Blob | File;
let db: PgliteDatabase;
let phone: PhoneService;
let daemon: DaemonService;

beforeAll(async () => {
  const seed = new PgliteDatabase();
  await migrate(seed);
  await seed.query(
    `INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'human','Admin'),($3,'agent','Worker')`,
    [OWNER, ADMIN, AGENT],
  );
  await seed.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, OWNER]);
  await seed.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
  await seed.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$3,$4,'Room'),($2,$3,$4,'Other')`,
    [ROOM, OTHER_ROOM, WORKSPACE, OWNER],
  );
  for (const [identity, role] of [
    [OWNER, 'owner'],
    [ADMIN, 'member'],
    [AGENT, 'member'],
  ]) {
    await seed.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,$3),($1,$4,$2,$3),($1,$5,$2,$3)`,
      [WORKSPACE, identity, role, ROOM, OTHER_ROOM],
    );
  }
  await seed.query(`UPDATE memberships SET role='admin' WHERE identity_id=$1 AND room_id=$2`, [
    ADMIN,
    ROOM,
  ]);
  await seed.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES('save',$1,$2,'Save daily')`,
    [ROOM, OWNER],
  );
  const command = (await createAgentCommand(seed, {
    roomId: ROOM,
    agentId: AGENT,
    sourceMessageId: 'save',
    reason: 'human_tag',
  }))!;
  await saveWorkflow(seed, command, {
    contract: describedWorkflow({
      version: 1,
      name: 'daily',
      description: 'Daily work',
      roles: ['worker'],
      start: 'work',
      handoffs: {
        work: { role: 'worker', requires: [], on: { done: 'done' } },
        done: { kind: 'terminal', status: 'done' },
      },
    }),
  });
  snapshot = await seed.snapshot();
  await seed.close();
});
beforeEach(() => {
  db = PgliteDatabase.fromSnapshot(snapshot);
  phone = new PhoneService(db, 'http://local.test');
  daemon = new DaemonService(db, new LiveHub());
});
afterEach(async () => {
  await db.close();
});

const start = () =>
  startWorkflow(
    db,
    { room_id: ROOM, agent_id: OWNER },
    { name: 'daily', roleBindings: { worker: AGENT } },
  );
async function schedule(prompt: string, explicit = false) {
  const created = await daemon.execute(
    'createAgentSchedule',
    {
      roomId: ROOM,
      agentId: AGENT,
      prompt,
      cadence: { kind: 'interval', everyMinutes: 1 },
      maxRuns: 1,
      ...(explicit ? { workflowName: 'daily' } : {}),
    },
    AGENT,
  );
  const due = new Date();
  await db.query(`UPDATE agent_schedules SET next_run_at=$2 WHERE id=$1`, [
    created.scheduleId,
    due,
  ]);
  return { ...created, due };
}

it('Reproduction schedules-11: keeps maxRuns:1 through skips and later starts exactly one run', async () => {
  const live = await start();
  const { scheduleId, due } = await schedule('Start workflow daily', true);
  const loop = new AgentScheduleLoop(db);
  expect(await loop.runOnce(due)).toBe(1);
  const remaining = (await daemon.execute('listAgentSchedules', { roomId: ROOM }, AGENT)).schedules;
  expect(remaining).toEqual([
    expect.objectContaining({
      scheduleId,
      runCount: 0,
      maxRuns: 1,
      nextRunAt: Math.floor(due.getTime() / 1000) + 60,
    }),
  ]);
  expect((await db.query(`SELECT 1 FROM agent_commands WHERE reason='schedule'`)).rowCount).toBe(0);
  const next = new Date(due.getTime() + 60_000);
  expect(await loop.runOnce(next)).toBe(1);
  expect(
    (await daemon.execute('listAgentSchedules', { roomId: ROOM }, AGENT)).schedules[0]?.runCount,
  ).toBe(0);
  await cancelWorkflowRun(
    db,
    { room_id: ROOM, agent_id: OWNER },
    { runId: live.runId, reason: 'Allow the next scheduled run' },
  );
  expect(await loop.runOnce(new Date(next.getTime() + 60_000))).toBe(1);
  const commands = (
    await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE reason='schedule'`)
  ).rows;
  expect(commands).toHaveLength(1);
  const fresh = await startWorkflow(db, commands[0]!, {
    name: 'daily',
    roleBindings: { worker: AGENT },
  });
  expect(await getWorkflowRun(db, ROOM, fresh.runId)).toMatchObject({ state: 'work' });
  expect((await daemon.execute('listAgentSchedules', { roomId: ROOM }, AGENT)).schedules).toEqual(
    [],
  );
  expect(await loop.runOnce(new Date(next.getTime() + 120_000))).toBe(0);
  console.log(
    'Demonstrated schedules-11: two skips preserved maxRuns:1 and advanced nextRunAt; after cancellation the next tick started exactly one run and removed the schedule',
  );
});

it('Reproduction schedules-12: resolves Start the daily workflow with… and skips before restart', async () => {
  await start();
  const { scheduleId, due } = await schedule('Start the daily workflow with today’s input');
  const listed = (await daemon.execute('listAgentSchedules', { roomId: ROOM }, AGENT)).schedules;
  expect(await new AgentScheduleLoop(db).runOnce(due)).toBe(1);
  console.log('schedules-12 observed:', {
    workflowName: listed[0]?.workflowName,
    skips: (await db.query(`SELECT 1 FROM messages WHERE text LIKE '%skipped a run%'`)).rowCount,
    wakes: (await db.query(`SELECT 1 FROM agent_commands WHERE reason='schedule'`)).rowCount,
  });
  expect(listed).toEqual([expect.objectContaining({ scheduleId, workflowName: 'daily' })]);
  expect(
    (await db.query(`SELECT 1 FROM messages WHERE text LIKE '%skipped a run%'`)).rowCount,
  ).toBe(1);
  expect((await db.query(`SELECT 1 FROM agent_commands WHERE reason='schedule'`)).rowCount).toBe(0);
  console.log(
    'Demonstrated schedules-12: prompt resolved daily at creation; live run caused one skip and no schedule wake before any restart',
  );
});

it('Reproduction schedules-13: Room admin lists and deletes only their Room schedules', async () => {
  const input = {
    roomId: ROOM,
    agentId: AGENT,
    prompt: 'Run daily',
    cadence: { kind: 'interval' as const, everyMinutes: 1 },
  };
  const created = await daemon.execute('createAgentSchedule', input, AGENT);
  const other = await daemon.execute(
    'createAgentSchedule',
    { ...input, roomId: OTHER_ROOM },
    AGENT,
  );
  expect(
    (await phone.execute('listRoomSchedules', { roomId: ROOM }, ADMIN)).schedules.map(
      (row) => row.id,
    ),
  ).toEqual([created.scheduleId]);
  await expect(phone.execute('listRoomSchedules', { roomId: OTHER_ROOM }, ADMIN)).rejects.toThrow(
    'room manager required',
  );
  await expect(
    phone.execute('deleteRoomSchedule', { roomId: ROOM, scheduleId: other.scheduleId }, ADMIN),
  ).rejects.toThrow('schedule not found');
  await expect(
    phone.execute(
      'deleteRoomSchedule',
      { roomId: OTHER_ROOM, scheduleId: other.scheduleId },
      ADMIN,
    ),
  ).rejects.toThrow('room manager required');
  await phone.execute(
    'deleteRoomSchedule',
    { roomId: ROOM, scheduleId: created.scheduleId },
    ADMIN,
  );
  expect((await phone.execute('listRoomSchedules', { roomId: ROOM }, ADMIN)).schedules).toEqual([]);
  expect(
    (await phone.execute('listRoomSchedules', { roomId: OTHER_ROOM }, OWNER)).schedules.map(
      (row) => row.id,
    ),
  ).toEqual([other.scheduleId]);
  console.log(
    'Demonstrated schedules-13: Room admin listed and deleted their schedule; other Room schedules stayed hidden and could not be deleted',
  );
});

describe('workflow prompt resolution', () => {
  it.each([
    'Start workflow daily',
    'start_workflow "daily"',
    'workflow `daily`',
    'Start the daily workflow with input',
    'Start the "daily" workflow with input',
    'Start the DAILY workflow with input',
  ])('resolves %s', async (prompt) => {
    expect(await scheduleWorkflowName(db, ROOM, prompt)).toBe('daily');
  });
  it.each([
    'Start the missing workflow with input',
    'Start workflow daily-other',
    'notdaily workflow',
    'daily workflows',
    'ordinary prompt',
  ])('does not resolve %s', async (prompt) => {
    expect(await scheduleWorkflowName(db, ROOM, prompt)).toBeUndefined();
  });
});

it('backfills with the same resolver and preserves already resolved workflows', async () => {
  const prompts = [
    'Start the daily workflow with input',
    'Start workflow daily',
    'start_workflow "daily"',
    'workflow `daily`',
    'Start the DAILY workflow with input',
    'Start workflow daily-other',
    'ordinary prompt',
  ];
  const expected = [];
  for (const prompt of prompts) {
    const created = await schedule(prompt);
    expected.push({
      id: created.scheduleId,
      workflow_slug: (await scheduleWorkflowName(db, ROOM, prompt)) ?? null,
    });
    await db.query(`UPDATE agent_schedules SET workflow_slug=NULL WHERE id=$1`, [
      created.scheduleId,
    ]);
  }
  const preserved = await schedule('Start the daily workflow with input');
  await db.query(`UPDATE agent_schedules SET workflow_slug='recorded-target' WHERE id=$1`, [
    preserved.scheduleId,
  ]);
  await migrate(db, { deferData: true });
  for (const row of expected) {
    expect(
      (await db.query(`SELECT id,workflow_slug FROM agent_schedules WHERE id=$1`, [row.id])).rows,
    ).toEqual([row]);
  }
  expect(
    (
      await db.query(`SELECT workflow_slug FROM agent_schedules WHERE id=$1`, [
        preserved.scheduleId,
      ])
    ).rows,
  ).toEqual([{ workflow_slug: 'recorded-target' }]);
});
