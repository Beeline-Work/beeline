import {
  ROOM_VIEW_MESSAGE_LIMIT,
  type RoomViewIdentity,
  type RoomViewMember,
} from '@beeline/buzz-client';

export const RAW_EVENT_LIMIT = 180;
export const HISTORY_EVENT_LIMIT = 180;
export const CHAT_PREVIEW_LIMIT = 12;
export const DURABLE_KINDS = [0, 9, 9000, 9001, 9002, 9007, 9008, 30078, 39000, 39001, 39002] as const;

export function profileFilter(identities: readonly RoomViewIdentity[]) {
  return identities.length
    ? [{ kinds: [0], authors: [...new Set(identities.map((item) => item.pubkey))] }]
    : [];
}

/**
 * Resolve the latest valid human soul for one declared agent.
 *
 * The author may be a predecessor key that is no longer a current Workspace
 * member, so display reads must not re-apply a current-membership check. The
 * relay enforced membership when it accepted the event; excluding declared
 * agent authors and requiring the full canonical address keeps forged or
 * unrelated kind:30078 records out of this overlay.
 */
function agentSoulLateralSql(
  identityAlias: string,
  workspaceIdSql: string,
  declarationAlias: string,
): string {
  const pubkeySql = `encode(${identityAlias}.pubkey, 'hex')`;
  return `LEFT JOIN LATERAL (
    SELECT e.content FROM events e
    WHERE ${declarationAlias}.content IS NOT NULL
      AND e.community_id = ${identityAlias}.community_id
      AND e.kind = 30078 AND e.deleted_at IS NULL
      AND pg_input_is_valid(e.content, 'jsonb')
      AND e.d_tag = ${workspaceIdSql} || ':' || ${pubkeySql}
      AND e.tags @> '[["t", "buzz-agent-soul"]]'::jsonb
      AND e.tags @> jsonb_build_array(jsonb_build_array('h', ${workspaceIdSql}))
      AND e.tags @> jsonb_build_array(jsonb_build_array('community', ${workspaceIdSql}))
      AND e.tags @> jsonb_build_array(jsonb_build_array('p', ${pubkeySql}))
      AND NOT EXISTS (
        SELECT 1 FROM events author_agent
        WHERE author_agent.community_id = e.community_id AND author_agent.pubkey = e.pubkey
          AND author_agent.kind = 9 AND author_agent.deleted_at IS NULL
          AND author_agent.tags @> '[["t", "buzz-agent"]]'::jsonb
          AND author_agent.tags @> jsonb_build_array(jsonb_build_array('h', ${workspaceIdSql}))
      )
    ORDER BY e.created_at DESC, e.id DESC LIMIT 1
  ) soul ON true`;
}

function agentSoulsCteSql(
  scopeRelation: string,
  scopeAlias: string,
  workspaceIdSql: string,
): string {
  return `agent_souls AS MATERIALIZED (
    SELECT DISTINCT ON (e.community_id, e.d_tag) e.community_id, e.d_tag, e.content
    FROM ${scopeRelation} ${scopeAlias}
    JOIN events e ON e.community_id = ${scopeAlias}.community_id
      AND e.kind = 30078 AND e.deleted_at IS NULL
    JOIN agent_declarations agent ON agent.community_id = e.community_id
      AND e.d_tag = ${workspaceIdSql} || ':' || encode(agent.pubkey, 'hex')
    WHERE pg_input_is_valid(e.content, 'jsonb')
      AND e.tags @> '[["t", "buzz-agent-soul"]]'::jsonb
      AND e.tags @> jsonb_build_array(jsonb_build_array('h', ${workspaceIdSql}))
      AND e.tags @> jsonb_build_array(jsonb_build_array('community', ${workspaceIdSql}))
      AND e.tags @> jsonb_build_array(jsonb_build_array('p', encode(agent.pubkey, 'hex')))
      AND NOT EXISTS (
        SELECT 1 FROM agent_declarations author_agent
        WHERE author_agent.community_id = e.community_id AND author_agent.pubkey = e.pubkey
      )
    ORDER BY e.community_id, e.d_tag, e.created_at DESC, e.id DESC
  )`;
}

function resolvedIdentityNameSql(
  alias: string,
  declarationColumn = 'agent_content',
  humanNameColumn = 'name',
): string {
  return `COALESCE(NULLIF(${alias}.soul_content::jsonb->>'name', ''), NULLIF(${alias}.${declarationColumn}::jsonb->>'displayName', ''), ${alias}.${humanNameColumn})`;
}

export function roomFilters(
  roomId: string,
  workspaceId: string,
  familyIds: readonly string[],
  members: readonly RoomViewMember[],
) {
  const h = [...new Set([workspaceId, roomId, ...familyIds])];
  return [
    { kinds: [...DURABLE_KINDS], '#h': h },
    ...profileFilter(members.map((member) => member.identity)),
    {
      kinds: [30078],
      '#d': [`agent-draft:${roomId}`, `agent-thought:${roomId}`, `agent-presence:${roomId}`],
    },
  ];
}

/**
 * Resolve only the current NIP-10 shapes accepted by Beeline's publishers.
 * A direct reply omits a redundant root marker, so its validated same-Room
 * parent is the root. A nested reply must carry an explicit root.
 */
function messageRootIdSql(eventAlias: string): string {
  const eventTags = `jsonb_array_elements(${eventAlias}.tags)`;
  return `CASE
    WHEN (SELECT count(*) FROM ${eventTags} tag WHERE tag->>0 = 'e') = 0
      THEN encode(${eventAlias}.id, 'hex')
    WHEN (SELECT count(*) FROM ${eventTags} tag WHERE tag->>0 = 'e') = 1
      AND (SELECT count(*) FROM ${eventTags} tag
        WHERE tag->>0 = 'e' AND tag->>3 = 'reply') = 1
      THEN (
        SELECT encode(parent.id, 'hex')
        FROM ${eventTags} reply_tag
        JOIN events parent ON parent.community_id = ${eventAlias}.community_id
          AND parent.channel_id = ${eventAlias}.channel_id
          AND parent.id = CASE WHEN reply_tag->>1 ~ '^[0-9a-f]{64}$'
            THEN decode(reply_tag->>1, 'hex') END
          AND parent.deleted_at IS NULL AND parent.kind = 9
        WHERE reply_tag->>0 = 'e' AND reply_tag->>3 = 'reply'
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(parent.tags) parent_tag
            WHERE parent_tag->>0 = 'e'
          )
        LIMIT 1
      )
    WHEN (SELECT count(*) FROM ${eventTags} tag WHERE tag->>0 = 'e') = 2
      AND (SELECT count(*) FROM ${eventTags} tag
        WHERE tag->>0 = 'e' AND tag->>3 = 'reply') = 1
      AND (SELECT count(*) FROM ${eventTags} tag
        WHERE tag->>0 = 'e' AND tag->>3 = 'root') = 1
      THEN (
        SELECT encode(thread_root.id, 'hex')
        FROM ${eventTags} root_tag
        JOIN events thread_root ON thread_root.community_id = ${eventAlias}.community_id
          AND thread_root.channel_id = ${eventAlias}.channel_id
          AND thread_root.id = CASE WHEN root_tag->>1 ~ '^[0-9a-f]{64}$'
            THEN decode(root_tag->>1, 'hex') END
          AND thread_root.deleted_at IS NULL AND thread_root.kind = 9
        JOIN LATERAL ${eventTags} reply_tag
          ON reply_tag->>0 = 'e' AND reply_tag->>3 = 'reply'
        JOIN events nested_parent ON nested_parent.community_id = ${eventAlias}.community_id
          AND nested_parent.channel_id = ${eventAlias}.channel_id
          AND nested_parent.id = CASE WHEN reply_tag->>1 ~ '^[0-9a-f]{64}$'
            THEN decode(reply_tag->>1, 'hex') END
          AND nested_parent.deleted_at IS NULL AND nested_parent.kind = 9
        WHERE root_tag->>0 = 'e' AND root_tag->>3 = 'root'
          AND nested_parent.id <> thread_root.id
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(thread_root.tags) root_marker
            WHERE root_marker->>0 = 'e'
          )
          AND EXISTS (
            WITH RECURSIVE ancestry(id, tags, path) AS (
              SELECT nested_parent.id, nested_parent.tags, ARRAY[nested_parent.id]
              UNION ALL
              SELECT ancestor.id, ancestor.tags, current.path || ancestor.id
              FROM ancestry current
              JOIN LATERAL (
                SELECT candidate->>1 AS event_id
                FROM jsonb_array_elements(current.tags) candidate
                WHERE candidate->>0 = 'e' AND candidate->>3 = 'reply'
                  AND candidate->>1 ~ '^[0-9a-f]{64}$'
              ) parent_link ON true
              JOIN events ancestor ON ancestor.community_id = ${eventAlias}.community_id
                AND ancestor.channel_id = ${eventAlias}.channel_id
                AND ancestor.id = decode(parent_link.event_id, 'hex')
                AND ancestor.deleted_at IS NULL AND ancestor.kind = 9
              WHERE current.id <> thread_root.id
                AND NOT ancestor.id = ANY(current.path)
                AND (
                  ((SELECT count(*) FROM jsonb_array_elements(current.tags) tag
                    WHERE tag->>0 = 'e') = 1
                    AND parent_link.event_id = encode(thread_root.id, 'hex'))
                  OR
                  ((SELECT count(*) FROM jsonb_array_elements(current.tags) tag
                    WHERE tag->>0 = 'e') = 2
                    AND parent_link.event_id <> encode(thread_root.id, 'hex')
                    AND (SELECT count(*) FROM jsonb_array_elements(current.tags) tag
                      WHERE tag->>0 = 'e' AND tag->>3 = 'root'
                        AND tag->>1 = encode(thread_root.id, 'hex')) = 1)
                )
            )
            SELECT 1 FROM ancestry candidate WHERE candidate.id = thread_root.id
          )
        LIMIT 1
      )
    ELSE NULL
  END`;
}

