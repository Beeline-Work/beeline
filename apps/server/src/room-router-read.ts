import { taggedIdentityIdsSql } from './message-mentions.js';
const mediaPath = `CASE WHEN file->>'url' LIKE '/%' THEN file->>'url' ELSE
  regexp_replace(split_part(split_part(file->>'url','?',1),'#',1),'^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]+','') END`;

/** These CTEs extend PhoneService's existing authorized Room query. They use
 * that statement's permission cut and bounded row sets, not another checkout. */
export const ROOM_ROUTER_CTES = `,
 router_tool_grouped AS (
   SELECT message.id,message.author_id,message.created_at,message.request_id,message.turn_id,
     count(*) OVER(PARTITION BY message.author_id,message.request_id,message.turn_id)::int count,
     row_number() OVER(PARTITION BY message.author_id,message.request_id,message.turn_id ORDER BY message.created_at DESC,message.id DESC) ordinal
   FROM authorized_room room JOIN messages message ON message.room_id=room.id
   WHERE message.presentation='activity' AND message.deleted_at IS NULL AND message.durable_fact IS NULL
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(message.activity) item WHERE item->>'kind'='tool')
 ), router_tool_summaries AS (
   SELECT grouped.id,grouped.author_id,grouped.created_at,grouped.request_id,grouped.count,
     left(person.name,128) name,person.kind FROM router_tool_grouped grouped JOIN identities person ON person.id=grouped.author_id
   WHERE ordinal=1 ORDER BY grouped.created_at DESC,grouped.id DESC LIMIT 30
 ), router_read_messages AS (
   SELECT id,attachments FROM transcript_rows UNION SELECT id,attachments FROM corner_briefing_rows
 ), router_visible_ids AS (
   SELECT id FROM transcript_rows UNION SELECT id FROM activity_rows
 ), router_media_messages AS (
   SELECT id,attachments FROM router_read_messages UNION SELECT id,attachments FROM activity_rows
 ), router_media_ids AS (
   SELECT DISTINCT substring(${mediaPath} FROM '^/v1/media/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$')::uuid id
   FROM router_media_messages message CROSS JOIN LATERAL jsonb_array_elements(message.attachments) file
   WHERE (${mediaPath})~'^/v1/media/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
 )`;

export function roomRouterColumnsSql(): string {
  return `,
    jsonb_build_object('epoch',stream.epoch,'sequence',stream.sequence::text,
      'scopes',COALESCE((SELECT jsonb_agg(jsonb_build_object('authorityScope',domain,'epoch',authority.epoch::text) ORDER BY domain)
        FROM unnest(array_remove(ARRAY['reader:'||$2::text||':workspace:'||authorized_room.workspace_id::text,
          'room:'||authorized_room.id::text,'room:'||authorized_room.parent_id::text],NULL)) domain
        LEFT JOIN router_authority authority ON authority.scope=domain),'[]'::jsonb)) router_metadata,
    COALESCE((SELECT jsonb_agg(to_jsonb(summary)) FROM router_tool_summaries summary),'[]'::jsonb) router_tools,
    jsonb_build_object(
      'presence',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',member.identity_id,
        'presence_body',presence.body,'presence_updated_at',presence.updated_at))
        FROM memberships member LEFT JOIN LATERAL(SELECT body,updated_at FROM live_outputs
          WHERE agent_id=member.identity_id AND kind='presence' ORDER BY updated_at DESC LIMIT 1) presence ON true
        WHERE member.room_id=COALESCE(authorized_room.parent_id,authorized_room.id) AND member.removed_at IS NULL
          AND member.identity_id IN(SELECT id FROM member_rows)),'[]'::jsonb),
      'tags',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,'tagged_ids',${roomMessageTagsSql('m')}))
        FROM messages m WHERE m.id IN(SELECT id FROM router_read_messages)),'[]'::jsonb),
      'bookmarks',COALESCE((SELECT jsonb_agg(jsonb_build_object('message_id',message_id)) FROM message_bookmarks
        WHERE identity_id=$2 AND message_id IN(SELECT id FROM router_visible_ids)),'[]'::jsonb),
      'reports',COALESCE((SELECT jsonb_agg(jsonb_build_object('trigger_message_id',trigger_message_id)) FROM feedback_items
        WHERE source_kind='human' AND trigger_message_id IN(SELECT id FROM router_visible_ids)),'[]'::jsonb),
      'expired',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id::text)) FROM object_expirations
        WHERE id IN(SELECT id FROM router_media_ids)),'[]'::jsonb),
      'objects',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',object.id::text,'title',COALESCE(object.title,''),
        'mime',object.mime,'size',object.size::text,'author',COALESCE(person.handle,person.name)))
        FROM objects object JOIN identities person ON person.id=object.owner_id
        WHERE object.state='ready' AND object.id IN(SELECT id FROM router_media_ids)),'[]'::jsonb),
      'allow_auto_merge',(SELECT allow_auto_merge FROM github_repositories WHERE repository_id=
        substring(CASE WHEN authorized_room.parent_id IS NULL THEN authorized_room.repository_key
          ELSE (SELECT repository_key FROM rooms parent WHERE parent.id=authorized_room.parent_id) END
          FROM '^github:([0-9]+)$')::bigint)) router_enrichment`;
}

/** Equal closed bounds preserve the DESC index pathkey. An equality join lets
 * PostgreSQL discard that ordering and scan old head versions before the
 * current one, pruning their full heap pages on the first read after a bulk
 * commit. The existing primary key serves this one-key backward lookup;
 * no index, writer work, warm-up or read-side maintenance is added. */
export const ROOM_ROUTER_HEAD_JOIN = `LEFT JOIN LATERAL (
  SELECT epoch,sequence FROM live_streams
  WHERE id>='workspace:'||authorized_room.workspace_id::text
    AND id<='workspace:'||authorized_room.workspace_id::text
  ORDER BY id DESC LIMIT 1
) stream ON true`;

/** No tokenizer branch can produce a mention without an @ character. Keep
 * the complete existing tokenizer/ambiguity rules for every possible tag. */
export function roomMessageTagsSql(alias: string): string {
  return `CASE WHEN strpos(${alias}.text,'@')=0 THEN '{}'::text[] ELSE ${taggedIdentityIdsSql(alias)} END`;
}
