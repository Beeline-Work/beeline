BEGIN READ ONLY;
SET LOCAL statement_timeout='20s';
SELECT now() snapshot_at;
SELECT CASE WHEN r.archived_at IS NULL THEN 'open' ELSE 'archived' END room_status,
       COALESCE(f.workflow_state,'<null>') state,COALESCE(f.workflow_outcome,'<null>') outcome,
       count(*) FROM rooms r JOIN corner_facts f ON f.corner_id=r.id GROUP BY 1,2,3 ORDER BY 1,2,3;
SELECT count(*) corners,count(*) FILTER(WHERE archived_at IS NULL) open FROM rooms WHERE parent_id IS NOT NULL;
SELECT r.id,r.created_at,r.archived_at,f.workflow_state,f.workflow_outcome,
 f.lifecycle->>'lifecycle' lifecycle,f.lifecycle->>'checks' checks,
 f.lifecycle->'pr' pr,f.lifecycle->'mergeRecovery' recovery,f.merge_attempt_head,
 p.repository_resolution,p.reviewer_agent_id IS NOT NULL reviewer_configured,
 cardinality(p.reviewer_fallback_ids) fallback_count,
 f.worker_agent_id IS NOT NULL worker_set,f.owner_agent_id IS NOT NULL owner_set,
 (SELECT count(*) FROM agent_commands c WHERE c.room_id=r.id AND c.state IN ('pending','claimed')) active_commands,
 (SELECT count(*) FROM agent_turns t WHERE t.room_id=r.id AND t.status='working') working_turns,
 (SELECT jsonb_build_object('reason',c.reason,'state',c.state,'action',c.action,'createdAt',c.created_at,'completedAt',c.completed_at)
  FROM agent_commands c WHERE c.room_id=r.id ORDER BY c.created_at DESC,c.id DESC LIMIT 1) last_command,
 (SELECT jsonb_build_object('state',m.card->>'toState','outcome',m.card->>'outcome','seq',m.card->>'seq','createdAt',m.created_at)
  FROM messages m WHERE m.room_id=r.id AND m.card_type='corner-workflow-handoff' AND m.card->>'runId'=r.id::text ORDER BY (m.card->>'seq')::int DESC LIMIT 1) last_card,
 (SELECT jsonb_build_object('currentHead',a.head_sha=f.lifecycle->'pr'->>'headSha','at',a.approved_at)
  FROM corner_merge_approvals a WHERE a.corner_id=r.id) approval,
 (SELECT count(*) FROM corner_merge_holds h WHERE h.corner_id=r.id AND h.released_at IS NULL) holds,
 (SELECT count(*) FROM corner_brief_revisions b WHERE b.corner_id=r.id) brief_revisions
FROM rooms r JOIN corner_facts f ON f.corner_id=r.id JOIN rooms p ON p.id=r.parent_id
WHERE r.archived_at IS NULL ORDER BY r.created_at;
SELECT count(*) projection_drift FROM corner_facts f JOIN LATERAL (
 SELECT card->>'toState' state,card->>'outcome' outcome FROM messages m
 WHERE m.room_id=f.corner_id AND m.card_type='corner-workflow-handoff' AND m.card->>'runId'=f.corner_id::text
 ORDER BY (m.card->>'seq')::int DESC LIMIT 1) c ON true
WHERE f.workflow_state IS DISTINCT FROM c.state OR f.workflow_outcome IS DISTINCT FROM c.outcome;
SELECT count(*) archived_active_commands FROM agent_commands c JOIN rooms r ON r.id=c.room_id
 WHERE r.parent_id IS NOT NULL AND r.archived_at IS NOT NULL AND c.state IN ('pending','claimed');
COMMIT;
