import { describedWorkflow } from './test-support.js';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { createAgentCommand } from './agent-command.js';
import { saveWorkflow, startWorkflow, handoff } from './workflow-runs.js';
import { activeWorkflowRunIds } from './workflow-admin.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';

vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return { ...crypto, randomBytes: vi.fn(crypto.randomBytes) };
});

const ROOM = '20000000-0000-4000-8000-000000000001';
const CORNER = '20000000-0000-4000-8000-000000000002';
const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const HUMAN = 'a'.repeat(64),
  SCANNER = 'b'.repeat(64),
  OTHER = 'c'.repeat(64);
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
let db: PgliteDatabase, daemon: DaemonService;
beforeAll(async () => {
  const seed = new PgliteDatabase();
  await migrate(seed);
  await seed.query(
    `INSERT INTO identities(id,kind,name) VALUES($1,'human','Creator'),($2,'agent','Scanner'),($3,'agent','Peer')`,
    [HUMAN, SCANNER, OTHER],
  );
  await seed.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [
    SCANNER,
    OTHER,
    HUMAN,
  ]);
  await seed.query(`INSERT INTO workspaces(id,name) VALUES($1,'Test')`, [WORKSPACE]);
  await seed.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`, [
    ROOM,
    WORKSPACE,
    HUMAN,
  ]);
  for (const identity of [HUMAN, SCANNER, OTHER])
    await seed.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'member'),($1,NULL,$3,'member')`,
      [WORKSPACE, ROOM, identity],
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
});
afterEach(async () => {
  await db.close();
});
async function command(agentId = SCANNER, roomId = ROOM) {
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
  await saveWorkflow(db, await command(), { contract: describedWorkflow(contract) });
}
async function surface(roomId: string, parentId: string | null, members = [SCANNER, OTHER]) {
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
const start = (actor = SCANNER) =>
  startWorkflow(
    db,
    { room_id: ROOM, agent_id: actor },
    { name: 'daily', roleBindings: { scanner: OTHER } },
  );

describe('activeWorkflowRunIds', () => {
  it('excludes a same-transaction terminal card whose ID sorts below the start', async () => {
    await save();
    const worker = await command(OTHER);
    await db.transaction(async (tx) => {
      vi.mocked(randomBytes).mockImplementationOnce(() => Buffer.alloc(32, 0xff));
      const { runId } = await startWorkflow(
        tx,
        { room_id: ROOM, agent_id: SCANNER },
        { name: 'daily', roleBindings: { scanner: OTHER } },
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
      expect(await activeWorkflowRunIds(tx, ROOM, 'daily', OTHER)).toEqual([]);
      // Sequenced cards also outrank legacy cards with a later timestamp.
      await tx.query(
        `UPDATE messages SET card=card-'seq',created_at=now()+interval '1 day' WHERE id=$1`,
        [runId],
      );
      expect(await activeWorkflowRunIds(tx, ROOM, 'daily', OTHER)).toEqual([]);
    });
  });

  it('limits corner active runs to readable parent and sibling surfaces and excludes ended runs', async () => {
    await save();
    const sibling = '20000000-0000-4000-8000-000000000003';
    const privateCorner = '20000000-0000-4000-8000-000000000004';
    const unrelatedRoom = '20000000-0000-4000-8000-000000000005';
    await surface(CORNER, ROOM);
    await surface(sibling, ROOM);
    await surface(privateCorner, ROOM, [SCANNER]);
    await surface(unrelatedRoom, null);
    const parentRun = await start();
    const startHere = (roomId: string) =>
      startWorkflow(
        db,
        { room_id: roomId, agent_id: SCANNER },
        { name: 'daily', roleBindings: { scanner: SCANNER } },
      );
    const cornerRun = await startHere(CORNER);
    const siblingRun = await startHere(sibling);
    const privateRun = await startHere(privateCorner);
    await startHere(unrelatedRoom);
    const visible = [parentRun.runId, cornerRun.runId, siblingRun.runId].sort();
    expect(await activeWorkflowRunIds(db, CORNER, 'daily', OTHER)).toEqual(visible);
    expect(await activeWorkflowRunIds(db, ROOM, 'daily', OTHER)).toEqual(visible);
    expect(await activeWorkflowRunIds(db, CORNER, 'daily', SCANNER)).toEqual(
      [...visible, privateRun.runId].sort(),
    );
    await handoff(db, await command(SCANNER, sibling), {
      runId: siblingRun.runId,
      outcome: 'done',
      contents: {},
    });
    expect(await activeWorkflowRunIds(db, CORNER, 'daily', OTHER)).toEqual(
      [parentRun.runId, cornerRun.runId].sort(),
    );
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
      ROOM,
      OTHER,
    ]);
    expect(await activeWorkflowRunIds(db, CORNER, 'daily', OTHER)).toEqual([cornerRun.runId]);
  });

  it('is unavailable (empty) for a slug with no saved workflow', async () => {
    expect(await activeWorkflowRunIds(db, ROOM, 'nonexistent', SCANNER)).toEqual([]);
  });

  it('feeds list_schedules active run IDs for a workflow-targeted schedule, alongside its own triggered runs', async () => {
    await save();
    const { runId } = await start();
    const created = await daemon.execute(
      'createAgentSchedule',
      {
        roomId: ROOM,
        agentId: SCANNER,
        prompt: 'Start workflow daily',
        workflowName: 'daily',
        cadence: { kind: 'interval', everyMinutes: 1 },
      },
      SCANNER,
    );
    const listed = await daemon.execute('listAgentSchedules', { roomId: ROOM }, OTHER);
    expect(listed.schedules.find((entry) => entry.scheduleId === created.scheduleId)).toMatchObject(
      { workflowName: 'daily', activeRunIds: [runId] },
    );
  });
});
