import { ExpectedRefusalError } from './command-refusal.js';
import type { SqlDatabase } from './database.js';

/** These SQL reads are executable with the operator's read-only Neon route. */
export const SERVICE_REVIEW_READ_SCHEMA = `
CREATE OR REPLACE FUNCTION service_review_targets(review_agent text,review_run text)
RETURNS TABLE(workspace_id uuid) LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY SELECT v.workspace_id FROM service_review_visits v
    JOIN workspaces w ON w.id=v.workspace_id
    WHERE v.agent_id=review_agent AND v.run_id=review_run AND w.allow_fix_sweep=true AND NOT w.internal
      AND v.visited_at>now()-interval '1 day';
END $$;
CREATE OR REPLACE FUNCTION service_review_page(review_agent text,review_run text,review_workspace uuid,after_id text DEFAULT '')
RETURNS TABLE(id text,room_id uuid,text text,activity jsonb) LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY
    WITH target_rooms AS (
      SELECT r.id FROM rooms r JOIN workspaces w ON w.id=r.workspace_id
      WHERE w.id=review_workspace AND w.allow_fix_sweep=true AND NOT w.internal
        AND EXISTS(SELECT 1 FROM service_review_visits v WHERE v.workspace_id=w.id AND v.agent_id=review_agent AND v.run_id=review_run
          AND v.visited_at > now()-interval '1 day')
    ), content AS (
      SELECT m.id,m.room_id,m.text,
        (CASE WHEN jsonb_typeof(m.activity)='object' THEN m.activity
          ELSE jsonb_build_object('activity',m.activity) END)
          || jsonb_build_object('createdAt',m.created_at,'rowKind','message') activity FROM messages m
      JOIN target_rooms r ON r.id=m.room_id WHERE m.deleted_at IS NULL
        AND EXISTS(SELECT 1 FROM service_review_visits v WHERE v.workspace_id=review_workspace
          AND v.agent_id=review_agent AND v.run_id=review_run
          AND (m.created_at>coalesce(v.read_from,v.visited_at-interval '24 hours') AND m.created_at<=coalesce(v.read_through,v.visited_at)))
      UNION ALL
      SELECT concat('turn:',t.room_id,':',t.request_id,':',t.agent_id),t.room_id,
        coalesce(t.failure_reason,''),jsonb_build_object('status',t.status,'startedAt',t.started_at,'agentId',t.agent_id,'rowKind','turn')
      FROM agent_turns t JOIN target_rooms r ON r.id=t.room_id
      WHERE EXISTS(SELECT 1 FROM service_review_visits v WHERE v.workspace_id=review_workspace
        AND v.agent_id=review_agent AND v.run_id=review_run
        AND (t.started_at>coalesce(v.read_from,v.visited_at-interval '24 hours') AND t.started_at<=coalesce(v.read_through,v.visited_at)))
    ) SELECT content.id,content.room_id,content.text,content.activity FROM content WHERE content.id>after_id ORDER BY content.id LIMIT 200;
END $$;
`;

