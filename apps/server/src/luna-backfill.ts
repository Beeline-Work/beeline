import { createHash } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { createFreeAgentInWorkspace, FREE_AGENT_EVENT_SUBSCRIPTIONS, LUNA_BACKFILL_HELLO, type FreeAgentConfig } from './free-agents.js';

/** IDs verified against production on 2026-10-27; names are documentation only. */
export const LUNA_BACKFILL_SKIP = [
  '18e555f7-e191-452b-9b0f-b825f58ee4ba', // Tubing Crew
  '8556a9be-d929-41e7-a0ef-d70af452a494', // Beeline Community
  '890f35b7-2838-4bbc-a536-bd55fddbcef9', // The Salon
  '011464ea-5481-4b65-9c0d-5a01fc3c0283', // Burd Nest
  '7aa2a3bb-4248-403c-b3a0-df96f5e8b271', // jellybean-beeline-test's team
  '50c8dee6-03b2-4934-a756-54d7af9a4839', // Methoxine's team
] as const;

export const LUNA_BACKFILL_EXTRA_ROOM = '289fbeab-3df5-4db3-9b70-d2fd3b937cae';

export type LunaBackfillTarget = {
  workspace_id: string; workspace_name: string; owner_id: string; owner_handle: string;
  target_kind: 'explicit Room' | 'free-Beebee sweep'; room_id: string; beebee_id: string; luna_id: string | null;
};

export const LUNA_BACKFILL_TARGET_SQL = `SELECT DISTINCT ON (w.id)
  w.id workspace_id,w.name workspace_name,f.owner_id,person.handle owner_handle,
  CASE WHEN room.id=$2 THEN 'explicit Room' ELSE 'free-Beebee sweep' END target_kind,
  room.id room_id,f.agent_id beebee_id,
  (SELECT luna.agent_id FROM free_agents luna WHERE luna.workspace_id=w.id
    AND luna.starter_role='luna' ORDER BY luna.created_at LIMIT 1) luna_id
FROM workspaces w JOIN free_agents f ON f.workspace_id=w.id AND f.removed_at IS NULL
  AND (f.starter_role='beebee' OR f.starter_role IS NULL)
JOIN identities person ON person.id=f.owner_id AND person.kind='human' AND person.handle IS NOT NULL
JOIN memberships owner ON owner.workspace_id=w.id AND owner.room_id IS NULL
  AND owner.identity_id=f.owner_id AND owner.removed_at IS NULL
JOIN rooms room ON room.workspace_id=w.id AND room.parent_id IS NULL AND room.direct_participants IS NULL
  AND room.archived_at IS NULL
WHERE ((NOT (w.id=ANY($1::uuid[])) AND lower(room.name)='general') OR room.id=$2)
  AND EXISTS(SELECT 1 FROM memberships teammate WHERE teammate.room_id=room.id
    AND teammate.identity_id=f.agent_id AND teammate.removed_at IS NULL)
ORDER BY w.id,(room.id=$2) DESC,f.created_at,room.created_at,room.id`;

export async function lunaBackfillTargets(database: SqlDatabase): Promise<LunaBackfillTarget[]> {
  const room = await database.query(`SELECT id FROM rooms WHERE id=$1 AND archived_at IS NULL
    AND parent_id IS NULL AND direct_participants IS NULL`, [LUNA_BACKFILL_EXTRA_ROOM]);
  if (!room.rowCount) throw new Error(`Explicit General Room ${LUNA_BACKFILL_EXTRA_ROOM} does not resolve; stop without guessing`);
  const targets = (await database.query<LunaBackfillTarget>(LUNA_BACKFILL_TARGET_SQL, [[...LUNA_BACKFILL_SKIP], LUNA_BACKFILL_EXTRA_ROOM])).rows;
  if (!targets.some(row => row.room_id === LUNA_BACKFILL_EXTRA_ROOM))
    throw new Error('Explicit General Room has no eligible free Beebee and human owner; stop without guessing');
  return targets;
}

/** No Fly calls and no model turns. The ordinary wake path provisions on first use. */
export async function backfillLuna(database: SqlDatabase, config: FreeAgentConfig | undefined,
  options: { apply?: boolean; approvedTargets?: ReadonlyArray<{ workspace_id: string; room_id: string }> },
) {
  let targets = await lunaBackfillTargets(database);
  if (options.approvedTargets) {
    const approved = options.approvedTargets;
    for (const target of approved) {
      if (!targets.some(row => row.workspace_id === target.workspace_id && row.room_id === target.room_id))
        throw new Error(`Approved target ${target.workspace_id}/${target.room_id} no longer resolves; stop for a new decision`);
    }
    targets = targets.filter(row => approved.some(target => target.workspace_id === row.workspace_id && target.room_id === row.room_id));
  }
  const results: Array<LunaBackfillTarget & { result: string }> = [];
  for (const target of targets) {
    if (!options.apply) { results.push({ ...target, result: target.luna_id ? 'already present' : 'would add Luna' }); continue; }
    if (!config) throw new Error('Free-agent configuration is required for --apply');
    const result = await database.transaction(async db => {
      await db.query(`SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, [target.workspace_id]);
      const current = (await lunaBackfillTargets(db)).find(row => row.workspace_id === target.workspace_id && row.room_id === target.room_id);
      if (!current) return 'no longer eligible';
      if (current.luna_id) return 'already present';
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`free-agent-create:${current.owner_id}`]);
      const luna = await createFreeAgentInWorkspace(db, {
        ...config, model: config.lunaModel ?? 'openai/gpt-6-luna',
      }, { workspaceId: current.workspace_id, creatorId: current.owner_id, roomId: current.room_id,
        name: 'Luna', silent: true, team: true });
      if (!luna) return 'owner at agent limit';
      await db.query(`UPDATE memberships SET event_subscriptions=$3::jsonb
        WHERE identity_id=ANY($1::text[]) AND room_id=$2 AND removed_at IS NULL`,
        [[current.beebee_id, luna], current.room_id, JSON.stringify(FREE_AGENT_EVENT_SUBSCRIPTIONS)]);
      await db.query(`UPDATE free_agents SET starter_role='beebee' WHERE agent_id=$1 AND starter_role IS NULL`, [current.beebee_id]);
      await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`, [
        createHash('sha256').update(`luna-backfill-intro:${current.workspace_id}`).digest('hex'),
        current.room_id, luna, LUNA_BACKFILL_HELLO.replace('{name}', `@${current.owner_handle}`),
      ]);
      return 'added Luna and intro';
    });
    results.push({ ...target, result });
  }
  return results;
}
