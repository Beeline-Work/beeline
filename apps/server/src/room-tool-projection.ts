import type { RoomToolPage, RoomToolReference, RoomViewMessage } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { readRouterAuthority, RouterProjectionUnavailable } from './router-projections.js';

type Summary = { id: string; author_id: string; name: string; kind: 'agent' | 'human'; created_at: Date; request_id: string | null; count: number };
const authorized = `SELECT room.id,room.workspace_id FROM rooms room
  JOIN memberships member ON member.room_id=COALESCE(room.parent_id,room.id) AND member.identity_id=$2 AND member.removed_at IS NULL
  JOIN memberships workspace ON workspace.workspace_id=room.workspace_id AND workspace.room_id IS NULL
    AND workspace.identity_id=$2 AND workspace.removed_at IS NULL WHERE room.id=$1`;
const isTool = `message.presentation='activity' AND message.deleted_at IS NULL AND message.durable_fact IS NULL
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(message.activity) item WHERE item->>'kind'='tool')`;

/** Aggregate IDs/counts only: never transfer 200 full JSONB tool bodies into
 * Node just to discard them. These are actual source row IDs, not new events. */
export async function roomToolSummaries(db: SqlDatabase, roomId: string, reader: string): Promise<RoomViewMessage[]> {
  const rows = (await db.query<Summary>(`WITH authorized AS (${authorized}), grouped AS (
    SELECT message.id,message.author_id,message.created_at,message.request_id,message.turn_id,
      count(*) OVER(PARTITION BY message.author_id,message.request_id,message.turn_id)::int count,
      row_number() OVER(PARTITION BY message.author_id,message.request_id,message.turn_id ORDER BY message.created_at DESC,message.id DESC) ordinal
    FROM authorized JOIN messages message ON message.room_id=authorized.id WHERE ${isTool}
  ) SELECT grouped.id,grouped.author_id,grouped.created_at,grouped.request_id,grouped.count,
    left(person.name,128) name,person.kind FROM grouped JOIN identities person ON person.id=grouped.author_id
    WHERE ordinal=1 ORDER BY grouped.created_at DESC,grouped.id DESC LIMIT 30`, [roomId, reader])).rows;
  return rows.map(row => ({ id: row.id, text: '', createdAt: Math.floor(row.created_at.getTime() / 1000), createdAtMs: row.created_at.getTime(),
    author: { pubkey: row.author_id, kind: row.kind, name: row.name }, presentation: 'activity',
    ...(row.request_id ? { requestId: row.request_id } : {}),
    activity: [{ kind: 'tool', title: `${row.count} steps`, toolGroup: { roomId, anchor: row.id, count: row.count } }],
  }));
}

/** Existing disclosure/Open actions own each bounded page. The optional
 * message target loads one full stored tool result, never a Room refetch. */
export async function readRoomTools(database: SqlDatabase, input: RoomToolReference & { before?: string; messageId?: string }, reader: string): Promise<RoomToolPage> {
  return database.transaction(async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const room = (await db.query<{ workspace_id: string }>(authorized, [input.roomId, reader])).rows[0];
    if (!room) throw new RouterProjectionUnavailable('authority');
    const authority = await readRouterAuthority(db, { family: 'room-head', roomId: input.roomId, workspaceId: room.workspace_id }, reader);
    const full = input.messageId !== undefined;
    const rows = (await db.query<Summary & { activity: RoomViewMessage['activity']; more: boolean }>(`WITH anchor AS (
      SELECT id,created_at,author_id,request_id,turn_id FROM messages WHERE id=$2 AND room_id=$1 AND presentation='activity' AND deleted_at IS NULL
    ), cursor AS (SELECT created_at,id FROM messages WHERE id=$3 AND room_id=$1), page AS (
      SELECT message.id,message.author_id,message.created_at,message.request_id,
        ${full ? `(SELECT jsonb_agg(item) FROM jsonb_array_elements(message.activity) item WHERE item->>'kind'='tool')` : `(SELECT jsonb_agg(jsonb_build_object('kind','tool','title',left(item->>'title',128),
          'operation',left(item->>'operation',64),'status',left(item->>'status',32),'output',left(item->>'output',128),
          'toolOutput',jsonb_build_object('roomId',$1::text,'anchor',$2::text,'messageId',message.id)))
          FROM jsonb_array_elements(message.activity) item WHERE item->>'kind'='tool')`} activity
      FROM messages message JOIN anchor ON message.author_id=anchor.author_id
        AND message.request_id IS NOT DISTINCT FROM anchor.request_id AND message.turn_id IS NOT DISTINCT FROM anchor.turn_id
      WHERE message.room_id=$1 AND ${isTool}
        AND (message.created_at,message.id)<=(anchor.created_at,anchor.id)
        AND ($3::text IS NULL OR (message.created_at,message.id)<(SELECT created_at,id FROM cursor))
        AND ($4::text IS NULL OR message.id=$4)
      ORDER BY message.created_at DESC,message.id DESC LIMIT ${full ? 1 : 51}
    ) SELECT page.*,left(person.name,128) name,person.kind FROM page JOIN identities person ON person.id=page.author_id
      ORDER BY page.created_at DESC,page.id DESC`, [input.roomId, input.anchor, input.before ?? null, input.messageId ?? null])).rows;
    const page = rows.slice(0, 50);
    const result: RoomToolPage = { roomId: input.roomId, authority, messages: page.map(row => ({
      id: row.id, text: '', createdAt: Math.floor(row.created_at.getTime() / 1000), createdAtMs: row.created_at.getTime(),
      author: { pubkey: row.author_id, kind: row.kind, name: row.name }, presentation: 'activity', activity: row.activity,
      ...(row.request_id ? { requestId: row.request_id } : {}),
    })), ...(rows.length > 50 ? { next: page.at(-1)!.id } : {}) };
    if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) throw new RouterProjectionUnavailable('budget');
    return result;
  });
}