/** Legacy model diagnostics are machine records, never indexed conversation rows. */
function withoutModelAvailabilityNoticeSql(eventAlias: string): string {
  return `NOT (${eventAlias}.tags @> '[["t", "buzz-agent-model-unavailable"]]'::jsonb)`;
}

export const ROOM_SQL = `
WITH candidates AS (
  SELECT c.community_id, c.id, c.name, c.description, c.visibility, c.created_at, c.updated_at,
    c.archived_at, cm.role::text AS viewer_role, encode(cm.pubkey, 'hex') AS viewer_pubkey,
    COALESCE((SELECT tag->>1 FROM jsonb_array_elements(g.tags) tag
      WHERE tag->>0 = 'community' LIMIT 1), c.id::text) AS workspace_id,
    (SELECT tag->>1 FROM jsonb_array_elements(g.tags) tag
      WHERE tag->>0 = 'parent' LIMIT 1) AS parent_id,
    (SELECT tag->>1 FROM jsonb_array_elements(g.tags) tag
      WHERE tag->>0 IN ('avatar', 'picture') LIMIT 1) AS avatar
  FROM channels c
  JOIN channel_members cm ON cm.community_id = c.community_id AND cm.channel_id = c.id
    AND cm.pubkey = decode($2, 'hex') AND cm.removed_at IS NULL
  LEFT JOIN LATERAL (
    SELECT e.tags FROM events e
    WHERE e.community_id = c.community_id AND e.channel_id = c.id
      AND e.kind = 9007 AND e.deleted_at IS NULL
    ORDER BY e.created_at ASC, e.id ASC LIMIT 1
  ) g ON true
  WHERE c.id = $1::uuid AND c.deleted_at IS NULL
), authorized AS (
  SELECT * FROM candidates WHERE (SELECT count(*) FROM candidates) = 1
), page AS (
  SELECT e.* FROM authorized a
  JOIN LATERAL (
    SELECT e.* FROM events e
    WHERE e.community_id = a.community_id AND e.channel_id = a.id
      AND e.deleted_at IS NULL AND e.kind = 9
      AND ${withoutModelAvailabilityNoticeSql('e')}
      AND ($3::bigint IS NULL OR extract(epoch FROM e.created_at)::bigint < $3
        OR (extract(epoch FROM e.created_at)::bigint = $3 AND encode(e.id, 'hex') > $4))
    ORDER BY e.created_at DESC, e.id ASC LIMIT $5
  ) e ON true
), identity_keys AS (
  SELECT cm.community_id, cm.pubkey, a.workspace_id FROM authorized a
  JOIN channel_members cm ON cm.community_id = a.community_id AND cm.channel_id = a.id
    AND cm.removed_at IS NULL
  UNION
  SELECT e.community_id, e.pubkey, a.workspace_id FROM page e JOIN authorized a ON true
), agent_declarations AS MATERIALIZED (
  SELECT DISTINCT ON (e.community_id, e.pubkey) e.community_id, e.pubkey, e.content
  FROM authorized a JOIN events e ON e.community_id = a.community_id
    AND e.kind = 9 AND e.deleted_at IS NULL
  WHERE e.tags @> '[["t", "buzz-agent"]]'::jsonb
    AND e.tags @> jsonb_build_array(jsonb_build_array('h', a.workspace_id))
  ORDER BY e.community_id, e.pubkey, e.created_at DESC, e.id DESC
), ${agentSoulsCteSql('authorized', 'a', 'a.workspace_id')}, identities AS (
  SELECT k.community_id, k.pubkey,
    NULLIF(u.display_name, '') AS name, u.nip05_handle AS handle, u.avatar_url AS avatar,
    agent.content AS agent_content, soul.content AS soul_content
  FROM identity_keys k
  LEFT JOIN users u ON u.community_id = k.community_id AND u.pubkey = k.pubkey
    AND u.deactivated_at IS NULL
  LEFT JOIN agent_declarations agent ON agent.community_id = k.community_id
    AND agent.pubkey = k.pubkey
  LEFT JOIN agent_souls soul ON soul.community_id = k.community_id
    AND soul.d_tag = k.workspace_id || ':' || encode(k.pubkey, 'hex')
)
SELECT 'room' AS section, jsonb_build_object(
  'id', a.id, 'workspaceId', a.workspace_id, 'parentId', a.parent_id,
  'name', a.name, 'about', a.description, 'avatar', a.avatar, 'visibility', a.visibility,
  'archived', a.archived_at IS NOT NULL,
  'createdAt', extract(epoch FROM a.created_at)::bigint,
  'updatedAt', extract(epoch FROM a.updated_at)::bigint,
  'viewerRole', a.viewer_role, 'viewerPubkey', a.viewer_pubkey
) AS data FROM authorized a
UNION ALL
SELECT 'member', jsonb_build_object(
  'pubkey', encode(cm.pubkey, 'hex'), 'role', cm.role::text,
  'name', ${resolvedIdentityNameSql('resolved')},
  'handle', resolved.handle, 'avatar', COALESCE(resolved.agent_content::jsonb->>'avatar', resolved.avatar),
  'agent', resolved.agent_content IS NOT NULL
) FROM authorized a
JOIN channel_members cm ON cm.community_id = a.community_id AND cm.channel_id = a.id
  AND cm.removed_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM events service
    WHERE service.community_id = cm.community_id AND service.pubkey = cm.pubkey
      AND service.kind = 9 AND service.deleted_at IS NULL
      AND service.tags @> '[["service", "beeline-events"]]'::jsonb
  )
JOIN identities resolved ON resolved.community_id = cm.community_id AND resolved.pubkey = cm.pubkey
UNION ALL
SELECT 'event', jsonb_build_object(
  'id', encode(e.id, 'hex'), 'pubkey', encode(e.pubkey, 'hex'),
  'createdAt', extract(epoch FROM e.created_at)::bigint,
  'tags', e.tags, 'content', e.content,
  'rootId', ${messageRootIdSql('e')},
  'name', ${resolvedIdentityNameSql('resolved')},
  'handle', resolved.handle, 'avatar', COALESCE(resolved.agent_content::jsonb->>'avatar', resolved.avatar),
  'agent', resolved.agent_content IS NOT NULL
) FROM page e
JOIN identities resolved ON resolved.community_id = e.community_id AND resolved.pubkey = e.pubkey;
`;

export const WORKSPACE_LIST_SQL = `
WITH accessible AS (
  SELECT c.community_id, c.id, c.name, c.updated_at, c.visibility::text,
    cm.role::text AS viewer_role,
    COALESCE(
      (SELECT NULLIF(tag->>1, '') FROM jsonb_array_elements(metadata.tags) tag
        WHERE tag->>0 IN ('avatar', 'picture') LIMIT 1),
      (SELECT NULLIF(replace(tag->>1, 'buzz-workspace-avatar:', ''), '')
        FROM jsonb_array_elements(metadata.tags) tag
        WHERE tag->>0 = 'purpose' AND tag->>1 LIKE 'buzz-workspace-avatar:%' LIMIT 1),
      CASE WHEN metadata.tags IS NULL THEN
        (SELECT NULLIF(tag->>1, '') FROM jsonb_array_elements(g.tags) tag
          WHERE tag->>0 IN ('avatar', 'picture') LIMIT 1)
      END
    ) AS avatar
  FROM channels c
  JOIN channel_members cm ON cm.community_id = c.community_id AND cm.channel_id = c.id
    AND cm.pubkey = decode($1, 'hex') AND cm.removed_at IS NULL
  JOIN LATERAL (
    SELECT e.tags FROM events e WHERE e.community_id = c.community_id
      AND e.channel_id = c.id AND e.kind = 9007 AND e.deleted_at IS NULL
    ORDER BY e.created_at ASC, e.id ASC LIMIT 1
  ) g ON EXISTS (SELECT 1 FROM jsonb_array_elements(g.tags) t
    WHERE t->>0 = 'community' AND t->>1 = c.id::text)
  LEFT JOIN LATERAL (
    SELECT e.tags FROM events e WHERE e.community_id = c.community_id
      AND e.channel_id = c.id AND e.kind = 39000 AND e.deleted_at IS NULL
      AND (e.d_tag = c.id::text OR EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
        WHERE t->>0 IN ('d', 'h') AND t->>1 = c.id::text))
    ORDER BY e.created_at DESC, e.id DESC LIMIT 1
  ) metadata ON true
  WHERE c.deleted_at IS NULL
)
SELECT 'viewer' AS section, jsonb_build_object(
  'pubkey', $1, 'name', NULLIF(u.display_name, ''), 'handle', u.nip05_handle,
  'avatar', u.avatar_url, 'agent', false
) AS data
FROM (SELECT community_id FROM accessible ORDER BY updated_at DESC LIMIT 1) a
LEFT JOIN users u ON u.community_id = a.community_id AND u.pubkey = decode($1, 'hex')
UNION ALL
SELECT 'workspace', jsonb_build_object(
  'id', a.id, 'name', a.name, 'avatar', a.avatar,
  'visibility', a.visibility, 'role', a.viewer_role,
  'updatedAt', extract(epoch FROM a.updated_at)::bigint
) FROM (SELECT * FROM accessible ORDER BY updated_at DESC, id ASC LIMIT $2) a;
`;

