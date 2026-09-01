import { randomBytes, randomUUID } from 'node:crypto';
import type { SqlDatabase } from './database.js';

type RoomSelection =
  | { type: 'none' }
  | { type: 'rooms'; roomIds: readonly string[] }
  | { type: 'all-live-top-level' }
  | { type: 'inherited-live-top-level'; identityId: string };

export interface JoinRoomsInput {
  workspaceId: string;
  identityId: string;
  rooms: RoomSelection;
  workspaceJoined?: boolean;
}

export interface JoinRoomsResult {
  roomIds: string[];
  notificationId?: string;
}

function messageId(): string {
  return randomBytes(32).toString('hex');
}

/**
 * The one write path for adding an existing identity to existing top-level Rooms.
 * It keeps membership, transcript notes, and the single workspace push event atomic.
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
           SELECT room.workspace_id,room.id,$2,'member'
           FROM rooms room
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
      }
    }

    if (!input.workspaceJoined && !roomIds.length) return { roomIds };

    const context = (
      await transaction.query<{ display_name: string; workspace_name: string }>(
        `SELECT COALESCE(NULLIF(identity.handle,''),identity.name) display_name,
                workspace.name workspace_name
         FROM identities identity CROSS JOIN workspaces workspace
         WHERE identity.id=$1 AND workspace.id=$2`,
        [input.identityId, input.workspaceId],
      )
    ).rows[0];
    if (!context) throw new Error('join context not found');

    for (const roomId of roomIds) {
      await transaction.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
         VALUES($1,$2,$3,$4,'system','member-joined',$5::jsonb)`,
        [
          messageId(),
          roomId,
          input.identityId,
          `${context.display_name} joined`,
          JSON.stringify({ identityId: input.identityId }),
        ],
      );
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
        `${context.display_name} joined ${context.workspace_name}`,
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
