import { createHash } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { createFreeAgentInWorkspace, FREE_AGENT_EVENT_SUBSCRIPTIONS, type FreeAgentConfig } from './free-agents.js';

/** IDs verified against production on 2026-10-27; names are documentation only. */
export const LUNA_BACKFILL_SKIP = [
  '18e555f7-e191-452b-9b0f-b825f58ee4ba', // Tubing Crew
  '8556a9be-d929-41e7-a0ef-d70af452a494', // Beeline Community
  '890f35b7-2838-4bbc-a536-bd55fddbcef9', // The Salon
  '011464ea-5481-4b65-9c0d-5a01fc3c0283', // Burd Nest
] as const;

export type LunaBackfillTarget = {
  workspace_id: string; workspace_name: string; owner_id: string; owner_handle: string;
  room_id: string; beebee_id: string; luna_id: string | null;
};

export const LUNA_BACKFILL_TARGET_SQL = `SELECT DISTINCT ON (w.id)
  w.id workspace_id,w.name workspace_name,f.owner_id,person.handle owner_handle,
  room.id room_id,f.agent_id beebee_id,
  (SELECT luna.agent_id FROM free_agents luna WHERE luna.workspace_id=w.id
    AND luna.starter_role='luna' ORDER BY luna.created_at LIMIT 1) luna_id
FROM workspaces w JOIN free_agents f ON f.workspace_id=w.id AND f.removed_at IS NULL
  AND (f.starter_role='beebee' OR f.starter_role IS NULL)
JOIN identities person ON person.id=f.owner_id AND person.kind='human' AND person.handle IS NOT NULL
JOIN memberships owner ON owner.workspace_id=w.id AND owner.room_id IS NULL
  AND owner.identity_id=f.owner_id AND owner.removed_at IS NULL
JOIN rooms room ON room.workspace_id=w.id AND room.parent_id IS NULL AND room.direct_participants IS NULL
  AND room.archived_at IS NULL AND lower(room.name)='general'
WHERE NOT (w.id=ANY($1::uuid[]))
ORDER BY w.id,f.created_at,room.created_at,room.id`;

export async function lunaBackfillTargets(database: SqlDatabase): Promise<LunaBackfillTarget[]> {
  return (await database.query<LunaBackfillTarget>(LUNA_BACKFILL_TARGET_SQL, [[...LUNA_BACKFILL_SKIP]])).rows;
}

/** No Fly calls and no model turns. The ordinary wake path provisions on first use. */
export async function backfillLuna(database: SqlDatabase, config: FreeAgentConfig | undefined,
  options: { apply?: boolean; intro: (ownerHandle: string) => string },
) {
  const targets = await lunaBackfillTargets(database);
  const results: Array<LunaBackfillTarget & { result: string }> = [];
  for (const target of targets) {
    if (!options.apply) { results.push({ ...target, result: target.luna_id ? 'already present' : 'would add Luna' }); continue; }
    if (!config) throw new Error('Free-agent configuration is required for --apply');
    const result = await database.transaction(async db => {
      await db.query(`SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, [target.workspace_id]);
      const current = (await lunaBackfillTargets(db)).find(row => row.workspace_id === target.workspace_id);
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
        current.room_id, luna, options.intro(current.owner_handle),
      ]);
      return 'added Luna and intro';
    });
    results.push({ ...target, result });
  }
  return results;
}
