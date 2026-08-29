import {
  ROOM_VIEW_BRIEFING_LIMIT,
  ROOM_VIEW_AGENT_LIMIT,
  ROOM_VIEW_CHAT_LIMIT,
  ROOM_VIEW_MEMBER_LIMIT,
  ROOM_VIEW_MESSAGE_LIMIT,
  ROOM_VIEW_WORKSPACE_LIMIT,
  TAG_AGENT,
  TAG_AGENT_ACTIVITY,
  TAG_AGENT_DRAFT,
  TAG_AGENT_PRESENCE,
  TAG_AGENT_THOUGHT,
  directMessageChannelId,
  isRetiredAgentNotice,
  normalizeRoomRepositoryContent,
  isAllowedAgentModelConfigCategory,
  parseAttachmentTags,
  parseChangeReviewArtifactDescriptor,
  type AgentDetailView,
  type ChatListItem,
  type ChatListView,
  type ChatListWorkspace,
  type CornerListItem,
  type CornerListView,
  type InviteView,
  type RoomHistoryView,
  type RoomRepositoryView,
  type RoomReviewView,
  type RoomView,
  type RoomViewAgentTurn,
  type RoomViewActivity,
  type RoomViewHeader,
  type RoomViewIdentity,
  type RoomViewMember,
  type RoomViewMessage,
  type WorkspaceListView,
  type WorkspaceView,
} from '@beeline/buzz-client';
import type { DatabaseQueryable } from './database.js';

type IndexRow = { readonly section: string; readonly data: unknown };
type Json = Record<string, unknown>;

const RAW_EVENT_LIMIT = 180;
const HISTORY_EVENT_LIMIT = 180;
const CHAT_PREVIEW_LIMIT = 12;
const DURABLE_KINDS = [0, 9, 9000, 9001, 9002, 9007, 9008, 30078, 39000, 39001, 39002] as const;

function profileFilter(identities: readonly RoomViewIdentity[]) {
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

function roomFilters(
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

const ROOM_SQL = `
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

const WORKSPACE_LIST_SQL = `
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

const WORKSPACE_SQL = `
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
  SELECT child.community_id,
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
  SELECT parent.community_id, parent.id AS room_id, count(*)::bigint AS corner_count
  FROM chats parent JOIN corner_children child ON child.community_id = parent.community_id
    AND child.parent_id = parent.id::text
  GROUP BY parent.community_id, parent.id
), repositories AS (
  SELECT DISTINCT ON (e.community_id, e.channel_id)
    e.community_id, e.channel_id AS room_id, e.content
  FROM chats a JOIN events e ON e.community_id = a.community_id AND e.channel_id = a.id
    AND e.kind = 30078 AND e.deleted_at IS NULL
  JOIN channel_members author ON author.community_id = e.community_id
    AND author.channel_id = e.channel_id AND author.pubkey = e.pubkey
    AND author.removed_at IS NULL AND author.role IN ('owner', 'admin')
  WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
    WHERE t->>0 = 't' AND t->>1 = 'buzz-room-repository')
  ORDER BY e.community_id, e.channel_id, e.created_at DESC, e.id DESC
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
  'repositoryName', repo.content::jsonb->>'name'
) FROM chats a
LEFT JOIN member_counts members ON members.community_id = a.community_id AND members.room_id = a.id
LEFT JOIN corner_counts corners ON corners.community_id = a.community_id AND corners.room_id = a.id
LEFT JOIN repositories repo ON repo.community_id = a.community_id AND repo.room_id = a.id
LEFT JOIN latest_events latest ON latest.community_id = a.community_id AND latest.room_id = a.id
LEFT JOIN beeline_room_read_marks mark ON mark.community_id = a.community_id
  AND mark.room_id = a.id AND mark.viewer_pubkey = decode($2, 'hex')
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

const AGENT_DETAIL_SQL = `
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

const INVITE_SQL = `
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

const CORNER_LIST_SQL = `
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
  'updatedAt', extract(epoch FROM GREATEST(
    c.updated_at, COALESCE(state.created_at, c.updated_at)
  ))::bigint,
  'statusTags', state.tags,
  'agentPubkey', encode(c.created_by, 'hex'),
  'agentName', ${resolvedIdentityNameSql('resolved')},
  'agentHandle', resolved.handle,
  'agentAvatar', COALESCE(resolved.agent_content::jsonb->>'avatar', resolved.avatar),
  'agent', resolved.agent_content IS NOT NULL
) FROM corners c JOIN authorized a ON true
JOIN identities resolved ON resolved.community_id = c.community_id AND resolved.pubkey = c.created_by
LEFT JOIN LATERAL (
  SELECT e.tags, e.created_at FROM events e WHERE e.community_id = c.community_id
    AND e.pubkey = c.created_by AND e.kind = 30078
    AND e.d_tag = 'buzz-corner-state:' || c.id::text AND e.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) h
      WHERE h->>0 = 'h' AND h->>1 = a.id::text)
  ORDER BY e.created_at DESC, e.id DESC LIMIT 1
) state ON true
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
), page AS (
  SELECT e.* FROM authorized a JOIN LATERAL (
    SELECT e.* FROM events e WHERE e.community_id = a.community_id AND e.channel_id = a.id
      AND e.deleted_at IS NULL AND e.kind = 9
    ORDER BY e.created_at DESC, e.id ASC LIMIT $3
  ) e ON true
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
  'updatedAt', extract(epoch FROM GREATEST(
    f.updated_at, COALESCE(state.created_at, f.updated_at)
  ))::bigint,
  'statusTags', state.tags,
  'agentPubkey', encode(f.created_by, 'hex'),
  'agentName', ${resolvedIdentityNameSql('resolved')},
  'agentHandle', resolved.handle,
  'agentAvatar', COALESCE(resolved.agent_content::jsonb->>'avatar', resolved.avatar),
  'agent', resolved.agent_content IS NOT NULL
) FROM family f JOIN authorized a ON true
JOIN identities resolved ON resolved.community_id = f.community_id AND resolved.pubkey = f.created_by
LEFT JOIN LATERAL (
  SELECT e.tags, e.created_at FROM events e WHERE e.community_id = f.community_id
    AND e.pubkey = f.created_by AND e.kind = 30078
    AND e.d_tag = 'buzz-corner-state:' || f.id::text AND e.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) h
      WHERE h->>0 = 'h' AND h->>1 = COALESCE(a.parent_id, a.id)::text)
  ORDER BY e.created_at DESC, e.id DESC LIMIT 1
) state ON true
UNION ALL
SELECT 'repository-candidate', jsonb_build_object('content', e.content)
FROM authorized a JOIN LATERAL (
  SELECT e.content FROM events e
  WHERE e.community_id = a.community_id AND e.channel_id = COALESCE(a.parent_id, a.id)
    AND e.kind = 30078
    AND e.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
      WHERE t->>0 = 't' AND t->>1 = 'buzz-room-repository')
  ORDER BY e.created_at DESC, e.id DESC LIMIT 1
) e ON true
UNION ALL
SELECT 'repository', jsonb_build_object('content', e.content)
FROM authorized a JOIN LATERAL (
  SELECT e.content FROM events e
  JOIN channel_members author ON author.community_id = e.community_id
    AND author.channel_id = e.channel_id AND author.pubkey = e.pubkey
    AND author.removed_at IS NULL AND author.role IN ('owner', 'admin')
  WHERE e.community_id = a.community_id AND e.channel_id = COALESCE(a.parent_id, a.id)
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
    AND author.channel_id = e.channel_id AND author.pubkey = e.pubkey
    AND author.removed_at IS NULL
  WHERE e.community_id = a.community_id AND e.channel_id = a.id AND e.kind = 30078
    AND e.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
      WHERE t->>0 = 't' AND t->>1 = 'change-review-artifact')
  ORDER BY e.created_at DESC, e.id DESC LIMIT 1
) e ON true
UNION ALL
SELECT 'not-ready', jsonb_build_object('reason', e.content)
FROM authorized a JOIN LATERAL (
  SELECT e.content FROM events e WHERE e.community_id = a.community_id
    AND e.channel_id = a.id AND e.kind = 9 AND e.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tags) t
      WHERE t->>0 = 't' AND t->>1 = 'merge-not-ready')
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

