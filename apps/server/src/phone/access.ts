import { phoneIdentity as identity, type PhoneIdentityRow as IdentityRow } from '../phone-identity.js';
import type { AgentGrantView } from '@beeline/api-contract/phone';
import { type AgentGrantStatus } from '@beeline/api-contract/agent-grants';
import { type SqlDatabase } from '../database.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { PhoneContext } from './context.js';
import { AGENT_OWNER_AUTHORITY_MESSAGE, WORKSPACE_ADMIN_AUTHORITY_MESSAGE } from './values.js';



  export function phoneCanReadRoom(ctx: PhoneContext, roomId: string, identityId: string): Promise<boolean> {
    return phoneHasRoomAccess(ctx, roomId, identityId);
  }


  /** One membership query for a live subscribe batch (Room deck watchFilters). */
  export async function phoneCanReadRooms(ctx: PhoneContext, roomIds: readonly string[], identityId: string): Promise<ReadonlySet<string>> {
    const unique = [...new Set(roomIds.filter((id) => typeof id === 'string' && id.length > 0))];
    if (unique.length === 0) return new Set();
    const result = await ctx.database.query<{ room_id: string }>(
      `SELECT room_member.room_id::text AS room_id FROM memberships room_member
       JOIN rooms room ON room.id=room_member.room_id
       WHERE room_member.room_id = ANY($1::uuid[]) AND room_member.identity_id=$2
         AND room_member.removed_at IS NULL
         AND ($2=$3 OR EXISTS(
           SELECT 1 FROM memberships workspace_member
           WHERE workspace_member.workspace_id=room.workspace_id
             AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
             AND workspace_member.removed_at IS NULL
         ))`,
      [unique, identityId, SYSTEM_IDENTITY_ID],
    );
    return new Set(result.rows.map((row) => row.room_id));
  }

  export async function phoneRequireGrantAuthority(ctx: PhoneContext, grantId: unknown, viewerId: string) {
    if (typeof grantId !== 'string' || !grantId) throw new Error('grantId is required');
    const grant = (
      await ctx.database.query<{
        agent_id: string;
        workspace_id: string;
        room_id: string;
        kind: AgentGrantView['kind'];
        target: string;
        status: AgentGrantStatus;
        owner_id: string;
        app_owner_id: string | null;
      }>(
        `SELECT g.agent_id,g.workspace_id,g.room_id,g.kind,g.target,g.status,a.owner_id,
                app.owner_identity_id app_owner_id
         FROM agent_grants g JOIN agents a ON a.agent_id=g.agent_id
         LEFT JOIN workspace_apps app ON app.id=g.app_id
         WHERE g.id::text=$1`,
        [grantId],
      )
    ).rows[0];
    if (!grant) throw new Error('grant not found');
    if (grant.target.startsWith('app:') ||
      (grant.kind === 'mcp' && grant.target.startsWith('connection-install:') && grant.app_owner_id)) {
      if (!grant.app_owner_id || grant.app_owner_id !== viewerId)
        throw new Error('app approval access denied: requires the connected person');
      const member = await ctx.database.query(
        `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL
         AND identity_id=$2 AND removed_at IS NULL`,
        [grant.workspace_id, viewerId],
      );
      if (!member.rowCount) throw new Error('app approval access denied');
      return grant;
    }
    if (grant.kind === 'shared_asset') {
      const member = await ctx.database.query(
        `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL
         AND identity_id=$2 AND removed_at IS NULL
         AND (role IN ('owner','admin') OR $2=$3)`,
        [grant.workspace_id, viewerId, grant.owner_id],
      );
      if (!member.rowCount)
        throw new Error('shared asset approval access denied: requires a Workspace manager or the agent owner');
      return grant;
    }
    if (grant.kind !== 'repository') {
      if (grant.owner_id !== viewerId) throw new Error(AGENT_OWNER_AUTHORITY_MESSAGE);
      const member = await ctx.database.query(
        `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL
         AND identity_id=$2 AND removed_at IS NULL`,
        [grant.workspace_id, viewerId],
      );
      if (!member.rowCount) throw new Error(AGENT_OWNER_AUTHORITY_MESSAGE);
      return grant;
    }
    const manager = await ctx.database.query(
      `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2
       AND role IN ('owner','admin') AND removed_at IS NULL`,
      [grant.workspace_id, viewerId],
    );
    if (!manager.rowCount)
      throw new Error('repository approval access denied: requires a workspace owner or admin');
    return grant;
  }

  export function phoneRequireGitHub(ctx: PhoneContext) {
    if (!ctx.github) throw new Error('GitHub service is not configured');
    return ctx.github;
  }

  export async function phoneRequireIdentity(ctx: PhoneContext, id: string, database: SqlDatabase = ctx.database) {
    const row = (
      await database.query<IdentityRow>(
        `SELECT id,kind,name,handle,avatar,face_id FROM identities WHERE id=$1`,
        [id],
      )
    ).rows[0];
    if (!row) throw new Error('identity not found');
    return identity(row, ctx.publicOrigin);
  }

  export async function phoneRequireWorkspaceAgent(ctx: PhoneContext, workspaceId: string, agentId: string, viewerId: string) {
    const result = await ctx.database.query<{ owner_id: string }>(
      `SELECT a.owner_id
       FROM agents a
       JOIN memberships m ON m.identity_id=a.agent_id
       WHERE a.agent_id=$1 AND m.workspace_id=$2
         AND m.room_id IS NULL AND m.removed_at IS NULL`,
      [agentId, workspaceId],
    );
    if (!result.rows[0]) throw new Error('agent not found in workspace');
    await phoneRequireWorkspaceMember(ctx, workspaceId, viewerId);
    if (result.rows[0].owner_id !== viewerId) throw new Error(AGENT_OWNER_AUTHORITY_MESSAGE);
  }

  export async function phoneRequireWorkspaceAgentRemover(ctx: PhoneContext, 
    workspaceId: string,
    agentId: string,
    viewerId: string,
  ) {
    const result = await ctx.database.query<{ owner_id: string; viewer_role: string | null }>(
      `SELECT a.owner_id,viewer_membership.role viewer_role
       FROM agents a
       JOIN memberships agent_membership ON agent_membership.identity_id=a.agent_id
       LEFT JOIN memberships viewer_membership ON viewer_membership.workspace_id=agent_membership.workspace_id
         AND viewer_membership.room_id IS NULL AND viewer_membership.identity_id=$3
         AND viewer_membership.removed_at IS NULL
       WHERE a.agent_id=$1 AND agent_membership.workspace_id=$2
         AND agent_membership.room_id IS NULL AND agent_membership.removed_at IS NULL`,
      [agentId, workspaceId, viewerId],
    );
    const agent = result.rows[0];
    if (!agent) throw new Error('agent not found in workspace');
    if (!agent.viewer_role) throw new Error('workspace membership required');
    if (
      agent.owner_id !== viewerId &&
      agent.viewer_role !== 'owner' &&
      agent.viewer_role !== 'admin'
    )
      throw new Error('agent removal access denied');
  }

  export async function phoneRequireWorkspaceMember(ctx: PhoneContext, workspaceId: string, identityId: string, database = ctx.database) {
    const row = await database.query(
      `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL
       AND identity_id=$2 AND removed_at IS NULL`,
      [workspaceId, identityId], 'phone-workspace-member-0',
    );
    if (!row.rowCount) throw new Error('workspace membership required');
  }

  export async function phoneHasRoomAccess(ctx: PhoneContext, roomId: string, identityId: string) {
    return (
      (
        await ctx.database.query(
          `SELECT 1 FROM rooms room
           JOIN memberships room_member ON room_member.room_id=COALESCE(room.parent_id,room.id)
           WHERE room.id=$1 AND room_member.identity_id=$2
             AND room_member.removed_at IS NULL
             AND ($2=$3 OR EXISTS(
               SELECT 1 FROM memberships workspace_member
               WHERE workspace_member.workspace_id=room.workspace_id
                 AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
                 AND workspace_member.removed_at IS NULL
             ))`,
          [roomId, identityId, SYSTEM_IDENTITY_ID],
        )
      ).rowCount > 0
    );
  }


  export async function phoneAssertRoomIsWritable(ctx: PhoneContext, roomId: string, author: string): Promise<void> {
    if (author === SYSTEM_IDENTITY_ID) return;
    const room = await ctx.database.query<{ direct_participants: string[] | null }>(
      `SELECT direct_participants FROM rooms WHERE id=$1`,
      [roomId],
    );
    const participants = room.rows[0]?.direct_participants ?? null;
    if (participants?.includes(SYSTEM_IDENTITY_ID)) {
      throw new Error(
        'this is a read-only system thread; only @system may post here (access denied)',
      );
    }
  }

  export async function phoneRequireRoomWorkspaceManager(ctx: PhoneContext, roomId: string, identityId: string, database = ctx.database) {
    const row = await database.query(
      `SELECT 1 FROM rooms room
       JOIN memberships membership ON membership.workspace_id=room.workspace_id
         AND membership.room_id IS NULL AND membership.identity_id=$2
         AND membership.role IN ('owner','admin') AND membership.removed_at IS NULL
       WHERE room.id=$1`,
      [roomId, identityId],
    );
    if (!row.rowCount) throw new Error(WORKSPACE_ADMIN_AUTHORITY_MESSAGE);
  }

  export async function phoneRequireHumanRoomWorkspaceManager(ctx: PhoneContext, roomId: string, identityId: string) {
    const row = await ctx.database.query(
      `SELECT 1 FROM rooms room
       JOIN memberships membership ON membership.workspace_id=room.workspace_id
         AND membership.room_id IS NULL AND membership.identity_id=$2
         AND membership.role IN ('owner','admin') AND membership.removed_at IS NULL
       JOIN identities identity ON identity.id=membership.identity_id AND identity.kind='human'
       WHERE room.id=$1 AND room.parent_id IS NULL AND room.archived_at IS NULL`,
      [roomId, identityId],
    );
    if (!row.rowCount) throw new Error(WORKSPACE_ADMIN_AUTHORITY_MESSAGE);
  }

  export async function phoneRequireTopLevelChatMember(ctx: PhoneContext, 
    roomId: string,
    identityId: string,
    database = ctx.database,
  ) {
    const row = await database.query(
      `SELECT 1 FROM rooms room
       JOIN memberships membership ON membership.room_id=room.id
         AND membership.identity_id=$2 AND membership.removed_at IS NULL
       WHERE room.id=$1 AND room.parent_id IS NULL AND room.archived_at IS NULL
       FOR SHARE OF room,membership`,
      [roomId, identityId],
    );
    if (!row.rowCount) throw new Error('chat membership required');
  }

  export async function phoneRequireTopLevelRoom(ctx: PhoneContext, roomId: string) {
    const room = (
      await ctx.database.query<{
        workspace_id: string;
        parent_id: string | null;
        direct_participants: string[] | null;
        archived_at: Date | null;
        visibility: 'public' | 'invite-only';
      }>(
        `SELECT workspace_id,parent_id,direct_participants,archived_at,visibility FROM rooms WHERE id=$1`,
        [roomId],
      )
    ).rows[0];
    if (!room) throw new Error('room not found');
    if (room.parent_id) throw new Error('room lifecycle cannot target a corner');
    if (room.direct_participants) throw new Error('direct-message membership is immutable');
    if (room.archived_at) throw new Error('room is archived');
    return room;
  }

  export async function phoneRequireWorkspaceManager(ctx: PhoneContext, 
    workspaceId: string,
    identityId: string,
    database = ctx.database,
  ) {
    const row = await database.query(
      `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2 AND role IN ('owner','admin') AND removed_at IS NULL`,
      [workspaceId, identityId],
    );
    if (!row.rowCount) throw new Error(WORKSPACE_ADMIN_AUTHORITY_MESSAGE);
  }

  /** Owner-only: stricter than requireWorkspaceManager (owner|admin), for the
   *  one action an admin may never take — deleting the whole workspace. */
  export async function phoneRequireWorkspaceOwner(ctx: PhoneContext, 
    workspaceId: string,
    identityId: string,
    database = ctx.database,
  ) {
    const row = await database.query(
      `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2 AND role='owner' AND removed_at IS NULL`,
      [workspaceId, identityId],
    );
    if (!row.rowCount) throw new Error('workspace owner access denied');
  }
