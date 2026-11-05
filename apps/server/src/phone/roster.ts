import { mcpClientName } from '../rooms-mcp-logos.js';
import { agentUsageColumns, projectAgentUsage } from '../agent-usage.js';
import { ROOM_VIEW_CHAT_LIMIT, WORKSPACE_MEMBER_PAGE_SIZE } from '@beeline/api-contract/phone';
import type { RoomViewIdentity, RoomViewMember, WorkspaceAgentView, WorkspaceMemberListQuery, WorkspaceMemberListView } from '@beeline/api-contract/phone';
import type { PhoneContext } from './context.js';
import { IdentityRow, MemberRow, RosterAgentRow, mcpClientIdentitySql } from './types.js';
import { phoneOptionalEnrichment } from './optional-enrichment.js';
import { reviveDates, identity, selectedModelLabel, projectAgentPresence } from './read-projection.js';



  export function phoneRosterSearchNeedle(ctx: PhoneContext, query: string | undefined): string | null {
    const needle = query?.trim().toLowerCase() ?? '';
    return needle ? needle.slice(0, 80) : null;
  }


  export async function phoneWorkspaceRoster(ctx: PhoneContext, 
    workspaceId: string,
    viewerId: string,
    query: WorkspaceMemberListQuery = {},
  ): Promise<(WorkspaceMemberListView & {
    workspaceRow: {
      id: string; name: string; avatar: string | null;
      visibility: 'public' | 'invite-only'; allow_fix_sweep: boolean; created_at: Date; updated_at: Date;
      role: 'owner' | 'admin' | 'member' | 'spectator';
    };
    viewerIdentity: RoomViewIdentity;
    managedRoomRows: Array<{
      id: string; name: string; visibility: 'public' | 'invite-only'; created_at: Date;
    }>;
  }) | null> {
    const needle = phoneRosterSearchNeedle(ctx, query.q);
    const offset = Number.isSafeInteger(query.offset) && (query.offset ?? 0) > 0
      ? query.offset! : 0;
    const kind = query.kind === 'human' || query.kind === 'agent' ? query.kind : undefined;
    const result = await ctx.database.query<{
      workspace_row: {
        id: string; name: string; avatar: string | null;
        visibility: 'public' | 'invite-only'; allow_fix_sweep: boolean; created_at: Date; updated_at: Date;
        role: 'owner' | 'admin' | 'member' | 'spectator';
      };
      viewer_row: IdentityRow;
      managed_room_rows: Array<{
        id: string; name: string; visibility: 'public' | 'invite-only'; created_at: Date;
      }>;
      people_rows: MemberRow[];
      agent_rows: RosterAgentRow[];
      people_total: string;
      agent_total: string;
    }>(`WITH visible_workspace AS (
        SELECT w.id,w.name,w.avatar,w.visibility,w.allow_fix_sweep,w.created_at,w.updated_at,wm.role
        FROM workspaces w JOIN memberships wm ON wm.workspace_id=w.id AND wm.room_id IS NULL
        WHERE w.id=$1 AND wm.identity_id=$7 AND wm.removed_at IS NULL
      ), viewer_row AS (
        SELECT id,kind,name,handle,avatar,face_id FROM identities WHERE id=$7
      ), people AS (
        SELECT i.id,i.kind,i.name,i.handle,i.avatar,i.face_id,m.role,
          NULL::jsonb presence_body,NULL::timestamptz presence_updated_at
        FROM memberships m JOIN identities i ON i.id=m.identity_id
        WHERE m.workspace_id=$1 AND m.room_id IS NULL AND m.removed_at IS NULL
          AND i.hidden_from_roster=false AND i.kind='human'
          AND ($2::text IS NULL OR position($2 in lower(i.name))>0
            OR position($2 in lower(COALESCE(i.handle,'')))>0)
      ), agent_rows AS (
        SELECT i.id,i.kind,i.name,i.handle,i.avatar,i.face_id,m.role,
          NULL::jsonb presence_body,NULL::timestamptz presence_updated_at,
          agent.selected_model,agent.model_catalog,
          ${mcpClientIdentitySql('agent.agent_id')} mcp_client,
          owner.id owner_id,owner.name owner_name,owner.handle owner_handle,
          ${(agentUsageColumns('agent', '$7'))}
        FROM memberships m JOIN identities i ON i.id=m.identity_id
        LEFT JOIN agents agent ON agent.agent_id=i.id
        LEFT JOIN identities owner ON owner.id=agent.owner_id
        WHERE m.workspace_id=$1 AND m.room_id IS NULL AND m.removed_at IS NULL
          AND i.hidden_from_roster=false AND i.kind='agent'
          AND ($2::text IS NULL OR position($2 in lower(i.name))>0
            OR position($2 in lower(COALESCE(i.handle,'')))>0)
          AND ($5::text IS NULL OR $4::text='human' OR agent.owner_id=$5)
      )
      SELECT to_jsonb(visible_workspace) workspace_row,
        to_jsonb(viewer_row) viewer_row,
        COALESCE((SELECT jsonb_agg(to_jsonb(managed)) FROM (
          SELECT id,name,visibility,created_at FROM rooms
          WHERE workspace_id=$1 AND parent_id IS NULL AND direct_participants IS NULL
            AND archived_at IS NULL
            AND visible_workspace.role IN ('owner','admin')
          ORDER BY lower(name),name,id LIMIT $8
        ) managed),'[]'::jsonb) managed_room_rows,
        (SELECT count(*)::text FROM people) people_total,
        (SELECT count(*)::text FROM agent_rows) agent_total,
        COALESCE((SELECT jsonb_agg(to_jsonb(page)) FROM (
          SELECT * FROM people
          ORDER BY CASE WHEN role='owner' THEN 0 ELSE 1 END,lower(name),id
          LIMIT $6 OFFSET CASE WHEN $4='human' THEN $3 ELSE 0 END
        ) page),'[]'::jsonb) people_rows,
        COALESCE((SELECT jsonb_agg(to_jsonb(page)) FROM (
          SELECT * FROM agent_rows ORDER BY lower(name),id
          LIMIT $6 OFFSET CASE WHEN $4='agent' THEN $3 ELSE 0 END
        ) page),'[]'::jsonb) agent_rows
      FROM visible_workspace JOIN viewer_row ON true`,
      [workspaceId, needle, offset, kind ?? null, query.ownerId ?? null,
        WORKSPACE_MEMBER_PAGE_SIZE + 1, viewerId, ROOM_VIEW_CHAT_LIMIT + 1],
    );
    const data = result.rows[0];
    if (!data) return null;
    const peoplePage = kind === 'agent' ? [] : data.people_rows;
    const agentPage = kind === 'human' ? [] : data.agent_rows;
    const peopleTruncated = peoplePage.length > WORKSPACE_MEMBER_PAGE_SIZE;
    const agentsTruncated = agentPage.length > WORKSPACE_MEMBER_PAGE_SIZE;
    const pageRows: MemberRow[] = [
      ...peoplePage.slice(0, WORKSPACE_MEMBER_PAGE_SIZE),
      ...agentPage.slice(0, WORKSPACE_MEMBER_PAGE_SIZE),
    ];
    if ((pageRows.length)) {
      const presence = await phoneOptionalEnrichment(ctx, 
        'member-presence',
        ctx.enrichmentDatabase.query<{
          id: string; presence_body: MemberRow['presence_body']; presence_updated_at: Date;
        }>(`SELECT member.identity_id id,presence.body presence_body,
            presence.updated_at presence_updated_at
          FROM memberships member
          JOIN LATERAL(
            SELECT body,updated_at FROM live_outputs
            WHERE agent_id=member.identity_id AND kind='presence'
            ORDER BY updated_at DESC LIMIT 1
          ) presence ON true
          WHERE member.workspace_id=$1 AND member.room_id IS NULL
            AND member.removed_at IS NULL AND member.identity_id=ANY($2::text[])`,
          [workspaceId, pageRows.map((row) => row.id)],
        ),
      );
      const byId = new Map(presence?.rows.map((row) => [row.id, row]) ?? []);
      for (const row of pageRows) {
        const found = byId.get(row.id);
        row.presence_body = found?.presence_body ?? null;
        row.presence_updated_at = found?.presence_updated_at ?? null;
      }
    }
    const people = phoneProjectMembers(ctx, pageRows.filter((row) => row.kind === 'human'), null);
    const agents = phoneProjectWorkspaceAgents(ctx, pageRows.filter((row) => row.kind === 'agent'), agentPage);
    return {
      workspaceRow: reviveDates(data.workspace_row, ['created_at', 'updated_at']),
      viewerIdentity: identity(data.viewer_row, ctx.publicOrigin),
      managedRoomRows: data.managed_room_rows.map((row) => reviveDates(row, ['created_at'])),
      members: people,agents,
      peopleTotal: Number(data.people_total),agentTotal: Number(data.agent_total),
      membersTruncated: peopleTruncated,agentsTruncated,
    };
  }


  /** Roster agent rows with their selected model and owner, as every roster read shows them. */
  export function phoneProjectWorkspaceAgents(ctx: PhoneContext, rows: MemberRow[], configs: RosterAgentRow[]): WorkspaceAgentView[] {
    const agentConfig = new Map(configs.map((row) => [row.id, row]));
    return phoneProjectMembers(ctx, rows, null).map((member) => {
      const config = agentConfig.get(member.identity.pubkey);
      const model = config?.mcp_client
        ? mcpClientName(config.mcp_client.name, config.mcp_client.redirects)
        : config ? selectedModelLabel(config.selected_model, config.model_catalog ?? []) : undefined;
      // Usage columns are owner-filtered in SQL; other viewers' rows carry nulls.
      const usage = (config) ? projectAgentUsage(config) : undefined;
      return {
        ...member,
        ...(model ? { model } : {}),
        ...(usage ? { usage } : {}),
        ...(config?.owner_id && config.owner_name ? { owner: {
          pubkey: config.owner_id,kind: 'human' as const,name: config.owner_name,
          ...(config.owner_handle ? { handle: config.owner_handle } : {}),
        } } : {}),
      };
    });
  }


  export async function phoneMembers(ctx: PhoneContext, 
    workspaceId: string,
    roomId: string | null,
    memberId?: string,
  ): Promise<RoomViewMember[]> {
    const rows = await ctx.database.query<MemberRow>(
      `SELECT i.id,
         i.kind,i.name,i.handle,i.avatar,
         i.face_id,
         COALESCE(workspace_member.role,m.role) role,NULL::jsonb presence_body,
         NULL::timestamptz presence_updated_at
       FROM memberships m JOIN identities i ON i.id=m.identity_id
       LEFT JOIN memberships workspace_member ON workspace_member.workspace_id=m.workspace_id
         AND workspace_member.room_id IS NULL AND workspace_member.identity_id=m.identity_id
         AND workspace_member.removed_at IS NULL
       WHERE m.workspace_id=$1 AND ($2::uuid IS NULL AND m.room_id IS NULL OR m.room_id=$2)
         AND m.removed_at IS NULL AND i.hidden_from_roster=false
         AND ($3::text IS NULL OR i.id=$3)`,
      [workspaceId, roomId, memberId ?? null],
    );
    const presence = await phoneOptionalEnrichment(ctx, 
      'member-presence',
      ctx.enrichmentDatabase.query<{
        id: string;
        presence_body: MemberRow['presence_body'];
        presence_updated_at: Date;
      }>(
        `SELECT member.identity_id id,presence.body presence_body,
           presence.updated_at presence_updated_at
         FROM memberships member
         JOIN LATERAL(
           SELECT body,updated_at FROM live_outputs
           WHERE agent_id=member.identity_id AND kind='presence'
           ORDER BY updated_at DESC LIMIT 1
         ) presence ON true
         WHERE member.workspace_id=$1 AND ($2::uuid IS NULL AND member.room_id IS NULL OR member.room_id=$2)
           AND member.removed_at IS NULL AND ($3::text IS NULL OR member.identity_id=$3)`,
        [workspaceId, roomId, memberId ?? null],
      ),
    );
    const presenceByMember = new Map(presence?.rows.map((item) => [item.id, item]) ?? []);
    for (const member of rows.rows) {
      const item = presenceByMember.get(member.id);
      member.presence_body = item?.presence_body ?? null;
      member.presence_updated_at = item?.presence_updated_at ?? null;
    }
    return phoneProjectMembers(ctx, rows.rows, roomId);
  }

  export function phoneProjectMembers(ctx: PhoneContext, rows: readonly MemberRow[], roomId: string | null): RoomViewMember[] {
    return rows.map((row) => ({
      identity: identity(row, ctx.publicOrigin),
      role: row.role,
      ...(row.presence_body && row.presence_updated_at
        ? { presence: projectAgentPresence(row.presence_body, row.presence_updated_at, roomId) }
        : {}),
    }));
  }
