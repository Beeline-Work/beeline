import { afterEach, expect, it } from 'vitest';
import { migrate } from './database.js';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { cornerImplementerSql as oldWorker, cornerOwnerSql as oldOwner } from './fixtures/rollout-0707-corner-worker.js';
import { cornerImplementerSql, cornerOwnerSql } from './corner-worker.js';
import { starPromptReplySql } from './github-star-prompt.js';

let db: PgliteDatabase;
afterEach(async () => { await db?.close(); });
const H = 'a'.repeat(64), A = 'b'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111', R = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
async function fixture() {
  db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Worker')`, [H,A]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [A,H]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Rollout proof')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Parent',$3)`, [R,W,H]);
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'Corner',$4)`, [C,W,R,A]);
  await db.query(`INSERT INTO corner_facts(corner_id) VALUES($1)`, [C]);
}

it('rollout-0707: the exact released expressions survive both schema overlap directions and repeated migrations', async () => {
  // Sentry 466aa2408b8c47348aac9a16b97f527a, release 3fe0d1b17,
  // 2026-11-03 07:08:34 UTC: waiting_fact.owner_agent_id does not exist.
  await fixture();
  for (const alias of ['waiting_fact','fact','owner_fact']) {
    const query = `SELECT ${oldWorker(alias, 'corner')} worker,${oldOwner('corner.id')} owner
      FROM rooms corner JOIN corner_facts ${alias} ON ${alias}.corner_id=corner.id WHERE corner.id=$1`;
    expect((await db.query(query, [C])).rows[0]).toMatchObject({ worker: A });
  }
  await db.query(`UPDATE corner_facts SET owner_agent_id=$1 WHERE corner_id=$2`, [A,C]);
  await migrate(db);
  await migrate(db);
  expect((await db.query(`SELECT owner_agent_id FROM corner_facts WHERE corner_id=$1`, [C])).rows[0]).toEqual({ owner_agent_id: A });
  expect((await db.query(`SELECT ${cornerImplementerSql('fact','corner')} worker,${cornerOwnerSql('corner.id')} owner
    FROM rooms corner JOIN corner_facts fact ON fact.corner_id=corner.id WHERE corner.id=$1`, [C])).rows[0]).toMatchObject({ worker: A });
  // Also repair installations where the preceding release already dropped it.
  await db.query(`ALTER TABLE corner_facts DROP COLUMN owner_agent_id`);
  await migrate(db);
  await expect(db.query(`SELECT ${oldOwner('corner.id')} owner FROM rooms corner WHERE id=$1`, [C])).resolves.toMatchObject({ rowCount: 1 });
}, 60_000);

it('SERVER-27: a released reply upsert and the candidate upsert both commit through overlap and repair', async () => {
  // Sentry db04a711c86948d18b913312503ad871, 2026-11-02 21:21:58 UTC.
  await fixture();
  const source = 'e'.repeat(64);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'A person asks')`, [source,R,H]);
  // Exact 75e48e93346e starPromptReplySql output. Keep the retired write frozen.
  const oldReply = `WITH command AS (SELECT $1::text root_source_message_id)
    INSERT INTO github_star_prompts AS prompt(identity_id,replies,reached_milestone)
     SELECT source.author_id,1,
       CASE WHEN 1=ANY(ARRAY[3,30,300]) THEN 1 ELSE 0 END
     FROM command command
     JOIN messages source ON source.id=command.root_source_message_id
     JOIN identities person ON person.id=source.author_id
       AND person.kind='human' AND NOT person.hidden_from_roster
     LIMIT 1
     ON CONFLICT(identity_id) DO UPDATE SET
       replies=prompt.replies+1,
       reached_milestone=CASE WHEN prompt.replies+1=ANY(ARRAY[3,30,300])
         THEN prompt.replies+1 ELSE prompt.reached_milestone END,
       updated_at=now()`;
  await db.query(oldReply, [source]);
  await db.query(`WITH command AS (SELECT $1::text root_source_message_id) ${starPromptReplySql('command')}`, [source]);
  await db.query(oldReply, [source]);
  await migrate(db);
  expect((await db.query(`SELECT replies,reached_milestone FROM github_star_prompts WHERE identity_id=$1`, [H])).rows[0])
    .toEqual({ replies: 3, reached_milestone: 3 });
  await db.query(`ALTER TABLE github_star_prompts DROP COLUMN reached_milestone`);
  await migrate(db);
  await db.query(oldReply, [source]);
  expect((await db.query(`SELECT replies FROM github_star_prompts WHERE identity_id=$1`, [H])).rows[0]).toEqual({ replies: 4 });
}, 60_000);