export const WORKSPACE_SQL = `
WITH candidates AS (
  SELECT c.community_id, c.id, c.name, c.description, c.visibility::text,
    c.created_at, c.updated_at, cm.role::text AS viewer_role,
    encode(cm.pubkey, 'hex') AS viewer_pubkey,
    COALESCE(
      (SELECT NULLIF(tag->>1, '') FROM jsonb_array_elements(metadata.tags) tag
        WHERE tag->>0 IN ('avatar', 'picture') LIMIT 1),
      (SELECT NULLIF(replace(tag->>1, 'buzz-workspace-avatar:', ''), '')
        FROM jsonb_array_elements(metadata.tags) tag
        WHERE tag->>0 = 'purpose' AND tag->>1 LIKE 'buzz-workspace-avatar:%' LIMIT 1),
      CASE WHEN metadata.tags IS NULL THEN
        (SELECT NULLIF(tag->>1, '') FROM jsonb_array_elements(g.tags) tag
          WHERE tag->>0 IN ('avatar', 'picture') LIMIT 1)
      END
    ) AS avatar
  FROM channels c
  JOIN channel_members cm ON cm.community_id = c.community_id AND cm.channel_id = c.id
    AND cm.pubkey = decode($2, 'hex') AND cm.removed_at IS NULL
  JOIN LATERAL (
    SELECT e.tags FROM events e WHERE e.community_id = c.community_id
      AND e.channel_id = c.id AND e.kind = 9007 AND e.deleted_at IS NULL
    ORDER BY e.created_at ASC, e.id ASC LIMIT 1
  ) g ON EXISTS (SELECT 1 FROM jsonb_array_elements(g.tags) t
    WHERE t->>0 = 'community' AND t->>1 = c.id::text)
  LEFT JOIN LATERAL (
    SELECT e.tags FROM events e WHERE e.community_id = c.community_id
      AND e.channel_id = c.id AND e.kind = 39000 AND e.deleted_at IS NULL
      AND (e.d_tag = c.id::text OR EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
        WHERE t->>0 IN ('d', 'h') AND t->>1 = c.id::text))
    ORDER BY e.created_at DESC, e.id DESC LIMIT 1
  ) metadata ON true
  WHERE c.id = $1::uuid AND c.deleted_at IS NULL
), authorized AS (
  SELECT * FROM candidates WHERE (SELECT count(*) FROM candidates) = 1
), agent_declarations AS MATERIALIZED (
  SELECT DISTINCT ON (e.community_id, e.pubkey) e.community_id, e.pubkey, e.content
  FROM authorized a JOIN events e ON e.community_id = a.community_id
    AND e.kind = 9 AND e.deleted_at IS NULL
  WHERE e.tags @> '[["t", "buzz-agent"]]'::jsonb
    AND e.tags @> jsonb_build_array(jsonb_build_array('h', a.id::text))
  ORDER BY e.community_id, e.pubkey, e.created_at DESC, e.id DESC
), ${agentSoulsCteSql('authorized', 'a', 'a.id::text')}, roster_resolved AS (
  SELECT a.community_id, a.id AS workspace_id, cm.pubkey, cm.role::text,
    NULLIF(u.display_name, '') AS human_name, u.nip05_handle, u.avatar_url,
    agent.content AS agent_content, soul.content AS soul_content,
    presence.status AS presence_status, presence.observed_at, presence.room_id
  FROM authorized a
  JOIN channel_members cm ON cm.community_id = a.community_id AND cm.channel_id = a.id
    AND cm.removed_at IS NULL
  LEFT JOIN users u ON u.community_id = cm.community_id AND u.pubkey = cm.pubkey
    AND u.deactivated_at IS NULL
  LEFT JOIN agent_declarations agent ON agent.community_id = cm.community_id
    AND agent.pubkey = cm.pubkey
  LEFT JOIN agent_souls soul ON soul.community_id = cm.community_id
    AND soul.d_tag = a.id::text || ':' || encode(cm.pubkey, 'hex')
  LEFT JOIN LATERAL (
    SELECT (SELECT t->>1 FROM jsonb_array_elements(e.tags) t WHERE t->>0 = 'status' LIMIT 1) AS status,
      extract(epoch FROM e.created_at)::bigint AS observed_at,
      (SELECT t->>1 FROM jsonb_array_elements(e.tags) t WHERE t->>0 = 'h' LIMIT 1) AS room_id
    FROM events e
    WHERE agent.content IS NOT NULL AND e.community_id = a.community_id AND e.pubkey = cm.pubkey
      AND e.kind = 30078 AND e.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
        WHERE t->>0 = 't' AND t->>1 = 'agent-presence')
      AND EXISTS (SELECT 1 FROM channels room
        JOIN channel_members member ON member.community_id = room.community_id
          AND member.channel_id = room.id AND member.pubkey = cm.pubkey AND member.removed_at IS NULL
        JOIN LATERAL (SELECT g.tags FROM events g WHERE g.community_id = room.community_id
          AND g.channel_id = room.id AND g.kind = 9007 AND g.deleted_at IS NULL
          ORDER BY g.created_at ASC, g.id ASC LIMIT 1) generation ON true
        WHERE room.community_id = a.community_id AND room.deleted_at IS NULL
          AND room.id::text = (SELECT t->>1 FROM jsonb_array_elements(e.tags) t WHERE t->>0 = 'h' LIMIT 1)
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(generation.tags) t
            WHERE t->>0 = 'community' AND t->>1 = a.id::text))
    ORDER BY e.created_at DESC, e.id DESC LIMIT 1
  ) presence ON true
), roster AS (
  SELECT r.*,
    row_number() OVER (PARTITION BY (r.agent_content IS NOT NULL) ORDER BY encode(r.pubkey, 'hex')) AS ordinal,
    count(*) OVER (PARTITION BY (r.agent_content IS NOT NULL)) AS kind_total
  FROM roster_resolved r
)
SELECT 'workspace' AS section, jsonb_build_object(
  'id', a.id, 'name', a.name, 'about', a.description, 'avatar', a.avatar,
  'visibility', a.visibility, 'role', a.viewer_role,
  'createdAt', extract(epoch FROM a.created_at)::bigint,
  'updatedAt', extract(epoch FROM a.updated_at)::bigint,
  'viewerPubkey', a.viewer_pubkey
) AS data FROM authorized a
UNION ALL
SELECT 'member', jsonb_build_object(
  'pubkey', encode(r.pubkey, 'hex'), 'role', r.role,
  'name', ${resolvedIdentityNameSql('r', 'agent_content', 'human_name')},
  'handle', r.nip05_handle, 'avatar', COALESCE(r.soul_content::jsonb->>'avatar',
    r.agent_content::jsonb->>'avatar', r.avatar_url),
  'agent', r.agent_content IS NOT NULL,
  'presenceStatus', r.presence_status, 'presenceObservedAt', r.observed_at,
  'presenceRoomId', r.room_id, 'kindTotal', r.kind_total
) FROM roster r
WHERE (r.agent_content IS NULL AND r.ordinal <= $3)
   OR (r.agent_content IS NOT NULL AND r.ordinal <= $4);
`;

