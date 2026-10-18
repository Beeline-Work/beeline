import type { SqlDatabase } from './database.js';

/** Reserve today's workspaces only after notice and its full waiting period. */
export async function reserveServiceReviewWorkspaces(database: SqlDatabase): Promise<string[]> {
  return database.transaction(async (db) => {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('beeline-service-review'))`);
    const result = await db.query<{ workspace_id: string }>(`
      WITH rollout AS (
        SELECT 1 FROM service_review_rollout
        WHERE id=1 AND notice_sent_at IS NOT NULL
          AND effective_at >= notice_sent_at + interval '14 days' AND effective_at <= now()
      ), candidates AS (
        SELECT w.id FROM workspaces w
        WHERE w.allow_fix_sweep=true AND EXISTS(SELECT 1 FROM rollout)
          AND NOT EXISTS(SELECT 1 FROM service_review_visits v
            WHERE v.workspace_id=w.id AND v.visited_at > now()-interval '14 days')
        ORDER BY (w.created_at > now()-interval '7 days') DESC,
          (SELECT count(*) FROM messages m JOIN rooms r ON r.id=m.room_id WHERE r.workspace_id=w.id
            AND m.created_at > now()-interval '7 days') DESC,w.created_at DESC,w.id
        LIMIT (SELECT greatest(0,5-count(*)) FROM service_review_visits
          WHERE visited_at >= date_trunc('day',now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')
      )
      INSERT INTO service_review_visits(workspace_id)
      SELECT id FROM candidates RETURNING workspace_id`);
    return result.rows.map((row) => row.workspace_id);
  });
}

/** Read a reserved workspace a page at a time, rechecking opt-out on every page. */
export async function readServiceReviewPage(database: SqlDatabase, workspaceId: string, after = '') {
  return database.query<{ id: string; room_id: string; text: string; activity: unknown }>(`
    WITH target_rooms AS (
      SELECT r.id FROM rooms r JOIN workspaces w ON w.id=r.workspace_id
      WHERE w.id=$1 AND w.allow_fix_sweep=true
        AND EXISTS(SELECT 1 FROM service_review_visits v WHERE v.workspace_id=w.id
          AND v.visited_at > now()-interval '1 day')
        AND EXISTS(SELECT 1 FROM service_review_rollout WHERE id=1
          AND effective_at<=now() AND effective_at>=notice_sent_at+interval '14 days')
    ), content AS (
      SELECT m.id,m.room_id,m.text,m.activity FROM messages m
      JOIN target_rooms r ON r.id=m.room_id WHERE m.deleted_at IS NULL
      UNION ALL
      SELECT concat('turn:',t.room_id,':',t.request_id,':',t.agent_id),t.room_id,
        coalesce(t.failure_reason,''),jsonb_build_object('status',t.status,'startedAt',t.started_at,'agentId',t.agent_id)
      FROM agent_turns t JOIN target_rooms r ON r.id=t.room_id
    ) SELECT * FROM content WHERE id>$2 ORDER BY id LIMIT 200`, [workspaceId, after]);
}
