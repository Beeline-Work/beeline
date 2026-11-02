import { randomUUID } from 'node:crypto';
import { DELIVERY_PICKUP_WINDOW_MS } from './connection-presence.js';
import type { SqlDatabase } from './database.js';
import type { InstitutionalMemoryShadowConfig } from './institutional-memory-shadow.js';
import {
  refreshWorkspaceSkillAnchors,
  type InstitutionalSkillAnchorSource,
} from './institutional-skill-anchors.js';

/**
 * A sample covers at most this much time. The curator samples on the server's
 * reconciliation cadence, so a longer span means nothing watched the host and
 * the span must not be credited as available.
 */
export const AVAILABILITY_OBSERVATION_MAX_MS = 10 * 60_000;

/**
 * An authorized helper host that could serve this Workspace right now: a
 * current Workspace-member agent on a known machine whose authenticated
 * presence evidence is still fresh.
 */
const WORKSPACE_HOST_AVAILABLE_SQL = `EXISTS (
    SELECT 1
    FROM memberships member
    JOIN agents agent ON agent.agent_id=member.identity_id AND agent.machine_id IS NOT NULL
    JOIN live_outputs presence
      ON presence.agent_id=member.identity_id AND presence.kind='presence'
    WHERE member.workspace_id=$1 AND member.room_id IS NULL AND member.removed_at IS NULL
      AND presence.body->>'status'='online'
      AND (presence.body->>'held'='true'
        OR presence.updated_at>=$2::timestamptz-interval '${DELIVERY_PICKUP_WINDOW_MS} milliseconds')
  )`;

/** Seconds since `anchor` in which no authorized helper host was available. */
function unavailableSecondsSql(anchor: string): string {
  return `(SELECT COALESCE(sum(extract(epoch FROM (
              LEAST(gap.ended_at,$2::timestamptz)-GREATEST(gap.started_at,${anchor})))),0)
           FROM institutional_host_availability_gaps gap
           WHERE gap.workspace_id=$1 AND gap.ended_at>${anchor}
             AND gap.started_at<$2::timestamptz)`;
}

/** True once `anchor` is older than `$<days>` days of MEASURED availability. */
function agedBeyondSql(anchor: string, days: string): string {
  return `extract(epoch FROM ($2::timestamptz-${anchor}))
            -${unavailableSecondsSql(anchor)}>=(${days})::integer*86400`;
}

/** Only a save, an update (a new row), or an end-of-turn used report resets an item's age. */
const ITEM_AGE_ANCHOR = `GREATEST(item.updated_at,COALESCE(item.last_used_at,item.updated_at))`;

/**
 * Sample whether an authorized helper host can serve this Workspace and record
 * every span that cannot be credited as available: an unavailable host, the
 * unobserved history before the first sample, and any span longer than the
 * sampling cadence. One contiguous span stays one row.
 */
export async function recordWorkspaceHostAvailability(
  database: SqlDatabase,
  workspaceId: string,
  now: Date,
): Promise<boolean> {
  // The gap write and the cursor advance are one transaction: a crash between
  // them would leave ended_at no longer equal to the next `since`, so the
  // extend would miss and a second overlapping gap would double-count.
  return database.transaction(async (db) => {
    const state = (
      await db.query<{ available: boolean; observed_at: Date | null; created_at: Date }>(
        `SELECT ${WORKSPACE_HOST_AVAILABLE_SQL} available,
                rollout.availability_observed_at observed_at,workspace.created_at
         FROM institutional_memory_workspace_rollouts rollout
         JOIN workspaces workspace ON workspace.id=rollout.workspace_id
         WHERE rollout.workspace_id=$1
         FOR UPDATE OF rollout`,
        [workspaceId, now],
      )
    ).rows[0];
    if (!state) return true;
    const since = state.observed_at ?? state.created_at;
    const credited =
      state.available &&
      state.observed_at !== null &&
      now.getTime() - since.getTime() <= AVAILABILITY_OBSERVATION_MAX_MS;
    if (!credited && since.getTime() < now.getTime()) {
      const extended = await db.query(
        `UPDATE institutional_host_availability_gaps SET ended_at=$3
         WHERE id=(SELECT id FROM institutional_host_availability_gaps
                   WHERE workspace_id=$1 AND ended_at=$2 ORDER BY started_at DESC LIMIT 1)`,
        [workspaceId, since, now],
      );
      if (!extended.rowCount) {
        await db.query(
          `INSERT INTO institutional_host_availability_gaps(id,workspace_id,started_at,ended_at)
           VALUES($1,$2,$3,$4)`,
          [randomUUID(), workspaceId, since, now],
        );
      }
    }
    await db.query(
      `UPDATE institutional_memory_workspace_rollouts SET availability_observed_at=$2
       WHERE workspace_id=$1`,
      [workspaceId, now],
    );
    return state.available;
  });
}