export const CHAT_LIST_SQL = `
WITH workspace_candidates AS (
  SELECT c.community_id, c.id, c.name, c.updated_at, c.visibility::text,
    cm.role::text AS viewer_role,
    COALESCE(
      (SELECT NULLIF(tag->>1, '') FROM jsonb_array_elements(metadata.tags) tag
        WHERE tag->>0 IN ('avatar', 'picture') LIMIT 1),
      (SELECT NULLIF(replace(tag->>1, 'buzz-workspace-avatar:', ''), '')
        FROM jsonb_array_elements(metadata.tags) tag
        WHERE tag->>0 = 'purpose' AND tag->>1 LIKE 'buzz-workspace-avatar:%' LIMIT 1),
      CASE WHEN metadata.tags IS NULL THEN
        (SELECT NULLIF(tag->>1, '') FROM jsonb_array_elements(g.tags) tag
          WHERE tag->>0 IN ('avatar', 'picture') LIMIT 1)
      END
    ) AS avatar
  FROM channels c
  JOIN channel_members cm ON cm.community_id = c.community_id AND cm.channel_id = c.id
    AND cm.pubkey = decode($2, 'hex') AND cm.removed_at IS NULL
  JOIN LATERAL (
    SELECT e.tags FROM events e WHERE e.community_id = c.community_id
      AND e.channel_id = c.id AND e.kind = 9007 AND e.deleted_at IS NULL
    ORDER BY e.created_at ASC, e.id ASC LIMIT 1
  ) g ON EXISTS (SELECT 1 FROM jsonb_array_elements(g.tags) t
    WHERE t->>0 = 'community' AND t->>1 = c.id::text)
  LEFT JOIN LATERAL (
    SELECT e.tags FROM events e WHERE e.community_id = c.community_id
      AND e.channel_id = c.id AND e.kind = 39000 AND e.deleted_at IS NULL
      AND (e.d_tag = c.id::text OR EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
        WHERE t->>0 IN ('d', 'h') AND t->>1 = c.id::text))
    ORDER BY e.created_at DESC, e.id DESC LIMIT 1
  ) metadata ON true
  WHERE c.id = $1::uuid AND c.deleted_at IS NULL
), workspace AS (
  SELECT * FROM workspace_candidates WHERE (SELECT count(*) FROM workspace_candidates) = 1
), chats AS (
  SELECT c.*, g.tags,
    (SELECT tag->>1 FROM jsonb_array_elements(g.tags) tag
      WHERE tag->>0 IN ('avatar', 'picture') LIMIT 1) AS avatar
  FROM workspace w
  JOIN channels c ON c.community_id = w.community_id AND c.id <> w.id
    AND c.deleted_at IS NULL
  JOIN channel_members cm ON cm.community_id = c.community_id AND cm.channel_id = c.id
    AND cm.pubkey = decode($2, 'hex') AND cm.removed_at IS NULL
  JOIN LATERAL (
    SELECT e.tags FROM events e WHERE e.community_id = c.community_id
      AND e.channel_id = c.id AND e.kind = 9007 AND e.deleted_at IS NULL
    ORDER BY e.created_at ASC, e.id ASC LIMIT 1
  ) g ON EXISTS (SELECT 1 FROM jsonb_array_elements(g.tags) t
      WHERE t->>0 = 'community' AND t->>1 = w.id::text)
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(g.tags) t WHERE t->>0 = 'parent')
  ORDER BY c.updated_at DESC, c.id ASC LIMIT $3
), preview_ranked AS (
  SELECT a.id AS room_id, e.*,
    row_number() OVER (PARTITION BY e.community_id, e.channel_id
      ORDER BY e.created_at DESC, e.id ASC) AS ordinal
  FROM chats a JOIN events e ON e.community_id = a.community_id AND e.channel_id = a.id
    AND e.deleted_at IS NULL AND e.kind = 9
  -- Rank conversation messages, not every kind:9 machine record. Otherwise
  -- a burst of agent-turn/activity receipts can exhaust the bounded preview
  -- window and also move the unread cursor beyond the last real message.
  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) marker
      WHERE marker->>0 = 't' AND COALESCE(marker->>1, '') <> ''
        AND marker->>1 NOT IN (
          'agent-message', 'buzz-agent-exchange', 'buzz-agent-delegation', 'buzz-agent-request', 'buzz-attachment'
        ))
    AND (
      btrim(e.content) <> ''
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) marker
        WHERE marker->>0 = 't' AND marker->>1 = 'buzz-attachment')
    )
), preview_events AS (
  SELECT * FROM preview_ranked WHERE ordinal <= $4
), latest_events AS (
  SELECT * FROM preview_ranked WHERE ordinal = 1
), member_counts AS (
  SELECT a.community_id, a.id AS room_id, count(*)::bigint AS member_count
  FROM chats a JOIN channel_members cm ON cm.community_id = a.community_id
    AND cm.channel_id = a.id AND cm.removed_at IS NULL
  GROUP BY a.community_id, a.id
), corner_children AS (
  SELECT child.community_id, child.id AS corner_id, child.created_by, child.archived_at,
    (SELECT t->>1 FROM jsonb_array_elements(generation.tags) t
      WHERE t->>0 = 'parent' LIMIT 1) AS parent_id
  FROM workspace w JOIN channels child ON child.community_id = w.community_id
    AND child.id <> w.id AND child.deleted_at IS NULL
  JOIN channel_members child_viewer ON child_viewer.community_id = child.community_id
    AND child_viewer.channel_id = child.id AND child_viewer.pubkey = decode($2, 'hex')
    AND child_viewer.removed_at IS NULL
  JOIN LATERAL (
    SELECT e.tags FROM events e WHERE e.community_id = child.community_id
      AND e.channel_id = child.id AND e.kind = 9007 AND e.deleted_at IS NULL
    ORDER BY e.created_at ASC, e.id ASC LIMIT 1
  ) generation ON EXISTS (SELECT 1 FROM jsonb_array_elements(generation.tags) t
    WHERE t->>0 = 'parent')
), corner_counts AS (
  -- Same non-terminal rule the deck applies before pinning or expanding a
  -- corner (isCornerTerminalState, room-indicators.ts): a corner that has
  -- concluded (landed), closed, or been archived is done work, not an open
  -- count. A room whose corners are all terminal gets no row here at all,
  -- so COALESCE(corners.corner_count, 0) below reads 0.
  SELECT parent.community_id, parent.id AS room_id, count(*)::bigint AS corner_count
  FROM chats parent JOIN corner_children cs ON cs.community_id = parent.community_id
    AND cs.parent_id = parent.id::text
  WHERE cs.archived_at IS NULL
  GROUP BY parent.community_id, parent.id
), repositories AS (
  SELECT DISTINCT ON (e.community_id, a.id)
    e.community_id, a.id AS room_id, e.content
  FROM chats a JOIN events e ON e.community_id = a.community_id
    AND e.d_tag = 'buzz-room-repository:' || a.id::text
    AND e.kind = 30078 AND e.deleted_at IS NULL
  JOIN channel_members author ON author.community_id = e.community_id
    AND author.channel_id = a.id AND author.pubkey = e.pubkey
    AND author.removed_at IS NULL AND author.role IN ('owner', 'admin')
  WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
    WHERE t->>0 = 't' AND t->>1 = 'buzz-room-repository')
  ORDER BY e.community_id, a.id, e.created_at DESC, e.id DESC
), identity_keys AS (
  SELECT DISTINCT e.community_id, e.pubkey, w.id::text AS workspace_id
  FROM preview_events e JOIN workspace w ON true
), agent_declarations AS MATERIALIZED (
  SELECT DISTINCT ON (e.community_id, e.pubkey) e.community_id, e.pubkey, e.content
  FROM workspace w JOIN events e ON e.community_id = w.community_id
    AND e.kind = 9 AND e.deleted_at IS NULL
  WHERE e.tags @> '[["t", "buzz-agent"]]'::jsonb
    AND e.tags @> jsonb_build_array(jsonb_build_array('h', w.id::text))
  ORDER BY e.community_id, e.pubkey, e.created_at DESC, e.id DESC
), room_turn_latest AS (
  -- Newest durable agent-turn receipt per (room, agent), mirroring
  -- ROOM_PAINT_SQL's latest_agent_turns so the deck's own room-turn
  -- signal agrees with the single Room view's.
  SELECT DISTINCT ON (e.channel_id, e.pubkey)
    e.community_id, e.channel_id AS room_id,
    (SELECT t->>1 FROM jsonb_array_elements(e.tags) t
      WHERE t->>0 = 'status' AND t->>1 IN ('working', 'complete', 'failed') LIMIT 1) AS status
  FROM chats a
  JOIN events e ON e.community_id = a.community_id AND e.channel_id = a.id
    AND e.kind = 9 AND e.deleted_at IS NULL
  JOIN channel_members member ON member.community_id = e.community_id
    AND member.channel_id = e.channel_id AND member.pubkey = e.pubkey
    AND member.removed_at IS NULL
  JOIN agent_declarations agent ON agent.community_id = e.community_id
    AND agent.pubkey = e.pubkey
  WHERE e.tags @> '[["t", "agent-turn"]]'::jsonb
    AND e.tags @> jsonb_build_array(jsonb_build_array('h', a.id::text))
    AND e.tags @> jsonb_build_array(jsonb_build_array('agent', encode(e.pubkey, 'hex')))
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
      WHERE t->>0 = 'request' AND t->>1 ~ '^[0-9a-f]{64}$')
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
      WHERE t->>0 = 'status' AND t->>1 IN ('working', 'complete', 'failed'))
  ORDER BY e.channel_id, e.pubkey, e.created_at DESC, e.id DESC
), room_turns AS (
  SELECT community_id, room_id, bool_or(status = 'working') AS working
  FROM room_turn_latest
  GROUP BY community_id, room_id
), ${agentSoulsCteSql('workspace', 'w', 'w.id::text')}, identities AS (
  SELECT k.community_id, k.pubkey,
    NULLIF(u.display_name, '') AS name, u.nip05_handle AS handle, u.avatar_url AS avatar,
    agent.content AS agent_content, soul.content AS soul_content
  FROM identity_keys k
  LEFT JOIN users u ON u.community_id = k.community_id AND u.pubkey = k.pubkey
    AND u.deactivated_at IS NULL
  LEFT JOIN agent_declarations agent ON agent.community_id = k.community_id
    AND agent.pubkey = k.pubkey
  LEFT JOIN agent_souls soul ON soul.community_id = k.community_id
    AND soul.d_tag = k.workspace_id || ':' || encode(k.pubkey, 'hex')
)
SELECT 'workspace' AS section, jsonb_build_object(
  'id', w.id, 'name', w.name, 'avatar', w.avatar,
  'visibility', w.visibility, 'role', w.viewer_role,
  'updatedAt', extract(epoch FROM w.updated_at)::bigint
) AS data FROM workspace w
UNION ALL
SELECT 'viewer', jsonb_build_object(
  'pubkey', $2, 'name', NULLIF(u.display_name, ''), 'handle', u.nip05_handle,
  'avatar', u.avatar_url, 'agent', false
) FROM workspace w
LEFT JOIN users u ON u.community_id = w.community_id AND u.pubkey = decode($2, 'hex')
UNION ALL
SELECT 'chat', jsonb_build_object(
  'id', a.id, 'workspaceId', $1, 'name', a.name, 'about', a.description,
  'avatar', a.avatar, 'visibility', a.visibility, 'archived', a.archived_at IS NOT NULL,
  'createdAt', extract(epoch FROM a.created_at)::bigint,
  'updatedAt', extract(epoch FROM a.updated_at)::bigint,
  'memberCount', COALESCE(members.member_count, 0),
  'cornerCount', COALESCE(corners.corner_count, 0),
  'unread', latest.id IS NOT NULL AND (
    mark.message_created_at IS NULL
    OR latest.created_at > mark.message_created_at
    OR (latest.created_at = mark.message_created_at AND latest.id < mark.message_id)
  ),
  'repositoryName', repo.content::jsonb->>'name',
  -- Max-severity rollup of the room's own conversational turn and every
  -- corner's current state: a corner waiting on a human outranks a working
  -- turn, and either outranks quiet. NULL means idle.
  'agentState', CASE
    WHEN COALESCE(turns.working, false) THEN 'working'
    ELSE NULL
  END
) FROM chats a
LEFT JOIN member_counts members ON members.community_id = a.community_id AND members.room_id = a.id
LEFT JOIN corner_counts corners ON corners.community_id = a.community_id AND corners.room_id = a.id
LEFT JOIN room_turns turns ON turns.community_id = a.community_id AND turns.room_id = a.id
LEFT JOIN repositories repo ON repo.community_id = a.community_id AND repo.room_id = a.id
LEFT JOIN latest_events latest ON latest.community_id = a.community_id AND latest.room_id = a.id
LEFT JOIN beeline_room_read_marks mark ON mark.community_id = a.community_id
  AND mark.room_id = a.id AND mark.viewer_pubkey = decode($2, 'hex')
UNION ALL
SELECT 'corner-watch', jsonb_build_object('id', cs.corner_id, 'parentId', cs.parent_id)
FROM corner_children cs
JOIN chats parent ON parent.community_id = cs.community_id AND parent.id::text = cs.parent_id
UNION ALL
SELECT 'preview', jsonb_build_object(
  'roomId', e.room_id, 'id', encode(e.id, 'hex'), 'pubkey', encode(e.pubkey, 'hex'),
  'createdAt', extract(epoch FROM e.created_at)::bigint,
  'tags', e.tags, 'content', e.content,
  'name', ${resolvedIdentityNameSql('resolved')},
  'handle', resolved.handle,
  'avatar', COALESCE(resolved.agent_content::jsonb->>'avatar', resolved.avatar),
  'agent', resolved.agent_content IS NOT NULL
) FROM preview_events e
JOIN identities resolved ON resolved.community_id = e.community_id AND resolved.pubkey = e.pubkey;
`;

