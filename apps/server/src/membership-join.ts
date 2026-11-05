import { subscriptionRooms } from './agent-subscriptions.js';
import type { QueryResultRow } from 'pg';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { randomUUID } from 'node:crypto';
import type { SystemEventKind } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { systemIdentityMention, systemLine } from './system-line.js';

type RoomSelection =
  { type: 'none' } | { type: 'rooms'; roomIds: readonly string[] } | { type: 'all-live-top-level' };

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
 * DM roles stay independent; corners derive their roles from these Room rows.
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

/**
 * A public top-level Room belongs to every current Workspace member. This is
 * the server-side projection used both when the Room becomes public and when
 * it is first created; DMs and corners can never enter through this path.
 */
export async function joinWorkspaceMembersToPublicRoom(
  database: SqlDatabase,
  workspaceId: string,
  roomId: string,
  scope: 'all' | 'roster-humans' = 'all',
): Promise<number> {
  await database.query(`SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, [workspaceId]);
  const joined = await database.query<{ identity_id: string }>(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
     SELECT room.workspace_id,room.id,workspace_member.identity_id,workspace_member.role
     FROM rooms room
     JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
       AND workspace_member.room_id IS NULL AND workspace_member.removed_at IS NULL
     JOIN identities identity ON identity.id=workspace_member.identity_id
     WHERE room.id=$2 AND room.workspace_id=$1 AND room.parent_id IS NULL
       AND room.direct_participants IS NULL AND room.archived_at IS NULL
       AND room.visibility='public'
       AND ($3='all' OR (identity.kind='human' AND identity.hidden_from_roster=false))
     ON CONFLICT (room_id,identity_id) WHERE room_id IS NOT NULL
     DO UPDATE SET role=EXCLUDED.role,removed_at=NULL
       WHERE memberships.removed_at IS NOT NULL AND $3='all'
     RETURNING identity_id`,
    [workspaceId, roomId, scope],
  );
  return joined.rowCount;
}

/**
 * The Rooms among these whose current agent members subscribed to `kind`.
 *
 * A projected join emits its event only where someone listens; a Room nobody
 * subscribed to stays silent, exactly as an unprojected join would leave it.
 * Mirrors `system-line.ts`'s subscriber lookup and its failure stance: the
 * join's membership writes are real, so a lookup failure logs and emits
 * nowhere rather than failing the join.
 */
async function subscriberRooms(
  database: SqlDatabase,
  roomIds: readonly string[],
  kind: SystemEventKind,
): Promise<string[]> {
  if (!roomIds.length) return [];
  try {
    return await subscriptionRooms(database, roomIds, kind);
  } catch (error) {
    console.error('[membership-join] subscriber room lookup failed', error);
    return [];
  }
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
    await transaction.query(`SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, [
      input.workspaceId,
    ]);
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
          roomPredicate = `room.visibility='public'`;
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
           DO UPDATE SET role=EXCLUDED.role,removed_at=NULL
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

    const line = {
      subject: {
        kind: context.kind === 'agent' ? ('agent' as const) : ('person' as const),
        id: input.identityId,
        name: joiningMention,
      },
      verb: systemMessage("membership-join.joined"),
      ...(context.inviter_id &&
      context.inviter_kind &&
      context.inviter_name &&
      context.inviter_handle
        ? {
            attribution: {
              verb: systemMessage("membership-join.invited-by"),
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
      kind: 'joined' as const,
      cardType: 'member-joined',
      card: { identityId: input.identityId },
    };

    // Auto-joining public Rooms is only a membership projection of the
    // Workspace arrival. In an ordinary Room that arrival stays silent: it is
    // retained in memberships without a System DM. System events are
    // SUBSCRIBABLE per Room, so the
    // projection emits its `joined` event exactly where someone subscribed:
    // any agent member of a projected Room that subscribed to `joined` wakes
    // on it, in any Workspace, with no workspace special case — that is how a
    // greeter hears about every newcomer. An explicit Room join always belongs
    // in that Room and keeps its subscribed `joined` event.
    const announced =
      input.rooms.type !== 'all-live-top-level'
        ? roomIds
        : await subscriberRooms(transaction, roomIds, 'joined');
    for (const roomId of announced)
      await systemLine(transaction, {
        roomId,
        ...line,
      });

    // Workspace arrivals are retained in memberships without a broadcast push.
    if (input.workspaceJoined) return { roomIds };

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

// Membership write primitives. Callers retain their transaction and access checks.
// Keep each conflict policy explicit: initial joins and restorations differ.
export function removeWorkspaceMemberships<Row extends QueryResultRow = QueryResultRow>(
  database: Pick<SqlDatabase, 'query'>, values: [workspaceId: string, identityId: string],
) {
  return database.query<Row>(
    `UPDATE memberships SET removed_at=now() WHERE workspace_id=$1 AND identity_id=$2`, values,
  );
}

export function restoreRoomMembership<Row extends QueryResultRow = QueryResultRow>(
  database: Pick<SqlDatabase, 'query'>, values: [workspaceId: string, roomId: string, identityId: string],
) {
  return database.query<Row>(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')
         ON CONFLICT(room_id,identity_id) WHERE room_id IS NOT NULL DO UPDATE SET removed_at=NULL`, values,
  );
}

