import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { createFreeAgentInWorkspace, freeAgentConfigFromEnv } from './free-agents.js';
import { backfillLuna, LUNA_BACKFILL_SKIP } from './luna-backfill.js';

let db: PgliteDatabase;
const config = freeAgentConfigFromEnv({ BEELINE_FREE_AGENT_SEAL_KEY: 'test', FLY_FREE_AGENT_IMAGE: 'test' }, 'https://test.invalid')!;
const intro = (owner: string) => `@${owner} Test intro`;
beforeAll(async () => { db = new PgliteDatabase(); await migrate(db); }, 30_000);
afterAll(async () => { await db?.close(); });

async function seed(workspaceId: string, name: string) {
  const owner = randomUUID().replaceAll('-', '').repeat(2), room = randomUUID();
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner',$2)`, [owner, `owner${owner.slice(0, 8)}`]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,$2)`, [workspaceId, name]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'general',$3)`, [room, workspaceId, owner]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`, [workspaceId, owner, room]);
  await db.transaction(tx => createFreeAgentInWorkspace(tx, config, { workspaceId, roomId: room, creatorId: owner }));
  return { owner, room };
}

it('dry-runs without writes, adds the same model and team prompt once, and skips IDs even after renaming', async () => {
  for (const id of LUNA_BACKFILL_SKIP) await seed(id, 'Renamed excluded workspace');
  const workspaceId = randomUUID();
  const { owner, room } = await seed(workspaceId, 'Tubing Crew');
  const before = (await db.query(`SELECT count(*) FROM messages`)).rows;
  const dry = await backfillLuna(db, undefined, { intro });
  expect(dry.map(row => row.workspace_id)).toEqual([workspaceId]);
  expect((await db.query(`SELECT count(*) FROM messages`)).rows).toEqual(before);
  expect((await backfillLuna(db, config, { apply: true, intro }))[0]!.result).toBe('added Luna and intro');
  expect((await backfillLuna(db, config, { apply: true, intro }))[0]!.result).toBe('already present');
  const luna = (await db.query<{ model: string; selected_model: string; soul: { instructions: string } }>(
    `SELECT f.model,a.selected_model,a.soul FROM free_agents f JOIN agents a ON a.agent_id=f.agent_id
     WHERE f.workspace_id=$1 AND f.starter_role='luna'`, [workspaceId])).rows;
  expect(luna).toHaveLength(1);
  expect(luna[0]!.model).toBe(config.lunaModel);
  expect(luna[0]!.soul.instructions).toContain('The server already posts your first hello');
  expect((await db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND text=$2`, [room, intro(`owner${owner.slice(0, 8)}`)])).rowCount).toBe(1);
  expect((await db.query(`SELECT 1 FROM free_agents WHERE workspace_id=ANY($1::uuid[]) AND starter_role='luna'`, [[...LUNA_BACKFILL_SKIP]])).rowCount).toBe(0);
  expect((await db.query(`SELECT 1 FROM agent_commands c JOIN free_agents f ON f.agent_id=c.agent_id WHERE f.starter_role='luna'`)).rowCount).toBe(0);
});
