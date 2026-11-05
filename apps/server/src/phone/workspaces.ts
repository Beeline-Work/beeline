import { ROOM_VIEW_CHAT_LIMIT, WORKSPACE_MEMBER_PAGE_SIZE } from '@beeline/api-contract/phone';
import type { WorkspaceListView, WorkspaceMemberListQuery, WorkspaceMemberListView, WorkspaceView } from '@beeline/api-contract/phone';
import { roomNeedsYouSql } from '../chat-corner-counts.js';
import { unreadMessageSql } from '../read-cursor.js';
import type { PhoneContext } from './context.js';
import { assetUrl, identity, reviveDates } from './read-projection.js';
import { unix, MemberGrantRow, PROFILE_GRANT_LIMIT } from './values.js';
import { phoneWorkspaceRoster, phoneProjectMembers, phoneProjectWorkspaceAgents } from './roster.js';
import { IdentityRow, MemberRow, RosterAgentRow, mcpClientIdentitySql } from './types.js';
import { phoneOptionalEnrichment } from './optional-enrichment.js';
import { phoneProjectMemberGrantRows } from './agent-reads.js';



  export async function phoneReadWorkspaces(ctx: PhoneContext, viewerId: string): Promise<WorkspaceListView> {
    const rows = await ctx.database.query<{
      id: string | null;
      name: string | null;
      avatar: string | null;
      visibility: 'public' | 'invite-only' | null;
      role: 'owner' | 'admin' | 'member' | 'spectator' | null;
      updated_at: Date | null;
      room_count: string | null;
      attention: boolean | null;
      viewer_id: string;
      viewer_kind: 'human' | 'agent';
      viewer_name: string;
      viewer_handle: string | null;
      viewer_avatar: string | null;
      viewer_face_id: string | null;
      deleted_notices: { workspaceId: string; workspaceName: string }[] | null;
    }>(
      `WITH deleted AS (
         DELETE FROM workspace_deletion_notices WHERE identity_id=$1
         RETURNING workspace_id
       ), visible AS (
       SELECT w.id, w.name, w.avatar, w.visibility, m.role, w.updated_at, summary.room_count, summary.attention
       FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
       LEFT JOIN LATERAL (
         SELECT count(*)::text room_count,COALESCE(bool_or(
           (latest.id IS NOT NULL AND (mark.message_created_at IS NULL OR
             latest.id<>mark.message_id AND (latest.created_at,latest.id)>(mark.message_created_at,mark.message_id)))
           OR ${roomNeedsYouSql('r')}
         ),false) attention
         FROM rooms r JOIN memberships member ON member.room_id=r.id
           AND member.identity_id=$2 AND member.removed_at IS NULL
         LEFT JOIN room_read_marks mark ON mark.room_id=r.id AND mark.identity_id=$2
         LEFT JOIN LATERAL (
           SELECT message.id,message.created_at FROM messages message
           WHERE message.room_id=r.id AND ${unreadMessageSql('message')}
           ORDER BY message.created_at DESC,message.id DESC LIMIT 1
         ) latest ON true
         WHERE r.workspace_id=w.id AND r.parent_id IS NULL AND r.archived_at IS NULL
       ) summary ON true
       WHERE m.identity_id = $1 AND m.room_id IS NULL AND m.removed_at IS NULL
       ORDER BY w.updated_at DESC, w.id LIMIT 51
       )
       SELECT visible.*,viewer.id viewer_id,viewer.kind viewer_kind,
         viewer.name viewer_name,viewer.handle viewer_handle,
         viewer.avatar viewer_avatar,viewer.face_id viewer_face_id,
         (SELECT jsonb_agg(jsonb_build_object('workspaceId',deleted.workspace_id,
            'workspaceName',deletion.workspace_name))
          FROM deleted JOIN workspace_deletions deletion USING(workspace_id)) deleted_notices
       FROM identities viewer LEFT JOIN visible ON true
       WHERE viewer.id=$1
       ORDER BY visible.updated_at DESC NULLS LAST,visible.id`,
      [viewerId, viewerId], 'phone-workspaces-0',
    );
    const viewer = rows.rows[0];
    if (!viewer) throw new Error('identity not found');
    const workspaces = rows.rows.filter((row) => row.id !== null) as (typeof rows.rows)[number][];
    return {
      workspaces: workspaces.slice(0, 50).map((row) => ({
        id: row.id!,
        name: row.name!,
        ...(row.avatar ? { avatar: assetUrl(row.avatar, ctx.publicOrigin) } : {}),
        visibility: row.visibility!,
        role: row.role!,
        updatedAt: unix(row.updated_at!),
        roomCount: Number(row.room_count),
        attention: Boolean(row.attention),
      })),
      viewer: identity({
        id: viewer.viewer_id,kind: viewer.viewer_kind,name: viewer.viewer_name,
        handle: viewer.viewer_handle,avatar: viewer.viewer_avatar,face_id: viewer.viewer_face_id,
      }, ctx.publicOrigin),
      truncated: workspaces.length > 50,
      watchFilters: [],
      ...(viewer.deleted_notices?.length ? { deletedNotices: viewer.deleted_notices } : {}),
    };
  }


  export async function phoneReadWorkspace(ctx: PhoneContext, workspaceId: string, viewerId: string,query:WorkspaceMemberListQuery={}): Promise<WorkspaceView | null> {
    const roster = await phoneWorkspaceRoster(ctx, workspaceId, viewerId,query);
    if (!roster) return null;
    const row = roster.workspaceRow;
    const managedRooms = row.role === 'owner' || row.role === 'admin'
      ? roster.managedRoomRows.slice(0, ROOM_VIEW_CHAT_LIMIT).map((room) => ({
          id: room.id,name: room.name,visibility: room.visibility,
          createdAt: unix(room.created_at),
        }))
      : undefined;
    return {
      workspace: {
        id: row.id,name: row.name,
        ...(row.avatar ? { avatar: assetUrl(row.avatar, ctx.publicOrigin) } : {}),
        visibility: row.visibility,role: row.role,updatedAt: unix(row.updated_at),
        createdAt: unix(row.created_at),
      },
      ...(managedRooms ? { managerSettings: {
        visibility: row.visibility,allowFixSweep: row.allow_fix_sweep,rooms: managedRooms,
        roomsTruncated: roster.managedRoomRows.length > ROOM_VIEW_CHAT_LIMIT,
      } } : {}),
      members: roster.members,agents: roster.agents,
      peopleTotal: roster.peopleTotal,agentTotal: roster.agentTotal,
      membersTruncated: roster.membersTruncated,agentsTruncated: roster.agentsTruncated,
      viewer: {
        identity: roster.viewerIdentity,role: row.role,
        permissions: { send: row.role !== 'spectator',
          manage: row.role === 'owner' || row.role === 'admin' },
      },
      watchFilters: [],
    };
  }


  export async function phoneReadWorkspaceMembers(ctx: PhoneContext, 
    workspaceId: string,
    viewerId: string,
    query: WorkspaceMemberListQuery = {},
  ): Promise<WorkspaceMemberListView | null> {
    if (!query.memberId) {
      const roster = await phoneWorkspaceRoster(ctx, workspaceId, viewerId, query);
      if (!roster) return null;
      return {
        members: roster.members,agents: roster.agents,
        peopleTotal: roster.peopleTotal,agentTotal: roster.agentTotal,
        membersTruncated: roster.membersTruncated,agentsTruncated: roster.agentsTruncated,
      };
    }
    // One profile read: the person, their grants and the agents they own.
    const detail = await ctx.database.query<{
      role: 'owner' | 'admin' | 'member' | 'spectator';
      viewer_row: IdentityRow;
      member_row: MemberRow | null;
      grant_rows: MemberGrantRow[];
      owned_rows: RosterAgentRow[];
      owned_total: string;
    }>(`WITH authorized AS (
        SELECT role FROM memberships WHERE workspace_id=$1 AND room_id IS NULL
          AND identity_id=$2 AND removed_at IS NULL
      ), member_row AS (
        SELECT i.id,i.kind,i.name,i.handle,i.avatar,i.face_id,m.role,
          NULL::jsonb presence_body,NULL::timestamptz presence_updated_at
        FROM memberships m JOIN identities i ON i.id=m.identity_id
        WHERE m.workspace_id=$1 AND m.room_id IS NULL AND m.identity_id=$3
          AND m.removed_at IS NULL AND i.kind='human' AND i.hidden_from_roster=false
      ), owned AS (
        SELECT i.id,i.kind,i.name,i.handle,i.avatar,i.face_id,m.role,
          NULL::jsonb presence_body,NULL::timestamptz presence_updated_at,
          agent.selected_model,agent.model_catalog,
          ${mcpClientIdentitySql('agent.agent_id')} mcp_client,
          owner.id owner_id,owner.name owner_name,owner.handle owner_handle
        FROM agents agent JOIN identities i ON i.id=agent.agent_id
        JOIN memberships m ON m.identity_id=i.id
        JOIN identities owner ON owner.id=agent.owner_id
        WHERE agent.owner_id=$3 AND m.workspace_id=$1 AND m.room_id IS NULL
          AND m.removed_at IS NULL AND i.kind='agent' AND i.hidden_from_roster=false
      )
      SELECT authorized.role,to_jsonb(viewer) viewer_row,
        (SELECT to_jsonb(member_row) FROM member_row) member_row,
        COALESCE((SELECT jsonb_agg(to_jsonb(page)) FROM (
          SELECT * FROM owned ORDER BY lower(name),id LIMIT $5
        ) page),'[]'::jsonb) owned_rows,
        (SELECT count(*)::text FROM owned) owned_total,
        COALESCE((SELECT jsonb_agg(to_jsonb(grant_row) ORDER BY created_at DESC,id) FROM (
          SELECT g.id,g.kind,g.target,g.reason,g.status,g.room_id,g.auto,g.created_at,
            g.decided_at,g.expires_at,
            CASE WHEN EXISTS(SELECT 1 FROM memberships rm
              WHERE rm.room_id=g.room_id AND rm.identity_id=$2 AND rm.removed_at IS NULL)
              OR (room.parent_id IS NULL AND room.direct_participants IS NULL
                AND room.archived_at IS NULL AND authorized.role IN ('owner','admin'))
              THEN room.name END room_name,g.script,
            to_jsonb(agent_identity) agent,to_jsonb(requester) requester,
            to_jsonb(decider) decider
          FROM agent_grants g JOIN rooms room ON room.id=g.room_id
          JOIN agents a ON a.agent_id=g.agent_id AND a.owner_id=$3
          JOIN identities agent_identity ON agent_identity.id=g.agent_id
          JOIN identities requester ON requester.id=g.requested_by
          LEFT JOIN identities decider ON decider.id=g.decided_by
          WHERE g.workspace_id=$1 AND g.status<>'pending'
            AND (g.kind IN ('repository','shared_asset') OR a.owner_id=$2)
          ORDER BY g.created_at DESC,g.id LIMIT $4
        ) grant_row),'[]'::jsonb) grant_rows
      FROM authorized JOIN identities viewer ON viewer.id=$2`,
      [workspaceId, viewerId, query.memberId, PROFILE_GRANT_LIMIT, WORKSPACE_MEMBER_PAGE_SIZE + 1]);
    const row = detail.rows[0];
    if (!row) return null;
    const member = row.member_row ? reviveDates(row.member_row, ['presence_updated_at']) : null;
    const ownedRows = row.owned_rows.slice(0, WORKSPACE_MEMBER_PAGE_SIZE);
    const presenceRows: MemberRow[] = [...(member ? [member] : []), ...ownedRows];
    if (presenceRows.length) {
      const presence = await phoneOptionalEnrichment(ctx, 'member-presence',
        ctx.enrichmentDatabase.query<{ id: string; presence_body: MemberRow['presence_body'];
          presence_updated_at: Date }>(`SELECT DISTINCT ON (agent_id) agent_id id,body presence_body,
            updated_at presence_updated_at
          FROM live_outputs WHERE agent_id=ANY($1::text[]) AND kind='presence'
          ORDER BY agent_id,updated_at DESC`, [presenceRows.map((entry) => entry.id)]));
      const byId = new Map(presence?.rows.map((entry) => [entry.id, entry]) ?? []);
      for (const entry of presenceRows) {
        entry.presence_body = byId.get(entry.id)?.presence_body ?? null;
        entry.presence_updated_at = byId.get(entry.id)?.presence_updated_at ?? null;
      }
    }
    const role = row.role;
    return {
      viewer: { identity: identity(row.viewer_row, ctx.publicOrigin), role,
        permissions: { send: role !== 'spectator', manage: role === 'owner' || role === 'admin' } },
      members: member ? phoneProjectMembers(ctx, [member], null) : [],
      agents: phoneProjectWorkspaceAgents(ctx, ownedRows, ownedRows),
      grants: phoneProjectMemberGrantRows(ctx, row.grant_rows.map((grant) =>
        reviveDates(grant, ['created_at', 'decided_at', 'expires_at']))),
      agentTotal: Number(row.owned_total),
      membersTruncated: false,agentsTruncated: row.owned_rows.length > WORKSPACE_MEMBER_PAGE_SIZE,
    };
  }