/** Reserve opted-in workspaces. */
export async function reserveServiceReviewWorkspaces(database: SqlDatabase, agentId: string, runId: string, daily = false): Promise<string[]> {
  return database.transaction(async (db) => {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('beeline-service-review'))`);
    if (daily) {
      const result = await db.query<{ workspace_id: string }>(`
        INSERT INTO service_review_visits(workspace_id,agent_id,run_id,read_from,read_through)
        SELECT w.id,$1,$2,
          bounds.read_from,now()
        FROM workspaces w CROSS JOIN LATERAL (
          SELECT coalesce((SELECT max(v.read_through) FROM service_review_visits v
            WHERE v.workspace_id=w.id AND v.completed_at IS NOT NULL),
            (SELECT min(v.read_from) FROM service_review_visits v WHERE v.workspace_id=w.id),now()-interval '24 hours') AS read_from
        ) bounds WHERE w.allow_fix_sweep=true AND NOT w.internal
          AND EXISTS(SELECT 1 FROM messages m JOIN rooms r ON r.id=m.room_id
            WHERE r.workspace_id=w.id AND m.deleted_at IS NULL
              AND m.created_at>bounds.read_from AND m.created_at<=now()
            UNION ALL
            SELECT 1 FROM agent_turns t JOIN rooms r ON r.id=t.room_id
            WHERE r.workspace_id=w.id AND t.started_at>bounds.read_from AND t.started_at<=now())
          AND NOT EXISTS(SELECT 1 FROM service_review_visits v WHERE v.workspace_id=w.id AND v.run_id=$2)
        RETURNING workspace_id`,[agentId,runId]);
      return result.rows.map(row => row.workspace_id);
    }
    const result = await db.query<{ workspace_id: string }>(`
      WITH candidates AS (
        SELECT w.id FROM workspaces w
        WHERE w.allow_fix_sweep=true AND NOT w.internal
          AND NOT EXISTS(SELECT 1 FROM service_review_visits v
            WHERE v.workspace_id=w.id AND v.visited_at > now()-interval '14 days')
        ORDER BY (w.created_at > now()-interval '7 days') DESC,
          (SELECT count(*) FROM messages m JOIN rooms r ON r.id=m.room_id WHERE r.workspace_id=w.id
            AND m.created_at > now()-interval '7 days') DESC,w.created_at DESC,w.id
        LIMIT (SELECT greatest(0,5-count(*)) FROM service_review_visits
          WHERE visited_at >= date_trunc('day',now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')
      )
      INSERT INTO service_review_visits(workspace_id,agent_id,run_id,read_from,read_through)
      SELECT id,$1,$2,coalesce((SELECT max(v.read_through) FROM service_review_visits v
        WHERE v.workspace_id=candidates.id AND v.completed_at IS NOT NULL),
        (SELECT min(v.read_from) FROM service_review_visits v WHERE v.workspace_id=candidates.id),now()-interval '24 hours'),now() FROM candidates RETURNING workspace_id`, [agentId,runId]);
    return result.rows.map((row) => row.workspace_id);
  });
}

/** Same SQL function used by the read-only Squire path. */
export async function readServiceReviewPage(database: SqlDatabase, agentId: string, runId: string, workspaceId: string, after = '') {
  return database.query<{ id: string; room_id: string; text: string; activity: unknown }>(
    'SELECT * FROM service_review_page($1,$2,$3,$4)', [agentId,runId,workspaceId,after]);
}

/** Validate against the same privacy-filtered pages the agent reads.
 * Completed visits are the durable per-workspace cursor: max(read_through).
 * The timestamp boundary covers messages and turns with equal timestamps together.
 * Failed runs retain their initial lower bound but never advance the cursor.
 * All receipts commit in the workflow's completion transaction.
 */
export async function completeServiceReview(database: SqlDatabase, agentId: string, runId: string, value: unknown): Promise<void> {
  if (!Array.isArray(value)) throw new ExpectedRefusalError('workspace receipts must be an array');
  await database.transaction(async (db) => {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('beeline-service-review'))`);
    const targets = await db.query<{workspace_id: string}>('SELECT * FROM service_review_targets($1,$2)',[agentId,runId]);
    if (value.length !== targets.rows.length) throw new ExpectedRefusalError('a receipt is required for every active workspace');
    for (const target of targets.rows) {
      const receipts = value.filter(row => row?.workspace === target.workspace_id);
      if (receipts.length !== 1) throw new ExpectedRefusalError('each workspace needs exactly one receipt');
      const receipt = receipts[0];
      let rowsRead = 0;
      let after = '';
      const times: string[] = [];
      for (;;) {
        const page = await readServiceReviewPage(db,agentId,runId,target.workspace_id,after);
        if (!page.rows.length) break;
        rowsRead += page.rows.length;
        for (const row of page.rows) {
          const activity = row.activity as { rowKind?: string; createdAt?: string };
          if (activity?.rowKind === 'message' && activity.createdAt) times.push(new Date(activity.createdAt).toISOString());
        }
        after = page.rows.at(-1)!.id;
      }
      times.sort();
      if (!rowsRead || receipt.rowsRead !== rowsRead || receipt.firstMessageTime !== (times[0] ?? null)
        || receipt.lastMessageTime !== (times.at(-1) ?? null) || typeof receipt.findings !== 'string')
        throw new ExpectedRefusalError('workspace receipt must match all rows and first/last message times');
      await db.query(`UPDATE service_review_visits SET receipt=$4::jsonb,completed_at=now()
        WHERE workspace_id=$1 AND agent_id=$2 AND run_id=$3`,[target.workspace_id,agentId,runId,JSON.stringify(receipt)]);
    }
  });
}