function json(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function integer(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function tags(value: unknown): string[][] {
  return Array.isArray(value)
    ? value.flatMap((candidate) =>
        Array.isArray(candidate) && candidate.every((item) => typeof item === 'string')
          ? [candidate as string[]]
          : [],
      )
    : [];
}

function tag(values: readonly string[][], name: string): string | undefined {
  return values.find((candidate) => candidate[0] === name)?.[1];
}

function markerSet(values: readonly string[][]): Set<string> {
  return new Set(
    values.flatMap((candidate) => (candidate[0] === 't' && candidate[1] ? [candidate[1]] : [])),
  );
}

function githubEventCard(
  values: readonly string[][],
): NonNullable<RoomViewMessage['githubEvent']> | undefined {
  const type = tag(values, 'github-event-type');
  const action = tag(values, 'github-event-action');
  const actor = text(tag(values, 'github-event-actor'));
  const title = text(tag(values, 'github-event-title'));
  const url = text(tag(values, 'github-event-url'));
  if (
    tag(values, 'service') !== 'beeline-events' ||
    !text(tag(values, 'github-event-id')) ||
    (type !== 'pull-request' && type !== 'issue') ||
    (action !== 'opened' && action !== 'closed' && action !== 'merged') ||
    (type === 'issue' && action === 'merged') ||
    !actor ||
    !title ||
    !url ||
    !/^https:\/\/github\.com\/[^\s]+$/i.test(url)
  )
    return undefined;
  return { type, action, actor, title, url };
}

function identity(data: Json): RoomViewIdentity {
  const pubkey = String(data.pubkey ?? '');
  const fallback = pubkey
    ? `${data.agent === true ? 'Agent' : 'Person'} ${pubkey.slice(0, 8)}`
    : 'Unknown';
  return {
    pubkey,
    kind: data.agent === true ? 'agent' : 'human',
    name: text(data.name) ?? text(data.handle)?.split('@')[0] ?? fallback,
    ...(text(data.handle) ? { handle: text(data.handle) } : {}),
    ...(text(data.avatar) ? { avatar: text(data.avatar) } : {}),
  };
}

function header(data: Json): RoomViewHeader {
  return {
    id: String(data.id ?? ''),
    workspaceId: String(data.workspaceId ?? data.id ?? ''),
    ...(text(data.parentId) ? { parentId: text(data.parentId) } : {}),
    name: text(data.name) ?? 'ROOM',
    ...(text(data.about) ? { about: text(data.about) } : {}),
    ...(text(data.avatar) ? { avatar: text(data.avatar) } : {}),
    ...(text(data.visibility)
      ? {
          visibility:
            data.visibility === 'open' || data.visibility === 'public'
              ? ('public' as const)
              : ('invite-only' as const),
        }
      : {}),
    archived: data.archived === true,
    createdAt: integer(data.createdAt),
    updatedAt: integer(data.updatedAt),
  };
}

function workspaceItem(data: Json): ChatListWorkspace {
  return {
    id: String(data.id ?? ''),
    name: text(data.name) ?? 'WORKSPACE',
    ...(text(data.avatar) ? { avatar: text(data.avatar) } : {}),
    visibility:
      data.visibility === 'private' || data.visibility === 'invite-only' ? 'invite-only' : 'public',
    role: data.role === 'owner' || data.role === 'admin' ? data.role : 'member',
    updatedAt: integer(data.updatedAt),
  };
}

function safeJson(content: string): Json | undefined {
  try {
    return json(JSON.parse(content));
  } catch {
    return undefined;
  }
}

function activityDetail(value: unknown): RoomViewActivity | undefined {
  const update = json(value);
  const updateType = text(update.sessionUpdate) ?? text(update.type) ?? '';
  const kind: RoomViewActivity['kind'] = updateType.includes('thought')
    ? 'thinking'
    : updateType.includes('tool')
      ? 'tool'
      : updateType.includes('summary')
        ? 'summary'
        : 'output';
  const rollup = json(update.rollup);
  const observed = Array.isArray(update.observed)
    ? update.observed.flatMap((item) => {
        const entry = json(item);
        const verb = text(entry.verb);
        return verb
          ? [
              {
                verb,
                ...(text(entry.target) ? { target: text(entry.target) } : {}),
                ...(text(entry.result) ? { result: text(entry.result) } : {}),
              },
            ]
          : [];
      })
    : [];
  const files = Array.isArray(update.files)
    ? update.files.flatMap((item) => {
        const file = json(item);
        const path = text(file.path);
        return path ? [{ path, ...(text(file.status) ? { status: text(file.status) } : {}) }] : [];
      })
    : [];
  const rawPlan = json(update.plan);
  const planItems = Array.isArray(rawPlan.items)
    ? rawPlan.items.flatMap((item) => {
        const planItem = json(item);
        const step = text(planItem.step);
        const status = text(planItem.status);
        return step && (status === 'pending' || status === 'in_progress' || status === 'completed')
          ? [{ step, status: status as 'pending' | 'in_progress' | 'completed' }]
          : [];
      })
    : [];
  return {
    kind,
    title:
      text(update.title) ??
      (kind === 'tool' ? 'Tool' : kind === 'thinking' ? 'Thinking' : 'Update'),
    ...(updateType ? { operation: updateType } : {}),
    ...(text(update.status) ? { status: text(update.status) } : {}),
    ...(typeof update.thoughtMs === 'number' && update.thoughtMs > 0
      ? { thoughtMs: update.thoughtMs }
      : {}),
    ...(Object.keys(rollup).length
      ? {
          rollup: Object.fromEntries(
            Object.entries(rollup).filter(
              ([, count]) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0,
            ),
          ) as Record<string, number>,
        }
      : {}),
    ...(observed.length ? { observed } : {}),
    ...(files.length ? { files } : {}),
    ...(planItems.length
      ? {
          plan: {
            ...(text(rawPlan.objective) ? { objective: text(rawPlan.objective) } : {}),
            items: planItems,
          },
        }
      : {}),
  };
}

const HIDDEN_MARKERS = new Set([
  TAG_AGENT,
  TAG_AGENT_DRAFT,
  TAG_AGENT_THOUGHT,
  TAG_AGENT_PRESENCE,
  'body-control',
  'agent-turn',
  'corner-session',
  'buzz-merge-approval',
  'buzz-write-permission-response',
  'buzz-permission-decision',
  'buzz-permission-revocation',
  'buzz-permission-execution',
  'buzz-delegation-turn',
  'buzz-delegation-receipt',
]);

/** Durable machine-authored Room lines that the client renders as status text. */
const SYSTEM_MARKERS = new Set([
  'buzz-agent-model-unavailable',
  'buzz-work-schedule-paused',
  'github-event-health',
  'steer-queued',
  'slash-command-notice',
]);

/**
 * Typed kind:9 events are machine records unless they opt into one of the
 * product's durable conversation shapes. This fail-closed boundary keeps new
 * control records visible as system lines without silently spending a model
 * transcript slot.
 */
const CONVERSATION_MARKERS = new Set([
  'agent-message',
  'buzz-agent-exchange',
  'buzz-agent-request',
  'buzz-attachment',
]);

function projectEvent(data: Json, channelId: string): RoomViewMessage | undefined {
  const eventTags = tags(data.tags);
  const markers = markerSet(eventTags);
  if ([...markers].some((candidate) => HIDDEN_MARKERS.has(candidate))) return undefined;
  const eventIdentity = identity(data);
  const base = {
    id: String(data.id ?? ''),
    text: String(data.content ?? ''),
    createdAt: integer(data.createdAt),
    author: eventIdentity,
  };

  // Old daemon health/stall prose has no distinguishing wire tag. The shared
  // tombstone is therefore the only safe discriminator; suppress it before it
  // can become a transcript row, Room-list preview, or corner preview.
  if (isRetiredAgentNotice(base.text)) return undefined;

  if (
    markers.has(TAG_AGENT_ACTIVITY) ||
    (eventIdentity.kind === 'agent' && safeJson(base.text)?.sessionId)
  ) {
    const parsed = safeJson(base.text);
    const update = json(parsed?.update);
    const candidates =
      update.sessionUpdate === 'activity_batch' && Array.isArray(update.updates)
        ? update.updates
        : [update];
    const activity = candidates.flatMap((candidate) => {
      const detail = activityDetail(candidate);
      return detail ? [detail] : [];
    });
    if (!activity.length) return undefined;
    const failed =
      activity.some((item) => item.status === 'failed') || tag(eventTags, 'status') === 'failed';
    const merge = tag(eventTags, 'delivery-stage') === 'landed' || markers.has('landed');
    const action = [...markers].some((candidate) =>
      ['corner-open', 'room-target-branch-realign', 'branch-switch'].includes(candidate),
    );
    return {
      ...base,
      text: '',
      presentation: 'activity',
      activity,
      ...(failed
        ? { durableFact: 'failure' as const }
        : merge
          ? { durableFact: 'merge' as const }
          : action
            ? { durableFact: 'action' as const }
            : {}),
    };
  }

  if (markers.has('github-event')) {
    // A service health notice is status text, not a person-authored turn.
    if (markers.has('github-event-health')) return { ...base, presentation: 'system' };
    // Old batch prose never gets a compatibility renderer: cards need the
    // complete typed envelope or remain invisible.
    const githubEvent = githubEventCard(eventTags);
    return githubEvent ? { ...base, text: '', presentation: 'card', githubEvent } : undefined;
  }

  const permissionMarker =
    markers.has('buzz-write-permission-request') || markers.has('buzz-permission-request');
  if (permissionMarker) {
    const status = tag(eventTags, 'status');
    const agentPubkey = tag(eventTags, 'agent') ?? eventIdentity.pubkey;
    return {
      ...base,
      presentation: 'card',
      permission: {
        permissionId: tag(eventTags, 'permission') ?? base.id,
        requestId: tag(eventTags, 'request') ?? base.id,
        agent:
          agentPubkey === eventIdentity.pubkey
            ? eventIdentity
            : { pubkey: agentPubkey, kind: 'agent', name: `Agent ${agentPubkey.slice(0, 8)}` },
        tool: tag(eventTags, 'tool') ?? 'edit files',
        ...(tag(eventTags, 'repo') ? { repository: tag(eventTags, 'repo') } : {}),
        ...(tag(eventTags, 'purpose') === 'squire-spending'
          ? { purpose: 'squire-spending' as const }
          : {}),
        status:
          status === 'allowed' || status === 'denied' || status === 'expired' || status === 'failed'
            ? status
            : 'pending',
        ...(tag(eventTags, 'subchannel') ? { cornerId: tag(eventTags, 'subchannel') } : {}),
      },
    };
  }

  if (markers.has('buzz-target-branch-proposal')) {
    const from = tag(eventTags, 'from');
    const to = tag(eventTags, 'to');
    if (!from || !to) return undefined;
    return {
      ...base,
      presentation: 'card',
      targetBranch: {
        proposalId: base.id,
        from,
        to,
        ...(tag(eventTags, 'repo') ? { repository: tag(eventTags, 'repo') } : {}),
      },
    };
  }

  const mergeAction = markers.has('merge-ready')
    ? 'ready'
    : markers.has('merge-not-ready')
      ? 'not-ready'
      : markers.has('buzz-merge-approval-ack')
        ? 'approval-ack'
        : tag(eventTags, 'status') === 'failed' && !tag(eventTags, 'subchannel')
          ? 'failed'
          : markers.has('landed') || tag(eventTags, 'delivery') === 'landed'
            ? 'landed'
            : undefined;
  if (mergeAction) {
    const retry = tag(eventTags, 'retry');
    const decision = tag(eventTags, 'decision');
    const state = tag(eventTags, 'state');
    return {
      ...base,
      presentation: mergeAction === 'ready' || mergeAction === 'not-ready' ? 'card' : 'system',
      merge: {
        action: mergeAction,
        ...(tag(eventTags, 'repo') ? { repository: tag(eventTags, 'repo') } : {}),
        ...(tag(eventTags, 'branch') ? { branch: tag(eventTags, 'branch') } : {}),
        ...(tag(eventTags, 'tip') ? { tip: tag(eventTags, 'tip') } : {}),
        ...(tag(eventTags, 'patch-id') ? { patchId: tag(eventTags, 'patch-id') } : {}),
        ...(tag(eventTags, 'preview')?.startsWith('https://')
          ? { previewUrl: tag(eventTags, 'preview') }
          : {}),
        ...(retry === 'auto' || retry === 'realigning' || retry === 'blocked' ? { retry } : {}),
        ...(tag(eventTags, 'approval') ? { approvalId: tag(eventTags, 'approval') } : {}),
        ...(decision === 'accepted' || decision === 'rejected' ? { decision } : {}),
        ...(state === 'landing' ||
        state === 'realigning' ||
        state === 'realigned' ||
        state === 'content-changed' ||
        state === 'tip-moved'
          ? { state }
          : {}),
        ...(tag(eventTags, 'rejected-tip') ? { rejectedTip: tag(eventTags, 'rejected-tip') } : {}),
      },
    };
  }

  const cornerId = tag(eventTags, 'subchannel');
  if (cornerId) {
    const status = tag(eventTags, 'status');
    if (
      status !== 'open' &&
      status !== 'working' &&
      status !== 'waiting' &&
      status !== 'idle' &&
      status !== 'concluded' &&
      status !== 'closed'
    )
      return undefined;
    return { ...base, presentation: 'card', corner: { id: cornerId, status } };
  }

  if ([...markers].some((candidate) => SYSTEM_MARKERS.has(candidate))) {
    return { ...base, presentation: 'system' };
  }
  if (
    markers.size > 0 &&
    [...markers].some((candidate) => !CONVERSATION_MARKERS.has(candidate))
  ) {
    if ([...markers].some((candidate) => candidate.startsWith('buzz-'))) return undefined;
    return { ...base, presentation: 'system' };
  }
  if (!base.text.trim() && !markers.has('buzz-attachment')) return undefined;

  const replyMarker = eventTags.find(
    (candidate) => candidate[0] === 'e' && candidate[3] === 'reply',
  );
  const replyId = replyMarker?.[1];
  const validatedRoot = text(data.rootId);
  const rootId = validatedRoot && /^[0-9a-f]{64}$/.test(validatedRoot) ? validatedRoot : undefined;
  const requestId = tag(eventTags, 'request');
  return {
    ...base,
    presentation: 'message',
    ...(requestId ? { requestId, liveTurnId: `live-turn:${requestId}` } : {}),
    ...(parseAttachmentTags(eventTags).length
      ? { attachments: parseAttachmentTags(eventTags) }
      : {}),
    ...(eventTags.some((candidate) => candidate[0] === 'p')
      ? {
          mentionPubkeys: [
            ...new Set(
              eventTags.flatMap((candidate) =>
                candidate[0] === 'p' && /^[0-9a-f]{64}$/.test(candidate[1] ?? '')
                  ? [candidate[1]!]
                  : [],
              ),
            ),
          ],
        }
      : {}),
    ...(replyId && /^[0-9a-f]{64}$/.test(replyId) && rootId
      ? { reply: { channelId, eventId: replyId, rootId } }
      : {}),
    ...((!replyMarker || (replyId && /^[0-9a-f]{64}$/.test(replyId))) && rootId
      ? { reference: { channelId, eventId: base.id, rootId } }
      : {}),
  } as RoomViewMessage;
}

function projectedMessages(
  rows: readonly IndexRow[],
  section: string,
  channelId: string,
  limit: number,
) {
  return rows
    .filter((row) => row.section === section)
    .flatMap((row) => {
      const message = projectEvent(json(row.data), channelId);
      return message ? [message] : [];
    })
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .slice(-limit);
}

function projectedHistoryPage(
  rows: readonly IndexRow[],
  channelId: string,
): { messages: RoomViewMessage[]; nextBefore?: { createdAt: number; id: string } } {
  const raw = rows.filter((row) => row.section === 'event');
  const messages: RoomViewMessage[] = [];
  let examined = 0;
  let cursor: Json | undefined;
  for (const row of raw) {
    cursor = json(row.data);
    examined += 1;
    const message = projectEvent(cursor, channelId);
    if (message) messages.push(message);
    if (messages.length === ROOM_VIEW_MESSAGE_LIMIT) break;
  }
  messages.sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
  const hasMoreRawRows = examined < raw.length || raw.length === HISTORY_EVENT_LIMIT;
  return {
    messages,
    ...(hasMoreRawRows && cursor
      ? { nextBefore: { createdAt: integer(cursor.createdAt), id: String(cursor.id ?? '') } }
      : {}),
  };
}

function viewer(room: Json, members: readonly RoomViewMember[]) {
  const pubkey = String(room.viewerPubkey ?? '');
  const member = members.find((candidate) => candidate.identity.pubkey === pubkey);
  return {
    identity: member?.identity ?? identity({ pubkey }),
    role: (room.viewerRole === 'owner' || room.viewerRole === 'admin'
      ? room.viewerRole
      : 'member') as 'owner' | 'admin' | 'member',
    permissions: {
      send: room.archived !== true,
      manage: room.viewerRole === 'owner' || room.viewerRole === 'admin',
    },
  };
}

function rowData(rows: readonly IndexRow[], section: string): Json | undefined {
  const row = rows.find((candidate) => candidate.section === section);
  return row ? json(row.data) : undefined;
}

function repositoryFromRows(rows: readonly IndexRow[]): RoomRepositoryView | undefined {
  const repositoryData = rowData(rows, 'repository');
  if (!repositoryData || !text(repositoryData.content)) return undefined;
  const normalized = normalizeRoomRepositoryContent(safeJson(text(repositoryData.content)!) ?? {});
  if (!normalized) return undefined;
  return {
    key: normalized.key,
    name: normalized.name,
    remote: normalized.remote,
    targetBranch: normalized.targetBranch ?? 'main',
    ...(normalized.githubInstallationId
      ? { githubInstallationId: normalized.githubInstallationId }
      : {}),
    githubEventsEnabled: normalized.githubEventsEnabled !== false,
  };
}

function repositoryResolutionFromRows(
  rows: readonly IndexRow[],
  repository: RoomRepositoryView | undefined,
): 'repository' | 'none' | 'unverified' {
  if (repository) return 'repository';
  // Keep an authorization failure separate from absence. This row is any
  // relay-indexed repository event, while `repository` above is limited to
  // one whose author still projects as the Room owner/admin.
  return rowData(rows, 'repository-candidate') ? 'unverified' : 'none';
}

function reviewFromRows(rows: readonly IndexRow[]): RoomReviewView {
  const reviewData = rowData(rows, 'review');
  const descriptor =
    reviewData && text(reviewData.content)
      ? parseChangeReviewArtifactDescriptor(text(reviewData.content)!)
      : null;
  const notReady = text(rowData(rows, 'not-ready')?.reason);
  const approvedBy = rows
    .filter((row) => row.section === 'approval')
    .map((row) => identity(json(row.data)))
    .filter(
      (candidate, index, all) =>
        all.findIndex((other) => other.pubkey === candidate.pubkey) === index,
    );
  return descriptor
    ? { status: 'ready', artifact: descriptor, files: descriptor.files, approvedBy }
    : notReady
      ? { status: 'not-ready', reason: notReady, files: [], approvedBy }
      : { status: 'none', files: [], approvedBy };
}

function cornerItem(data: Json, latest?: RoomViewMessage): CornerListItem {
  const stateTags = tags(data.statusTags);
  const rawStatus = tag(stateTags, 'state');
  const status = rawStatus === 'waiting-on-human' ? 'waiting' : rawStatus;
  const agentData = {
    pubkey: data.agentPubkey,
    name: data.agentName,
    handle: data.agentHandle,
    avatar: data.agentAvatar,
    agent: data.agent,
  };
  return {
    corner: header(data),
    status:
      status === 'working' ||
      status === 'waiting' ||
      status === 'idle' ||
      status === 'concluded' ||
      status === 'closed'
        ? status
        : 'open',
    ...(['review', 'question', 'failure'].includes(tag(stateTags, 'reason') ?? '')
      ? { reason: tag(stateTags, 'reason') as 'review' | 'question' | 'failure' }
      : {}),
    ...(text(data.agentPubkey) ? { agent: identity(agentData) } : {}),
    ...(latest
      ? {
          latestMessage: {
            id: latest.id,
            text: latest.text,
            createdAt: latest.createdAt,
            author: latest.author,
          },
        }
      : {}),
  };
}

function paintRoom(rows: readonly IndexRow[], roomId: string): RoomView | null {
  const roomData = rowData(rows, 'room');
  if (!roomData) return null;
  const members = rows
    .filter((row) => row.section === 'member')
    .map((row) => {
      const data = json(row.data);
      const memberIdentity = identity(data);
      const presenceStatus = text(data.presenceStatus);
      return {
        identity: memberIdentity,
        role: data.role as RoomViewMember['role'],
        ...(memberIdentity.kind === 'agent' &&
        (presenceStatus === 'online' || presenceStatus === 'offline')
          ? {
              presence: {
                status: presenceStatus as 'online' | 'offline',
                observedAt: integer(data.presenceObservedAt),
                ...(text(data.presenceRoomId) ? { roomId: text(data.presenceRoomId) } : {}),
              },
            }
          : {}),
      };
    });
  const parentData = rowData(rows, 'parent');
  const repository = repositoryFromRows(rows);
  const repositoryResolution = repositoryResolutionFromRows(rows, repository);
  const directMessageData = json(roomData.directMessage);
  const directMessageParticipants = Array.isArray(directMessageData.participants)
    ? directMessageData.participants.filter(
        (participant): participant is string =>
          typeof participant === 'string' && /^[0-9a-f]{64}$/.test(participant),
      )
    : [];
  const directMessage =
    directMessageParticipants.length === 2 &&
    new Set(directMessageParticipants).size === 2 &&
    members.length === 2 &&
    directMessageParticipants.every((participant) =>
      members.some((member) => member.identity.pubkey === participant),
    ) &&
    directMessageChannelId(
      String(roomData.workspaceId ?? ''),
      directMessageParticipants[0]!,
      directMessageParticipants[1]!,
    ) === roomId
      ? { participants: directMessageParticipants as [string, string] }
      : undefined;
  const corners = rows
    .filter((row) => row.section === 'sibling')
    .map((row) => cornerItem(json(row.data)));
  const latestAgentTurns = rows
    .filter((row) => row.section === 'agent-turn')
    .flatMap((row): RoomViewAgentTurn[] => {
      const data = json(row.data);
      const requestId = text(data.requestId);
      const agentPubkey = text(data.agentPubkey);
      const status = text(data.status);
      if (
        !requestId ||
        !/^[0-9a-f]{64}$/.test(requestId) ||
        !agentPubkey ||
        !/^[0-9a-f]{64}$/.test(agentPubkey) ||
        (status !== 'working' && status !== 'complete' && status !== 'failed')
      ) {
        return [];
      }
      const generationId = text(data.generationId);
      return [
        {
          requestId,
          agentPubkey,
          status,
          createdAt: integer(data.createdAt),
          ...(generationId ? { generationId } : {}),
        },
      ];
    })
    .sort(
      (left, right) =>
        right.createdAt - left.createdAt || left.agentPubkey.localeCompare(right.agentPubkey),
    );
  return {
    room: header(roomData),
    messages: projectedMessages(rows, 'event', roomId, ROOM_VIEW_MESSAGE_LIMIT),
    members,
    latestAgentTurns,
    viewer: viewer(roomData, members),
    ...(directMessage ? { directMessage } : {}),
    ...(parentData ? { parent: header(parentData) } : {}),
    briefing: projectedMessages(
      rows,
      'briefing',
      String(parentData?.id ?? roomId),
      ROOM_VIEW_BRIEFING_LIMIT,
    ),
    ...(repository ? { repository } : {}),
    repositoryResolution,
    review: reviewFromRows(rows),
    corners,
    watchFilters: roomFilters(
      roomId,
      String(roomData.workspaceId ?? ''),
      [
        ...(parentData ? [String(parentData.id ?? '')] : []),
        ...corners.map((item) => item.corner.id),
      ],
      members,
    ),
  };
}

export class RoomIndexer {
  constructor(private readonly database: DatabaseQueryable) {}

  async readWorkspaces(viewerPubkey: string): Promise<WorkspaceListView> {
    const rows = (
      await this.database.query<IndexRow>(WORKSPACE_LIST_SQL, [
        viewerPubkey,
        ROOM_VIEW_WORKSPACE_LIMIT + 1,
      ])
    ).rows;
    const allWorkspaces = rows
      .filter((row) => row.section === 'workspace')
      .map((row) => workspaceItem(json(row.data)))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
    const workspaces = allWorkspaces.slice(0, ROOM_VIEW_WORKSPACE_LIMIT);
    return {
      workspaces,
      viewer: identity(rowData(rows, 'viewer') ?? { pubkey: viewerPubkey }),
      truncated: allWorkspaces.length > ROOM_VIEW_WORKSPACE_LIMIT,
      watchFilters: [
        { kinds: [9000, 9001, 9007, 9008], '#p': [viewerPubkey] },
        ...profileFilter([identity(rowData(rows, 'viewer') ?? { pubkey: viewerPubkey })]),
      ],
    };
  }

  async readWorkspace(workspaceId: string, viewerPubkey: string): Promise<WorkspaceView | null> {
    const rows = (
      await this.database.query<IndexRow>(WORKSPACE_SQL, [
        workspaceId,
        viewerPubkey,
        ROOM_VIEW_MEMBER_LIMIT,
        ROOM_VIEW_AGENT_LIMIT,
      ])
    ).rows;
    const workspaceData = rowData(rows, 'workspace');
    if (!workspaceData) return null;
    const roster = rows
      .filter((row) => row.section === 'member')
      .map((row) => {
        const data = json(row.data);
        const memberIdentity = identity(data);
        const presenceStatus = text(data.presenceStatus);
        return {
          identity: memberIdentity,
          role: data.role as RoomViewMember['role'],
          ...(memberIdentity.kind === 'agent' &&
          (presenceStatus === 'online' || presenceStatus === 'offline')
            ? {
                presence: {
                  status: presenceStatus as 'online' | 'offline',
                  observedAt: integer(data.presenceObservedAt) * 1_000,
                  ...(text(data.presenceRoomId) ? { roomId: text(data.presenceRoomId) } : {}),
                },
              }
            : {}),
          kindTotal: integer(data.kindTotal),
        };
      });
    const allMembers = roster.filter((member) => member.identity.kind === 'human');
    const allAgents = roster.filter((member) => member.identity.kind === 'agent');
    const members = allMembers.slice(0, ROOM_VIEW_MEMBER_LIMIT);
    const agents = allAgents.slice(0, ROOM_VIEW_AGENT_LIMIT);
    const item = workspaceItem(workspaceData);
    const currentViewer = roster.find((member) => member.identity.pubkey === viewerPubkey);
    const role = item.role;
    return {
      workspace: {
        ...item,
        ...(text(workspaceData.about) ? { about: text(workspaceData.about) } : {}),
        createdAt: integer(workspaceData.createdAt),
      },
      ...(role === 'owner' || role === 'admin'
        ? { managerSettings: { visibility: item.visibility } }
        : {}),
      members,
      agents,
      membersTruncated: (allMembers[0]?.kindTotal ?? allMembers.length) > ROOM_VIEW_MEMBER_LIMIT,
      agentsTruncated: (allAgents[0]?.kindTotal ?? allAgents.length) > ROOM_VIEW_AGENT_LIMIT,
      viewer: {
        identity: currentViewer?.identity ?? identity({ pubkey: viewerPubkey }),
        role,
        permissions: { send: true, manage: role === 'owner' || role === 'admin' },
      },
      watchFilters: [
        { kinds: [...DURABLE_KINDS], '#h': [workspaceId] },
        ...profileFilter(roster.map((member) => member.identity)),
      ],
    };
  }

  async readAgent(
    workspaceId: string,
    agentPubkey: string,
    viewerPubkey: string,
  ): Promise<AgentDetailView | null> {
    const rows = (
      await this.database.query<IndexRow>(AGENT_DETAIL_SQL, [
        workspaceId,
        agentPubkey,
        viewerPubkey,
      ])
    ).rows;
    const agentData = rowData(rows, 'agent');
    if (!agentData) return null;
    const catalog = safeJson(text(rowData(rows, 'catalog')?.content) ?? '') ?? {};
    const config = safeJson(text(rowData(rows, 'config')?.content) ?? '') ?? {};
    const soulContent = safeJson(text(rowData(rows, 'soul')?.content) ?? '') ?? {};
    const soulName = text(soulContent.name);
    const soulInstructions =
      text(soulContent.soul) ??
      [
        text(soulContent.personality) ? `Personality: ${text(soulContent.personality)}` : undefined,
        text(soulContent.intent) ? `Intent: ${text(soulContent.intent)}` : undefined,
      ]
        .filter((value): value is string => Boolean(value))
        .join('\n\n');
    const soulAvatarSeed = text(soulContent.avatarSeed);
    const soulAvatar = text(soulContent.avatar);
    const safeSoulAvatar = soulAvatar && /^https?:\/\//i.test(soulAvatar) ? soulAvatar : undefined;
    const soul =
      soulName && soulInstructions && soulAvatarSeed
        ? {
            name: soulName,
            instructions: soulInstructions,
            avatarSeed: soulAvatarSeed,
            ...(safeSoulAvatar ? { avatar: safeSoulAvatar } : {}),
          }
        : undefined;
    const options = Array.isArray(catalog.options)
      ? catalog.options.flatMap((candidate) => {
          const option = json(candidate);
          const id = text(option.id);
          const category = text(option.category);
          if (!id || !category || !isAllowedAgentModelConfigCategory(category)) return [];
          const choices = Array.isArray(option.options)
            ? option.options.flatMap((raw) => {
                const choice = json(raw);
                const choiceId = text(choice.id);
                return choiceId
                  ? [{ id: choiceId, ...(text(choice.name) ? { name: text(choice.name) } : {}) }]
                  : [];
              })
            : [];
          return [
            {
              id,
              category,
              ...(text(option.currentValue) ? { currentValue: text(option.currentValue) } : {}),
              options: choices,
            },
          ];
        })
      : [];
    const runtime = json(catalog.selection);
    const selected = config;
    const runtimeSelection = {
      ...(text(runtime.model) ? { model: text(runtime.model) } : {}),
      ...(text(runtime.effort) ? { effort: text(runtime.effort) } : {}),
    };
    const selectedSelection = {
      ...(text(selected.model) ? { model: text(selected.model) } : {}),
      ...(text(selected.effort) ? { effort: text(selected.effort) } : {}),
    };
    return {
      workspaceId,
      agent: {
        identity: identity({
          ...agentData,
          ...(soul ? { name: soul.name } : {}),
          ...(soul?.avatar ? { avatar: soul.avatar } : {}),
        }),
        role: agentData.role === 'owner' || agentData.role === 'admin' ? agentData.role : 'member',
      },
      ...(soul ? { soul } : {}),
      catalog: options,
      ...(Object.keys(runtimeSelection).length ? { runtimeSelection } : {}),
      ...(Object.keys(selectedSelection).length ? { selected: selectedSelection } : {}),
      watchFilters: [
        { kinds: [0], authors: [agentPubkey] },
        { kinds: [9, 9000, 9001], '#h': [workspaceId], '#p': [agentPubkey] },
        // Parameterized agent overlays are indexed by their canonical d key,
        // not by their community h tag. All three records share this key.
        { kinds: [30078], '#d': [`${workspaceId}:${agentPubkey}`] },
      ],
    };
  }

  async readRoom(roomId: string, viewerPubkey: string): Promise<RoomView | null> {
    const rows = (
      await this.database.query<IndexRow>(ROOM_PAINT_SQL, [
        roomId,
        viewerPubkey,
        RAW_EVENT_LIMIT,
        ROOM_VIEW_BRIEFING_LIMIT * 4,
      ])
    ).rows;
    return paintRoom(rows, roomId);
  }

  async readHistory(
    roomId: string,
    viewerPubkey: string,
    before?: { readonly createdAt: number; readonly id: string },
  ): Promise<RoomHistoryView | null> {
    const rows = (
      await this.database.query<IndexRow>(ROOM_SQL, [
        roomId,
        viewerPubkey,
        before?.createdAt ?? null,
        before?.id ?? '',
        HISTORY_EVENT_LIMIT,
      ])
    ).rows;
    if (!rowData(rows, 'room')) return null;
    const page = projectedHistoryPage(rows, roomId);
    return {
      roomId,
      messages: page.messages,
      ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
    };
  }

  async readChats(workspaceId: string, viewerPubkey: string): Promise<ChatListView | null> {
    const rows = (
      await this.database.query<IndexRow>(CHAT_LIST_SQL, [
        workspaceId,
        viewerPubkey,
        ROOM_VIEW_CHAT_LIMIT + 1,
        CHAT_PREVIEW_LIMIT,
      ])
    ).rows;
    const workspaceData = rowData(rows, 'workspace');
    if (!workspaceData) return null;
    const previews = new Map<string, RoomViewMessage>();
    for (const row of rows.filter((candidate) => candidate.section === 'preview')) {
      const data = json(row.data);
      const roomId = String(data.roomId ?? '');
      const message = projectEvent(data, roomId);
      const current = previews.get(roomId);
      if (
        message?.presentation === 'message' &&
        (!current ||
          message.createdAt > current.createdAt ||
          (message.createdAt === current.createdAt && message.id < current.id))
      ) {
        previews.set(roomId, message);
      }
    }
    const allChats: ChatListItem[] = rows
      .filter((row) => row.section === 'chat')
      .map((row) => {
        const data = json(row.data);
        const room = header(data);
        const latest = previews.get(room.id);
        return {
          room,
          ...(latest
            ? {
                latestMessage: {
                  id: latest.id,
                  text: latest.text,
                  createdAt: latest.createdAt,
                  author: latest.author,
                },
              }
            : {}),
          memberCount: integer(data.memberCount),
          cornerCount: integer(data.cornerCount),
          unread: data.unread === true,
          ...(text(data.repositoryName) ? { repositoryName: text(data.repositoryName) } : {}),
        };
      })
      .sort(
        (left, right) =>
          right.room.updatedAt - left.room.updatedAt || left.room.id.localeCompare(right.room.id),
      );
    const chats = allChats.slice(0, ROOM_VIEW_CHAT_LIMIT);
    const viewerData = rowData(rows, 'viewer') ?? { pubkey: viewerPubkey };
    return {
      workspace: workspaceItem(workspaceData),
      chats,
      viewer: identity(viewerData),
      truncated: allChats.length > ROOM_VIEW_CHAT_LIMIT,
      watchFilters: [
        { kinds: [9000, 9001], '#p': [viewerPubkey] },
        { kinds: [...DURABLE_KINDS], '#h': [workspaceId, ...chats.map((chat) => chat.room.id)] },
        ...profileFilter([
          identity(viewerData),
          ...chats.flatMap((chat) => (chat.latestMessage ? [chat.latestMessage.author] : [])),
        ]),
      ],
    };
  }

  async readInvite(tokenHash: string, _readerPubkey?: string): Promise<InviteView | null> {
    const rows = (await this.database.query<IndexRow>(INVITE_SQL, [tokenHash])).rows;
    const data = rowData(rows, 'invite');
    if (!data) return null;
    return {
      name: text(data.name) ?? 'WORKSPACE',
      ...(text(data.avatar) ? { avatar: text(data.avatar) } : {}),
      expiresAt: integer(data.expiresAt),
    };
  }

  async readCorners(roomId: string, viewerPubkey: string): Promise<CornerListView | null> {
    const rows = (
      await this.database.query<IndexRow>(CORNER_LIST_SQL, [
        roomId,
        viewerPubkey,
        CHAT_PREVIEW_LIMIT,
      ])
    ).rows;
    const roomData = rowData(rows, 'room');
    if (!roomData) return null;
    const previews = new Map<string, RoomViewMessage>();
    for (const row of rows.filter((candidate) => candidate.section === 'preview')) {
      const data = json(row.data);
      const cornerId = String(data.roomId ?? '');
      const message = projectEvent(data, cornerId);
      if (message?.presentation === 'message' && !previews.has(cornerId))
        previews.set(cornerId, message);
    }
    const corners: CornerListItem[] = rows
      .filter((row) => row.section === 'corner')
      .map((row) => {
        const data = json(row.data);
        const id = String(data.id ?? '');
        return cornerItem(data, previews.get(id));
      });
    return {
      room: header(roomData),
      corners,
      viewer: {
        identity: identity({ pubkey: roomData.viewerPubkey }),
        role: (roomData.viewerRole === 'owner' || roomData.viewerRole === 'admin'
          ? roomData.viewerRole
          : 'member') as 'owner' | 'admin' | 'member',
        permissions: {
          send: roomData.archived !== true,
          manage: roomData.viewerRole === 'owner' || roomData.viewerRole === 'admin',
        },
      },
      watchFilters: [
        {
          kinds: [...DURABLE_KINDS],
          '#h': [
            String(roomData.workspaceId ?? ''),
            roomId,
            ...corners.map((item) => item.corner.id),
          ],
        },
        ...profileFilter(corners.flatMap((item) => (item.agent ? [item.agent] : []))),
      ],
    };
  }
}
