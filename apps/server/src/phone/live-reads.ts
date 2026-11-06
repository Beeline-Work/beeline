import { assetUrl, phoneIdentity as identity, type PhoneIdentityRow as IdentityRow } from '../phone-identity.js';
import { workingTurnFreshSql } from '../turn-ownership.js';
import { readHelperOverlayFrame } from '@beeline/api-contract/helper-overlay';
import { CommandScopedDatabase } from '../command-scoped-database.js';
import { readRepositoryOnboardingCard } from '@beeline/api-contract/phone';
import { CornerAccessDatabase } from '../corner-access-database.js';
import { turnRootMessageSql } from '../agent-command.js';
import { ROOM_VIEW_AGENT_LIMIT } from '@beeline/api-contract/phone';
import type { ChatListItem, ChatListCorner, CornerListView, MessageBookmarkView, NeedsYouItemView, RoomLiveDelta, RoomView, RoomViewIdentity, RoomViewMessage } from '@beeline/api-contract/phone';
import { type WelcomeCardsView, isPushLevel, type PushLevel } from '@beeline/api-contract/phone';
import { taggedIdentityIdsSql } from '../message-mentions.js';
import { type SqlDatabase } from '../database.js';
import { readNeedsYouOrder, needsYouItems } from '../needs-you.js';
import type { CommittedMessageLiveRow, LiveEvent } from '../live.js';
import { roomAttentionActorSql, roomNeedsYouSql, roomWorkingSql } from '../chat-corner-counts.js';
import { visibleMessageSql, visibleChatMessageSql, viewerReadCursorSql } from '../read-cursor.js';
import { readStarPrompt } from '../github-star-prompt.js';
import type { PhoneContext } from './context.js';
import { phoneDecorateCornerOpenCards } from './message-decoration.js';
import { projectedMessage, decorateAttachments, reactionIdentitiesSql } from './read-projection.js';
import { phoneAttachmentFacts, phoneProjectAgentTurns, phoneProjectPendingAgentCommands } from './message-enrichment.js';
import { messageId, unix } from './values.js';
import { AgentTurnRow, MessageRow, deckCornerSummary } from './types.js';
import { phoneLoadCorners } from './corner-reads.js';
import { phoneCanReadRooms } from './access.js';
import { phoneListRoomWorkflowRuns } from './schedules.js';



  /** Project a row the daemon's committing transaction already returned. The
   * socket subscription performed the Room access check; cross-process hints
   * still use readLiveDelta, which rechecks current membership. Attachments
   * get the same decoration as readLiveDeltas, read once per committed row. */
  export async function phoneProjectCommittedLiveDelta(ctx: PhoneContext, 
    roomId: string,
    committed: { type: 'message'; row: CommittedMessageLiveRow },
    viewerId?: string,
  ): Promise<RoomLiveDelta | null> {
    if (committed.row.room_id !== roomId) return null;
    if (committed.row.card_type === 'repository-onboarding' && (!viewerId ||
      readRepositoryOnboardingCard(committed.row.card)?.requesterId !== viewerId)) return null;
    const message = (await phoneDecorateCornerOpenCards(ctx, roomId, [
      projectedMessage(committed.row, ctx.publicOrigin, viewerId),
    ]))[0]!;
    let facts = ctx.committedAttachmentFacts.get(committed.row);
    if (!facts) {
      facts = phoneAttachmentFacts(ctx, [message]);
      ctx.committedAttachmentFacts.set(committed.row, facts);
    }
    return {
      type: 'message-delta',
      roomId,
      message: decorateAttachments([message], await facts)[0]!,
      ...(typeof committed.row.version === 'number' ? { version: committed.row.version } : {}),
    };
  }


  /** One committed row for the live paint path, behind the same two membership
   * bounds as a full Room read. A missing/hidden row falls back to the ordinary
   * reconciliation read at the caller. */
  export async function phoneReadLiveDelta(ctx: PhoneContext, 
    roomId: string,
    viewerId: string,
    target:
      { type: 'message'; messageId: string } | { type: 'turn'; agentId: string; requestId: string },
    database: SqlDatabase = ctx.database,
  ): Promise<RoomLiveDelta | null> {
    return (await phoneReadLiveDeltas(ctx, roomId, [viewerId], target, database)).get(viewerId) ?? null;
  }


  /** Resolve one committed row for every viewer listening on this process.
   * The authorized set and the base row come from one statement, so adding
   * sockets does not multiply row reads or trust a stale subscribe grant. */
  export async function phoneReadLiveDeltas(ctx: PhoneContext, 
    roomId: string,
    viewerIds: readonly string[],
    target:
      { type: 'message'; messageId: string } | { type: 'turn'; agentId: string; requestId: string },
    database: SqlDatabase = ctx.database,
  ): Promise<ReadonlyMap<string, RoomLiveDelta>> {
    database = new CornerAccessDatabase(database);
    const viewers = [...new Set(viewerIds)];
    const deltas = new Map<string, RoomLiveDelta>();
    if (!viewers.length) return deltas;
    if (target.type === 'turn') {
      const row = (
        await database.query<AgentTurnRow & {
          authorized_viewers: string[];
          deck_needs_you: boolean;
          deck_attention_actor: string | null;
          deck_working: boolean;
        }>(
          `WITH authorized AS (
             SELECT member.identity_id FROM rooms room
             JOIN memberships member ON member.room_id=room.id
               AND member.identity_id=ANY($2::text[]) AND member.removed_at IS NULL
             JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
               AND workspace_member.room_id IS NULL
               AND workspace_member.identity_id=member.identity_id
               AND workspace_member.removed_at IS NULL
             WHERE room.id=$1
           )
           SELECT turn.request_id,turn.agent_id,turn.status,turn.started_at,turn.created_at,turn.generation_id,
             requester.id requested_by,
             ARRAY(SELECT identity_id FROM authorized) authorized_viewers,
             ${roomNeedsYouSql('room')} deck_needs_you,
             ${roomWorkingSql('room')} deck_working,
             ${roomAttentionActorSql('room')} deck_attention_actor
           FROM rooms room
           JOIN agent_turns turn ON turn.room_id=room.id AND turn.agent_id=$3
           LEFT JOIN messages trigger ON trigger.id=${turnRootMessageSql('turn')}
           LEFT JOIN identities requester ON requester.id=trigger.author_id
             AND requester.kind='human'
           WHERE room.id=$1 AND EXISTS(SELECT 1 FROM authorized)
             AND (turn.status<>'working' OR ${workingTurnFreshSql('turn')})
           ORDER BY (turn.status='working') DESC,turn.created_at DESC,turn.request_id DESC LIMIT 1`,
          [roomId, viewers, target.agentId],
        )
      ).rows[0];
      if (!row || row.request_id !== target.requestId) return deltas;
      const delta: RoomLiveDelta = {
        type: 'turn-delta', roomId, turn: phoneProjectAgentTurns(ctx, [row])[0]!,
        agentState: row.deck_needs_you ? 'needs-you' : row.deck_working ? 'working' : null,
        ...(row.deck_needs_you ? { attentionReason: { kind: 'approval' as const,
          ...(row.deck_attention_actor ? { actor: row.deck_attention_actor } : {}) } } : {}),
      };
      for (const viewer of row.authorized_viewers) deltas.set(viewer, delta);
      return deltas;
    }
    const row = (
      await database.query<MessageRow & {
        authorized_viewers: string[];
        deck_latest_id: string | null;
        deck_latest_text: string | null;
        deck_latest_attachments: MessageRow['attachments'] | null;
        deck_latest_created_at: Date | null;
        deck_latest_author_id: string | null;
        deck_latest_author_kind: 'human' | 'agent' | null;
        deck_latest_author_name: string | null;
        deck_latest_author_handle: string | null;
        deck_latest_author_avatar: string | null;
        deck_latest_author_face: string | null;
        deck_latest_tagged_ids: string[] | null;
      }>(
        `WITH authorized AS (
           SELECT member.identity_id FROM rooms room
           JOIN memberships member ON member.room_id=room.id
             AND member.identity_id=ANY($3::text[]) AND member.removed_at IS NULL
           JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
             AND workspace_member.room_id IS NULL
             AND workspace_member.identity_id=member.identity_id
             AND workspace_member.removed_at IS NULL
           WHERE room.id=$1
         )
         SELECT message.*,author.kind author_kind,author.name author_name,
           author.handle author_handle,author.avatar author_avatar,author.face_id author_face,
           ${reactionIdentitiesSql('message')} reaction_identities,
           ${taggedIdentityIdsSql('message')} tagged_ids,
           ARRAY(SELECT identity_id FROM authorized) authorized_viewers,
           latest.id deck_latest_id,latest.text deck_latest_text,
           latest.attachments deck_latest_attachments,
           latest.created_at deck_latest_created_at,
           preview_author.id deck_latest_author_id,
           preview_author.kind deck_latest_author_kind,
           preview_author.name deck_latest_author_name,
           preview_author.handle deck_latest_author_handle,
           preview_author.avatar deck_latest_author_avatar,
           preview_author.face_id deck_latest_author_face,
           CASE WHEN message.deleted_at IS NOT NULL
             THEN ${taggedIdentityIdsSql('latest')}
             ELSE '{}'::text[] END deck_latest_tagged_ids
         FROM rooms room
         JOIN messages message ON message.room_id=room.id AND message.id=$2
         JOIN identities author ON author.id=message.author_id
         LEFT JOIN LATERAL (
           SELECT candidate.* FROM messages candidate
           WHERE message.deleted_at IS NOT NULL AND candidate.room_id=room.id
             AND ${visibleChatMessageSql('candidate')}
           ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT 1
         ) latest ON true
         LEFT JOIN identities preview_author ON preview_author.id=latest.author_id
         WHERE room.id=$1 AND EXISTS(SELECT 1 FROM authorized)
           AND ${visibleMessageSql('message')}
           AND (
             message.presentation<>'activity' OR message.durable_fact IS NOT NULL OR EXISTS(
               SELECT 1 FROM agent_turns turn
               WHERE turn.room_id=room.id AND turn.agent_id=message.author_id
                 AND turn.status='working'
                 AND date_trunc('second',message.created_at)>=date_trunc('second',turn.created_at)
                 AND NOT EXISTS(
                   SELECT 1 FROM agent_turns newer
                   WHERE newer.room_id=turn.room_id AND newer.agent_id=turn.agent_id
                     AND (newer.created_at,newer.request_id)>(turn.created_at,turn.request_id)
                 )
             )
           )`,
        [roomId, target.messageId, viewers],
      )
    ).rows[0];
    if (!row) return deltas;
    const base = (await phoneDecorateCornerOpenCards(ctx, roomId, [
      projectedMessage(row, ctx.publicOrigin),
    ]))[0]!;
    const facts = await phoneAttachmentFacts(ctx, [base]);
    const preview: ChatListItem['latestMessage'] | null =
      row.deck_latest_id && row.deck_latest_created_at && row.deck_latest_author_id &&
      row.deck_latest_author_kind && row.deck_latest_author_name
        ? {
            id: row.deck_latest_id,
            text: row.deck_latest_text ?? '',
            createdAt: unix(row.deck_latest_created_at),
            author: identity({
              id: row.deck_latest_author_id, kind: row.deck_latest_author_kind,
              name: row.deck_latest_author_name, handle: row.deck_latest_author_handle,
              avatar: row.deck_latest_author_avatar, face_id: row.deck_latest_author_face,
            }, ctx.publicOrigin),
            ...(row.deck_latest_attachments?.length ? {
              attachments: (row.deck_latest_attachments as NonNullable<RoomViewMessage['attachments']>)
                .map((attachment) => ({
                ...attachment,
                url: attachment.url.startsWith('/')
                  ? `${ctx.publicOrigin}${attachment.url}` : attachment.url,
                ...(attachment.previewUrl?.startsWith('/')
                  ? { previewUrl: `${ctx.publicOrigin}${attachment.previewUrl}` } : {}),
                ...(attachment.thumbnailUrl?.startsWith('/')
                  ? { thumbnailUrl: `${ctx.publicOrigin}${attachment.thumbnailUrl}` } : {}),
                })),
            } : {}),
          }
        : null;
    for (const viewer of row.authorized_viewers) {
      if (row.card_type === 'repository-onboarding' &&
        (readRepositoryOnboardingCard(row.card)?.requesterId !== viewer)) continue;
      const message = { ...projectedMessage(row, ctx.publicOrigin, viewer),
        ...(base.daemonFact ? { daemonFact: base.daemonFact } : {}) };
      deltas.set(viewer, {
        type: 'message-delta', roomId,
        message: decorateAttachments([message], facts)[0]!,
        ...(typeof row.version === 'number' ? { version: row.version } : {}),
        ...(row.deleted_at ? { deckPreview: preview ? {
          ...preview,
          ...(row.deck_latest_tagged_ids?.includes(viewer) ? { mentionsViewer: true as const } : {}),
        } : null } : {}),
      });
    }
    return deltas;
  }


  /** One bookmark row for an identity-wide live update. A lost Workspace or
   * Room membership can only remove fields from the result, never expose a
   * message the viewer can no longer read. */
  export async function phoneReadLiveBookmark(ctx: PhoneContext, messageId: string, viewerId: string): Promise<MessageBookmarkView | null> {
    const row = (await ctx.database.query<{
      message_id: string; workspace_id: string; room_id: string;
      room_name: string; room_kind: 'room' | 'corner';
      message_created_at: Date; bookmarked_at: Date; available: boolean;
      text: string | null; author_id: string | null;
      author_kind: 'human' | 'agent' | null; author_name: string | null;
      author_handle: string | null; author_avatar: string | null; author_face: string | null;
    }>(`SELECT bookmark.message_id,bookmark.workspace_id,bookmark.room_id,
         COALESCE(room.name,bookmark.source_room_name) room_name,
         bookmark.source_room_kind room_kind,
         bookmark.message_created_at,bookmark.created_at bookmarked_at,
         (message.id IS NOT NULL AND message.deleted_at IS NULL AND room_member.identity_id IS NOT NULL) available,
         CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN message.text END text,
         CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN author.id END author_id,
         CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN author.kind END author_kind,
         CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN author.name END author_name,
         CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN author.handle END author_handle,
         CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN author.avatar END author_avatar,
         CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN author.face_id END author_face
       FROM message_bookmarks bookmark
       JOIN memberships workspace_member ON workspace_member.workspace_id=bookmark.workspace_id
         AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
         AND workspace_member.removed_at IS NULL
       LEFT JOIN rooms room ON room.id=bookmark.room_id AND room.workspace_id=bookmark.workspace_id
       LEFT JOIN memberships room_member ON room_member.room_id=COALESCE(room.parent_id,room.id)
         AND room_member.identity_id=$2 AND room_member.removed_at IS NULL
       LEFT JOIN messages message ON message.id=bookmark.message_id AND message.room_id=room.id
       LEFT JOIN identities author ON author.id=message.author_id
       WHERE bookmark.message_id=$1 AND bookmark.identity_id=$2`,
    [messageId, viewerId])).rows[0];
    if (!row) return null;
    return {
      messageId: row.message_id, workspaceId: row.workspace_id, roomId: row.room_id,
      roomName: row.room_name, roomKind: row.room_kind,
      messageCreatedAt: unix(row.message_created_at), bookmarkedAt: unix(row.bookmarked_at),
      available: row.available,
      ...(row.available && row.text !== null ? { text: row.text } : {}),
      ...(row.available && row.author_id && row.author_kind && row.author_name
        ? { author: identity({ id: row.author_id, kind: row.author_kind,
            name: row.author_name, handle: row.author_handle,
            avatar: row.author_avatar, face_id: row.author_face }, ctx.publicOrigin) }
        : {}),
    };
  }


  /** A Workspace's rail header after a rename or picture change, and the
   * current Workspace members who may hear it. */
  export async function phoneLiveWorkspaceChange(ctx: PhoneContext, workspaceId: string): Promise<{
    workspace: { id: string; name: string; avatar?: string };
    viewers: ReadonlySet<string>;
  } | null> {
    const rows = (await ctx.database.query<{
      id: string; name: string; avatar: string | null; viewer: string | null;
    }>(`SELECT workspace.id,workspace.name,workspace.avatar,member.identity_id viewer
        FROM workspaces workspace
        LEFT JOIN memberships member ON member.workspace_id=workspace.id
          AND member.room_id IS NULL AND member.removed_at IS NULL
        WHERE workspace.id=$1`, [workspaceId])).rows;
    const row = rows[0];
    if (!row) return null;
    return {
      workspace: {
        id: row.id, name: row.name,
        ...(row.avatar ? { avatar: assetUrl(row.avatar, ctx.publicOrigin) } : {}),
      },
      viewers: new Set(rows.flatMap((candidate) => candidate.viewer ? [candidate.viewer] : [])),
    };
  }


  /** A person's or agent's public identity after a change, plus the owner's
   * push level. Only the identity itself and viewers who share a Workspace
   * or a Room with it may hear it. */
  export async function phoneLivePersonChange(ctx: PhoneContext, personId: string): Promise<{
    person: RoomViewIdentity;
    pushLevel?: PushLevel;
    viewers: ReadonlySet<string>;
  } | null> {
    const row = (await ctx.database.query<IdentityRow & { push_level: string }>(
      `SELECT id,kind,name,handle,avatar,face_id,push_level FROM identities WHERE id=$1`,
      [personId],
    )).rows[0];
    if (!row) return null;
    const viewers = await ctx.database.query<{ id: string }>(
      `SELECT other.identity_id id FROM memberships mine
       JOIN memberships other ON other.workspace_id=mine.workspace_id
         AND other.room_id IS NULL AND other.removed_at IS NULL
       WHERE mine.identity_id=$1 AND mine.room_id IS NULL AND mine.removed_at IS NULL
       UNION
       SELECT other.identity_id FROM memberships mine
       JOIN memberships other ON other.room_id=mine.room_id AND other.removed_at IS NULL
       WHERE mine.identity_id=$1 AND mine.room_id IS NOT NULL AND mine.removed_at IS NULL`,
      [personId],
    );
    return {
      person: identity(row, ctx.publicOrigin),
      ...(row.kind === 'human' && isPushLevel(row.push_level) ? { pushLevel: row.push_level } : {}),
      viewers: new Set([personId, ...viewers.rows.map((viewer) => viewer.id)]),
    };
  }


  /** Current count plus only the changed Room's cells. This is a peek: the
   * 24-hour first-seen clock starts only on explicit seen commands or legacy tray reads. */
  export async function phoneLiveNeedsYou(ctx: PhoneContext, roomId: string, viewerId: string): Promise<{
    workspaceId: string; count: number; items: readonly NeedsYouItemView[];
  } | null> {
    return ctx.database.transaction(async database=>{
    await database.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const scope = (await database.query<{ workspace_id: string }>(
      `SELECT room.workspace_id FROM rooms room
       JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
         AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
         AND workspace_member.removed_at IS NULL
       JOIN memberships room_member ON room_member.room_id=room.id
         AND room_member.identity_id=$2 AND room_member.removed_at IS NULL
       WHERE room.id=$1`, [roomId, viewerId],
    )).rows[0];
    if (!scope) return null;
    const order=await readNeedsYouOrder(database, scope.workspace_id, viewerId);
    // This snapshot proves there are no cells to project. Legacy replay still
    // sends the empty delta, without repeating the expensive cell query.
    if(order.count===0)return {workspaceId:scope.workspace_id,count:0,items:[]};
    const { items } = await needsYouItems(database, scope.workspace_id, viewerId, (row) => identity(row, ctx.publicOrigin), false, [roomId]);
    const selected=new Map(items.map(item=>[item.messageId,item]));
    return { workspaceId: scope.workspace_id, count: order.count,
      items: order.order.flatMap(id=>selected.has(id)?[selected.get(id)!]:[]) };
    });
  }


  /**
   * The live draft a joining reader has already missed.
   *
   * `LiveHub` is publish-only: a socket receives what is written after it
   * subscribes, and `live_outputs` — which holds the running text — was never
   * offered to anyone who was not already listening. A top-level Room hides
   * that, because its turn writes a fresh whole-answer snapshot every few
   * hundred milliseconds and repaints a late reader almost immediately. A
   * corner turn spends minutes inside tool calls between assistant runs, so
   * the same reader sits in front of the collapsed tool group and the clock
   * with no prose at all for as long as the tools run.
   *
   * Bounded by the turn receipt on exactly the rule the phone uses to call a
   * turn active (`AGENT_TURN_FRESHNESS_MS`, 90s, kept inside itself by the
   * daemon's 30s heartbeat and by every activity row it posts): a finished or
   * abandoned turn never has its draft resurrected.
   */
  export async function phoneLiveDraftSnapshot(ctx: PhoneContext, roomId: string): Promise<LiveEvent[]> {
    const rows = await ctx.database.query<{
      agent_id: string;
      turn_id: string;
      body: { text?: unknown; latestChunk?: unknown; overlayV1?:unknown } | null;
    }>(
      `SELECT o.agent_id, o.turn_id, o.body FROM live_outputs o
       JOIN rooms r ON r.id=o.room_id AND r.parent_id IS NOT NULL
       JOIN agent_turns t ON t.room_id=o.room_id AND t.request_id=o.turn_id AND t.agent_id=o.agent_id
       WHERE o.room_id=$1 AND o.kind='draft'
         AND t.status='working' AND ${workingTurnFreshSql('t')}
       ORDER BY o.updated_at`,
      [roomId],
    );
    return rows.rows.flatMap((row) => {
      const text = typeof row.body?.text === 'string' ? row.body.text : '';
      const overlayV1=readHelperOverlayFrame(row.body?.overlayV1);
      if(row.body?.overlayV1!==undefined && (!overlayV1 || overlayV1.roomId!==roomId ||
          overlayV1.agentId!==row.agent_id || overlayV1.turnId!==row.turn_id || overlayV1.kind!=='draft'))return [];
      return text
        ? [
            {
              type: 'draft' as const,
              roomId,
              agentId: row.agent_id,
              turnId: row.turn_id,
              text,
              ...(overlayV1?{overlayV1}:{}),
              ...(typeof row.body?.latestChunk === 'string'
                ? { latestChunk: row.body.latestChunk }
                : {}),
            },
          ]
        : [];
    });
  }


  export async function phoneReadWelcomeCards(ctx: PhoneContext, viewerId: string): Promise<WelcomeCardsView> {
    const result = await ctx.database.query(`SELECT 1 FROM identities WHERE id=$1 AND kind='human'`, [viewerId]);
    if (!result.rows[0]) throw new Error('human identity required');
    // Compatibility for older clients: the welcome deck is retired for everyone.
    return { due: false };
  }


  export async function phoneCompleteWelcomeCards(ctx: PhoneContext, viewerId: string): Promise<WelcomeCardsView> {
    return phoneReadWelcomeCards(ctx, viewerId);
  }


  /** Project only the parent deck fields a child-corner status changes. */
  export async function phoneLiveChatCornerStatus(ctx: PhoneContext, 
    parentRoomId: string,
    viewerId: string,
  ): Promise<{
    cornerCount: number;
    waitingCornerCount: number;
    mineCornerCount: number;
    openCorners: ChatListCorner[];
    agentState: 'needs-you' | 'working' | null;
    attentionReason?: NonNullable<ChatListItem['attentionReason']>;
    corners: CornerListView['corners'];
    nextOpen?: string;
  } | null> {
    const loaded = await phoneLoadCorners(ctx, parentRoomId, viewerId, { deck: true });
    if (!loaded?.deck) return null;
    const { view, deck } = loaded;
    return { ...deckCornerSummary(parentRoomId, deck),
      agentState: deck.needs_you ? 'needs-you' : deck.working ? 'working' : null,
      ...(deck.needs_you ? { attentionReason: { kind: 'approval' as const,
        ...(deck.attention_actor ? { actor: deck.attention_actor } : {}) } } : {}),
      corners: view.corners,
      ...(view.nextOpen ? { nextOpen: view.nextOpen } : {}),
    };
  }


  /** Narrow, authorized projections for committed read/queue changes. */
  export async function phoneLiveReadState(ctx: PhoneContext, roomId: string, viewerId: string) {
    if (!(await phoneCanReadRooms(ctx, [roomId], viewerId)).has(roomId)) return null;
    const row = (await ctx.database.query<{
      read_cursor: NonNullable<RoomView['viewer']['readCursor']>;
    }>(`SELECT ${viewerReadCursorSql()} read_cursor FROM rooms room WHERE room.id=$1`,
      [roomId, viewerId])).rows[0];
    return row?.read_cursor ?? null;
  }


  export async function phoneLiveRoomCommands(ctx: PhoneContext, roomId: string, viewerId: string) {
    if (!(await phoneCanReadRooms(ctx, [roomId], viewerId)).has(roomId)) return null;
    const rows = await ctx.database.query<{
      agent_id: string; turn_request_id: string; created_at: Date;
    }>(`SELECT DISTINCT ON(command.agent_id)
        command.agent_id,command.turn_request_id,command.created_at
      FROM agent_commands command
      JOIN messages source ON source.id=command.source_message_id AND source.room_id=command.room_id
      JOIN identities author ON author.id=source.author_id AND author.kind='human'
      WHERE command.room_id=$1 AND command.state='pending' AND command.action='input'
        AND command.reason IN ('human_tag','direct_message')
      ORDER BY command.agent_id,command.created_at ASC,command.id ASC
      LIMIT ${ROOM_VIEW_AGENT_LIMIT}`, [roomId]);
    return phoneProjectPendingAgentCommands(ctx, rows.rows);
  }


  /** The workflow card's compact, authorized companion for a live delta. */
  export async function phoneLiveWorkflowRuns(ctx: PhoneContext, roomId: string, viewerId: string) {
    return phoneListRoomWorkflowRuns(ctx, roomId, viewerId);
  }


  export async function phoneLiveStarPrompt(ctx: PhoneContext, viewerId: string) {
    return readStarPrompt(ctx.database, viewerId, (ctx.database as CommandScopedDatabase).active ? undefined : ctx.github);
  }