export const AGENT_DETAIL_SQL = `
WITH authorized AS (
  SELECT c.community_id, c.id
  FROM channels c
  JOIN channel_members viewer ON viewer.community_id = c.community_id AND viewer.channel_id = c.id
    AND viewer.pubkey = decode($3, 'hex') AND viewer.removed_at IS NULL
  WHERE c.id = $1::uuid AND c.deleted_at IS NULL
), selected AS (
  SELECT a.community_id, a.id AS workspace_id, cm.role::text,
    encode(cm.pubkey, 'hex') AS pubkey, declaration.content, soul.content AS soul_content,
    NULLIF(u.display_name, '') AS human_name, u.nip05_handle, u.avatar_url
  FROM authorized a
  JOIN channel_members cm ON cm.community_id = a.community_id AND cm.channel_id = a.id
    AND cm.pubkey = decode($2, 'hex') AND cm.removed_at IS NULL
  LEFT JOIN users u ON u.community_id = cm.community_id AND u.pubkey = cm.pubkey
    AND u.deactivated_at IS NULL
  JOIN LATERAL (
    SELECT e.content FROM events e
    WHERE e.community_id = a.community_id AND e.pubkey = cm.pubkey AND e.kind = 9
      AND e.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
        WHERE t->>0 = 't' AND t->>1 = 'buzz-agent')
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) h
        WHERE h->>0 = 'h' AND h->>1 = a.id::text)
    ORDER BY e.created_at DESC, e.id DESC LIMIT 1
  ) declaration ON true
  ${agentSoulLateralSql('cm', 'a.id::text', 'declaration')}
), catalog AS (
  SELECT e.content FROM selected s JOIN LATERAL (
    SELECT e.content FROM events e
    WHERE e.community_id = s.community_id AND e.pubkey = decode(s.pubkey, 'hex')
      AND e.kind = 30078 AND e.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
        WHERE t->>0 = 't' AND t->>1 = 'buzz-agent-model-catalog')
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) d
        WHERE d->>0 = 'd' AND d->>1 = s.workspace_id::text || ':' || s.pubkey)
    ORDER BY e.created_at DESC, e.id DESC LIMIT 1
  ) e ON true
), config AS (
  SELECT e.content FROM selected s JOIN LATERAL (
    SELECT e.content FROM events e
    JOIN channel_members author ON author.community_id = e.community_id
      AND author.channel_id = s.workspace_id AND author.pubkey = e.pubkey
      AND author.removed_at IS NULL
    WHERE e.community_id = s.community_id AND e.kind = 30078 AND e.deleted_at IS NULL
      AND pg_input_is_valid(e.content, 'jsonb')
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
        WHERE t->>0 = 't' AND t->>1 = 'buzz-agent-model-config')
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) d
        WHERE d->>0 = 'd' AND d->>1 = s.workspace_id::text || ':' || s.pubkey)
    ORDER BY e.created_at DESC, e.id DESC LIMIT 1
  ) e ON true
)
SELECT 'agent' AS section, jsonb_build_object(
  'workspaceId', s.workspace_id, 'pubkey', s.pubkey, 'role', s.role,
  'name', ${resolvedIdentityNameSql('s', 'content', 'human_name')},
  'handle', s.nip05_handle, 'avatar', COALESCE(s.soul_content::jsonb->>'avatar',
    s.content::jsonb->>'avatar', s.avatar_url),
  'agent', true
) AS data FROM selected s
UNION ALL SELECT 'catalog', jsonb_build_object('content', c.content) FROM catalog c
UNION ALL SELECT 'config', jsonb_build_object('content', c.content) FROM config c
UNION ALL SELECT 'soul', jsonb_build_object('content', s.soul_content) FROM selected s;
`;

export const INVITE_SQL = `
WITH current_records AS (
  SELECT DISTINCT ON (e.community_id, e.pubkey) e.community_id, e.pubkey,
    e.created_at, e.tags
  FROM events e
  WHERE e.deleted_at IS NULL AND e.kind = 30078
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
      WHERE t->>0 = 'd' AND t->>1 = $1)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
      WHERE t->>0 = 't' AND t->>1 = 'buzz-community-invite')
  ORDER BY e.community_id, e.pubkey, e.created_at DESC, e.id DESC
), valid AS (
  SELECT r.*,
    (SELECT t->>1 FROM jsonb_array_elements(r.tags) t WHERE t->>0 = 'h' LIMIT 1) AS workspace_id,
    (SELECT t->>1 FROM jsonb_array_elements(r.tags) t WHERE t->>0 = 'expiration' LIMIT 1) AS expires_at
  FROM current_records r
  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.tags) t
    WHERE t->>0 = 'revoked' AND t->>1 = 'true')
), candidates AS (
  SELECT w.id, w.name, v.expires_at,
    COALESCE(
      (SELECT NULLIF(t->>1, '') FROM jsonb_array_elements(metadata.tags) t
        WHERE t->>0 IN ('avatar', 'picture') LIMIT 1),
      (SELECT NULLIF(replace(t->>1, 'buzz-workspace-avatar:', ''), '')
        FROM jsonb_array_elements(metadata.tags) t
        WHERE t->>0 = 'purpose' AND t->>1 LIKE 'buzz-workspace-avatar:%' LIMIT 1),
      CASE WHEN metadata.tags IS NULL THEN
        (SELECT NULLIF(t->>1, '') FROM jsonb_array_elements(g.tags) t
          WHERE t->>0 IN ('avatar', 'picture') LIMIT 1)
      END
    ) AS avatar
  FROM valid v
  JOIN channels w ON w.community_id = v.community_id
    AND w.id = CASE WHEN v.workspace_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN v.workspace_id::uuid ELSE NULL END
    AND w.deleted_at IS NULL AND w.archived_at IS NULL
  JOIN channel_members minter ON minter.community_id = w.community_id
    AND minter.channel_id = w.id AND minter.pubkey = v.pubkey AND minter.removed_at IS NULL
  JOIN LATERAL (
    SELECT e.tags FROM events e WHERE e.community_id = w.community_id
      AND e.channel_id = w.id AND e.kind = 9007 AND e.deleted_at IS NULL
    ORDER BY e.created_at ASC, e.id ASC LIMIT 1
  ) g ON EXISTS (SELECT 1 FROM jsonb_array_elements(g.tags) t
    WHERE t->>0 = 'community' AND t->>1 = w.id::text)
  LEFT JOIN LATERAL (
    SELECT e.tags FROM events e WHERE e.community_id = w.community_id
      AND e.channel_id = w.id AND e.kind = 39000 AND e.deleted_at IS NULL
      AND (e.d_tag = w.id::text OR EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
        WHERE t->>0 IN ('d', 'h') AND t->>1 = w.id::text))
    ORDER BY e.created_at DESC, e.id DESC LIMIT 1
  ) metadata ON true
  WHERE v.expires_at ~ '^[0-9]+$'
    AND CASE WHEN v.expires_at ~ '^[0-9]+$' THEN v.expires_at::numeric END
      > extract(epoch FROM now())::bigint
)
SELECT 'invite' AS section, jsonb_build_object(
  'workspaceId', c.id, 'name', c.name, 'avatar', c.avatar,
  'expiresAt', c.expires_at::bigint
) AS data FROM candidates c WHERE (SELECT count(*) FROM candidates) = 1;
`;

