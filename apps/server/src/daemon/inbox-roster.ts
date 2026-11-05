import { cornerOwnerSql } from '../corner-worker.js';
import { agentMemberMetadata } from '../agent-member-metadata.js';
import { subscriptionPromptBody } from '../agent-subscriptions.js';
import { commandInbox } from '../agent-command.js';
import type { DaemonAttachment, SystemEvent } from '@beeline/api-contract/daemon';
import { boundReplyExcerpt } from '@beeline/api-contract/daemon';
import { MESSAGE_CURSOR_MS_SQL } from '../database.js';
import type { DaemonContext } from './context.js';
import { Input, seconds, AccessDeniedError, id, conversationColumns, laterCursor, markExpiredAttachments } from './values.js';
import { daemonAccess, daemonReviewSourceAccess } from './access.js';
import { daemonReach } from './corner-messages.js';
import { daemonExpiredMediaIds } from './message-reads.js';



  export async function daemonBootstrap(ctx: DaemonContext, agentId: string) {
    const workspaces = await ctx.database.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM memberships WHERE identity_id=$1 AND room_id IS NULL AND removed_at IS NULL`,
      [agentId],
    );
    const rooms = await ctx.database.query<{ room_id: string; parent_id: string | null; workspace_id: string; archived: boolean; landed_head_sha: string | null; repository_revision: string }>(
      `SELECT r.id room_id, r.parent_id, r.workspace_id, r.archived_at IS NOT NULL archived,
              CASE WHEN r.archived_at IS NOT NULL AND f.lifecycle->>'outcome'='landed'
                AND f.lifecycle->'pr'->>'mergedAt' IS NOT NULL
                THEN f.lifecycle->'pr'->>'headSha' END landed_head_sha,
              concat_ws(':',r.repository_resolution,COALESCE(r.repository_key,''),
                COALESCE(r.repository_remote,''),r.repository_target_branch,
                COALESCE(r.repository_updated_at::text,''),
                COALESCE(i.status,''),COALESCE(i.updated_at::text,''),
                COALESCE(g.active::text,''),COALESCE(g.updated_at::text,'')) repository_revision
       FROM rooms r
       JOIN memberships m ON m.room_id=COALESCE(r.parent_id,r.id)
       LEFT JOIN corner_github_cache f ON f.corner_id=r.id
       LEFT JOIN github_installations i ON i.installation_id=r.github_installation_id
       LEFT JOIN github_repositories g ON r.repository_key='github:' || g.repository_id::text
       WHERE m.identity_id=$1 AND (m.removed_at IS NULL OR
         (r.parent_id IS NULL AND r.archived_at IS NOT NULL))`,
      [agentId],
    );
    const pending = await ctx.database.query<{ room_id: string; parent_id: string | null; owner_agent_id: string | null }>(
      `SELECT DISTINCT command.room_id,r.parent_id,CASE WHEN f.corner_id IS NOT NULL THEN ${cornerOwnerSql('r.id')} END owner_agent_id
       FROM agent_commands command
       JOIN rooms r ON r.id=command.room_id AND r.archived_at IS NULL
       JOIN memberships m ON m.room_id=r.id AND m.identity_id=command.agent_id AND m.removed_at IS NULL
       LEFT JOIN corner_facts f ON f.corner_id=r.id
       WHERE command.agent_id=$1 AND command.state='pending'`,
      [agentId],
    );
    return {
      workspaceIds: workspaces.rows.map((row) => row.workspace_id),
      pendingRooms: pending.rows.map(row => ({ roomId: row.room_id,
        ...(row.parent_id ? { parentRoomId: row.parent_id } : {}),
        ...(row.owner_agent_id ? { openedBy: row.owner_agent_id } : {}) })),
      storageRooms: rooms.rows.map(row => ({ roomId: row.room_id, archived: row.archived, ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
        ...(row.landed_head_sha ? { landedHeadSha: row.landed_head_sha } : {}) })),
      rooms: rooms.rows.filter(row => !row.parent_id).map((row) => ({ roomId: row.room_id, archived: row.archived,
        repositoryRevision: row.repository_revision })),
    };
  }

  export async function daemonWorkspaceRoster(ctx: DaemonContext, input: Input<'getWorkspaceRoster'>, agentId: string) {
    const access = await ctx.database.query(
      `SELECT 1 FROM memberships
       WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2 AND removed_at IS NULL`,
      [input.workspaceId, agentId],
    );
    if (!access.rowCount) throw new Error('workspace membership required');
    const rows = await ctx.database.query<{
      identity_id: string;
      kind: 'human' | 'agent';
      name: string;
      handle: string | null;
      role: 'owner' | 'admin' | 'member';
      owner_id: string | null;
      soul: {
        name?: string;
        instructions?: string;
        avatarSeed?: string;
        avatar?: string;
      } | null;
      agent_updated_at: Date | null;
    }>(
      `SELECT m.identity_id,
         i.kind,i.name,i.handle,
         m.role,a.owner_id,a.soul,a.updated_at agent_updated_at
       FROM memberships m
       JOIN identities i ON i.id=m.identity_id
       LEFT JOIN agents a ON a.agent_id=i.id
       WHERE m.workspace_id=$1 AND m.room_id IS NULL AND m.removed_at IS NULL
         AND i.hidden_from_roster=false
       ORDER BY i.kind,i.name,i.id`,
      [input.workspaceId],
    );
    return {
      members: await agentMemberMetadata(ctx.database, rows.rows.map((row) => ({
        identityId: row.identity_id,
        kind: row.kind,
        name: row.name,
        ...(row.handle ? { handle: row.handle } : {}),
        role: row.role,
        ...(row.kind === 'agent' &&
        row.soul?.name &&
        typeof row.soul.instructions === 'string' &&
        row.owner_id &&
        row.agent_updated_at
          ? {
              soul: {
                name: row.soul.name,
                instructions: row.soul.instructions,
                avatarSeed: row.soul.avatarSeed ?? row.identity_id,
                ...(row.soul.avatar ? { avatar: row.soul.avatar } : {}),
                authoredBy: row.owner_id,
                updatedAt: seconds(row.agent_updated_at),
              },
            }
          : {}),
      }))),
    };
  }

  export async function daemonInbox(ctx: DaemonContext, name: string, input: Input<'getRoomConversation'>, agentId: string) {
    const roomId =
      name === 'getCornerCloseRequests'
        ? (input as unknown as { cornerId: string }).cornerId
        : input.roomId;
    await daemonAccess(ctx, roomId, agentId).catch((error: unknown) => {
      if (error instanceof AccessDeniedError &&
          (name === 'getRoomInbox' || name === 'getCornerCloseRequests'))
        return daemonReach(ctx, roomId, agentId);
      if (error instanceof AccessDeniedError && name === 'getRoomConversation')
        return daemonReviewSourceAccess(ctx, roomId, agentId).catch((sourceError: unknown) => {
          if (sourceError instanceof AccessDeniedError) return daemonReach(ctx, roomId, agentId);
          throw sourceError;
        });
      throw error;
    });
    const closeRequested =
      name === 'getCornerCloseRequests'
        ? Boolean(
            (
              await ctx.database.query<{ closed: boolean }>(
                `SELECT archived_at IS NOT NULL closed FROM rooms WHERE id=$1`,
                [roomId],
              )
            ).rows[0]?.closed,
          )
        : undefined;
    if (name === 'getRoomInbox' || name === 'getCornerCloseRequests')
      return {
        ...(await commandInbox(ctx.database, roomId, agentId)),
        ...(closeRequested !== undefined ? { closeRequested } : {}),
      };
    const limit = Math.max(1, Math.min(input.limit ?? 100, 200));
    const after = input.after?.match(/^(\d+),([0-9a-f]{64}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/);
    if (input.after && !after) throw new Error('invalid inbox cursor; pass the returned next object unchanged as read cursor');
    const beforeInput = name === 'getRoomConversation' ? input.before : undefined;
    const before = beforeInput?.match(/^(\d+),([0-9a-f]{64}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/);
    if (beforeInput && (!before || after || input.window === 'earliest' || input.window === 'continuity'))
      throw new Error('invalid conversation before cursor; pass the returned next object unchanged as read cursor');
    // A conversation read defaults to the NEWEST page: a turn is prompted from
    // the most recent messages, and the first 200 rows of a long Room are old
    // news. Startup objective recovery is the one caller that wants the other
    // end and asks for it by name (`window: 'earliest'`) — the two needs share
    // this code path, so they are selected here rather than by reversing the
    // sort for everyone. `getRoomInbox` and any cursor walk keep the ascending
    // forward semantics untouched.
    const newestPage = name === 'getRoomConversation' && !after && input.window !== 'earliest';
    const continuityPage =
      name === 'getRoomConversation' && !after && input.window === 'continuity';
    const rows = await ctx.database.query<{
      id: string;
      author_id: string;
      created_at: Date;
      presentation: string;
      text: string;
      agent_author: boolean;
      reply_to_message_id: string | null;
      reply_to_author_id: string | null;
      reply_to_author_name: string | null;
      reply_to_excerpt: string | null;
      root_message_id: string | null;
      request_id: string | null;
      request_author_id: string | null;
      agent_hop_count: number;
      attachments: DaemonAttachment[];
      cursor_ms: string;
      now_ms: string;
      system_event: SystemEvent | null;
    }>(
      // The newest page takes exactly `limit` rows from the tail and puts them
      // back in transcript order; the forward walk keeps its `limit + 1` probe
      // for whether another page exists.
      continuityPage
        ? `SELECT * FROM (${conversationColumns}
             FROM messages WHERE room_id=$1 AND presentation='message'
             ORDER BY cursor_ms DESC,id DESC LIMIT ${limit}) continuity
           ORDER BY cursor_ms,id`
        : newestPage
          ? `SELECT * FROM (${conversationColumns}
             FROM messages WHERE room_id=$1
               ${before ? `AND (${MESSAGE_CURSOR_MS_SQL},id) < ($2::bigint,$3)` : ''}
             ORDER BY cursor_ms DESC,id DESC LIMIT ${limit}) newest
           ORDER BY cursor_ms,id`
          : `${conversationColumns}
             FROM messages WHERE room_id=$1
               ${
                 after ? `AND (${MESSAGE_CURSOR_MS_SQL},id) > ($2::bigint,$3)` : ''
               }
             ORDER BY cursor_ms,id LIMIT ${limit + 1}`,
      after
        ? [roomId, after[1], after[2]]
        : before
          ? [roomId, before[1], before[2]]
          : [roomId],
    );
    const page = newestPage ? rows.rows : rows.rows.slice(0, limit);
    const expiredMedia = await daemonExpiredMediaIds(ctx, 
      page.flatMap((row) => row.attachments ?? []),
    );
    const savedNarration =
      name === 'getRoomConversation' && input.narrationRequestId
        ? (
            await ctx.database.query<{ text: string }>(
              `SELECT item->>'text' text FROM messages message,
                      jsonb_array_elements(message.activity) item
               WHERE message.room_id=$1 AND message.author_id=$2
                 AND message.request_id=$3 AND message.presentation='activity'
                 AND item->>'kind'='output' AND item->>'text' IS NOT NULL
               ORDER BY message.created_at,message.id`,
              [roomId, agentId, input.narrationRequestId],
            )
          ).rows.map((row) => row.text)
        : undefined;
    // The cursor advances only onto rows the clock has reached. A not-yet-settled
    // line is still DELIVERED (it mentions nobody whose daemon it could
    // double-wake) and simply re-delivers on the next poll, at most until its
    // stamp arrives — ≤1s.
    const cursorRow = [...page].reverse().find((row) => row.cursor_ms <= row.now_ms);
    const cursor = laterCursor(
      cursorRow ? `${cursorRow.cursor_ms},${cursorRow.id}` : undefined,
      input.after,
    );
    return {
      items: page.map((row) => ({
        id: row.id,
        cursor: `${row.cursor_ms},${row.id}`,
        authorId: row.author_id,
        createdAt: seconds(row.created_at),
        type: row.presentation,
        body: subscriptionPromptBody(row.text, row.system_event),
        ...(row.agent_author ? { agentAuthor: true } : {}),
        ...(row.reply_to_message_id ? { replyToMessageId: row.reply_to_message_id } : {}),
        ...(row.reply_to_author_id ? { replyToAuthorId: row.reply_to_author_id } : {}),
        ...(row.reply_to_author_name ? { replyToAuthorName: row.reply_to_author_name } : {}),
        ...(row.reply_to_excerpt !== null ? { replyToExcerpt: boundReplyExcerpt(row.reply_to_excerpt) } : {}),
        ...(row.root_message_id ? { rootMessageId: row.root_message_id } : {}),
        ...(row.request_id ? { requestId: row.request_id } : {}),
        ...(row.request_author_id ? { requestAuthorId: row.request_author_id } : {}),
        ...(row.agent_hop_count ? { agentHopCount: row.agent_hop_count } : {}),
        attachments: markExpiredAttachments(row.attachments ?? [], expiredMedia),
        ...(row.system_event ? { systemEvent: row.system_event } : {}),
      })),
      ...(cursor ? { cursor } : {}),
      ...(savedNarration ? { savedNarration } : {}),
      ...(closeRequested !== undefined ? { closeRequested } : {}),
    };
  }