function utcWeekKey(now: Date): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

async function deterministicLifecycle(
  database: SqlDatabase,
  workspaceId: string,
  now: Date,
  expireAfterDays: number,
): Promise<{
  staleItems: number;
  archivedItems: number;
  staleSkills: number;
  archivedSkills: number;
}> {
  // Only a Workspace fact an agent saved on its own ages out. Profile facts
  // and standing orders (explicit_save) never expire; they change only when
  // corrected or deleted.
  const staleItems = await database.query(
    `UPDATE institutional_memory_items item
     SET state='stale',body='',deleted_at=$2,updated_at=$2
     WHERE item.workspace_id=$1 AND item.state='active' AND item.deleted_at IS NULL
       AND item.kind='workspace_fact' AND NOT item.explicit_save
       AND ${agedBeyondSql(ITEM_AGE_ANCHOR, '$3')}`,
    [workspaceId, now, expireAfterDays],
  );

  // Skills and workflows never expire: only memory items age out.
  return {
    staleItems: staleItems.rowCount,
    archivedItems: 0,
    staleSkills: 0,
    archivedSkills: 0,
  };
}

/** One idempotent weekly pass: deterministic aging first, then host-side consolidation jobs. */
export async function runInstitutionalCuratorCycle(
  database: SqlDatabase,
  config: InstitutionalMemoryShadowConfig,
  now = new Date(),
  options: { readonly anchors?: InstitutionalSkillAnchorSource } = {},
): Promise<number> {
  if (!config.enabled) return 0;
  const rollouts = await database.query<{
    workspace_id: string;
    expire_after_days: number;
  }>(
    `SELECT workspace.id workspace_id,
            COALESCE(rollout.expire_after_days,90) expire_after_days
     FROM workspaces workspace
     LEFT JOIN institutional_memory_workspace_rollouts rollout
       ON rollout.workspace_id=workspace.id
     ORDER BY workspace.id`,
  );
  for (const rollout of rollouts.rows) {
    try {
      if (config.live) {
        try {
          await refreshWorkspaceSkillAnchors(database, rollout.workspace_id, options.anchors, now);
        } catch (error) {
          console.error(`[server] institutional skill anchor pass failed (${rollout.workspace_id}):`, error);
        }
      }
      await recordWorkspaceHostAvailability(database, rollout.workspace_id, now);
      await database.transaction(async (db) => {
        await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `institutional-memory:${rollout.workspace_id}`,
        ]);
        const cycleKey = `weekly:${utcWeekKey(now)}`;
        const inserted = await db.query(
          `INSERT INTO institutional_curator_cycles(id,workspace_id,cycle_key)
           VALUES($1,$2,$3) ON CONFLICT(workspace_id,cycle_key) DO NOTHING`,
          [randomUUID(), rollout.workspace_id, cycleKey],
        );
        if (!inserted.rowCount) return;
        const lifecycle = !config.live
          ? { staleItems: 0, archivedItems: 0, staleSkills: 0, archivedSkills: 0 }
          : await deterministicLifecycle(db, rollout.workspace_id, now, rollout.expire_after_days);
        await db.query(
          `UPDATE institutional_curator_cycles
           SET queued_jobs=0,stale_items=$3,archived_items=0,stale_skills=$4,
               archived_skills=0,completed_at=$2
           WHERE workspace_id=$1 AND cycle_key=$5`,
          [rollout.workspace_id, now, lifecycle.staleItems, lifecycle.staleSkills, cycleKey],
        );
      });
    } catch (error) {
      console.error(`[server] institutional curator Workspace cycle failed (${rollout.workspace_id}):`, error);
    }
  }
  return 0;
}
