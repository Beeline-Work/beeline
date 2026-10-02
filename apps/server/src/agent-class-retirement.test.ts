import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { retireAgentClasses } from './agent-class-retirement.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000007';
const ROOM = '20000000-0000-4000-8000-000000000007';
const EMPTY_ROOM = '20000000-0000-4000-8000-000000000008';
const FIXED_ROOM = '20000000-0000-4000-8000-000000000009';
const OWNER = 'a'.repeat(64);
const OPUS_ZED = 'b'.repeat(64);
const OPUS_ADA = 'c'.repeat(64);
const LIGHT = 'd'.repeat(64);
const RUN = 'e'.repeat(64);

let database: PgliteDatabase;

beforeEach(async () => {
  database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name) VALUES
       ($1,'human','Owner'),($2,'agent','Zed'),($3,'agent','Ada'),($4,'agent','Light')`,
    [OWNER, OPUS_ZED, OPUS_ADA, LIGHT],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES
       ($1,$4,$5,'team'),($2,$4,$5,'empty'),($3,$4,$5,'fixed')`,
    [ROOM, EMPTY_ROOM, FIXED_ROOM, WORKSPACE, OWNER],
  );
  for (const room of [ROOM, FIXED_ROOM])
    for (const id of [OWNER, OPUS_ZED, OPUS_ADA, LIGHT])
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
        [WORKSPACE, room, id],
      );
  await database.query(
    `INSERT INTO agents(agent_id,owner_id,selected_model,custom_tags) VALUES
       ($1,$4,'opus-4-5','["night-shift"]'),($2,$4,'opus-4-5','[]'),($3,$4,'some-light-model','[]')`,
    [OPUS_ZED, OPUS_ADA, LIGHT, OWNER],
  );
});

const room = (id: string) =>
  database
    .query<{ reviewer_agent_id: string | null; reviewer_fallback_ids: string[]; reviewer_class: string | null }>(
      `SELECT reviewer_agent_id,reviewer_fallback_ids,reviewer_class FROM rooms WHERE id=$1`,
      [id],
    )
    .then((r) => r.rows[0]);

describe('retireAgentClasses', () => {
  it("turns a Room's reviewer class into the matching agents, ordered by name", async () => {
    await database.query(`UPDATE rooms SET reviewer_class='heavy' WHERE id=$1`, [ROOM]);
    const result = await retireAgentClasses(database);
    expect(await room(ROOM)).toEqual({
      reviewer_agent_id: OPUS_ADA,
      reviewer_fallback_ids: [OPUS_ZED],
      reviewer_class: null,
    });
    expect(result.convertedRooms).toBe(1);
  });

  it('clears a reviewer class matching nobody and names the Room', async () => {
    await database.query(`UPDATE rooms SET reviewer_class='god' WHERE id=$1`, [EMPTY_ROOM]);
    const result = await retireAgentClasses(database);
    expect(await room(EMPTY_ROOM)).toEqual({
      reviewer_agent_id: null,
      reviewer_fallback_ids: [],
      reviewer_class: null,
    });
    expect(result.clearedRooms).toEqual([{ id: EMPTY_ROOM, name: 'empty' }]);
  });

  it('keeps a fixed reviewer and only drops a stray class', async () => {
    await database.query(`UPDATE rooms SET reviewer_agent_id=$2,reviewer_class='heavy' WHERE id=$1`, [
      FIXED_ROOM,
      LIGHT,
    ]);
    await retireAgentClasses(database);
    expect(await room(FIXED_ROOM)).toEqual({
      reviewer_agent_id: LIGHT,
      reviewer_fallback_ids: [],
      reviewer_class: null,
    });
  });

  it('matches custom tags, then deletes stored custom tags and weight-tier rules', async () => {
    await database.query(`UPDATE rooms SET reviewer_class='night-shift' WHERE id=$1`, [ROOM]);
    await database.query(`UPDATE workspaces SET weight_tier_rules='[{"pattern":"opus*","tier":"god"}]'`);
    await retireAgentClasses(database);
    expect((await room(ROOM))!.reviewer_agent_id).toBe(OPUS_ZED);
    const tags = await database.query(`SELECT 1 FROM agents WHERE custom_tags<>'[]'::jsonb`);
    const rules = await database.query(`SELECT 1 FROM workspaces WHERE weight_tier_rules IS NOT NULL`);
    expect(tags.rows).toHaveLength(0);
    expect(rules.rows).toHaveLength(0);
  });

  it('gives an in-flight class-bound role its list and drops an unresolved class word', async () => {
    const card = (roleBindings: Record<string, string>, extra: object) =>
      JSON.stringify({ runId: RUN, workflowSlug: 'flow', workflowVersion: 1, roleBindings, toState: 'work', ...extra });
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,card_type,card,created_at) VALUES
         ($1,$2,$3,'started','workflow-handoff',$4::jsonb,now()-interval '1 minute'),
         ('later-card',$2,$3,'handed off','workflow-handoff',$5::jsonb,now())`,
      [
        RUN,
        ROOM,
        OPUS_ZED,
        card({ worker: OPUS_ZED, checker: 'heavy' }, { roleClasses: { worker: 'heavy', checker: 'heavy' } }),
        card({ worker: OPUS_ZED, checker: 'heavy' }, {}),
      ],
    );
    const result = await retireAgentClasses(database);
    expect(result.runs).toBe(1);
    const cards = await database.query<{ id: string; card: Record<string, unknown> }>(
      `SELECT id,card FROM messages WHERE card_type='workflow-handoff' ORDER BY created_at`,
    );
    expect(cards.rows[0]!.card.roleClasses).toBeUndefined();
    expect(cards.rows[0]!.card.roleAgents).toEqual({ worker: [OPUS_ADA, OPUS_ZED], checker: [OPUS_ADA, OPUS_ZED] });
    for (const row of cards.rows) expect(row.card.roleBindings).toEqual({ worker: OPUS_ZED });
    // A second release finds nothing left to convert.
    expect(await retireAgentClasses(database)).toEqual({ convertedRooms: 0, clearedRooms: [], runs: 0 });
  });
});
