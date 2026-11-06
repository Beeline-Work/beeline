import { phoneIdentity as identity } from '../phone-identity.js';
import { observeOnboardingInvite } from '../signin-funnel.js';
import { randomBytes } from 'node:crypto';
import { createCommunityInviteToken, isCommunityInviteToken } from '@beeline/api-contract/phone';
import { firstAccessibleRoomId } from '../first-room.js';
import { removeWorkspaceMemberships, restoreWorkspaceMembershipRole, ensureWorkspaceMembershipRole, createDirectMessageMembership, redeemWorkspaceMembership, joinRooms, syncTopLevelSharedRoomRoles } from '../membership-join.js';
import { lockIdentityHandleWorkspaces, reassignCollidingAgentHandles } from '../workspace-handles.js';
import { directMessageRoomId, ensureSystemDirectMessageRoomResult } from '../system-line.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { PhoneContext } from './context.js';
import { Input } from './types.js';
import { phoneRequireWorkspaceManager, phoneRequireIdentity, phoneRequireWorkspaceMember } from './access.js';
import { WORKSPACE_ADMIN_AUTHORITY_MESSAGE, token, hash } from './values.js';
import { phoneAvailableAgentHandle } from './pairing.js';


  export async function phoneAddWorkspaceMember(ctx: PhoneContext, input: Input<'addWorkspaceMember'>, viewerId: string) {
    await phoneRequireWorkspaceManager(ctx, input.workspaceId, viewerId);
    if (input.memberId === viewerId) throw new Error('workspace managers cannot change themselves');
    await phoneRequireIdentity(ctx, input.memberId);
    await phoneRequireIdentity(ctx, viewerId);
    return ctx.database.transaction(async (database) => {
      const workspaceIds = await lockIdentityHandleWorkspaces(database, input.memberId, [
        input.workspaceId,
      ]);
      const targetIdentity = (
        await database.query<{ handle: string | null; kind: 'human' | 'agent'; name: string }>(
          `SELECT handle,kind,name FROM identities WHERE id=$1 FOR UPDATE`,
          [input.memberId],
        )
      ).rows[0];
      if (!targetIdentity) throw new Error('identity not found');
      const roles = await database.query<{
        identity_id: string;
        role: 'owner' | 'admin' | 'member' | 'spectator';
        removed_at: Date | null;
      }>(
        `SELECT identity_id,role,removed_at FROM memberships
         WHERE workspace_id=$1 AND room_id IS NULL AND identity_id IN ($2,$3) FOR UPDATE`,
        [input.workspaceId, viewerId, input.memberId],
      );
      const actor = roles.rows.find((row) => row.identity_id === viewerId);
      const target = roles.rows.find((row) => row.identity_id === input.memberId);
      if (!actor || actor.removed_at || (actor.role !== 'owner' && actor.role !== 'admin')) {
        throw new Error(WORKSPACE_ADMIN_AUTHORITY_MESSAGE);
      }
      if (
        target?.role === 'owner' ||
        (actor.role === 'admin' && (input.role === 'owner' || target?.role === 'admin'))
      ) {
        throw new Error('workspace manager cannot change a member with equal or greater authority');
      }
      if (targetIdentity.kind === 'human')
        await reassignCollidingAgentHandles(
          database,
          input.memberId,
          targetIdentity.handle,
          workspaceIds,
        );
      else {
        const handle = await phoneAvailableAgentHandle(ctx, 
          database,
          input.workspaceId,
          input.memberId,
          targetIdentity.name,
          Promise.resolve(workspaceIds),
        );
        await database.query(`UPDATE identities SET handle=$2,updated_at=now() WHERE id=$1`, [
          input.memberId,
          handle,
        ]);
      }
      if (target) {
        await restoreWorkspaceMembershipRole(database, [input.workspaceId, input.memberId, input.role, viewerId]);
        await syncTopLevelSharedRoomRoles(database, input.workspaceId, input.memberId);
        if (target.removed_at)
          await joinRooms(database, {
            workspaceId: input.workspaceId,
            identityId: input.memberId,
            invitedById: viewerId,
            rooms: { type: 'all-live-top-level' },
            workspaceJoined: true,
          });
        return { joined: target.removed_at !== null };
      }
      const inserted = await ensureWorkspaceMembershipRole(database, [input.workspaceId, input.memberId, input.role, viewerId]);
      if (inserted.rowCount)
        await joinRooms(database, {
          workspaceId: input.workspaceId,
          identityId: input.memberId,
          invitedById: viewerId,
          rooms: { type: 'all-live-top-level' },
          workspaceJoined: true,
        });
      return { joined: inserted.rowCount > 0 };
    });
  }

  /**
   * A manager removes a person from the Workspace. Admins may remove peers;
   * owners remain protected. Every live Room membership goes with the
   * Workspace one and each of those Rooms carries the removal line. Agents
   * are not people — their removal is the removeAgent host teardown.
   */
  export async function phoneRemoveWorkspaceMember(ctx: PhoneContext, input: Input<'removeWorkspaceMember'>, viewerId: string) {
    await phoneRequireWorkspaceManager(ctx, input.workspaceId, viewerId);
    if (input.memberId === viewerId) throw new Error('workspace managers cannot remove themselves');
    const remover = await phoneRequireIdentity(ctx, viewerId);
    const removed = await phoneRequireIdentity(ctx, input.memberId);
    if (removed.kind !== 'human')
      throw new Error('invalid member: agents are removed through removeAgent');
    await ctx.database.transaction(async (database) => {
      await database.query(`SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE`, [input.workspaceId]);
      const roles = await database.query<{
        identity_id: string;
        role: 'owner' | 'admin' | 'member' | 'spectator';
      }>(
        `SELECT identity_id,role FROM memberships
         WHERE workspace_id=$1 AND room_id IS NULL AND identity_id IN ($2,$3) AND removed_at IS NULL
         FOR UPDATE`,
        [input.workspaceId, viewerId, input.memberId],
      );
      const actor = roles.rows.find((row) => row.identity_id === viewerId);
      const target = roles.rows.find((row) => row.identity_id === input.memberId);
      if (!actor || (actor.role !== 'owner' && actor.role !== 'admin')) {
        throw new Error(WORKSPACE_ADMIN_AUTHORITY_MESSAGE);
      }
      if (!target) throw new Error('workspace membership required');
      if (target.role === 'owner') {
        throw new Error('workspace manager cannot remove an owner');
      }
      await removeWorkspaceMemberships(database, [input.workspaceId, input.memberId]);
      await database.query(
        `DELETE FROM agent_pairing_codes WHERE workspace_id=$1 AND created_by=$2 AND claimed_by IS NULL`,
        [input.workspaceId, input.memberId],
      );
      // The committed state is the silent audit record.
    });
  }

  export async function phoneResolveDirectMessage(ctx: PhoneContext, input: Input<'resolveDirectMessage'>, viewerId: string) {
    if (input.participantId === SYSTEM_IDENTITY_ID) {
      await phoneRequireWorkspaceMember(ctx, input.workspaceId, viewerId);
      return ensureSystemDirectMessageRoomResult(ctx.database, input.workspaceId, viewerId);
    }
    const participants = [viewerId, input.participantId].sort();
    if (participants[0] === participants[1]) throw new Error('direct message requires two members');
    const members = await ctx.database.query<{ identity_id: string }>(
      `SELECT identity_id FROM memberships
       WHERE workspace_id=$1 AND room_id IS NULL AND identity_id IN ($2,$3) AND removed_at IS NULL`,
      [input.workspaceId, participants[0], participants[1]],
    );
    if (new Set(members.rows.map((row) => row.identity_id)).size !== 2) {
      throw new Error('workspace membership required for direct messages');
    }
    const found = await ctx.database.query<{ id: string }>(
      `SELECT id FROM rooms WHERE workspace_id=$1 AND direct_participants=$2::jsonb`,
      [input.workspaceId, JSON.stringify(participants)],
    );
    if (found.rows[0]) {
      await ctx.database.query(`DELETE FROM chat_dismissals WHERE room_id=$1 AND identity_id=$2`, [
        found.rows[0].id,
        viewerId,
      ]);
      return { id: found.rows[0].id, created: false };
    }
    const id = directMessageRoomId(input.workspaceId, participants as [string, string]);
    const created = await ctx.database.transaction(async (db) => {
      const inserted = await db.query(
        `INSERT INTO rooms(id,workspace_id,created_by,name,visibility,direct_participants)
         VALUES($1,$2,$3,'Direct message','invite-only',$4::jsonb) ON CONFLICT DO NOTHING`,
        [id, input.workspaceId, viewerId, JSON.stringify(participants)],
      );
      if (!inserted.rowCount) return false;
      for (const member of participants)
        await createDirectMessageMembership(db, [input.workspaceId, id, member]);
      return true;
    });
    return { id, created };
  }

  export async function phoneCreateInvite(ctx: PhoneContext, input: Input<'createInvite'>, viewerId: string) {
    return ctx.database.transaction(async (database) => {
      await database.query(`SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, [
        input.workspaceId,
      ]);
      await phoneRequireWorkspaceManager(ctx, input.workspaceId, viewerId, database);
      const workspace = await database.query<{ visibility: string }>(
        `SELECT visibility FROM workspaces WHERE id=$1`,
        [input.workspaceId],
      );
      const isPublic = workspace.rows[0]?.visibility === 'public';
      if (isPublic) {
        const existing = await database.query<{ public_token: string }>(
          `SELECT public_token FROM invites WHERE workspace_id=$1 AND public_token IS NOT NULL`,
          [input.workspaceId],
        );
        if (existing.rows[0])
          return { token: existing.rows[0].public_token, expiresAt: 0 };
      }
      const value = createCommunityInviteToken(randomBytes(32));
      const expiresAt = isPublic ? null : new Date(Date.now() + 7 * 86400_000);
      await database.query(
        `INSERT INTO invites(token_hash,workspace_id,created_by,expires_at,public_token) VALUES($1,$2,$3,$4,$5)`,
        [hash(value), input.workspaceId, viewerId, expiresAt, isPublic ? value : null],
      );
      return {
        token: value,
        expiresAt: expiresAt ? Math.floor(expiresAt.getTime() / 1000) : 0,
      };
    });
  }

  export async function phoneRedeemInvite(ctx: PhoneContext, input: Input<'redeemInvite'>, viewerId: string) {
    if (!isCommunityInviteToken(input.token)) throw new Error('invalid invite token');
    const result = await ctx.database.query<{
      workspace_id: string;
      created_by: string;
      public_token: string | null;
    }>(
      `SELECT i.workspace_id,i.created_by,i.public_token
       FROM invites i
       JOIN workspaces w ON w.id=i.workspace_id
       LEFT JOIN memberships creator ON creator.workspace_id=i.workspace_id AND creator.room_id IS NULL
         AND creator.identity_id=i.created_by AND creator.removed_at IS NULL
       WHERE i.token_hash=$1 AND (i.expires_at IS NULL OR i.expires_at>now())
         AND ((i.public_token IS NOT NULL AND w.visibility='public')
           OR (i.public_token IS NULL AND creator.identity_id IS NOT NULL))`,
      [hash(input.token)],
    );
    const row = result.rows[0];
    if (!row) throw new Error('invite not found');
    return ctx.database.transaction(async (database) => {
      // Use the handle allocator's Workspace lock before locking the invite:
      // invite creation and membership writes then share the same lock order.
      const workspaceIds = await lockIdentityHandleWorkspaces(database, viewerId, [
        row.workspace_id,
      ]);
      const current = await database.query<{
        consumed_at: Date | null;
        already_joined: boolean;
      }>(
        `SELECT i.consumed_at,
           EXISTS(SELECT 1 FROM memberships joined WHERE joined.workspace_id=i.workspace_id
             AND joined.room_id IS NULL AND joined.identity_id=$2 AND joined.removed_at IS NULL) already_joined
         FROM invites i JOIN workspaces w ON w.id=i.workspace_id
         LEFT JOIN memberships creator ON creator.workspace_id=i.workspace_id AND creator.room_id IS NULL
           AND creator.identity_id=i.created_by AND creator.removed_at IS NULL
         WHERE i.token_hash=$1 AND (i.expires_at IS NULL OR i.expires_at>now())
           AND ((i.public_token IS NOT NULL AND w.visibility='public')
             OR (i.public_token IS NULL AND creator.identity_id IS NOT NULL)) FOR UPDATE OF i`,
        [hash(input.token), viewerId],
      );
      if (!current.rows[0]) throw new Error('invite not found');
      if (current.rows[0].already_joined) {
        const invitedRoom = (await database.query<{ onboarding_room_id: string | null }>(`SELECT onboarding_room_id FROM invites WHERE token_hash=$1`, [hash(input.token)])).rows[0]?.onboarding_room_id;
        if (invitedRoom && !current.rows[0].consumed_at) {
          await joinRooms(database, { workspaceId: row.workspace_id, identityId: viewerId, invitedById: row.created_by,
            rooms: { type: 'rooms', roomIds: [invitedRoom] }, workspaceJoined: false });
          await database.query(`UPDATE invites SET consumed_at=now() WHERE token_hash=$1`, [hash(input.token)]);
          await observeOnboardingInvite(database, hash(input.token), viewerId, true);
        }
        const accessible = invitedRoom && (await database.query(`SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL`, [invitedRoom, viewerId])).rowCount > 0;
        const roomId = accessible ? invitedRoom : await firstAccessibleRoomId(database, row.workspace_id, viewerId);
        return { joined: false, workspaceId: row.workspace_id, ...(roomId ? { roomId } : {}) };
      }
      if (current.rows[0].consumed_at) throw new Error('invite not found');
      if (!row.public_token)
        await database.query(`UPDATE invites SET consumed_at=now() WHERE token_hash=$1`, [
          hash(input.token),
        ]);
      const identity = (
        await database.query<{ handle: string | null }>(
          `SELECT handle FROM identities WHERE id=$1 FOR UPDATE`,
          [viewerId],
        )
      ).rows[0];
      if (!identity) throw new Error('identity not found');
      await reassignCollidingAgentHandles(database, viewerId, identity.handle, workspaceIds);
      const joined = await redeemWorkspaceMembership(database, [row.workspace_id, viewerId, row.created_by]);
      await joinRooms(database, {
        workspaceId: row.workspace_id,
        identityId: viewerId,
        invitedById: row.created_by,
        rooms: { type: 'all-live-top-level' },
        workspaceJoined: joined.rowCount > 0,
      });
      const invitedRoom = (await database.query<{ onboarding_room_id: string | null }>(`SELECT onboarding_room_id FROM invites WHERE token_hash=$1`, [hash(input.token)])).rows[0]?.onboarding_room_id;
      if (invitedRoom) await joinRooms(database, { workspaceId: row.workspace_id, identityId: viewerId, invitedById: row.created_by,
        rooms: { type: 'rooms', roomIds: [invitedRoom] }, workspaceJoined: false });
      const roomId = invitedRoom ?? await firstAccessibleRoomId(database, row.workspace_id, viewerId);
      await observeOnboardingInvite(database, hash(input.token), viewerId, joined.rowCount > 0);
      if (roomId && joined.rowCount > 0) {
        if (ctx.freeAgents && !(await database.query(
          `SELECT 1 FROM free_agents WHERE workspace_id=$1`, [row.workspace_id])).rowCount) {
          await ctx.freeAgents.createInWorkspace(database, { workspaceId: row.workspace_id, creatorId: viewerId, roomId });
        }
      }
      return {
        joined: joined.rowCount > 0,
        workspaceId: row.workspace_id,
        ...(roomId ? { roomId } : {}),
      };
    });
  }