export function ensureRoomMembership<Row extends QueryResultRow = QueryResultRow>(
  database: Pick<SqlDatabase, 'query'>, values: [workspaceId: string, roomId: string, identityId: string],
) {
  return database.query<Row>(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member') ON CONFLICT DO NOTHING`, values,
  );
}

/** Bounded backfill SQL; the migration runner supplies its batch limit. */
export function perItemMembershipSubscriptionCleanupSql(): string {
  return `UPDATE memberships SET event_subscriptions=COALESCE(
       (SELECT jsonb_agg(elem) FROM jsonb_array_elements_text(event_subscriptions) elem
        WHERE NOT (elem=ANY($1::text[]))),
       '[]'::jsonb
     )
     WHERE id IN (SELECT id FROM memberships WHERE event_subscriptions ?| $1::text[] ORDER BY id LIMIT $2)`;
}

export function createInvitedWorkspaceMembership<Row extends QueryResultRow = QueryResultRow>(
  database: Pick<SqlDatabase, 'query'>, values: [workspaceId: string, identityId: string, invitedBy: string],
) {
  return database.query<Row>(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role,invited_by)
     VALUES($1,NULL,$2,'member',$3)`, values,
  );
}

export function deleteCornerMembershipBatch<Row extends QueryResultRow = QueryResultRow>(
  database: Pick<SqlDatabase, 'query'>, values: [] = [],
) {
  return database.query<Row>(
    `DELETE FROM memberships member WHERE member.id IN (
         SELECT legacy.id FROM memberships legacy JOIN rooms corner ON corner.id=legacy.room_id
         WHERE corner.parent_id IS NOT NULL ORDER BY legacy.id LIMIT 250
       ) RETURNING member.id`, values,
  );
}

export function ensureInvitedWorkspaceMembership<Row extends QueryResultRow = QueryResultRow>(
  database: Pick<SqlDatabase, 'query'>, values: [workspaceId: string, identityId: string, invitedBy: string],
) {
  return database.query<Row>(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role,invited_by)
         VALUES ($1,NULL,$2,'member',$3) ON CONFLICT DO NOTHING`, values,
  );
}

export function restorePairedWorkspaceMembership<Row extends QueryResultRow = QueryResultRow>(
  database: Pick<SqlDatabase, 'query'>, values: [workspaceId: string, identityId: string, invitedBy: string],
) {
  return database.query<Row>(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role,invited_by)
         VALUES ($1,NULL,$2,'member',$3)
         ON CONFLICT (workspace_id,identity_id) WHERE room_id IS NULL
         DO UPDATE SET role='member',removed_at=NULL,joined_at=now(),invited_by=EXCLUDED.invited_by
           WHERE memberships.removed_at IS NOT NULL
         RETURNING id`, values,
  );
}

export function createWorkspaceOwnerMembership<Row extends QueryResultRow = QueryResultRow>(
  database: Pick<SqlDatabase, 'query'>, values: [workspaceId: string, identityId: string],
) {
  return database.query<Row>(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner')`, values,
  );
}

export function joinRoomCreator<Row extends QueryResultRow = QueryResultRow>(
  database: Pick<SqlDatabase, 'query'>, values: [workspaceId: string, roomId: string, identityId: string],
) {
  return database.query<Row>(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         SELECT $1,$2,$3,role FROM memberships
         WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$3 AND removed_at IS NULL`, values,
  );
}

export function removeRoomMembership<Row extends QueryResultRow = QueryResultRow>(
  database: Pick<SqlDatabase, 'query'>, values: [roomId: string, identityId: string],
) {
  return database.query<Row>(
    `UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, values,
  );
}

export function restoreWorkspaceMembershipRole<Row extends QueryResultRow = QueryResultRow>(
  database: Pick<SqlDatabase, 'query'>, values: [workspaceId: string, identityId: string, role: string, invitedBy: string],
) {
  return database.query<Row>(
    `UPDATE memberships SET role=$3,removed_at=NULL,invited_by=CASE WHEN removed_at IS NOT NULL THEN $4 ELSE invited_by END
           WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`, values,
  );
}

