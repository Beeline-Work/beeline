import { unsubscribeRoomReviewer, subscribeRoomReviewer } from '../agent-subscriptions.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { reconcileConfiguredCornerReviewers } from '../agent-command.js';
import { randomUUID } from 'node:crypto';
import { requireRoomSlug, reserveRoomName } from '../room-names.js';
import { ROOM_VIEW_MEMBER_LIMIT } from '@beeline/api-contract/phone';
import { type SqlDatabase } from '../database.js';
import { advanceCorner, createCornerFacts } from '../corner-lifecycle.js';
import { joinRoomCreator, removeRoomMembership, joinRooms, joinWorkspaceMembersToPublicRoom } from '../membership-join.js';
import { identitySubject, systemLine } from '../system-line.js';
import { writeCornerTitle } from '../corner-title.js';
import type { PhoneContext } from './context.js';
import { Input } from './types.js';
import { phoneRequireWorkspaceManager, phoneRequireTopLevelRoom, phoneRequireIdentity, phoneRequireTopLevelChatMember } from './access.js';
import { normalizeHumanCornerTitle, UUID_PATTERN } from './values.js';


  export async function phoneCreateRoom(ctx: PhoneContext, input: Input<'createRoom'>, viewerId: string) {
    await phoneRequireWorkspaceManager(ctx, input.workspaceId, viewerId);
    const name = requireRoomSlug(input.name);
    const id = randomUUID();
    await ctx.database.transaction(async (db) => {
      await reserveRoomName(db, input.workspaceId, name);
      const repository =
        input.repositoryId === undefined
          ? undefined
          : (
              await db.query<{
                repository_id: string;
                installation_id: string;
                full_name: string;
                default_branch: string;
                private: boolean | null;
              }>(
                `SELECT r.repository_id,r.installation_id,r.full_name,r.default_branch,r.private
                 FROM github_repositories r
                 JOIN github_installations i USING(installation_id)
                 WHERE r.repository_id=$1 AND r.active AND i.owner_id=$2 AND i.status='active'`,
                [input.repositoryId, viewerId],
              )
            ).rows[0];
      if (input.repositoryId !== undefined && !repository)
        throw new Error('installed repository not found');
      await db.query(
        `INSERT INTO rooms(
           id,workspace_id,created_by,name,visibility,
           repository_key,repository_name,repository_remote,repository_target_branch,
           repository_updated_at,repository_resolution,github_installation_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          id,
          input.workspaceId,
          viewerId,
          name,
          input.visibility ??
            (repository && repository.private !== false ? 'invite-only' : 'public'),
          repository ? `github:${repository.repository_id}` : null,
          repository?.full_name ?? null,
          repository ? `git://github.com/${repository.full_name}` : null,
          repository?.default_branch ?? 'main',
          repository ? new Date() : null,
          repository ? 'repository' : 'none',
          repository?.installation_id ?? null,
        ],
      );
      await joinRoomCreator(db, [input.workspaceId, id, viewerId]);
      if (repository) await db.query(
        `INSERT INTO repository_link_successes(identity_id,workspace_id) VALUES($1,$2)
         ON CONFLICT DO NOTHING`, [viewerId, input.workspaceId],
      );
      await joinWorkspaceMembersToPublicRoom(db, input.workspaceId, id);
    });
    return { id };
  }

  export async function phoneCreateHumanCorner(ctx: PhoneContext, input: Input<'createHumanCorner'>, viewerId: string) {
    const title = normalizeHumanCornerTitle(input.title);
    if (input.cornerId !== undefined && !UUID_PATTERN.test(input.cornerId)) {
      throw new Error('corner id must be a UUID');
    }
    const id = input.cornerId ?? randomUUID();
    const created = await ctx.database.transaction(async (database) => {
      const parent = (
        await database.query<{ workspace_id: string; viewer_name: string }>(
          `SELECT room.workspace_id,viewer.name viewer_name FROM rooms room
           JOIN memberships room_member ON room_member.room_id=room.id
             AND room_member.identity_id=$2 AND room_member.removed_at IS NULL
           JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
             AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
             AND workspace_member.removed_at IS NULL
           JOIN identities viewer ON viewer.id=$2 AND viewer.kind='human'
           WHERE room.id=$1 AND room.parent_id IS NULL AND room.archived_at IS NULL
           FOR SHARE OF room,room_member,workspace_member,viewer`,
          [input.roomId, viewerId],
        )
      ).rows[0];
      if (!parent) throw new Error('room access denied');
      // A retried open names the same id: the first attempt's corner is the
      // answer, and nothing below runs twice.
      const inserted = await database.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,
        [id, parent.workspace_id, input.roomId, viewerId, title],
      );
      if (!inserted.rowCount) {
        const replay = await database.query(
          `SELECT 1 FROM rooms WHERE id=$1 AND parent_id=$2 AND created_by=$3`,
          [id, input.roomId, viewerId],
        );
        if (!replay.rowCount) throw new Error('corner id is already in use');
        return false;
      }
      await createCornerFacts(database, id);
      await advanceCorner(database, id, {
        kind: 'open',
      });
      // Every new corner leaves a static opening in its Room. A resident
      // requesting message anchors it; scratch openings stay at their open time.
      // No kind: a person opening a scratch corner wakes no subscriber.
      const source = input.sourceMessageId
        ? await database.query(`SELECT 1 FROM messages WHERE id=$1 AND room_id=$2`, [
            input.sourceMessageId,
            input.roomId,
          ])
        : undefined;
      await systemLine(database, {
        roomId: input.roomId,
        subject: identitySubject({ id: viewerId, kind: 'human', name: parent.viewer_name }),
        verb: systemMessage("phone-service.opened-a-corner"),
        object: { text: title, id },
        presentation: 'card',
        cardType: 'daemon-fact',
        card: {
          type: 'corner-open',
          cornerId: id,
          name: title,
          objective: title,
          ...(source?.rowCount ? { sourceMessageId: input.sourceMessageId } : {}),
        },
      });

      return true;
    });
    return { id };
  }

  export async function phoneRenameCorner(ctx: PhoneContext, roomId: string, name: string | undefined, viewerId: string) {
    const title = normalizeHumanCornerTitle(name);
    await ctx.database.transaction(async (database) => {
      const access = (
        await database.query<{ parent_id: string; archived_at: Date | null }>(
          `SELECT room.parent_id, room.archived_at
           FROM rooms room
           JOIN memberships room_member ON room_member.room_id=COALESCE(room.parent_id,room.id)
             AND room_member.identity_id=$2 AND room_member.removed_at IS NULL
           JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
             AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
             AND workspace_member.removed_at IS NULL
           JOIN identities viewer ON viewer.id=$2 AND viewer.kind='human'
           WHERE room.id=$1 AND room.parent_id IS NOT NULL
           FOR UPDATE OF room,room_member,workspace_member,viewer`,
          [roomId, viewerId],
        )
      ).rows[0];
      if (!access) throw new Error('room access denied');
      if (access.archived_at) throw new Error('room is archived');
      await writeCornerTitle(database, roomId, title);
    });
  }

  export async function phoneUpdateRoom(ctx: PhoneContext, input: Input<'updateRoom'>, viewerId: string) {
    const existing = (
      await ctx.database.query<{ parent_id: string | null }>(
        `SELECT parent_id FROM rooms WHERE id=$1`,
        [input.roomId],
      )
    ).rows[0];
    if (!existing) throw new Error('room not found');
    if (existing.parent_id) {
      if (
        input.visibility !== undefined ||
        input.reviewerAgentId !== undefined
      ) {
        throw new Error('room lifecycle cannot target a corner');
      }
      await phoneRenameCorner(ctx, input.roomId, input.name, viewerId);
      return;
    }
    const room = await phoneRequireTopLevelRoom(ctx, input.roomId);
    await phoneRequireWorkspaceManager(ctx, room.workspace_id, viewerId);
    const name = input.name === undefined ? undefined : requireRoomSlug(input.name);
    const reviewerAgentId = input.reviewerAgentId;
    await ctx.database.transaction(async (database) => {
      if (name !== undefined)
        await reserveRoomName(database, room.workspace_id, name, input.roomId);
      const current = (
        await database.query<{
          visibility: 'public' | 'invite-only';
          reviewer_agent_id: string | null;
        }>('SELECT visibility,reviewer_agent_id FROM rooms WHERE id=$1 FOR UPDATE', [input.roomId])
      ).rows[0];
      const required = reviewerAgentId ? [reviewerAgentId] : [];
      if (required.length) {
        const reviewers = await database.query<{ identity_id: string }>(
          `SELECT membership.identity_id
           FROM memberships membership
           JOIN identities identity ON identity.id=membership.identity_id AND identity.kind='agent'
           WHERE membership.room_id=$1 AND membership.identity_id=ANY($2::text[])
             AND membership.removed_at IS NULL
           FOR SHARE OF membership`,
          [input.roomId, required],
        );
        if (reviewers.rowCount !== new Set(required).size)
          throw new Error('reviewer agent Room membership required');
      }
      await database.query(
        `UPDATE rooms
         SET name=COALESCE($2,name),visibility=COALESCE($3,visibility),
             reviewer_agent_id=CASE WHEN $4::boolean THEN $5 ELSE reviewer_agent_id END,
             updated_at=now()
         WHERE id=$1`,
        [
          input.roomId,
          name ?? null,
          input.visibility ?? null,
          reviewerAgentId !== undefined,
          reviewerAgentId ?? null,
        ],
      );
      if (reviewerAgentId !== undefined && reviewerAgentId !== current?.reviewer_agent_id) {
        if (current?.reviewer_agent_id)
          await unsubscribeRoomReviewer(database, [input.roomId, current.reviewer_agent_id]);
        if (reviewerAgentId)
          await subscribeRoomReviewer(database, [input.roomId, reviewerAgentId]);

      }
      if (reviewerAgentId !== undefined)
        await reconcileConfiguredCornerReviewers(database, input.roomId);
      if (input.visibility && input.visibility !== current?.visibility) {
        if (input.visibility === 'public')
          await joinWorkspaceMembersToPublicRoom(database, room.workspace_id, input.roomId);
        const actor = await phoneRequireIdentity(ctx, viewerId, database);
        await systemLine(database, {
          roomId: input.roomId,
          subject: identitySubject({ id: actor.pubkey, kind: actor.kind, name: actor.name }),
          verb: systemMessage("phone-service.changed-room-visibility-to"),
          object: input.visibility,
          cardType: 'room-visibility',
          card: { visibility: input.visibility },
        });
      }
    });
  }

  export async function phoneDeleteRoom(ctx: PhoneContext, roomId: string, viewerId: string) {
    const room = await phoneRequireTopLevelRoom(ctx, roomId);
    await phoneRequireWorkspaceManager(ctx, room.workspace_id, viewerId);
    await phoneDeleteRoomRows(ctx, ctx.database, roomId);
  }

  export async function phoneDeleteRoomRows(ctx: PhoneContext, database: SqlDatabase, roomId: string) {
    await database.query(`DELETE FROM rooms WHERE id=$1`, [roomId]);
  }

  export async function phoneLeaveRoom(ctx: PhoneContext, input: Input<'leaveRoom'>, viewerId: string) {
    const { roomId } = input;
    const room = await phoneRequireTopLevelRoom(ctx, roomId);
    const leaver = await phoneRequireIdentity(ctx, viewerId);
    await ctx.database.transaction(async (database) => {
      // Serialize two managers leaving the same Room before checking whether
      // either departure destroys it.
      await database.query(`SELECT id FROM rooms WHERE id=$1 FOR UPDATE`, [roomId]);
      const membership = (
        await database.query<{ workspace_role: 'owner' | 'admin' | 'member' | 'spectator' }>(
          `SELECT workspace_member.role workspace_role
           FROM memberships room_member
           JOIN memberships workspace_member
             ON workspace_member.workspace_id=$3 AND workspace_member.room_id IS NULL
            AND workspace_member.identity_id=room_member.identity_id
            AND workspace_member.removed_at IS NULL
           WHERE room_member.room_id=$1 AND room_member.identity_id=$2
             AND room_member.removed_at IS NULL
           FOR UPDATE OF room_member,workspace_member`,
          [roomId, viewerId, room.workspace_id],
        )
      ).rows[0];
      if (!membership) throw new Error('room membership required');
      if (membership.workspace_role === 'owner' || membership.workspace_role === 'admin') {
        const others = await database.query(
          `SELECT 1 FROM memberships room_member
           JOIN memberships workspace_member ON workspace_member.workspace_id=$2
             AND workspace_member.room_id IS NULL
             AND workspace_member.identity_id=room_member.identity_id
             AND workspace_member.removed_at IS NULL
             AND workspace_member.role IN ('owner','admin')
           WHERE room_member.room_id=$1 AND room_member.identity_id<>$3
             AND room_member.removed_at IS NULL LIMIT 1`,
          [roomId, room.workspace_id, viewerId],
        );
        if (!others.rowCount) {
          if (input.confirmDelete !== true) throw new Error('last_admin_confirmation_required');
          await phoneDeleteRoomRows(ctx, database, roomId);
          return;
        }
      }
      await removeRoomMembership(database, [roomId, viewerId]);
      await systemLine(database, {
        roomId,
        subject: identitySubject({ id: leaver.pubkey, kind: leaver.kind, name: leaver.name }),
        verb: systemMessage("phone-service.left"),
        kind: 'left',
        cardType: 'member-left',
        card: { identityId: viewerId },
      });
    });
  }

  export async function phoneCloseChat(ctx: PhoneContext, roomId: string, viewerId: string) {
    await ctx.database.transaction(async (database) => {
      const membership = await database.query(
        `SELECT 1 FROM rooms room
         JOIN memberships membership ON membership.room_id=room.id
           AND membership.identity_id=$2 AND membership.removed_at IS NULL
         WHERE room.id=$1 AND room.parent_id IS NULL AND room.archived_at IS NULL
           AND room.direct_participants IS NOT NULL
         FOR SHARE OF room,membership`,
        [roomId, viewerId],
      );
      if (!membership.rowCount) throw new Error('direct-message membership required');
      await database.query(
        `INSERT INTO chat_dismissals(room_id,identity_id,dismissed_at) VALUES($1,$2,now())
         ON CONFLICT (room_id,identity_id)
         DO UPDATE SET dismissed_at=EXCLUDED.dismissed_at`,
        [roomId, viewerId],
      );
    });
  }

  export async function phoneReopenChat(ctx: PhoneContext, roomId: string, viewerId: string) {
    await ctx.database.transaction(async (database) => {
      await phoneRequireTopLevelChatMember(ctx, roomId, viewerId, database);
      await database.query(`DELETE FROM chat_dismissals WHERE room_id=$1 AND identity_id=$2`, [
        roomId,
        viewerId,
      ]);
    });
  }

  export async function phoneAddRoomMember(ctx: PhoneContext, input: Input<'addRoomMember'>, viewerId: string) {
    const memberIds = [...new Set(input.memberIds ?? (input.memberId ? [input.memberId] : []))];
    if (!memberIds.length || memberIds.length > ROOM_VIEW_MEMBER_LIMIT)
      throw new Error('invalid Room member list');
    const room = await phoneRequireTopLevelRoom(ctx, input.roomId);
    await phoneRequireWorkspaceManager(ctx, room.workspace_id, viewerId);
    const workspaceMembers = await ctx.database.query<{ identity_id: string }>(
      `SELECT identity_id FROM memberships
       WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=ANY($2::text[])
         AND removed_at IS NULL`,
      [room.workspace_id, memberIds],
    );
    if (workspaceMembers.rowCount !== memberIds.length)
      throw new Error('workspace membership required');
    return ctx.database.transaction(async (database) => {
      const joinedIds: string[] = [];
      for (const memberId of memberIds) {
        const result = await joinRooms(database, {
          workspaceId: room.workspace_id,
          identityId: memberId,
          invitedById: viewerId,
          rooms: { type: 'rooms', roomIds: [input.roomId] },
        });
        if (result.roomIds.length) joinedIds.push(memberId);
      }
      return { joined: joinedIds.length > 0, ...(input.memberIds ? { joinedIds } : {}) };
    });
  }

  export async function phoneRemoveRoomMember(ctx: PhoneContext, input: Input<'removeRoomMember'>, viewerId: string) {
    const room = await phoneRequireTopLevelRoom(ctx, input.roomId);
    await phoneRequireWorkspaceManager(ctx, room.workspace_id, viewerId);
    const target = await ctx.database.query(
      `SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL`,
      [input.roomId, input.memberId],
    );
    if (!target.rowCount) throw new Error('room membership required');
    if (input.memberId === viewerId) throw new Error('access denied: you cannot remove yourself from a Room; leave it instead');
    const remover = await phoneRequireIdentity(ctx, viewerId);
    const removed = await phoneRequireIdentity(ctx, input.memberId);
    await ctx.database.transaction(async (database) => {
      await removeRoomMembership(database, [input.roomId, input.memberId]);
      await systemLine(database, {
        roomId: input.roomId,
        subject: identitySubject({ id: remover.pubkey, kind: remover.kind, name: remover.name }),
        verb: systemMessage("phone-service.removed"),
        object: { text: removed.name, id: removed.pubkey },
        kind: 'left',
        cardType: 'member-removed',
        card: { identityId: input.memberId },
      });
    });
  }
