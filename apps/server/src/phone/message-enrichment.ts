import { ROOM_VIEW_AGENT_LIMIT, ROOM_VIEW_MESSAGE_LIMIT } from '@beeline/api-contract/phone';
import type { RoomView, RoomViewMessage } from '@beeline/api-contract/phone';
import { type ArtifactAttachment } from '@beeline/api-contract/phone';
import { taggedIdentityIdsSql } from '../message-mentions.js';
import { collapsePermissionCards } from '../permission-cards.js';
import { mediaIdFromUrl } from '../media-ttl.js';
import type { PhoneContext } from './context.js';
import { AttachmentFacts, MessageRow, AgentTurnRow } from './types.js';
import { phoneOptionalEnrichment } from './optional-enrichment.js';
import { unix } from './values.js';
import { projectedMessage, messageOrder } from './read-projection.js';


  /**
   * Which media ids referenced by these messages have expired, and which name
   * ready object rows. Two queries per read, both over indexed id sets: expiry
   * is a fact the sweep wrote, and card facts live on the `objects` row.
   */
  export async function phoneAttachmentFacts(ctx: PhoneContext, 
    ...groups: readonly (readonly RoomViewMessage[])[]
  ): Promise<AttachmentFacts> {
    const ids = new Set<string>();
    for (const messages of groups)
      for (const message of messages)
        for (const attachment of message.attachments ?? []) {
          const id = mediaIdFromUrl(attachment.url);
          if (id) ids.add(id);
        }
    if (!ids.size) return { expired: new Set(), artifacts: new Map() };
    const [expired, objectRows] = await Promise.all([
      ctx.database.query<{ id: string }>(
        `SELECT id::text id FROM object_expirations WHERE id=ANY($1::uuid[])`,
        [[...ids]], 'phone-room-media-0',
      ),
      ctx.database.query<{
        id: string;
        title: string;
        mime: string;
        size: string;
        author: string;
      }>(
        `SELECT o.id::text id,COALESCE(o.title, '') title,o.mime mime,o.size::text size,
                COALESCE(i.handle, i.name) author
         FROM objects o JOIN identities i ON i.id=o.owner_id
         WHERE o.state='ready' AND o.id=ANY($1::uuid[])`,
        [[...ids]], 'phone-room-media-1',
      ),
    ]);
    return {
      expired: new Set(expired.rows.map((row) => row.id)),
      artifacts: new Map(
        objectRows.rows.map((row) => [
          row.id,
          {
            kind: 'artifact',
            title: row.title,
            mimeType: row.mime,
            size: Number(row.size),
            author: row.author,
          } satisfies ArtifactAttachment,
        ]),
      ),
    };
  }


  /** One optional history decoration query for tags, bookmark/report flags and media facts. */
  export async function phoneEnrichHistoryRows(ctx: PhoneContext, rows: MessageRow[], viewerId: string): Promise<AttachmentFacts> {
    if (!rows.length) return { expired: new Set(), artifacts: new Map() };
    const mediaIds = new Set<string>();
    for (const row of rows) for (const attachment of
      (Array.isArray(row.attachments) ? row.attachments : [])) {
      const url = (attachment as { url?: unknown } | null)?.url;
      const id = typeof url === 'string' ? mediaIdFromUrl(url) : null;
      if (id) mediaIds.add(id);
    }
    const result = await phoneOptionalEnrichment(ctx, 'history-decoration',
      ctx.enrichmentDatabase.query<{
        decorations: Array<{ id: string; tagged_ids: string[];
          bookmarked: boolean; feedback_reported: boolean }>;
        expired: string[];
        artifacts: Array<{ id: string; title: string; mime: string; size: string; author: string }>;
      }>(`SELECT
          COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,
            'tagged_ids',${taggedIdentityIdsSql('m')},
            'bookmarked',EXISTS(SELECT 1 FROM message_bookmarks bookmark
              WHERE bookmark.message_id=m.id AND bookmark.identity_id=$2),
            'feedback_reported',EXISTS(SELECT 1 FROM feedback_items feedback
              WHERE feedback.trigger_message_id=m.id AND feedback.source_kind='human')))
            FROM messages m WHERE m.id=ANY($1::text[])),'[]'::jsonb) decorations,
          COALESCE((SELECT jsonb_agg(expired.id::text) FROM object_expirations expired
            WHERE expired.id=ANY($3::uuid[])),'[]'::jsonb) expired,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('id',object.id::text,
            'title',COALESCE(object.title,''),'mime',object.mime,
            'size',object.size::text,'author',COALESCE(author.handle,author.name)))
            FROM objects object JOIN identities author ON author.id=object.owner_id
            WHERE object.state='ready' AND object.id=ANY($3::uuid[])),'[]'::jsonb) artifacts`,
        [rows.map((row) => row.id),viewerId,[...mediaIds]],
      ),
    );
    const data = result?.rows[0];
    const byId = new Map(data?.decorations.map((row) => [row.id,row]) ?? []);
    for (const row of rows) {
      const decorated = byId.get(row.id);
      row.tagged_ids = decorated?.tagged_ids ?? [];
      row.bookmarked = decorated?.bookmarked ?? false;
      row.feedback_reported = decorated?.feedback_reported ?? false;
    }
    return {
      expired: new Set(data?.expired ?? []),
      artifacts: new Map((data?.artifacts ?? []).map((row) => [row.id,{
        kind: 'artifact' as const,title: row.title,mimeType: row.mime,
        size: Number(row.size),author: row.author,
      }])),
    };
  }


  export async function phoneEnrichMessageTags(ctx: PhoneContext, rows: MessageRow[]): Promise<void> {
    if (!rows.length) return;
    const tags = await phoneOptionalEnrichment(ctx, 
      'message-tags',
      ctx.enrichmentDatabase.query<{ id: string; tagged_ids: string[] }>(
        `SELECT m.id,${taggedIdentityIdsSql('m')} tagged_ids
         FROM messages m WHERE m.id=ANY($1::text[])`,
        [rows.map((message) => message.id)],
      ),
    );
    const tagsByMessage = new Map(tags?.rows.map((item) => [item.id, item.tagged_ids]) ?? []);
    for (const message of rows) message.tagged_ids = tagsByMessage.get(message.id) ?? [];
  }

  export function phoneProjectAgentTurns(ctx: PhoneContext, turns: readonly AgentTurnRow[]): RoomView['latestAgentTurns'] {
    return turns
      .map((turn) => ({
        requestId: turn.request_id,
        agentPubkey: turn.agent_id,
        status: turn.status,
        startedAt: unix(turn.started_at),
        createdAt: unix(turn.created_at),
        ...(turn.generation_id ? { generationId: turn.generation_id } : {}),
        ...(turn.requested_by ? { requestedBy: turn.requested_by } : {}),
      }))
      .sort(
        (left, right) =>
          right.createdAt - left.createdAt || left.agentPubkey.localeCompare(right.agentPubkey),
      )
      .slice(0, ROOM_VIEW_AGENT_LIMIT);
  }

  export function phoneProjectPendingAgentCommands(ctx: PhoneContext, 
    commands: readonly { agent_id: string; turn_request_id: string; created_at: Date | string }[],
  ): NonNullable<RoomView['pendingAgentCommands']> {
    return commands
      .map((command) => ({
        requestId: command.turn_request_id,
        agentPubkey: command.agent_id,
        createdAt: unix(new Date(command.created_at)),
      }))
      .sort((left, right) => left.createdAt - right.createdAt ||
        left.agentPubkey.localeCompare(right.agentPubkey));
  }

  export async function phoneEnrichMessageBookmarks(ctx: PhoneContext, 
    rows: readonly MessageRow[],
    viewerId: string,
  ): Promise<void> {
    if (!rows.length) return;
    const result = await ctx.database.query<{ message_id: string }>(
      `SELECT message_id FROM message_bookmarks
       WHERE identity_id=$1 AND message_id=ANY($2::text[])`,
      [viewerId, [...new Set(rows.map((row) => row.id))]],
    );
    const bookmarked = new Set(result.rows.map((row) => row.message_id));
    const reports = await ctx.database.query<{ trigger_message_id: string }>(
      `SELECT trigger_message_id FROM feedback_items
       WHERE source_kind='human' AND trigger_message_id=ANY($1::text[])`,
      [[...new Set(rows.map((row) => row.id))]],
    );
    const reported = new Set(reports.rows.map((row) => row.trigger_message_id));
    for (const row of rows) {
      row.bookmarked = bookmarked.has(row.id);
      row.feedback_reported = reported.has(row.id);
    }
  }

  export function phoneProjectRoomMessages(ctx: PhoneContext, 
    transcriptRows: readonly MessageRow[],
    liveRows: readonly MessageRow[],
    cornerActivityRows: readonly MessageRow[],
    resolvedAgentTurns: RoomView['latestAgentTurns'],
    isCorner: boolean,
    viewerId?: string,
  ): { messages: RoomViewMessage[]; toolRows: RoomViewMessage[] } {
    const transcript = transcriptRows.map((row) =>
      projectedMessage(row, ctx.publicOrigin, viewerId),
    );
    const workingByAgent = new Map(
      resolvedAgentTurns
        .filter((turn) => turn.status === 'working')
        .map((turn) => [turn.agentPubkey, turn.createdAt]),
    );
    const liveActivity = liveRows
      .map((row) => projectedMessage(row, ctx.publicOrigin, viewerId))
      .filter(
        (message) =>
          message.createdAt >=
          (workingByAgent.get(message.author.pubkey) ?? Number.POSITIVE_INFINITY),
      )
      .slice(0, ROOM_VIEW_MESSAGE_LIMIT);
    // Settled corner work rows survive the turn (#804): tools and the agent's
    // own interim prose share the additive activity payload, under its own cap
    // so neither crowds out the message window. The wire field keeps its
    // historical `toolRows` name for compatibility with shipped phones. Rows go
    // oldest first because a shipped phone keeps only the last 60 it receives.
    const cornerActivityMessages = cornerActivityRows
      .map((row) => projectedMessage(row, ctx.publicOrigin, viewerId))
      .reverse();
    const byId = new Map(
      collapsePermissionCards([...transcript.reverse(), ...liveActivity.reverse()]).map(
        (message) => [message.id, message],
      ),
    );
    const merged = [...byId.values()].sort(messageOrder);
    if (!isCorner) return { messages: merged.slice(-ROOM_VIEW_MESSAGE_LIMIT), toolRows: [] };
    // Every Room response stays inside the shared phone message cap. Settled
    // corner tool rows are additive and independently bounded.
    const liveIds = new Set(liveActivity.map((message) => message.id));
    return {
      messages: merged
        .filter(
          (message) =>
            message.presentation !== 'activity' || message.durableFact || liveIds.has(message.id),
        )
        .slice(-ROOM_VIEW_MESSAGE_LIMIT),
      toolRows: cornerActivityMessages,
    };
  }
