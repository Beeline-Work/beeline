\if :{?old_pubkey}
\else
  \echo 'usage: psql -v old_pubkey=<64-hex-pubkey> -f scripts/audit-agent-key-conflation.sql'
  \quit 2
\endif

\set ON_ERROR_STOP on

-- Read-only by construction. This distinguishes an agent record SIGNED by a
-- key from a human-authored soul overlay whose p tag merely TARGETS an agent.
WITH candidate AS (
  SELECT decode(:'old_pubkey', 'hex') AS pubkey
), facts AS (
  SELECT
    count(*) FILTER (
      WHERE e.kind = 0 AND e.pubkey = candidate.pubkey
    ) AS human_profiles,
    count(*) FILTER (
      WHERE e.kind = 9
        AND e.pubkey = candidate.pubkey
        AND e.tags @> jsonb_build_array(jsonb_build_array('t', 'buzz-agent'))
    ) AS self_signed_agent_markers,
    count(*) FILTER (
      WHERE e.kind = 30078
        AND e.pubkey = candidate.pubkey
        AND e.tags @> jsonb_build_array(jsonb_build_array('t', 'buzz-agent-soul'))
    ) AS souls_authored_by_human,
    count(*) FILTER (
      WHERE e.kind = 30078
        AND e.tags @> jsonb_build_array(jsonb_build_array('t', 'buzz-agent-soul'))
        AND e.tags @> jsonb_build_array(jsonb_build_array('p', :'old_pubkey'))
    ) AS souls_targeting_candidate
  FROM candidate
  LEFT JOIN events e
    ON e.deleted_at IS NULL
    AND (
      e.pubkey = candidate.pubkey
      OR e.tags @> jsonb_build_array(jsonb_build_array('p', :'old_pubkey'))
    )
  GROUP BY candidate.pubkey
)
SELECT *,
  CASE
    WHEN human_profiles > 0 AND self_signed_agent_markers > 0 THEN 'CONFLATED: repair precondition met'
    WHEN human_profiles > 0 THEN 'HUMAN_ONLY: do not migrate this key'
    WHEN self_signed_agent_markers > 0 THEN 'AGENT_ONLY: no human conflation'
    ELSE 'UNKNOWN: neither identity marker exists'
  END AS verdict
FROM facts;

-- A soul authored by the candidate is normal: the p tag is the agent identity.
-- Show those targets and whether each target owns a real self-signed agent marker.
WITH soul_targets AS (
  SELECT DISTINCT soul.community_id,
    soul.created_at AS soul_created_at,
    soul.tags,
    target.value AS target_pubkey
  FROM events soul
  CROSS JOIN LATERAL (
    SELECT tag->>1 AS value
    FROM jsonb_array_elements(soul.tags) AS tag
    WHERE tag->>0 = 'p'
    LIMIT 1
  ) target
  WHERE soul.deleted_at IS NULL
    AND soul.kind = 30078
    AND soul.pubkey = decode(:'old_pubkey', 'hex')
    AND soul.tags @> jsonb_build_array(jsonb_build_array('t', 'buzz-agent-soul'))
)
SELECT soul_targets.community_id, soul_targets.soul_created_at,
  soul_targets.target_pubkey,
  EXISTS (
    SELECT 1 FROM events marker
    WHERE marker.deleted_at IS NULL
      AND marker.kind = 9
      AND encode(marker.pubkey, 'hex') = soul_targets.target_pubkey
      AND marker.tags @> jsonb_build_array(jsonb_build_array('t', 'buzz-agent'))
  ) AS target_has_self_signed_agent_marker
FROM soul_targets
ORDER BY soul_created_at;