export function ensureWorkspaceMembershipRole<Row extends QueryResultRow = QueryResultRow>(
  database: Pick<SqlDatabase, 'query'>, values: [workspaceId: string, identityId: string, role: string, invitedBy: string],
) {
  return database.query<Row>(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role,invited_by)
         VALUES($1,NULL,$2,$3,$4) ON CONFLICT DO NOTHING`, values,
  );
}

export function createDirectMessageMembership<Row extends QueryResultRow = QueryResultRow>(
  database: Pick<SqlDatabase, 'query'>, values: [workspaceId: string, roomId: string, identityId: string],
) {
  return database.query<Row>(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, values,
  );
}

export function redeemWorkspaceMembership<Row extends QueryResultRow = QueryResultRow>(
  database: Pick<SqlDatabase, 'query'>, values: [workspaceId: string, identityId: string, invitedBy: string],
) {
  return database.query<Row>(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role,invited_by) VALUES($1,NULL,$2,'member',$3)
         ON CONFLICT (workspace_id,identity_id) WHERE room_id IS NULL
         DO UPDATE SET role='member',removed_at=NULL,invited_by=EXCLUDED.invited_by
           WHERE memberships.removed_at IS NOT NULL`, values,
  );
}

export function removeIdentityMemberships<Row extends QueryResultRow = QueryResultRow>(
  database: Pick<SqlDatabase, 'query'>, values: [identityId: string],
) {
  return database.query<Row>(
    `UPDATE memberships SET removed_at=now()
       WHERE identity_id=$1 AND removed_at IS NULL`, values,
  );
}

export function transferWorkspaceOwnership<Row extends QueryResultRow = QueryResultRow>(
  database: Pick<SqlDatabase, 'query'>, values: [identityIds: string[]],
) {
  return database.query<Row>(
    `WITH lone AS (
           SELECT m.workspace_id FROM memberships m
           WHERE m.room_id IS NULL AND m.role='owner' AND m.removed_at IS NULL
             AND m.identity_id=ANY($1)
             AND NOT EXISTS (SELECT 1 FROM memberships o
                             WHERE o.workspace_id=m.workspace_id AND o.room_id IS NULL
                               AND o.role='owner' AND o.removed_at IS NULL
                               AND o.identity_id <> ALL($1))
         ), heir AS (
           SELECT DISTINCT ON (l.workspace_id) l.workspace_id,h.identity_id
           FROM lone l
           JOIN memberships h ON h.workspace_id=l.workspace_id AND h.room_id IS NULL
             AND h.role IN ('admin','member') AND h.removed_at IS NULL
             AND h.identity_id <> ALL($1)
           JOIN identities hi ON hi.id=h.identity_id AND hi.kind='human'
           ORDER BY l.workspace_id,h.role,h.joined_at,h.identity_id
         )
         UPDATE memberships m SET role='owner' FROM heir
         WHERE m.workspace_id=heir.workspace_id AND m.identity_id=heir.identity_id`, values,
  );
}

export function transferRoomOwnership<Row extends QueryResultRow = QueryResultRow>(
  database: Pick<SqlDatabase, 'query'>, values: [identityIds: string[]],
) {
  return database.query<Row>(
    `WITH lone AS (
           SELECT m.room_id FROM memberships m JOIN rooms r ON r.id=m.room_id
           WHERE m.room_id IS NOT NULL AND r.parent_id IS NULL AND r.archived_at IS NULL
             AND m.role='owner' AND m.removed_at IS NULL AND m.identity_id=ANY($1)
             AND NOT EXISTS (SELECT 1 FROM memberships o
                             WHERE o.room_id=m.room_id AND o.role='owner'
                               AND o.removed_at IS NULL AND o.identity_id <> ALL($1))
         ), heir AS (
           SELECT DISTINCT ON (l.room_id) l.room_id,h.identity_id
           FROM lone l
           JOIN memberships h ON h.room_id=l.room_id AND h.role IN ('admin','member')
             AND h.removed_at IS NULL AND h.identity_id <> ALL($1)
           JOIN identities hi ON hi.id=h.identity_id AND hi.kind='human'
           ORDER BY l.room_id,h.role,h.joined_at,h.identity_id
         )
         UPDATE memberships m SET role='owner' FROM heir
         WHERE m.room_id=heir.room_id AND m.identity_id=heir.identity_id`, values,
  );
}