export const AGENT_PAIRING_CLAIM_SQL = `
WITH current_markers AS (
  SELECT DISTINCT ON (e.community_id, e.pubkey) e.community_id, e.pubkey,
    e.created_at, e.tags
  FROM events e
  WHERE e.deleted_at IS NULL AND e.kind = 30078
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
      WHERE t->>0 = 'd' AND t->>1 = $1)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
      WHERE t->>0 = 't' AND t->>1 = 'buzz-agent-pairing')
  ORDER BY e.community_id, e.pubkey, e.created_at DESC, e.id DESC
), candidates AS (
  SELECT marker.community_id, workspace.id AS workspace_id,
    marker.pubkey AS minter_pubkey
  FROM current_markers marker
  JOIN channels workspace ON workspace.community_id = marker.community_id
    AND workspace.id = CASE
      WHEN (SELECT t->>1 FROM jsonb_array_elements(marker.tags) t
        WHERE t->>0 = 'h' LIMIT 1)
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN (SELECT t->>1 FROM jsonb_array_elements(marker.tags) t
        WHERE t->>0 = 'h' LIMIT 1)::uuid
      ELSE NULL
    END
    AND workspace.deleted_at IS NULL AND workspace.archived_at IS NULL
  JOIN channel_members minter ON minter.community_id = workspace.community_id
    AND minter.channel_id = workspace.id AND minter.pubkey = marker.pubkey
    AND minter.removed_at IS NULL
  JOIN LATERAL (
    SELECT e.tags FROM events e
    WHERE e.community_id = workspace.community_id AND e.channel_id = workspace.id
      AND e.kind = 9007 AND e.deleted_at IS NULL
    ORDER BY e.created_at ASC, e.id ASC LIMIT 1
  ) genesis ON EXISTS (SELECT 1 FROM jsonb_array_elements(genesis.tags) t
    WHERE t->>0 = 'community' AND t->>1 = workspace.id::text)
  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(marker.tags) t
      WHERE t->>0 = 'revoked' AND t->>1 = 'true')
    AND (SELECT t->>1 FROM jsonb_array_elements(marker.tags) t
      WHERE t->>0 = 'expiration' LIMIT 1) ~ '^[0-9]+$'
    AND (SELECT t->>1 FROM jsonb_array_elements(marker.tags) t
      WHERE t->>0 = 'expiration' LIMIT 1)::numeric > extract(epoch FROM now())::bigint
), candidate AS (
  SELECT * FROM candidates WHERE (SELECT count(*) FROM candidates) = 1
), existing_claim AS (
  SELECT claim.* FROM beeline_agent_pairing_claims claim WHERE claim.token_hash = $1
), disqualifying_agent AS (
  SELECT 1 FROM events e JOIN candidate c ON c.community_id = e.community_id
  WHERE e.deleted_at IS NULL AND e.kind = 9 AND e.pubkey = decode($2, 'hex')
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
      WHERE t->>0 = 't' AND t->>1 = 'buzz-agent')
  LIMIT 1
), prior_redemption AS (
  SELECT 1 FROM events e JOIN candidate c ON c.community_id = e.community_id
  WHERE e.deleted_at IS NULL AND e.kind = 9
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
      WHERE t->>0 = 'pairing' AND t->>1 = $1)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
      WHERE t->>0 = 't' AND t->>1 = 'buzz-agent')
  LIMIT 1
), existing_member AS (
  SELECT 1 FROM channel_members member JOIN candidate c
    ON c.community_id = member.community_id AND c.workspace_id = member.channel_id
  WHERE member.pubkey = decode($2, 'hex') AND member.removed_at IS NULL
  LIMIT 1
), inserted_claim AS (
  INSERT INTO beeline_agent_pairing_claims (
    token_hash, community_id, workspace_id, minter_pubkey, agent_pubkey
  )
  SELECT $1, c.community_id, c.workspace_id, c.minter_pubkey, decode($2, 'hex')
  FROM candidate c
  WHERE NOT EXISTS (SELECT 1 FROM existing_claim)
    AND NOT EXISTS (SELECT 1 FROM disqualifying_agent)
    AND NOT EXISTS (SELECT 1 FROM prior_redemption)
    AND NOT EXISTS (SELECT 1 FROM existing_member)
  ON CONFLICT (token_hash) DO NOTHING
  RETURNING community_id, workspace_id, minter_pubkey, agent_pubkey
), accepted_claim AS (
  SELECT inserted.*, true AS joined FROM inserted_claim inserted
  UNION ALL
  SELECT claim.community_id, claim.workspace_id, claim.minter_pubkey,
    claim.agent_pubkey, false AS joined
  FROM existing_claim claim JOIN candidate c
    ON c.community_id = claim.community_id
    AND c.workspace_id = claim.workspace_id
    AND c.minter_pubkey = claim.minter_pubkey
  WHERE claim.agent_pubkey = decode($2, 'hex')
    AND NOT EXISTS (SELECT 1 FROM disqualifying_agent)
    AND NOT EXISTS (SELECT 1 FROM prior_redemption)
), membership AS (
  INSERT INTO channel_members (
    community_id, channel_id, pubkey, role, invited_by, joined_at,
    removed_at, removed_by, hidden_at
  )
  SELECT claim.community_id, claim.workspace_id, claim.agent_pubkey,
    'member', claim.minter_pubkey, now(), NULL, NULL, NULL
  FROM accepted_claim claim
  ON CONFLICT (community_id, channel_id, pubkey) DO UPDATE SET
    role = 'member', invited_by = EXCLUDED.invited_by, joined_at = now(),
    removed_at = NULL, removed_by = NULL, hidden_at = NULL
  RETURNING community_id, channel_id, pubkey
)
SELECT claim.workspace_id, encode(claim.minter_pubkey, 'hex') AS paired_by,
  claim.joined
FROM accepted_claim claim JOIN membership member
  ON member.community_id = claim.community_id
  AND member.channel_id = claim.workspace_id
  AND member.pubkey = claim.agent_pubkey;
`;

export const CORNER_LIST_SQL = `
WITH candidates AS (
  SELECT c.community_id, c.id, c.name, c.description, c.visibility, c.created_at, c.updated_at,
    c.archived_at, cm.role::text AS viewer_role, encode(cm.pubkey, 'hex') AS viewer_pubkey,
    COALESCE((SELECT tag->>1 FROM jsonb_array_elements(g.tags) tag
      WHERE tag->>0 = 'community' LIMIT 1), c.id::text) AS workspace_id,
    (SELECT tag->>1 FROM jsonb_array_elements(g.tags) tag
      WHERE tag->>0 IN ('avatar', 'picture') LIMIT 1) AS avatar
  FROM channels c
  JOIN channel_members cm ON cm.community_id = c.community_id AND cm.channel_id = c.id
    AND cm.pubkey = decode($2, 'hex') AND cm.removed_at IS NULL
  LEFT JOIN LATERAL (
    SELECT e.tags FROM events e WHERE e.community_id = c.community_id AND e.channel_id = c.id
      AND e.kind = 9007 AND e.deleted_at IS NULL
    ORDER BY e.created_at ASC, e.id ASC LIMIT 1
  ) g ON true
  WHERE c.id = $1::uuid AND c.deleted_at IS NULL
), authorized AS (
  SELECT * FROM candidates WHERE (SELECT count(*) FROM candidates) = 1
), corners AS (
  SELECT child.*, g.tags,
    (SELECT tag->>1 FROM jsonb_array_elements(g.tags) tag WHERE tag->>0 = 'task' LIMIT 1) AS task
  FROM authorized a
  JOIN channels child ON child.community_id = a.community_id AND child.deleted_at IS NULL
  JOIN channel_members viewer ON viewer.community_id = child.community_id
    AND viewer.channel_id = child.id AND viewer.pubkey = decode($2, 'hex')
    AND viewer.removed_at IS NULL
  JOIN LATERAL (
    SELECT e.tags FROM events e WHERE e.community_id = child.community_id
      AND e.channel_id = child.id AND e.kind = 9007 AND e.deleted_at IS NULL
    ORDER BY e.created_at ASC, e.id ASC LIMIT 1
  ) g ON EXISTS (SELECT 1 FROM jsonb_array_elements(g.tags) t
    WHERE t->>0 = 'parent' AND t->>1 = a.id::text)
), preview_ranked AS (
  SELECT c.id AS room_id, e.*,
    row_number() OVER (PARTITION BY e.community_id, e.channel_id
      ORDER BY e.created_at DESC, e.id ASC) AS ordinal
  FROM corners c JOIN events e ON e.community_id = c.community_id AND e.channel_id = c.id
    AND e.deleted_at IS NULL AND e.kind = 9
), previews AS (
  SELECT * FROM preview_ranked WHERE ordinal <= $3
), identity_keys AS (
  SELECT c.community_id, c.created_by AS pubkey, a.workspace_id
  FROM corners c JOIN authorized a ON true
  UNION
  SELECT e.community_id, e.pubkey, a.workspace_id
  FROM previews e JOIN authorized a ON true
), agent_declarations AS MATERIALIZED (
  SELECT DISTINCT ON (e.community_id, e.pubkey) e.community_id, e.pubkey, e.content
  FROM authorized a JOIN events e ON e.community_id = a.community_id
    AND e.kind = 9 AND e.deleted_at IS NULL
  WHERE e.tags @> '[["t", "buzz-agent"]]'::jsonb
    AND e.tags @> jsonb_build_array(jsonb_build_array('h', a.workspace_id))
  ORDER BY e.community_id, e.pubkey, e.created_at DESC, e.id DESC
), ${agentSoulsCteSql('authorized', 'a', 'a.workspace_id')}, identities AS (
  SELECT k.community_id, k.pubkey,
    NULLIF(u.display_name, '') AS name, u.nip05_handle AS handle, u.avatar_url AS avatar,
    agent.content AS agent_content, soul.content AS soul_content
  FROM identity_keys k
  LEFT JOIN users u ON u.community_id = k.community_id AND u.pubkey = k.pubkey
    AND u.deactivated_at IS NULL
  LEFT JOIN agent_declarations agent ON agent.community_id = k.community_id
    AND agent.pubkey = k.pubkey
  LEFT JOIN agent_souls soul ON soul.community_id = k.community_id
    AND soul.d_tag = k.workspace_id || ':' || encode(k.pubkey, 'hex')
)
SELECT 'room' AS section, jsonb_build_object(
  'id', a.id, 'workspaceId', a.workspace_id, 'name', a.name, 'about', a.description,
  'avatar', a.avatar, 'visibility', a.visibility, 'archived', a.archived_at IS NOT NULL,
  'createdAt', extract(epoch FROM a.created_at)::bigint,
  'updatedAt', extract(epoch FROM a.updated_at)::bigint,
  'viewerRole', a.viewer_role, 'viewerPubkey', a.viewer_pubkey
) AS data FROM authorized a
UNION ALL
SELECT 'corner', jsonb_build_object(
  'id', c.id, 'workspaceId', a.workspace_id, 'parentId', a.id,
  'name', c.name, 'about', COALESCE(c.description, c.task), 'visibility', c.visibility,
  'archived', c.archived_at IS NOT NULL,
  'createdAt', extract(epoch FROM c.created_at)::bigint,
  'updatedAt', extract(epoch FROM c.updated_at)::bigint,
  'agentPubkey', encode(c.created_by, 'hex'),
  'agentName', ${resolvedIdentityNameSql('resolved')},
  'agentHandle', resolved.handle,
  'agentAvatar', COALESCE(resolved.agent_content::jsonb->>'avatar', resolved.avatar),
  'agent', resolved.agent_content IS NOT NULL
) FROM corners c JOIN authorized a ON true
JOIN identities resolved ON resolved.community_id = c.community_id AND resolved.pubkey = c.created_by
UNION ALL
SELECT 'preview', jsonb_build_object(
  'roomId', e.room_id, 'id', encode(e.id, 'hex'), 'pubkey', encode(e.pubkey, 'hex'),
  'createdAt', extract(epoch FROM e.created_at)::bigint,
  'tags', e.tags, 'content', e.content,
  'name', ${resolvedIdentityNameSql('resolved')},
  'handle', resolved.handle,
  'avatar', COALESCE(resolved.agent_content::jsonb->>'avatar', resolved.avatar),
  'agent', resolved.agent_content IS NOT NULL
) FROM previews e
JOIN identities resolved ON resolved.community_id = e.community_id AND resolved.pubkey = e.pubkey;
`;

