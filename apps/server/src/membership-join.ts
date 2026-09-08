import { randomUUID } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { systemIdentityMention, systemLine } from './system-line.js';

type RoomSelection =
  | { type: 'none' }
  | { type: 'rooms'; roomIds: readonly string[] }
  | { type: 'all-live-top-level' }
  | { type: 'inherited-live-top-level'; identityId: string };

export interface JoinRoomsInput {
  workspaceId: string;
  identityId: string;
  /** The identity whose action created/restored this membership. */
  invitedById?: string;
  rooms: RoomSelection;
  workspaceJoined?: boolean;
}

export interface JoinRoomsResult {
  roomIds: string[];
  notificationId?: string;
}

/**
 * Top-level shared Room roles are projections of the active Workspace role.
 * Corners and DMs keep their own authority and are deliberately excluded.
 */
export async function syncTopLevelSharedRoomRoles(
  database: SqlDatabase,
  workspaceId?: string,
  identityId?: string,
): Promise<number> {
  const result = await database.query(
    `UPDATE memberships room_member SET role=workspace_member.role
     FROM rooms room,memberships workspace_member
     WHERE room_member.room_id=room.id
       AND workspace_member.workspace_id=room.workspace_id
       AND workspace_member.room_id IS NULL
       AND workspace_member.identity_id=room_member.identity_id
       AND workspace_member.removed_at IS NULL
       AND room_member.removed_at IS NULL
       AND room.parent_id IS NULL AND room.direct_participants IS NULL
       AND room_member.role<>workspace_member.role
       AND ($1::uuid IS NULL OR room.workspace_id=$1)
       AND ($2::text IS NULL OR room_member.identity_id=$2)`,
    [workspaceId ?? null, identityId ?? null],
  );
  return result.rowCount;
}

async function inheritCornerMemberships(
  database: SqlDatabase,
  workspaceId: string,
  identityId: string,
  parentRoomIds: readonly string[],
): Promise<void> {
  if (!parentRoomIds.length) return;
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
     SELECT corner.workspace_id,corner.id,$2,'member'
     FROM rooms corner
     WHERE corner.workspace_id=$1 AND corner.parent_id=ANY($3::uuid[])
     ON CONFLICT (room_id,identity_id) WHERE room_id IS NOT NULL
     DO UPDATE SET role='member',removed_at=NULL
       WHERE memberships.removed_at IS NOT NULL`,
    [workspaceId, identityId, parentRoomIds],
  );
}

/**
 * Repairs the roster snapshot older corners took when they were created.
 * Missing rows mean the person joined the parent later; an existing removed
 * row is intentional corner-level authority and must stay removed.
 */
export async function backfillInheritedCornerMemberships(database: SqlDatabase): Promise<number> {
  const result = await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
     SELECT corner.workspace_id,corner.id,parent_member.identity_id,parent_member.role
     FROM rooms corner
     JOIN memberships parent_member ON parent_member.room_id=corner.parent_id
       AND parent_member.removed_at IS NULL
     WHERE corner.parent_id IS NOT NULL
     ON CONFLICT DO NOTHING`,
  );
  console.log(
    `backfillInheritedCornerMemberships: added ${result.rowCount} missing corner membership row(s)`,
  );
  return result.rowCount;
}

/**
 * The one write path for adding an existing identity to existing top-level Rooms.
 * It keeps membership, transcript notes, and the single join push event atomic.
 */
