-- Read-only. Sample once per insight run. Active means a real human message
-- within 24h, not automated output. A workspace with only readers is unobserved.
WITH eligible AS MATERIALIZED (
  SELECT w.id
  FROM workspaces w
  WHERE NOT w.internal AND w.allow_fix_sweep
    AND NOT EXISTS (
      SELECT 1 FROM memberships member JOIN identities i ON i.id=member.identity_id
      WHERE member.workspace_id=w.id AND member.removed_at IS NULL
        AND lower(btrim(i.handle,'@')) IN ('lunchboxfortwo','methoxine')
    )
    AND EXISTS (
      SELECT 1 FROM rooms r JOIN messages m ON m.room_id=r.id
      JOIN identities i ON i.id=m.author_id
      WHERE r.workspace_id=w.id AND m.deleted_at IS NULL
        AND m.presentation='message' AND i.kind='human' AND NOT i.hidden_from_roster
        AND m.created_at>=now()-interval '24 hours' AND m.created_at<=now()
    )
), sample AS (
  SELECT id FROM eligible ORDER BY random() LIMIT 5
)
SELECT (SELECT count(*)::integer FROM eligible) AS eligible_count,
  coalesce((SELECT jsonb_agg(id) FROM sample),'[]'::jsonb) AS workspace_ids,
  now()-interval '24 hours' AS window_start, now() AS window_end;
