// SENTRY-22: frozen loadCorners/cornerRowsSql templates from release
// 2e6951beb1c06174a9adf4c6af6dbfd27d3f94c6, open list with deck=false.
// Shared corner fact projections stay current; retired app references are frozen.
import { cornerFactsSql } from '../chat-corner-counts.js';
import { cornerRoomColumnsSql } from '../corner-row-projection.js';

export function priorReleaseCornerListSql(): string {
  const facts = cornerFactsSql('$2');
  const archivedMicros = '(extract(epoch FROM c.archived_at)*1000000)::bigint';
  const createdMicros = '(extract(epoch FROM c.created_at)*1000000)::bigint';
  const archived = false;
  const keyset = '';
  const order = 'ORDER BY c.created_at DESC,c.id DESC';
  const limit = 'LIMIT 31';
  const cornerQuery = `
      SELECT ${cornerRoomColumnsSql},${facts.columns},f.objective,lm.id latest_id,lm.text latest_text,lm.author_id latest_author_id,
        initiator.id initiator_id,initiator.name initiator_name,
        initiator.handle initiator_handle,initiator.avatar initiator_avatar,
        initiator.face_id initiator_face,
        li.kind latest_author_kind,li.name latest_author_name,agent.identity_id agent_id,
        agent.name agent_name,agent.handle agent_handle,agent.avatar agent_avatar,
        app_binding.installation_id app_installation_id,
        app_binding.instance_id app_instance_id,app_installation.manifest app_manifest,
        ${archivedMicros}::text archived_us,
        ${createdMicros}::text created_us,
        (SELECT max(brief.revision) FROM corner_brief_revisions brief WHERE brief.corner_id=c.id) brief_revision
      FROM rooms c ${facts.joins}
      LEFT JOIN identities initiator
        ON initiator.id=f.commissioned_by AND initiator.kind='human'
      LEFT JOIN identities li ON li.id=lm.author_id
      LEFT JOIN LATERAL (
        SELECT i.id identity_id,
          i.name,i.handle,i.avatar
        FROM identities i
        LEFT JOIN memberships member ON member.room_id=c.id AND member.identity_id=i.id
          AND member.removed_at IS NULL
        WHERE i.id=f.owner_agent_id
          AND i.kind='agent' LIMIT 1
      ) agent ON true
      LEFT JOIN corner_app_bindings app_binding ON app_binding.corner_id=c.id
      LEFT JOIN corner_app_installations app_installation ON app_installation.id=app_binding.installation_id
      WHERE c.parent_id=$1 AND c.archived_at IS ${archived ? 'NOT NULL' : 'NULL'} AND ${facts.member}
        AND EXISTS (SELECT 1 FROM authorized) ${keyset} ${order} ${limit}`;
  return `WITH authorized AS (
        SELECT r.*,workspace_member.role workspace_role
        FROM rooms r JOIN memberships m ON m.room_id=r.id
        JOIN memberships workspace_member ON workspace_member.workspace_id=r.workspace_id
          AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
          AND workspace_member.removed_at IS NULL
        WHERE r.id=$1 AND m.identity_id=$2 AND m.removed_at IS NULL
      ), selected_corners AS (${cornerQuery})
      SELECT to_jsonb(authorized) room_row,
        COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY ${archived
          ? 'c.archived_at DESC,c.id DESC' : 'c.created_at DESC,c.id DESC'})
          FROM selected_corners c),'[]'::jsonb) corner_rows,
        jsonb_build_object('id',viewer.id,'kind',viewer.kind,'name',viewer.name,
          'handle',viewer.handle,'avatar',viewer.avatar,'face_id',viewer.face_id) viewer_row,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',app.id,'manifest',app.manifest)
          ORDER BY app.connected_at DESC,app.id)
          FROM corner_app_installations app WHERE app.workspace_id=authorized.workspace_id),'[]'::jsonb) app_rows,
        NULL::jsonb deck
      FROM authorized JOIN identities viewer ON viewer.id=$2`;
}