export async function joinRooms(
  database: SqlDatabase,
  input: JoinRoomsInput,
): Promise<JoinRoomsResult> {
  return database.transaction(async (transaction) => {
    let roomIds: string[] = [];
    if (input.rooms.type !== 'none') {
      const values: unknown[] = [input.workspaceId, input.identityId];
      let roomPredicate: string | undefined;
      switch (input.rooms.type) {
        case 'rooms':
          if (!input.rooms.roomIds.length) break;
          values.push(input.rooms.roomIds);
          roomPredicate = `room.id=ANY($3::uuid[])`;
          break;
        case 'all-live-top-level':
          roomPredicate = 'true';
          break;
        case 'inherited-live-top-level':
          values.push(input.rooms.identityId);
          roomPredicate = `EXISTS(
            SELECT 1 FROM memberships inherited
            WHERE inherited.room_id=room.id AND inherited.identity_id=$3
              AND inherited.removed_at IS NULL
          )`;
          break;
      }
      if (roomPredicate) {
        const joined = await transaction.query<{ room_id: string }>(
          `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
           SELECT room.workspace_id,room.id,$2,workspace_member.role
           FROM rooms room
           JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
             AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
             AND workspace_member.removed_at IS NULL
           WHERE room.workspace_id=$1 AND room.parent_id IS NULL
             AND room.direct_participants IS NULL AND room.archived_at IS NULL
             AND ${roomPredicate}
           ON CONFLICT (room_id,identity_id) WHERE room_id IS NOT NULL
           DO UPDATE SET role='member',removed_at=NULL
             WHERE memberships.removed_at IS NOT NULL
           RETURNING room_id`,
          values,
        );
        roomIds = joined.rows.map((row) => row.room_id);
        if (input.invitedById && roomIds.length)
          await transaction.query(
            `UPDATE memberships SET invited_by=$3
             WHERE identity_id=$1 AND room_id=ANY($2::uuid[])`,
            [input.identityId, roomIds, input.invitedById],
          );
        await inheritCornerMemberships(transaction, input.workspaceId, input.identityId, roomIds);
      }
    }

    if (!input.workspaceJoined && !roomIds.length) return { roomIds };

    const context = (
      await transaction.query<{
        identity_name: string;
        identity_handle: string | null;
        kind: 'human' | 'agent';
        workspace_name: string;
        room_name: string | null;
        inviter_id: string | null;
        inviter_kind: 'human' | 'agent' | null;
        inviter_name: string | null;
        inviter_handle: string | null;
      }>(
        `SELECT identity.name identity_name,identity.handle identity_handle,identity.kind,
                workspace.name workspace_name,
                (SELECT name FROM rooms WHERE id=$3) room_name,
                inviter.id inviter_id,inviter.kind inviter_kind,inviter.name inviter_name,
                inviter.handle inviter_handle
         FROM identities identity CROSS JOIN workspaces workspace
         LEFT JOIN identities inviter ON inviter.id=$4
         WHERE identity.id=$1 AND workspace.id=$2`,
        [input.identityId, input.workspaceId, roomIds[0] ?? null, input.invitedById ?? null],
      )
    ).rows[0];
    if (!context) throw new Error('join context not found');
    const joiningMention = systemIdentityMention({
      id: input.identityId,
      kind: context.kind,
      name: context.identity_name,
      handle: context.identity_handle,
    });

    for (const roomId of roomIds) {
      await systemLine(transaction, {
        roomId,
        subject: {
          kind: context.kind === 'agent' ? 'agent' : 'person',
          id: input.identityId,
          name: joiningMention,
        },
        verb: 'joined',
        ...(context.inviter_id &&
        context.inviter_kind &&
        context.inviter_name &&
        context.inviter_handle
          ? {
              attribution: {
                verb: 'invited by',
                actor: {
                  kind: context.inviter_kind === 'agent' ? ('agent' as const) : ('person' as const),
                  id: context.inviter_id,
                  name: systemIdentityMention({
                    id: context.inviter_id,
                    kind: context.inviter_kind,
                    name: context.inviter_name,
                    handle: context.inviter_handle,
                  }),
                },
              },
            }
          : {}),
        // The one thing a producer says about who cares: the kind. A Room's
        // subscribers are resolved inside `systemLine`, so an arrival wakes
        // exactly the agents that asked to hear about arrivals in THIS Room.
        kind: 'joined',
        cardType: 'member-joined',
        card: { identityId: input.identityId },
      });
    }

    const notificationId = `workspace-join:${randomUUID()}`;
    await transaction.query(
      `INSERT INTO workspace_join_notifications(
         id,workspace_id,room_id,joining_identity_id,text
       ) VALUES($1,$2,$3,$4,$5)`,
      [
        notificationId,
        input.workspaceId,
        roomIds[0] ?? null,
        input.identityId,
        `${joiningMention} joined ${input.workspaceJoined ? context.workspace_name : context.room_name}`,
      ],
    );
    await transaction.query(
      `INSERT INTO workspace_join_notification_devices(notification_id,device_token)
       SELECT $1,device.token
       FROM memberships member
       JOIN identities identity ON identity.id=member.identity_id AND identity.kind='human'
       JOIN push_devices device ON device.identity_id=member.identity_id
       WHERE member.workspace_id=$2 AND member.room_id IS NULL
         AND member.removed_at IS NULL AND member.identity_id<>$3
       ON CONFLICT DO NOTHING`,
      [notificationId, input.workspaceId, input.identityId],
    );
    return { roomIds, notificationId };
  });
}
