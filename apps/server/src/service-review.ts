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
CREATE OR REPLACE FUNCTION service_review_content(review_agent text,review_run text,review_workspace uuid)
RETURNS TABLE(id text,room_id uuid,text text,activity jsonb) LANGUAGE sql STABLE AS $$
    WITH target_rooms AS (
      SELECT r.id FROM rooms r JOIN workspaces w ON w.id=r.workspace_id
      WHERE w.id=review_workspace AND w.allow_fix_sweep=true AND NOT w.internal
        AND EXISTS(SELECT 1 FROM service_review_visits v WHERE v.workspace_id=w.id AND v.agent_id=review_agent AND v.run_id=review_run
          AND v.visited_at > now()-interval '1 day')
    ), content AS (
      SELECT m.id,m.room_id,m.text,
        (CASE WHEN jsonb_typeof(m.activity)='object' THEN m.activity
          ELSE jsonb_build_object('activity',m.activity) END)
          || jsonb_build_object('createdAt',m.created_at,'rowKind','message',
            'authorId',i.id,'authorKind',i.kind,
            'ownerId',CASE WHEN i.kind='agent' THEN a.owner_id END) activity FROM messages m
      JOIN identities i ON i.id=m.author_id LEFT JOIN agents a ON a.agent_id=i.id
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
    ) SELECT content.id,content.room_id,content.text,content.activity FROM content;
$$;
CREATE OR REPLACE FUNCTION service_review_page(review_agent text,review_run text,review_workspace uuid,after_id text DEFAULT '')
RETURNS TABLE(id text,room_id uuid,text text,activity jsonb) LANGUAGE sql STABLE AS $$
  SELECT content.* FROM service_review_content(review_agent,review_run,review_workspace) content
  WHERE content.id>after_id ORDER BY content.id LIMIT 200;
$$;
`;

/** Reserve opted-in workspaces. */
export async function reserveServiceReviewWorkspaces(database: SqlDatabase, agentId: string, runId: string, windowDays: 1 | 14 = 1): Promise<string[]> {
  const result = await database.query<{ workspace_id: string }>(`
        INSERT INTO service_review_visits(workspace_id,agent_id,run_id,read_from,read_through)
        SELECT w.id,$1,$2,
          bounds.read_from,now()
        FROM workspaces w CROSS JOIN LATERAL (
          SELECT least(CASE WHEN $3::int=14 THEN now()-interval '14 days' END,
            coalesce((SELECT max(v.read_through) FROM service_review_visits v
            WHERE v.workspace_id=w.id AND v.completed_at IS NOT NULL),
            (SELECT min(v.read_from) FROM service_review_visits v WHERE v.workspace_id=w.id),now()-interval '24 hours')) AS read_from
        ) bounds WHERE w.allow_fix_sweep=true AND NOT w.internal
          AND EXISTS(SELECT 1 FROM messages m JOIN rooms r ON r.id=m.room_id
            WHERE r.workspace_id=w.id AND m.deleted_at IS NULL
              AND m.created_at>bounds.read_from AND m.created_at<=now()
            UNION ALL
            SELECT 1 FROM agent_turns t JOIN rooms r ON r.id=t.room_id
            WHERE r.workspace_id=w.id AND t.started_at>bounds.read_from AND t.started_at<=now())
        ON CONFLICT(workspace_id,run_id) DO NOTHING
        RETURNING workspace_id`,[agentId,runId,windowDays]);
  return result.rows.map(row => row.workspace_id);
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
  const result = (await database.query<{ refusal: string | null }>(`
    WITH targets AS MATERIALIZED (
      SELECT * FROM service_review_targets($1,$2)
    ), supplied AS MATERIALIZED (
      SELECT value submission FROM jsonb_array_elements($3::jsonb)
    ), expected AS MATERIALIZED (
      SELECT target.workspace_id,count(content.id)::int rows_read,
        to_char(min((content.activity->>'createdAt')::timestamptz)
          FILTER (WHERE content.activity->>'rowKind'='message') AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') first_time,
        to_char(max((content.activity->>'createdAt')::timestamptz)
          FILTER (WHERE content.activity->>'rowKind'='message') AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') last_time
      FROM targets target LEFT JOIN LATERAL service_review_content($1,$2,target.workspace_id) content ON true
      GROUP BY target.workspace_id
    ), verdict AS MATERIALIZED (
      SELECT CASE
        WHEN (SELECT count(*) FROM supplied)<>(SELECT count(*) FROM targets)
          THEN 'a receipt is required for every active workspace'
        WHEN EXISTS (SELECT 1 FROM targets target WHERE
          (SELECT count(*) FROM supplied WHERE submission->>'workspace'=target.workspace_id::text)<>1)
          THEN 'each workspace needs exactly one receipt'
        WHEN EXISTS (SELECT 1 FROM expected JOIN supplied ON submission->>'workspace'=workspace_id::text
          WHERE rows_read=0 OR submission->'rowsRead' IS DISTINCT FROM to_jsonb(rows_read)
            OR submission->'firstMessageTime' IS DISTINCT FROM COALESCE(to_jsonb(first_time),'null'::jsonb)
            OR submission->'lastMessageTime' IS DISTINCT FROM COALESCE(to_jsonb(last_time),'null'::jsonb)
            OR jsonb_typeof(submission->'findings') IS DISTINCT FROM 'string')
          THEN 'workspace receipt must match all rows and first/last message times'
        END refusal
    ), saved AS (
      UPDATE service_review_visits visit SET receipt=supplied.submission,completed_at=now()
      FROM supplied,targets,verdict WHERE visit.workspace_id=targets.workspace_id
        AND supplied.submission->>'workspace'=visit.workspace_id::text
        AND visit.agent_id=$1 AND visit.run_id=$2 AND verdict.refusal IS NULL
      RETURNING visit.workspace_id
    ) SELECT verdict.refusal,(SELECT count(*) FROM saved) saved FROM verdict`,
    [agentId,runId,JSON.stringify(value)])).rows[0]!;
  if (result.refusal) throw new ExpectedRefusalError(result.refusal);
}
