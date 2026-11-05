import { recordPersonInteraction } from '../away-auto-pause.js';
import { CommandScopedDatabase } from '../command-scoped-database.js';
import { isMentionReplyInput } from '../owed-mentions.js';
import { observeOnboardingMessage } from '../signin-funnel.js';
import { CommandRefusalError } from '../command-refusal.js';
import { CornerAccessDatabase } from '../corner-access-database.js';
import { routeHumanMessage, soloRoomAgentSql } from '../agent-command.js';
import type { RoomViewMessage } from '@beeline/api-contract/phone';
import { MESSAGE_REACTION_EMOJIS } from '@beeline/api-contract/phone';
import { recordSystemReportMention } from '../feedback.js';
import { tombstoneInstitutionalMemoryForMessage } from '../institutional-memory-shadow.js';
import { deletedMessageEvent } from '../system-line.js';
import { unreadMessageSql, visibleChatMessageSql } from '../read-cursor.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { PhoneContext } from './context.js';
import { Input, Output } from './types.js';
import { phoneWithCommandTransaction } from './command-context.js';
import { messageId, advanceAuthorReadMark } from './values.js';
import { phoneUnansweredMentionTargets, phoneNoteUnansweredMentions, phoneActiveSteerAgentIds, phonePendingAgentCommandsForMessage, phoneReceiptMessage } from './mention-notices.js';
import { phoneHasRoomAccess, phoneAssertRoomIsWritable, phoneRequireWorkspaceMember } from './access.js';
import { phoneReadLiveDelta, phoneLiveStarPrompt } from './live-reads.js';



  export async function phoneMarkRead(ctx: PhoneContext, roomId: string, messageIdValue: string, viewerId: string): Promise<void> {
    const result = (await ctx.database.query<{ eligible: boolean; changed: boolean }>(
      `WITH eligible AS (
         SELECT message.id,message.created_at FROM messages message
         JOIN rooms room ON room.id=message.room_id
         JOIN memberships room_member ON room_member.room_id=COALESCE(room.parent_id,room.id)
           AND room_member.identity_id=$2 AND room_member.removed_at IS NULL
         JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
           AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
           AND workspace_member.removed_at IS NULL
         WHERE message.id=$3 AND room.id=$1
       ), written AS (
         INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id)
         SELECT $1,$2,created_at,id FROM eligible
         ON CONFLICT(room_id,identity_id) DO UPDATE
           SET message_created_at=EXCLUDED.message_created_at,message_id=EXCLUDED.message_id,
             updated_at=now()
         WHERE (EXCLUDED.message_created_at,EXCLUDED.message_id)>
           (room_read_marks.message_created_at,room_read_marks.message_id)
         RETURNING message_id
       ) SELECT EXISTS(SELECT 1 FROM eligible) eligible,
           EXISTS(SELECT 1 FROM written) changed`,
      [roomId, viewerId, messageIdValue],
    )).rows[0];
    if (!result?.eligible) throw new Error('message not found');
    await recordPersonInteraction(ctx.database, viewerId);
    // The committed row's PostgreSQL notification reconciles every reader
    // device, including those on this server. Publishing here duplicates it.
  }


  /**
   * Put the boundary back in front of `messageIdValue`, so the Room reads
   * unread from that message onward. The mark lands on the newest countable
   * row strictly older than the target; when nothing precedes it the mark is
   * removed entirely and the whole Room is unread again.
   *
   * Unlike `markRead` this is not monotonic — moving the boundary backwards is
   * the entire point — so it writes unconditionally.
   *
   * The target must be a row this viewer's unread count would actually count.
   * Anything else — their own message above all — makes the caller a boundary
   * the count then contradicts: it reported nothing unread while the open Room
   * drew a NEW MESSAGES divider at the chosen row (review 2026-09-22).
   */
  export async function phoneMarkUnread(ctx: PhoneContext, roomId: string, messageIdValue: string, viewerId: string): Promise<void> {
    const result = (await ctx.database.query<{ accessible: boolean; countable: boolean }>(
      `WITH accessible AS (
         SELECT message.* FROM messages message
         JOIN rooms room ON room.id=message.room_id
         JOIN memberships room_member ON room_member.room_id=COALESCE(room.parent_id,room.id)
           AND room_member.identity_id=$2 AND room_member.removed_at IS NULL
         JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
           AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
           AND workspace_member.removed_at IS NULL
         WHERE message.id=$1 AND room.id=$3
       ), target AS (
         SELECT * FROM accessible message WHERE ${unreadMessageSql('message')}
       ), previous AS (
         SELECT earlier.id,earlier.created_at FROM target
         JOIN messages earlier ON earlier.room_id=target.room_id
           AND (earlier.created_at,earlier.id)<(target.created_at,target.id)
           AND ${visibleChatMessageSql('earlier')}
         ORDER BY earlier.created_at DESC,earlier.id DESC LIMIT 1
       ), written AS (
         INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id)
         SELECT $3,$2,created_at,id FROM previous
         ON CONFLICT(room_id,identity_id) DO UPDATE
           SET message_created_at=EXCLUDED.message_created_at,
               message_id=EXCLUDED.message_id,updated_at=now()
         RETURNING message_id
       ), cleared AS (
         DELETE FROM room_read_marks
         WHERE room_id=$3 AND identity_id=$2 AND EXISTS(SELECT 1 FROM target)
           AND NOT EXISTS(SELECT 1 FROM previous)
         RETURNING message_id
       ) SELECT EXISTS(SELECT 1 FROM accessible) accessible,
           EXISTS(SELECT 1 FROM target) countable`,
      [messageIdValue, viewerId, roomId],
    )).rows[0];
    if (!result?.accessible) throw new Error('message not found');
    // 'invalid' is what the router reads as a 400 — the row is real and
    // readable, it is simply not something this viewer can hold unread.
    if (!result.countable)
      throw new Error(
        'messageId is invalid: only a row that counts as unread can be marked unread',
      );
    // INSERT/UPDATE/DELETE all notify through PostgreSQL, once per changed row.
  }


  export async function phoneUploadMedia(ctx: PhoneContext, 
    viewerId: string,
    bytes: Uint8Array,
    mimeType: string,
    name: string,
    maximumBytes: number,
  ) {
    if (!ctx.objects) throw new Error('object storage is not configured');
    if (!bytes.length || bytes.length > maximumBytes)
      throw new Error('media size is outside the allowed range');
    const stored = await ctx.objects.uploadSharedFile(viewerId, bytes, mimeType, name);
    return {
      url: stored.url,
      name: stored.title,
      mimeType: stored.mimeType,
      size: stored.size,
      sha256: stored.sha256,
    };
  }


  /** Only transport receipts defer observation; service completion still includes its milestones. */
  export async function phoneObserveSentMessage(ctx: PhoneContext, roomId: string, viewerId: string, defer: boolean): Promise<void> {
    const work = () =>
      observeOnboardingMessage(ctx.database, roomId, viewerId).catch((error) =>
        console.error('[onboarding]', error),
      );
    const backgroundWork = CornerAccessDatabase.physical(ctx.database).backgroundWork;
    if (defer && backgroundWork)
      backgroundWork.run(async () => {
        // Queue the response before analytics competes for a database connection.
        await new Promise<void>((resolve) => setImmediate(resolve));
        await work();
      });
    else await work();
  }

  export async function phoneSendMessage(ctx: PhoneContext, 
    input: Input<'sendRoomMessage'>,
    author: string,
    sourceClient?: { id: string; name: string },
    familyId?: string,
  ): Promise<Output<'sendRoomMessage'>> {
    if (!ctx.routingTransaction && !(ctx.database as CommandScopedDatabase).active)
      return ctx.database.transaction(db =>
        phoneWithCommandTransaction(ctx, db, () => phoneSendMessage(ctx, input, author, sourceClient, familyId)));
    const id = input.messageId ?? messageId();
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('messageId is invalid');
    const attachments = JSON.stringify(input.attachments ?? []);
    let database = ctx.database;
    const write = (await database.query<{
      inserted: boolean;
      retry: boolean;
      writable: boolean;
      system_dm: boolean;
      direct: boolean;
      corner: boolean;
      author_kind: 'human' | 'agent';
      solo_agent: boolean;
    }>(
      `WITH access AS (
         SELECT room.id,room.parent_id,room.direct_participants,identity.kind author_kind,
           ${soloRoomAgentSql('room', 'identity.id')} IS NOT NULL solo_agent,
           COALESCE(room.direct_participants ? $6,false) system_dm,
           COALESCE(workspace_member.role<>'spectator',$3=$6) writable
         FROM rooms room
         JOIN memberships room_member ON room_member.room_id=COALESCE(room.parent_id,room.id)
           AND room_member.identity_id=$3 AND room_member.removed_at IS NULL
         LEFT JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
           AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$3
           AND workspace_member.removed_at IS NULL
         JOIN identities identity ON identity.id=$3
         WHERE room.id=$2 AND room.archived_at IS NULL AND ($3=$6 OR workspace_member.identity_id IS NOT NULL)
         FOR SHARE OF room_member
       ), inserted AS (
         INSERT INTO messages(id,room_id,author_id,text,attachments,source_client)
         SELECT $1,$2,$3,$4,$5::jsonb,$7::jsonb FROM access
         WHERE writable AND ($3=$6 OR NOT system_dm)
         ON CONFLICT(id) DO NOTHING
         RETURNING id,room_id,created_at
       ), read_mark AS (
         INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id,updated_at)
         SELECT room_id,$3,created_at,id,'epoch'::timestamptz FROM inserted
         ON CONFLICT(room_id,identity_id) DO UPDATE
           SET message_created_at=EXCLUDED.message_created_at,message_id=EXCLUDED.message_id
         WHERE (EXCLUDED.message_created_at,EXCLUDED.message_id)>
           (room_read_marks.message_created_at,room_read_marks.message_id)
         RETURNING 1
       ), pending_route AS (
         INSERT INTO rooms_mcp_pending_routes(message_id,room_id,member_id)
         SELECT id,room_id,$3 FROM inserted WHERE $7::jsonb IS NOT NULL
         ON CONFLICT(message_id) DO NOTHING RETURNING 1
       )
       SELECT EXISTS(SELECT 1 FROM inserted) inserted,
         EXISTS(SELECT 1 FROM messages message
           WHERE message.id=$1 AND message.room_id=$2 AND message.author_id=$3
             AND message.text=$4 AND message.attachments=$5::jsonb
             AND message.reply_to_message_id IS NULL) retry,
         access.writable,access.system_dm,
         access.direct_participants IS NOT NULL direct,
         access.parent_id IS NOT NULL corner,access.author_kind,access.solo_agent
       FROM access`,
      [id, input.roomId, author, input.text, attachments, SYSTEM_IDENTITY_ID, sourceClient ? JSON.stringify(sourceClient) : null],
    )).rows[0];
    if (!write) throw new Error('room access denied');
    database = new CornerAccessDatabase(database);
    if (!write.writable) throw new Error('spectator access is read-only (access denied)');
    if (author !== SYSTEM_IDENTITY_ID && write.system_dm)
      throw new Error('this is a read-only system thread; only @system may post here (access denied)');
    const mayRoute = write.direct || write.corner || write.solo_agent || input.text.includes('@');
    if (!write.inserted && !write.retry) throw new Error('messageId is invalid');
    if (write.inserted) {
      const noticeAgentIds = write.author_kind === 'human' && mayRoute
        ? await phoneUnansweredMentionTargets(ctx, input.roomId, author, input.text, {
          authorKind: write.author_kind, direct: write.direct, corner: write.corner,
        })
        : [];
      const lifecycleCommand = mayRoute ? await routeHumanMessage(database, id) : undefined;
      if (!lifecycleCommand)
        await phoneNoteUnansweredMentions(ctx, input.roomId, author, noticeAgentIds, id);
      if (input.text.includes('@'))
        await recordSystemReportMention(database, {
          roomId: input.roomId,
          messageId: id,
          authorId: author,
          text: input.text,
          ...(familyId ? { familyId } : {}),
        });
    }
    return {
      messageId: id,
      activeSteerAgentIds: mayRoute ? await phoneActiveSteerAgentIds(ctx, database, id) : [],
      pendingAgentCommands: mayRoute
        ? await phonePendingAgentCommandsForMessage(ctx, database, input.roomId, id) : [],
      ...(await phoneReceiptMessage(ctx, input.roomId, author, id, database)),
    };
  }

  export async function phoneSendReply(ctx: PhoneContext, 
    input: Input<'sendRoomReply'>,
    author: string,
    sourceClient?: { id: string; name: string },
    familyId?: string,
  ): Promise<Output<'sendRoomReply'>> {
    if (!ctx.routingTransaction && !(ctx.database as CommandScopedDatabase).active)
      return ctx.database.transaction(db =>
        phoneWithCommandTransaction(ctx, db, () => phoneSendReply(ctx, input, author, sourceClient, familyId)));
    const parent = await ctx.database.query<{
      root_message_id: string | null;
      author_id: string;
      author_kind: 'human' | 'agent';
      direct: boolean;
    }>(
      `SELECT message.root_message_id,message.author_id,identity.kind author_kind,
              room.direct_participants IS NOT NULL direct
       FROM messages message
       JOIN identities identity ON identity.id=message.author_id
       JOIN rooms room ON room.id=message.room_id
       WHERE message.id=$1 AND message.room_id=$2`,
      [input.parentMessageId, input.roomId],
    );
    if (!parent.rows[0] || !(await phoneHasRoomAccess(ctx, input.roomId, author)))
      throw new Error('reply parent is not in this room');
    await phoneAssertRoomIsWritable(ctx, input.roomId, author);
    const id = input.messageId ?? messageId();
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('messageId is invalid');
    // A reply in a DM addresses the agent it answers without naming it. That
    // is the DM's own doing, not a tag: `routeHumanMessage` wakes every
    // participant of a direct Room, so the address survives without a list.
    const noticeAgentIds = await phoneUnansweredMentionTargets(ctx, input.roomId, author, input.text);
    const values = [
      id,
      input.roomId,
      author,
      input.text,
      JSON.stringify(input.attachments ?? []),
      input.parentMessageId,
      parent.rows[0].root_message_id ?? input.parentMessageId,
    ];
    const database = ctx.database;
    const inserted = await database.query(
      `WITH inserted AS (
       INSERT INTO messages(id,room_id,author_id,text,attachments,reply_to_message_id,root_message_id,source_client)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb) ON CONFLICT(id) DO NOTHING
       RETURNING id,room_id
     ), pending_route AS (
       INSERT INTO rooms_mcp_pending_routes(message_id,room_id,member_id)
       SELECT id,room_id,$3 FROM inserted WHERE $8::jsonb IS NOT NULL
       ON CONFLICT(message_id) DO NOTHING RETURNING 1
     ) SELECT id FROM inserted`,
      [...values, sourceClient ? JSON.stringify(sourceClient) : null],
    );
    if (!inserted.rowCount) {
      const retry = await database.query(
        `SELECT 1 FROM messages
       WHERE id=$1 AND room_id=$2 AND author_id=$3 AND (text=$4 OR $8::boolean)
         AND (attachments=$5::jsonb OR $8::boolean)
         AND reply_to_message_id=$6 AND root_message_id=$7`,
        [...values, isMentionReplyInput(input)],
      );
      if (!retry.rowCount) throw new Error('messageId is invalid');
    } else {
      await advanceAuthorReadMark(database, input.roomId, author, id);
      const lifecycleCommand = await routeHumanMessage(database, id);
      if (!lifecycleCommand)
        await phoneNoteUnansweredMentions(ctx, input.roomId, author, noticeAgentIds, id);
      await recordSystemReportMention(database, {
        roomId: input.roomId,
        messageId: id,
        authorId: author,
        text: input.text,
        ...(familyId ? { familyId } : {}),
      });
    }
    return {
      messageId: id,
      activeSteerAgentIds: await phoneActiveSteerAgentIds(ctx, database, id),
      pendingAgentCommands: await phonePendingAgentCommandsForMessage(ctx, database, input.roomId, id),
      ...(await phoneReceiptMessage(ctx, input.roomId, author, id, database)),
    };
  }


  export async function phoneReactToMessage(ctx: PhoneContext, input: Input<'reactToMessage'>, viewerId: string): Promise<Output<'reactToMessage'>> {
    if (!MESSAGE_REACTION_EMOJIS.includes(input.emoji)) throw new Error('reaction is invalid');
    await ctx.database.transaction(async (database) => {
      const row = (
        await database.query<{ reactions: Record<string, string[]> }>(
          `SELECT message.reactions
           FROM messages message
           JOIN memberships membership ON membership.room_id=message.room_id
             AND membership.identity_id=$3 AND membership.removed_at IS NULL
           JOIN memberships workspace_member ON workspace_member.workspace_id=membership.workspace_id
             AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$3
             AND workspace_member.removed_at IS NULL
           WHERE message.id=$1 AND message.room_id=$2 AND message.presentation='message'
             AND message.deleted_at IS NULL
           FOR UPDATE OF message`,
          [input.messageId, input.roomId, viewerId],
        )
      ).rows[0];
      if (!row) throw new CommandRefusalError('message is not available for reaction', 404);
      const reactions = { ...(row.reactions ?? {}) };
      const reactors = new Set(reactions[input.emoji] ?? []);
      if (reactors.has(viewerId)) reactors.delete(viewerId);
      else reactors.add(viewerId);
      if (reactors.size) reactions[input.emoji] = [...reactors];
      else delete reactions[input.emoji];
      await database.query(`UPDATE messages SET reactions=$3::jsonb WHERE id=$1 AND room_id=$2`, [
        input.messageId,
        input.roomId,
        JSON.stringify(reactions),
      ]);
    });
    const delta = await phoneReadLiveDelta(ctx, input.roomId, viewerId, {
      type: 'message', messageId: input.messageId,
    });
    if (delta?.type !== 'message-delta') return null;
    const prompt = await phoneLiveStarPrompt(ctx, viewerId).catch(() => undefined);
    return { ...delta.message, ...prompt };
  }


  export async function phoneDeleteRoomMessage(ctx: PhoneContext, 
    input: Input<'deleteRoomMessage'>,
    viewerId: string,
  ): Promise<RoomViewMessage | null> {
    if (!/^[0-9a-f]{64}$/.test(input.messageId)) throw new Error('messageId is invalid');
    await ctx.database.transaction(async (database) => {
      const deleted = await database.query<{ author_id: string; deleted_by: string }>(
        `UPDATE messages message SET deleted_at=COALESCE(message.deleted_at,now()),
           deleted_by=COALESCE(message.deleted_by,$3),text='',attachments='[]'::jsonb,reactions='{}'::jsonb
         FROM rooms room
         WHERE message.id=$1 AND message.room_id=$2 AND message.room_id=room.id
           AND message.presentation='message' AND EXISTS(
               SELECT 1 FROM memberships member
               WHERE member.room_id=COALESCE(room.parent_id,room.id) AND member.identity_id=$3
                 AND member.removed_at IS NULL FOR SHARE OF member
             ) AND (message.author_id=$3 OR EXISTS(
               SELECT 1 FROM memberships manager
               WHERE manager.workspace_id=room.workspace_id AND manager.room_id IS NULL
                 AND manager.identity_id=$3 AND manager.role IN ('owner','admin')
                 AND manager.removed_at IS NULL
             ))
         RETURNING message.author_id,message.deleted_by`,
        [input.messageId, input.roomId, viewerId],
      );
      database = new CornerAccessDatabase(database);
      const row = deleted.rows[0];
      if (!row) throw new CommandRefusalError('message is not available for deletion', 404);
      // The deleted row keeps its place and time and reads as a system line
      // naming who deleted it; nothing new is posted to the Room.
      await database.query(
        `UPDATE messages message SET system_event=$2::jsonb WHERE message.id=$1`,
        [
          input.messageId,
          JSON.stringify(await deletedMessageEvent(database, row.deleted_by, row.author_id)),
        ],
      );
      await tombstoneInstitutionalMemoryForMessage(database, input.messageId);

    });
    const delta = await phoneReadLiveDelta(ctx, input.roomId, viewerId, {
      type: 'message', messageId: input.messageId,
    });
    return delta?.type === 'message-delta' ? delta.message : null;
  }


  export async function phoneSetMessageBookmark(ctx: PhoneContext, 
    input: Input<'setMessageBookmark'>,
    viewerId: string,
  ): Promise<Output<'setMessageBookmark'>> {
    if (!/^[0-9a-f]{64}$/.test(input.messageId)) throw new Error('messageId is invalid');
    if (!input.bookmarked) {
      await ctx.database.query(
        `DELETE FROM message_bookmarks WHERE identity_id=$1 AND message_id=$2`,
        [viewerId, input.messageId],
      );
      return { bookmarked: false };
    }
    return ctx.database.transaction(async (database) => {
      const source = (
        await database.query<{
          workspace_id: string;
          room_name: string;
          room_kind: 'room' | 'corner';
          message_created_at: Date;
        }>(
          `SELECT room.workspace_id,room.name room_name,
             CASE WHEN room.parent_id IS NULL THEN 'room' ELSE 'corner' END room_kind,
             message.created_at message_created_at
           FROM messages message
           JOIN rooms room ON room.id=message.room_id
           JOIN memberships membership ON membership.room_id=COALESCE(room.parent_id,room.id)
             AND membership.identity_id=$3 AND membership.removed_at IS NULL
           JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
             AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$3
             AND workspace_member.removed_at IS NULL
           WHERE message.id=$1 AND message.room_id=$2 AND message.presentation='message'`,
          [input.messageId, input.roomId, viewerId],
        )
      ).rows[0];
      if (!source) throw new CommandRefusalError('message is not available for bookmarking', 404);
      await database.query(
        `INSERT INTO message_bookmarks(
           identity_id,workspace_id,room_id,message_id,source_room_name,source_room_kind,
           message_created_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(identity_id,message_id) DO NOTHING`,
        [
          viewerId,
          source.workspace_id,
          input.roomId,
          input.messageId,
          source.room_name,
          source.room_kind,
          source.message_created_at,
        ],
      );
      return { bookmarked: true };
    });
  }


  export async function phoneClearMessageBookmarks(ctx: PhoneContext, 
    input: Input<'clearMessageBookmarks'>,
    viewerId: string,
  ): Promise<void> {
    await phoneRequireWorkspaceMember(ctx, input.workspaceId, viewerId);
    await ctx.database.query(
      `DELETE FROM message_bookmarks WHERE workspace_id=$1 AND identity_id=$2`,
      [input.workspaceId, viewerId],
    );
  }
