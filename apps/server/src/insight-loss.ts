import type { SqlDatabase } from './database.js';
import { COHORT_SQL } from './operator-dashboard-cohort.js';

// Read-only, no embeddings/provider calls or persistent text copies. Character
// trigrams are computed only for adjacent human requests to the SAME agent.
// The caller supplies the verified deployment boundary; SQL also caps at 24h.
const LOSS_SQL = String.raw`WITH ${COHORT_SQL}, loss_workspaces AS (
  SELECT w.id FROM workspaces w JOIN production_workspaces p ON p.id=w.id WHERE w.allow_fix_sweep
), bounds AS (
  SELECT greatest($1::timestamptz, now()-interval '24 hours') AS since, now() AS through
), humans AS MATERIALIZED (
  SELECT m.id,m.room_id,m.author_id,m.created_at,m.text FROM messages m
  JOIN identities i ON i.id=m.author_id AND i.kind='human'
  JOIN production_identities pi ON pi.id=i.id
  JOIN rooms r ON r.id=m.room_id
  JOIN loss_workspaces w ON w.id=r.workspace_id
  CROSS JOIN bounds b
  WHERE m.deleted_at IS NULL AND m.presentation='message'
    AND m.created_at >= b.since-interval '15 minutes' AND m.created_at < b.through
), targets AS MATERIALIZED (
  SELECT DISTINCT h.id,h.room_id,h.author_id,h.created_at,h.text,c.agent_id,
    regexp_replace(lower(left(h.text,2000)), '[^[:alnum:] ]', '', 'g') AS normalized
  FROM humans h JOIN agent_commands c ON c.source_message_id=h.id AND c.room_id=h.room_id
    AND c.action='input' AND c.reason IN ('human_tag','direct_message')
), ordered_targets AS (
  SELECT t.*, lag(id) OVER prior AS previous_id, lag(created_at) OVER prior AS previous_at,
    lag(normalized) OVER prior AS previous_text
  FROM targets t WINDOW prior AS (PARTITION BY room_id,author_id,agent_id ORDER BY created_at,id)
), pairs AS (
  SELECT t.* FROM ordered_targets t CROSS JOIN bounds b
  WHERE t.created_at>=b.since AND t.previous_id IS NOT NULL
), similarity AS (
  SELECT p.*, shared.n::double precision / nullif(cardinality(a.grams)+cardinality(z.grams)-shared.n,0) AS similarity
  FROM pairs p
  CROSS JOIN LATERAL (SELECT array_agg(DISTINCT substring(p.normalized FROM n FOR 3)) AS grams
    FROM generate_series(1,length(p.normalized)-2) n) a
  CROSS JOIN LATERAL (SELECT array_agg(DISTINCT substring(p.previous_text FROM n FOR 3)) AS grams
    FROM generate_series(1,length(p.previous_text)-2) n) z
  CROSS JOIN LATERAL (SELECT count(*) AS n FROM unnest(a.grams) gram WHERE gram=ANY(z.grams)) shared
  WHERE length(p.normalized)>=12 AND length(p.previous_text)>=12
    AND p.created_at-p.previous_at<=interval '15 minutes'
), signals AS (
  SELECT h.room_id,h.id AS message_id,h.created_at AS observed_at,'frustration' AS signal,2 AS weight
  FROM humans h CROSS JOIN bounds b WHERE h.created_at>=b.since
    AND h.text ~* '(\m(still|again|why)\M|doesn[''’]?t work|not working|\mu there\M|\?\?)'
  UNION ALL
  SELECT room_id,id,created_at,'restatement',3 FROM similarity WHERE similarity>=0.7
  UNION ALL
  SELECT h.room_id,h.id,h.created_at,'silence_nudge',3 FROM humans h CROSS JOIN bounds b
  JOIN LATERAL (
    SELECT t.agent_id,t.created_at FROM targets t
    WHERE t.room_id=h.room_id AND t.author_id=h.author_id AND t.created_at<h.created_at
    ORDER BY t.created_at DESC,t.id DESC,t.agent_id LIMIT 1
  ) prior ON true
  WHERE h.created_at>=b.since AND h.created_at-prior.created_at>=interval '90 seconds'
    AND h.text ~* '(\m(still|again|hello|waiting|any update)\M|\mu there\M|\?\?)'
    AND NOT EXISTS (SELECT 1 FROM messages reply WHERE reply.room_id=h.room_id
      AND reply.author_id=prior.agent_id AND reply.presentation='message' AND reply.deleted_at IS NULL
      AND reply.created_at>prior.created_at AND reply.created_at<h.created_at)
  UNION ALL
  SELECT h.room_id,h.id,h.created_at,'failure_followup',3 FROM humans h CROSS JOIN bounds b
  WHERE h.created_at>=b.since AND EXISTS (
    SELECT 1 FROM messages failure WHERE failure.room_id=h.room_id
      AND failure.presentation IN ('system','card') AND failure.deleted_at IS NULL
      AND failure.created_at>=b.since AND failure.created_at<h.created_at
      AND failure.created_at>=h.created_at-interval '15 minutes'
      AND (failure.card_type='turn-failed' OR failure.text ~* '(could not answer|could not finish this request|is offline|helper is unreachable)')
      AND NOT EXISTS (SELECT 1 FROM messages reply JOIN identities agent ON agent.id=reply.author_id AND agent.kind='agent'
        WHERE reply.room_id=h.room_id AND reply.deleted_at IS NULL AND reply.presentation='message'
          AND reply.created_at>failure.created_at AND reply.created_at<h.created_at)
  )
  UNION ALL
  SELECT m.room_id,m.id,m.created_at,'human_stop',4 FROM messages m
  JOIN identities i ON i.id=m.author_id AND i.kind='human'
  JOIN production_identities pi ON pi.id=i.id
  JOIN rooms r ON r.id=m.room_id JOIN loss_workspaces w ON w.id=r.workspace_id CROSS JOIN bounds b
  WHERE m.deleted_at IS NULL AND m.system_event->>'kind'='turn-cancelled'
    AND m.created_at>=b.since AND m.created_at<b.through
  UNION ALL
  SELECT c.room_id,c.source_message_id,c.completed_at,'cancelled_command',2 FROM agent_commands c
  JOIN messages h ON h.id=c.source_message_id AND h.deleted_at IS NULL
  JOIN identities i ON i.id=h.author_id AND i.kind='human'
  JOIN production_identities pi ON pi.id=i.id
  JOIN rooms r ON r.id=c.room_id JOIN loss_workspaces w ON w.id=r.workspace_id CROSS JOIN bounds b
  WHERE c.state='cancelled' AND c.cancellation_reason='stop'
    AND c.completed_at>=b.since AND c.completed_at<b.through
  UNION ALL
  SELECT f.room_id,f.trigger_message_id,f.created_at,'human_report',4 FROM feedback_items f
  JOIN production_identities pi ON pi.id=f.reporter_identity_id
  JOIN rooms r ON r.id=f.room_id JOIN loss_workspaces w ON w.id=r.workspace_id CROSS JOIN bounds b
  WHERE f.source_kind='human' AND f.created_at>=b.since AND f.created_at<b.through
), ranked AS (
  SELECT room_id,sum(weight)::integer AS score, count(*)::integer AS signal_count,
    max(observed_at) AS last_observed_at
  FROM signals GROUP BY room_id ORDER BY score DESC,last_observed_at DESC,room_id LIMIT 10
)
SELECT ranked.room_id, r.workspace_id, ranked.score, ranked.signal_count,ranked.last_observed_at,
  (SELECT jsonb_agg(jsonb_build_object('kind',signal,'messageId',message_id,'observedAt',observed_at,'weight',weight)
      ORDER BY observed_at DESC,signal)
    FROM (SELECT * FROM signals WHERE room_id=ranked.room_id ORDER BY observed_at DESC,signal LIMIT 20) limited) AS signals,
  coalesce(context.messages,'[]'::jsonb) AS messages,
  b.since AS window_start,b.through AS window_end
FROM ranked JOIN rooms r ON r.id=ranked.room_id CROSS JOIN bounds b
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object('id',m.id,'authorKind',i.kind,'presentation',m.presentation,
    'text',left(m.text,500),'createdAt',m.created_at) ORDER BY m.created_at,m.id) AS messages
  FROM (SELECT * FROM messages m WHERE m.room_id=ranked.room_id AND m.deleted_at IS NULL
    AND m.created_at>=b.since AND m.created_at<=ranked.last_observed_at
    ORDER BY m.created_at DESC,m.id DESC LIMIT 12) m JOIN identities i ON i.id=m.author_id
) context ON true ORDER BY ranked.score DESC,ranked.last_observed_at DESC,ranked.room_id`;

export async function readInsightLoss(database: SqlDatabase, since: string, sourceSha: string) {
  const { rows } = await database.transaction(async tx => {
    await tx.query('SET TRANSACTION READ ONLY');
    await tx.query("SET LOCAL statement_timeout = '5s'");
    return tx.query(LOSS_SQL, [since]);
  });
  return { sourceSha, since, windowHours: 24, threads: rows };
}