export const ROOM_PAINT_SQL = `
WITH candidates AS (
  SELECT c.community_id, c.id, c.name, c.description, c.visibility, c.created_at, c.updated_at,
    c.archived_at, cm.role::text AS viewer_role, encode(cm.pubkey, 'hex') AS viewer_pubkey,
    p.id AS parent_id, p.name AS parent_name, p.description AS parent_description,
    p.visibility AS parent_visibility,
    p.created_at AS parent_created_at, p.updated_at AS parent_updated_at,
    p.archived_at AS parent_archived_at, g.tags,
    COALESCE((SELECT tag->>1 FROM jsonb_array_elements(g.tags) tag
      WHERE tag->>0 = 'community' LIMIT 1), p.id::text) AS workspace_id,
    (SELECT tag->>1 FROM jsonb_array_elements(g.tags) tag
      WHERE tag->>0 IN ('avatar', 'picture') LIMIT 1) AS avatar,
    (SELECT tag->>1 FROM jsonb_array_elements(g.tags) tag
      WHERE tag->>0 = 'task' LIMIT 1) AS task
  FROM channels c
  JOIN channel_members cm ON cm.community_id = c.community_id AND cm.channel_id = c.id
    AND cm.pubkey = decode($2, 'hex') AND cm.removed_at IS NULL
  JOIN LATERAL (
    SELECT e.tags FROM events e WHERE e.community_id = c.community_id AND e.channel_id = c.id
      AND e.kind = 9007 AND e.deleted_at IS NULL
    ORDER BY e.created_at ASC, e.id ASC LIMIT 1
  ) g ON true
  LEFT JOIN LATERAL (
    SELECT t->>1 AS parent_id FROM jsonb_array_elements(g.tags) t
    WHERE t->>0 = 'parent' LIMIT 1
  ) link ON true
  LEFT JOIN channels p ON p.community_id = c.community_id
    AND p.id = CASE WHEN link.parent_id ~* '^[0-9a-f-]{36}$' THEN link.parent_id::uuid ELSE NULL END
    AND p.deleted_at IS NULL
  LEFT JOIN channel_members pm ON pm.community_id = p.community_id AND pm.channel_id = p.id
    AND pm.pubkey = decode($2, 'hex') AND pm.removed_at IS NULL
  WHERE c.id = $1::uuid AND c.deleted_at IS NULL
    AND (link.parent_id IS NULL OR (p.id IS NOT NULL AND pm.pubkey IS NOT NULL))
), authorized AS (
  SELECT * FROM candidates WHERE (SELECT count(*) FROM candidates) = 1
), raw_page AS (
  SELECT e.* FROM authorized a JOIN LATERAL (
    SELECT e.* FROM events e WHERE e.community_id = a.community_id AND e.channel_id = a.id
      AND e.deleted_at IS NULL AND e.kind = 9
      AND ${withoutModelAvailabilityNoticeSql('e')}
    ORDER BY e.created_at DESC, e.id ASC LIMIT $3
  ) e ON true
), conversation_page AS (
  -- Conversation has its own bounded lane. A long first turn can publish
  -- enough activity receipts to exhaust raw_page before someone opens the
  -- corner; those machine records must never erase the durable reply from the
  -- cold Room response.
  SELECT e.* FROM authorized a JOIN LATERAL (
    SELECT e.* FROM events e WHERE e.community_id = a.community_id AND e.channel_id = a.id
      AND e.deleted_at IS NULL AND e.kind = 9
      AND ${withoutModelAvailabilityNoticeSql('e')}
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) marker
        WHERE marker->>0 = 't' AND COALESCE(marker->>1, '') <> ''
          AND marker->>1 NOT IN (
            'agent-message', 'buzz-agent-exchange', 'buzz-agent-delegation', 'buzz-agent-request', 'buzz-attachment'
          ))
      AND (
        btrim(e.content) <> ''
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) marker
          WHERE marker->>0 = 't' AND marker->>1 = 'buzz-attachment')
      )
    ORDER BY e.created_at DESC, e.id ASC LIMIT ${ROOM_VIEW_MESSAGE_LIMIT}
  ) e ON true
), page AS (
  SELECT raw.* FROM raw_page raw
  UNION ALL
  SELECT conversation.* FROM conversation_page conversation
  WHERE NOT EXISTS (SELECT 1 FROM raw_page raw WHERE raw.id = conversation.id)
), newest_message AS (
  SELECT e.community_id, e.channel_id, e.created_at, e.id FROM page e
  ORDER BY e.created_at DESC, e.id ASC LIMIT 1
), briefing AS (
  SELECT e.* FROM authorized a JOIN LATERAL (
    SELECT e.* FROM events e WHERE e.community_id = a.community_id AND e.channel_id = a.parent_id
      AND e.deleted_at IS NULL AND e.kind = 9 AND e.created_at <= a.created_at
    ORDER BY e.created_at DESC, e.id ASC LIMIT $4
  ) e ON true
), family AS (
  SELECT child.*, generation.tags
  FROM authorized a
  JOIN channels child ON child.community_id = a.community_id AND child.deleted_at IS NULL
  JOIN channel_members viewer ON viewer.community_id = child.community_id
    AND viewer.channel_id = child.id AND viewer.pubkey = decode($2, 'hex')
    AND viewer.removed_at IS NULL
  JOIN LATERAL (
    SELECT e.tags FROM events e WHERE e.community_id = child.community_id
      AND e.channel_id = child.id AND e.kind = 9007 AND e.deleted_at IS NULL
    ORDER BY e.created_at ASC, e.id ASC LIMIT 1
  ) generation ON EXISTS (SELECT 1 FROM jsonb_array_elements(generation.tags) t
    WHERE t->>0 = 'parent' AND t->>1 = COALESCE(a.parent_id, a.id)::text)
), identity_keys AS (
  SELECT cm.community_id, cm.pubkey, a.workspace_id FROM authorized a
  JOIN channel_members cm ON cm.community_id = a.community_id AND cm.channel_id = a.id
    AND cm.removed_at IS NULL
  UNION
  SELECT e.community_id, e.pubkey, a.workspace_id FROM page e JOIN authorized a ON true
  UNION
  SELECT e.community_id, e.pubkey, a.workspace_id FROM briefing e JOIN authorized a ON true
  UNION
  SELECT f.community_id, f.created_by, a.workspace_id FROM family f JOIN authorized a ON true
), agent_declarations AS MATERIALIZED (
  SELECT DISTINCT ON (e.community_id, e.pubkey) e.community_id, e.pubkey, e.content
  FROM authorized a JOIN events e ON e.community_id = a.community_id
    AND e.kind = 9 AND e.deleted_at IS NULL
  WHERE e.tags @> '[["t", "buzz-agent"]]'::jsonb
    AND e.tags @> jsonb_build_array(jsonb_build_array('h', a.workspace_id))
  ORDER BY e.community_id, e.pubkey, e.created_at DESC, e.id DESC
), latest_agent_turns AS MATERIALIZED (
  SELECT DISTINCT ON (e.pubkey)
    e.pubkey, e.created_at, e.tags
  FROM authorized a
  JOIN events e ON e.community_id = a.community_id AND e.channel_id = a.id
    AND e.kind = 9 AND e.deleted_at IS NULL
  JOIN channel_members member ON member.community_id = e.community_id
    AND member.channel_id = e.channel_id AND member.pubkey = e.pubkey
    AND member.removed_at IS NULL
  JOIN agent_declarations agent ON agent.community_id = e.community_id
    AND agent.pubkey = e.pubkey
  WHERE e.tags @> '[["t", "agent-turn"]]'::jsonb
    AND e.tags @> jsonb_build_array(jsonb_build_array('h', a.id::text))
    AND e.tags @> jsonb_build_array(jsonb_build_array('agent', encode(e.pubkey, 'hex')))
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
      WHERE t->>0 = 'request' AND t->>1 ~ '^[0-9a-f]{64}$')
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
      WHERE t->>0 = 'status' AND t->>1 IN ('working', 'complete', 'failed'))
  ORDER BY e.pubkey, e.created_at DESC, e.id DESC
), ${agentSoulsCteSql('authorized', 'a', 'a.workspace_id')}, identities AS (
  SELECT k.community_id, k.pubkey,
    NULLIF(u.display_name, '') AS name, u.nip05_handle AS handle, u.avatar_url AS avatar,
    agent.content AS agent_content, soul.content AS soul_content
  FROM identity_keys k
  LEFT JOIN users u ON u.community_id = k.community_id AND u.pubkey = k.pubkey
    AND u.deactivated_at IS NULL
  LEFT JOIN agent_declarations agent ON agent.community_id = k.community_id
    AND agent.pubkey = k.pubkey
  LEFT JOIN agent_souls soul ON soul.community_id = k.community_id
    AND soul.d_tag = k.workspace_id || ':' || encode(k.pubkey, 'hex')
)
SELECT 'room' AS section, jsonb_build_object(
  'id', a.id, 'workspaceId', a.workspace_id, 'parentId', a.parent_id,
  'name', a.name, 'about', COALESCE(a.description, a.task), 'avatar', a.avatar,
  'visibility', a.visibility,
  'archived', a.archived_at IS NOT NULL,
  'createdAt', extract(epoch FROM a.created_at)::bigint,
  'updatedAt', extract(epoch FROM a.updated_at)::bigint,
  'directMessage', CASE WHEN
    EXISTS (SELECT 1 FROM jsonb_array_elements(a.tags) t
      WHERE t->>0 = 't' AND t->>1 = 'buzz-dm')
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.tags) t
      WHERE t->>0 = 'visibility' AND t->>1 = 'private')
    AND a.parent_id IS NULL
    THEN jsonb_build_object('participants', (SELECT jsonb_agg(t->>1 ORDER BY t->>1)
      FROM jsonb_array_elements(a.tags) t WHERE t->>0 = 'p'))
    ELSE NULL END,
  '_readMarked', beeline_mark_room_read(
    a.community_id, a.id, decode($2, 'hex'), newest.created_at, newest.id
  ),
  'viewerRole', a.viewer_role, 'viewerPubkey', a.viewer_pubkey
) AS data FROM authorized a LEFT JOIN newest_message newest ON true
UNION ALL
SELECT 'parent', jsonb_build_object(
  'id', a.parent_id, 'workspaceId', a.workspace_id, 'name', a.parent_name,
  'about', a.parent_description, 'visibility', a.parent_visibility,
  'archived', a.parent_archived_at IS NOT NULL,
  'createdAt', extract(epoch FROM a.parent_created_at)::bigint,
  'updatedAt', extract(epoch FROM a.parent_updated_at)::bigint
) FROM authorized a WHERE a.parent_id IS NOT NULL
UNION ALL
SELECT 'member', jsonb_build_object(
  'pubkey', encode(cm.pubkey, 'hex'), 'role', cm.role::text,
  'name', ${resolvedIdentityNameSql('resolved')},
  'handle', resolved.handle,
  'avatar', COALESCE(resolved.agent_content::jsonb->>'avatar', resolved.avatar),
  'agent', resolved.agent_content IS NOT NULL,
  'presenceStatus', presence.status, 'presenceObservedAt', presence.observed_at,
  'presenceRoomId', presence.room_id
) FROM authorized a
JOIN channel_members cm ON cm.community_id = a.community_id AND cm.channel_id = a.id
  AND cm.removed_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM events service
    WHERE service.community_id = cm.community_id AND service.pubkey = cm.pubkey
      AND service.kind = 9 AND service.deleted_at IS NULL
      AND service.tags @> '[["service", "beeline-events"]]'::jsonb
  )
JOIN identities resolved ON resolved.community_id = cm.community_id AND resolved.pubkey = cm.pubkey
LEFT JOIN LATERAL (
  SELECT
    (SELECT t->>1 FROM jsonb_array_elements(e.tags) t
      WHERE t->>0 = 'status' LIMIT 1) AS status,
    extract(epoch FROM e.created_at)::bigint AS observed_at,
    a.id::text AS room_id
  FROM events e
  WHERE resolved.agent_content IS NOT NULL
    AND e.community_id = a.community_id AND e.pubkey = cm.pubkey
    AND e.kind = 30078 AND e.deleted_at IS NULL
    AND e.d_tag = 'agent-presence:' || a.id::text
    AND e.tags @> jsonb_build_array(jsonb_build_array('h', a.id::text))
    AND e.tags @> '[["t", "agent-presence"]]'::jsonb
  ORDER BY e.created_at DESC, e.id DESC LIMIT 1
) presence ON true
UNION ALL
SELECT section, jsonb_build_object(
  'id', encode(e.id, 'hex'), 'pubkey', encode(e.pubkey, 'hex'),
  'createdAt', extract(epoch FROM e.created_at)::bigint,
  'tags', e.tags, 'content', e.content,
  'rootId', ${messageRootIdSql('e')},
  'name', ${resolvedIdentityNameSql('resolved')},
  'handle', resolved.handle,
  'avatar', COALESCE(resolved.agent_content::jsonb->>'avatar', resolved.avatar),
  'agent', resolved.agent_content IS NOT NULL
) FROM authorized a
JOIN (
  SELECT 'event'::text AS section, p.* FROM page p
  UNION ALL SELECT 'briefing'::text, b.* FROM briefing b
) e ON true
JOIN identities resolved ON resolved.community_id = e.community_id AND resolved.pubkey = e.pubkey
UNION ALL
SELECT 'agent-turn', jsonb_build_object(
  'requestId', (SELECT t->>1 FROM jsonb_array_elements(turn.tags) t
    WHERE t->>0 = 'request' AND t->>1 ~ '^[0-9a-f]{64}$' LIMIT 1),
  'agentPubkey', encode(turn.pubkey, 'hex'),
  'status', (SELECT t->>1 FROM jsonb_array_elements(turn.tags) t
    WHERE t->>0 = 'status' AND t->>1 IN ('working', 'complete', 'failed') LIMIT 1),
  'createdAt', extract(epoch FROM turn.created_at)::bigint,
  'generationId', (SELECT t->>1 FROM jsonb_array_elements(turn.tags) t
    WHERE t->>0 = 'generation' LIMIT 1)
) FROM latest_agent_turns turn
UNION ALL
SELECT 'sibling', jsonb_build_object(
  'id', f.id, 'workspaceId', a.workspace_id,
  'parentId', COALESCE(a.parent_id, a.id), 'name', f.name, 'about', f.description,
  'visibility', f.visibility,
  'archived', f.archived_at IS NOT NULL,
  'createdAt', extract(epoch FROM f.created_at)::bigint,
  'updatedAt', extract(epoch FROM f.updated_at)::bigint,
  'agentPubkey', encode(f.created_by, 'hex'),
  'agentName', ${resolvedIdentityNameSql('resolved')},
  'agentHandle', resolved.handle,
  'agentAvatar', COALESCE(resolved.agent_content::jsonb->>'avatar', resolved.avatar),
  'agent', resolved.agent_content IS NOT NULL
) FROM family f JOIN authorized a ON true
JOIN identities resolved ON resolved.community_id = f.community_id AND resolved.pubkey = f.created_by
UNION ALL
SELECT 'repository-candidate', jsonb_build_object('content', e.content)
FROM authorized a JOIN LATERAL (
  SELECT e.content FROM events e
  WHERE e.community_id = a.community_id
    AND e.d_tag = 'buzz-room-repository:' || COALESCE(a.parent_id, a.id)::text
    AND e.kind = 30078
    AND e.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
      WHERE t->>0 = 't' AND t->>1 = 'buzz-room-repository')
  ORDER BY e.created_at DESC, e.id DESC LIMIT 1
) e ON true
UNION ALL
SELECT 'repository', jsonb_build_object(
  'content', e.content,
  'updatedAt', extract(epoch FROM e.created_at)::bigint
)
FROM authorized a JOIN LATERAL (
  SELECT e.content, e.created_at FROM events e
  JOIN channel_members author ON author.community_id = e.community_id
    AND author.channel_id = COALESCE(a.parent_id, a.id) AND author.pubkey = e.pubkey
    AND author.removed_at IS NULL AND author.role IN ('owner', 'admin')
  WHERE e.community_id = a.community_id
    AND e.d_tag = 'buzz-room-repository:' || COALESCE(a.parent_id, a.id)::text
    AND e.kind = 30078
    AND e.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
      WHERE t->>0 = 't' AND t->>1 = 'buzz-room-repository')
  ORDER BY e.created_at DESC, e.id DESC LIMIT 1
) e ON true
UNION ALL
SELECT 'review', jsonb_build_object('content', e.content)
FROM authorized a JOIN LATERAL (
  SELECT e.content FROM events e
  JOIN channel_members author ON author.community_id = e.community_id
    AND author.channel_id = a.id AND author.pubkey = e.pubkey
    AND author.removed_at IS NULL
  WHERE e.community_id = a.community_id AND e.kind = 30078
    AND e.deleted_at IS NULL
    AND e.tags @> jsonb_build_array(jsonb_build_array('h', a.id::text))
    AND e.tags @> '[["t", "change-review-artifact"]]'::jsonb
  ORDER BY e.created_at DESC, e.id DESC LIMIT 1
) e ON true
UNION ALL
SELECT 'approval', jsonb_build_object(
  'pubkey', encode(e.pubkey, 'hex'), 'name', resolved.name,
  'handle', resolved.handle, 'avatar', resolved.avatar, 'agent', false
) FROM authorized a
JOIN events e ON e.community_id = a.community_id AND e.channel_id = a.id
  AND e.kind = 9 AND e.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
    WHERE t->>0 = 't' AND t->>1 = 'buzz-merge-approval')
JOIN channel_members approver ON approver.community_id = a.community_id
  AND approver.channel_id = COALESCE(a.parent_id, a.id) AND approver.pubkey = e.pubkey
  AND approver.removed_at IS NULL AND approver.role IN ('owner', 'admin')
LEFT JOIN identities resolved ON resolved.community_id = e.community_id AND resolved.pubkey = e.pubkey;
`;
