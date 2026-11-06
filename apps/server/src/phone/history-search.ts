import { messageColumns } from '../message-columns.js';
import type { MessageSearchView, RoomHistoryOutline, RoomHistoryView } from '@beeline/api-contract/phone';
import { messageSearchTerms } from '@beeline/api-contract/phone';
import { visibleMessageSql } from '../read-cursor.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { PhoneContext } from './context.js';
import { MESSAGE_SEARCH_STATEMENT_TIMEOUT, MESSAGE_SEARCH_PAGE, MESSAGE_SEARCH_HEADLINE_OPTIONS, MessageSearchTooBroadError, messageSearchSnippet, reactionIdentitiesSql, reviveDates, projectedMessage, decorateAttachments } from './read-projection.js';
import { messageId, unix } from './values.js';
import { MessageRow } from './types.js';
import { phoneEnrichHistoryRows } from './message-enrichment.js';
import { phoneDecorateMessageCards } from './message-decoration.js';



  /**
   * The Room list's message search: the terms messageSearchTerms makes of
   * `query` are matched against `messages.search_document` (its GIN index
   * does the lookup), across the Rooms and direct messages the viewer's Room
   * list shows in this Workspace. Corners, archived Rooms, Rooms the viewer left, and deleted or
   * non-message rows are never searched. Newest first, a page at a time;
   * `before` is the previous page's last message id. A read that runs past
   * MESSAGE_SEARCH_STATEMENT_TIMEOUT throws MessageSearchTooBroadError.
   */
  export async function phoneSearchMessages(ctx: PhoneContext,
    workspaceId: string,
    viewerId: string,
    query: string,
    before?: string,
  ): Promise<MessageSearchView | null> {
    const workspace = await ctx.database.query(
      `SELECT 1 FROM memberships
       WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2 AND removed_at IS NULL`,
      [workspaceId, viewerId],
    );
    if (!workspace.rowCount) return null;
    const terms = messageSearchTerms(query);
    if (!terms) return { workspaceId, results: [] };
    type Row = {
      id: string;
      room_id: string;
      room_name: string;
      direct_message: boolean;
      author_name: string;
      created_at: Date;
      headline: string;
    };
    const rows = await ctx.database.transaction(async (database) => {
      await database.query(`SET LOCAL statement_timeout='${MESSAGE_SEARCH_STATEMENT_TIMEOUT}'`);
      try {
        return (
          await database.query<Row>(
            `WITH search_query AS (
             SELECT to_tsquery('simple',$3) query
           ), readable AS (
             SELECT room.id FROM rooms room
             JOIN memberships member ON member.room_id=room.id AND member.identity_id=$2
               AND member.removed_at IS NULL
             WHERE room.workspace_id=$1 AND room.parent_id IS NULL AND room.archived_at IS NULL
           ), cursor AS (
             SELECT created_at,id FROM messages WHERE id=$4
           ), matches AS (
             SELECT message.id,message.room_id,message.author_id,message.text,message.created_at
             FROM search_query
             JOIN messages message ON message.search_document @@ search_query.query
             WHERE message.room_id IN (SELECT id FROM readable)
               AND message.deleted_at IS NULL AND message.presentation='message'
               AND ($4::text IS NULL OR (message.created_at,message.id) < (SELECT created_at,id FROM cursor))
             ORDER BY message.created_at DESC,message.id DESC
             LIMIT ${MESSAGE_SEARCH_PAGE + 1}
           )
           SELECT matches.id,matches.room_id,matches.created_at,
             COALESCE(jsonb_typeof(room.direct_participants)='array',false) direct_message,
             COALESCE(peer.handle,peer.name,room.name) room_name,author.name author_name,
             ts_headline('simple',translate(matches.text,E'\\x01\\x02',''),search_query.query,$5) headline
           FROM matches
           CROSS JOIN search_query
           JOIN rooms room ON room.id=matches.room_id
           JOIN identities author ON author.id=matches.author_id
           LEFT JOIN identities peer ON jsonb_typeof(room.direct_participants)='array'
             AND peer.id=(SELECT participant FROM jsonb_array_elements_text(room.direct_participants) participant
                          WHERE participant<>$2 LIMIT 1)
           ORDER BY matches.created_at DESC,matches.id DESC`,
            [workspaceId, viewerId, terms, before ?? null, MESSAGE_SEARCH_HEADLINE_OPTIONS],
          )
        ).rows;
      } catch (error) {
        // Answered here rather than thrown through the transaction, so one broad
        // query does not count as a database outage. COMMIT of the failed
        // transaction rolls it back.
        if ((error as { code?: unknown } | null)?.code === '57014') return null;
        throw error;
      }
    });
    if (!rows) throw new MessageSearchTooBroadError();
    const page = rows.slice(0, MESSAGE_SEARCH_PAGE);
    return {
      workspaceId,
      results: page.map((row) => ({
        messageId: row.id,
        roomId: row.room_id,
        roomName: row.room_name,
        directMessage: row.direct_message,
        authorName: row.author_name,
        createdAt: unix(row.created_at),
        snippet: messageSearchSnippet(row.headline),
      })),
      ...(rows.length > MESSAGE_SEARCH_PAGE ? { nextBefore: page.at(-1)!.id } : {}),
    };
  }


  export async function phoneReadHistoryAround(ctx: PhoneContext, roomId: string, viewerId: string, targetId: string): Promise<RoomHistoryView | null> {
    const result = await ctx.database.query<{ rows: MessageRow[] }>(
      `WITH authorized AS (
        SELECT 1 FROM rooms room JOIN memberships room_member ON room_member.room_id=COALESCE(room.parent_id,room.id)
        WHERE room.id=$1 AND room_member.identity_id=$2
          AND room_member.removed_at IS NULL
          AND ($2=$4 OR EXISTS(SELECT 1 FROM memberships workspace_member
            WHERE workspace_member.workspace_id=room.workspace_id
              AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
              AND workspace_member.removed_at IS NULL))
      ), target AS (
         SELECT created_at,id FROM messages WHERE room_id=$1 AND id=$3
       ), target_rows AS (
         (SELECT m.id FROM messages m,target
          WHERE m.room_id=$1 AND (m.created_at,m.id)>=(target.created_at,target.id)
            AND (m.presentation<>'activity' OR m.durable_fact IS NOT NULL)
            AND ${visibleMessageSql('m')}
          ORDER BY m.created_at,m.id LIMIT 15)
         UNION ALL
         (SELECT m.id FROM messages m,target
          WHERE m.room_id=$1 AND (m.created_at,m.id)<(target.created_at,target.id)
            AND (m.presentation<>'activity' OR m.durable_fact IS NOT NULL)
            AND ${visibleMessageSql('m')}
          ORDER BY m.created_at DESC,m.id DESC LIMIT 15)
       ), page AS (
       SELECT ${messageColumns('m')},i.kind author_kind,i.name author_name,i.handle author_handle,
         i.avatar author_avatar,i.face_id author_face,
         ${reactionIdentitiesSql('m')} reaction_identities,
         '{}'::text[] tagged_ids
       FROM target_rows JOIN messages m ON m.id=target_rows.id
       JOIN identities i ON i.id=m.author_id
       ORDER BY m.created_at,m.id
       )
       SELECT COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.created_at,page.id)
         FROM page),'[]'::jsonb) rows FROM authorized`,
      [roomId,viewerId,targetId,SYSTEM_IDENTITY_ID],
    );
    const loaded = result.rows[0];
    if (!loaded) return null;
    const rows = loaded.rows.map((row) => reviveDates(row, ['created_at','deleted_at']));
    const attachmentFacts = await ctx.enrichHistoryRows(rows, viewerId);
    const messages = rows.map((row) => projectedMessage(row, ctx.publicOrigin, viewerId));
    const appMessages = await ctx.decorateMessageCards(roomId, messages, viewerId);
    return { roomId, messages: decorateAttachments(appMessages, attachmentFacts) };
  }


  export async function phoneReadHistoryAfter(ctx: PhoneContext, roomId: string, viewerId: string, afterId: string): Promise<RoomHistoryView | null> {
    const result = await ctx.database.query<{ rows: MessageRow[]; cursor_exists: boolean }>(
      `WITH authorized AS (
        SELECT 1 FROM rooms room JOIN memberships room_member ON room_member.room_id=COALESCE(room.parent_id,room.id)
        WHERE room.id=$1 AND room_member.identity_id=$2
          AND room_member.removed_at IS NULL
          AND ($2=$4 OR EXISTS(SELECT 1 FROM memberships workspace_member
            WHERE workspace_member.workspace_id=room.workspace_id
              AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
              AND workspace_member.removed_at IS NULL))
      ), page AS (
      SELECT ${messageColumns('m')},
         i.kind author_kind,i.name author_name,i.handle author_handle,
         i.avatar author_avatar,i.face_id author_face,
         ${reactionIdentitiesSql('m')} reaction_identities,
         '{}'::text[] tagged_ids
       FROM messages m JOIN identities i ON i.id=m.author_id
       WHERE m.room_id=$1 AND (m.presentation<>'activity' OR m.durable_fact IS NOT NULL)
         AND ${visibleMessageSql('m')}
         AND (m.created_at,m.id)>(
           SELECT cursor.created_at,cursor.id FROM messages cursor
           WHERE cursor.room_id=$1 AND cursor.id=$3
         )
       ORDER BY m.created_at,m.id LIMIT 30
      )
      SELECT COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.created_at,page.id)
        FROM page),'[]'::jsonb) rows,
        EXISTS(SELECT 1 FROM messages WHERE room_id=$1 AND id=$3) cursor_exists
      FROM authorized`,
      [roomId,viewerId,afterId,SYSTEM_IDENTITY_ID],
    );
    const loaded = result.rows[0];
    if (!loaded || !loaded.cursor_exists) return null;
    const rows = loaded.rows.map((row) => reviveDates(row, ['created_at','deleted_at']));
    const attachmentFacts = await ctx.enrichHistoryRows(rows, viewerId);
    const messages = rows.map((row) => projectedMessage(row, ctx.publicOrigin, viewerId));
    const appMessages = await ctx.decorateMessageCards(roomId, messages, viewerId);
    return { roomId, messages: decorateAttachments(appMessages, attachmentFacts) };
  }


  export async function phoneReadHistory(ctx: PhoneContext, roomId: string, viewerId: string, before?: { createdAt: number; id: string }): Promise<RoomHistoryView | null> {
    const result = await ctx.database.query<{ rows: MessageRow[] }>(
      `WITH authorized AS (
        SELECT 1 FROM rooms room
        JOIN memberships room_member ON room_member.room_id=COALESCE(room.parent_id,room.id)
        WHERE room.id=$1 AND room_member.identity_id=$2
          AND room_member.removed_at IS NULL
          AND ($2=$4 OR EXISTS(SELECT 1 FROM memberships workspace_member
            WHERE workspace_member.workspace_id=room.workspace_id
              AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
              AND workspace_member.removed_at IS NULL))
      ), cursor AS (
        SELECT created_at,id FROM messages WHERE room_id=$1 AND id=$3
      ), page AS (
        SELECT ${messageColumns('m')},i.kind author_kind,i.name author_name,i.handle author_handle,
          i.avatar author_avatar,i.face_id author_face,
          ${reactionIdentitiesSql('m')} reaction_identities,
          '{}'::text[] tagged_ids
        FROM messages m JOIN identities i ON i.id=m.author_id
        WHERE m.room_id=$1 AND EXISTS(SELECT 1 FROM authorized)
          AND (m.presentation<>'activity' OR m.durable_fact IS NOT NULL)
          AND ${visibleMessageSql('m')}
          AND ($3::text IS NULL OR NOT EXISTS(SELECT 1 FROM cursor)
            OR (m.created_at,m.id)<(SELECT created_at,id FROM cursor))
        ORDER BY m.created_at DESC,m.id DESC LIMIT 31
      )
      SELECT COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.created_at DESC,page.id DESC)
        FROM page),'[]'::jsonb) rows FROM authorized`,
      [roomId,viewerId,before?.id ?? null,SYSTEM_IDENTITY_ID],
    );
    const loaded = result.rows[0];
    if (!loaded) return null;
    const rows = loaded.rows.map((row) => reviveDates(row, ['created_at','deleted_at']));
    const page = rows.slice(0, 30);
    const attachmentFacts = await ctx.enrichHistoryRows(page, viewerId);
    const tail = page.at(-1);
    const messages = page
      .reverse()
      .map((row) => projectedMessage(row, ctx.publicOrigin, viewerId));
    const appMessages = await ctx.decorateMessageCards(roomId, messages, viewerId);
    return {
      roomId,
      messages: decorateAttachments(appMessages, attachmentFacts),
      ...(rows.length > 30 && tail
        ? { nextBefore: { createdAt: unix(tail.created_at), id: tail.id } }
        : {}),
    };
  }


  /**
   * Every message `readHistory` can page through, counted per local calendar
   * day in the reader's time zone with each day's oldest message, so the phone
   * can place the transcript scrubber and a marker for every day against the
   * whole history. `timeZone` is an IANA name the route has already checked.
   */
  export async function phoneReadHistoryOutline(ctx: PhoneContext,
    roomId: string,
    viewerId: string,
    timeZone: string,
  ): Promise<RoomHistoryOutline | null> {
    const newest = await ctx.database.query<{ id: string | null }>(
      `SELECT (SELECT m.id FROM messages m
         WHERE m.room_id=room.id AND (m.presentation<>'activity' OR m.durable_fact IS NOT NULL)
           AND ${visibleMessageSql('m')}
         ORDER BY m.created_at DESC,m.id DESC LIMIT 1) id
       FROM rooms room JOIN memberships member ON member.room_id=COALESCE(room.parent_id,room.id)
         AND member.identity_id=$2 AND member.removed_at IS NULL
       WHERE room.id=$1 AND ($2=$3 OR EXISTS(
         SELECT 1 FROM memberships workspace_member
         WHERE workspace_member.workspace_id=room.workspace_id
           AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
           AND workspace_member.removed_at IS NULL))`,
      [roomId,viewerId,SYSTEM_IDENTITY_ID],
    );
    if (!newest.rows[0]) return null;
    if (!ctx.outlineCache) return phoneCountHistoryOutline(ctx, roomId, timeZone);
    return ctx.outlineCache.read(roomId, timeZone, newest.rows[0]?.id ?? null, () =>
      phoneCountHistoryOutline(ctx, roomId, timeZone),
    );
  }


  export async function phoneCountHistoryOutline(ctx: PhoneContext, roomId: string, timeZone: string): Promise<RoomHistoryOutline> {
    const rows = (
      await ctx.database.query<{
        local_day: string;
        message_count: string;
        id: string;
        created_at: Date;
        author_name: string;
        author_handle: string | null;
        newest_id: string;
        newest_created_at: Date;
      }>(
        `SELECT DISTINCT ON (local.day) local.day::text AS local_day,
           count(*) OVER (PARTITION BY local.day)::text AS message_count,
           m.id,m.created_at,i.name author_name,i.handle author_handle,
           first_value(m.id) OVER (ORDER BY m.created_at DESC,m.id DESC) newest_id,
           first_value(m.created_at) OVER (ORDER BY m.created_at DESC,m.id DESC) newest_created_at
         FROM messages m JOIN identities i ON i.id=m.author_id
         CROSS JOIN LATERAL (SELECT (m.created_at AT TIME ZONE $2)::date AS day) local
         WHERE m.room_id=$1 AND (m.presentation<>'activity' OR m.durable_fact IS NOT NULL)
           AND ${visibleMessageSql('m')}
         ORDER BY local.day,m.created_at,m.id`,
        [roomId, timeZone],
      )
    ).rows;
    const days = rows.map((row) => ({
      day: row.local_day,
      count: Number(row.message_count),
      first: {
        id: row.id,
        createdAt: unix(row.created_at),
        authorName: row.author_name,
        ...(row.author_handle ? { authorHandle: row.author_handle } : {}),
      },
    }));
    const newest = rows[0];
    return {
      roomId,
      timeZone,
      total: days.reduce((sum, day) => sum + day.count, 0),
      ...(newest ? { newest: { id: newest.newest_id, createdAt: unix(newest.newest_created_at) } } : {}),
      days,
    };
  }