export function writeSurfacePushState<Row extends QueryResultRow = QueryResultRow>(
  database: Pick<SqlDatabase, 'query'>, values: [roomId: string, identityId: string, muted: boolean | null],
) {
  return database.query<Row>(
    `WITH surface AS (
           SELECT room.id,room.parent_id,member.push_muted FROM rooms room
           JOIN memberships member ON member.room_id=room.id
             AND member.identity_id=$2 AND member.removed_at IS NULL
           JOIN identities person ON person.id=$2 AND person.kind='human' WHERE room.id=$1
         ), room_update AS (
           UPDATE memberships member SET push_muted=COALESCE($3,member.push_muted) FROM surface
           WHERE surface.parent_id IS NULL AND member.room_id=surface.id AND member.identity_id=$2
           RETURNING member.push_muted
         ), corner_update AS (
           INSERT INTO corner_person_state(corner_id,identity_id,push_muted)
           SELECT id,$2,$3 FROM surface WHERE parent_id IS NOT NULL AND $3 IS NOT NULL
           ON CONFLICT(corner_id,identity_id) DO UPDATE SET push_muted=EXCLUDED.push_muted
           RETURNING push_muted
         ) SELECT * FROM room_update UNION ALL SELECT * FROM corner_update
           UNION ALL SELECT push_muted FROM surface WHERE parent_id IS NOT NULL AND $3 IS NULL`, values,
  );
}

export function ensureWorkspaceOwnerMembership<Row extends QueryResultRow = QueryResultRow>(
  database: Pick<SqlDatabase, 'query'>, values: [workspaceId: string, identityId: string],
) {
  return database.query<Row>(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
     VALUES($1,NULL,$2,'owner')
     ON CONFLICT (workspace_id,identity_id) WHERE room_id IS NULL DO NOTHING`, values,
  );
}

export function moveRoomMembershipsToWorkspace<Row extends QueryResultRow = QueryResultRow>(
  database: Pick<SqlDatabase, 'query'>, values: [roomId: string, workspaceId: string],
) {
  return database.query<Row>(
    `UPDATE memberships SET workspace_id=$2 WHERE room_id=$1 AND workspace_id<>$2`, values,
  );
}

export function ensureReviewProofMembership<Row extends QueryResultRow = QueryResultRow>(
  database: Pick<SqlDatabase, 'query'>, values: [roomId: string, identityId: string],
) {
  return database.query<Row>(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
     SELECT workspace_id,id,$2,'member' FROM rooms WHERE id=$1
     ON CONFLICT (room_id,identity_id) WHERE room_id IS NOT NULL DO NOTHING`, values,
  );
}

/**
 * Joins public top-level Rooms in the Room's own Workspace. A fresh member (a
 * first connection, or a reconnect after Disconnect) rejoins every public
 * Room; an existing member keeps the Rooms a person removed it from.
 */
export function joinMcpPublicRooms<Row extends QueryResultRow = QueryResultRow>(
  database: Pick<SqlDatabase, 'query'>, values: [identityId: string, workspaceIds: string[], restoreRemoved: boolean],
) {
  return database.query<Row>(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
  SELECT room.workspace_id,room.id,$1,'member' FROM rooms room
  WHERE room.workspace_id=ANY($2::uuid[]) AND room.parent_id IS NULL
    AND room.direct_participants IS NULL AND room.archived_at IS NULL AND room.visibility='public'
  ON CONFLICT (room_id,identity_id) WHERE room_id IS NOT NULL
  DO UPDATE SET removed_at=NULL WHERE memberships.removed_at IS NOT NULL AND $3::boolean`, values,
  );
}

export function restoreMcpWorkspaceMemberships<Row extends QueryResultRow = QueryResultRow>(
  database: Pick<SqlDatabase, 'query'>, values: [identityId: string, workspaceIds: string[]],
) {
  return database.query<Row>(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         SELECT workspace_id,NULL,$1,'member' FROM unnest($2::uuid[]) workspace_id
         ON CONFLICT(workspace_id,identity_id) WHERE room_id IS NULL
         DO UPDATE SET removed_at=NULL`, values,
  );
}

/** Retire historical bans before their table is dropped. */
export function retireWorkspaceBansSql(): string {
  return `DO $$
BEGIN
  IF to_regclass('workspace_bans') IS NOT NULL THEN
    UPDATE memberships m SET removed_at=now()
    FROM workspace_bans b
    WHERE m.workspace_id=b.workspace_id AND m.identity_id=b.identity_id AND m.removed_at IS NULL;
  END IF;
END;
$$;
`;
}

/** Upgrade-only: old membership JSON cannot remain an actionable subscription store. */
export async function retireMembershipSubscriptionLists(database: SqlDatabase): Promise<void> {
  await database.query(`UPDATE memberships SET event_subscriptions='[]'::jsonb WHERE event_subscriptions<>'[]'::jsonb`);
}
