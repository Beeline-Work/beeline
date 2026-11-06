import { phoneIdentity as identity } from '../phone-identity.js';
import { projectCornerBrief } from '../corner-brief.js';
import { ROOM_VIEW_MEMBER_LIMIT } from '@beeline/api-contract/phone';
import type { RoomView } from '@beeline/api-contract/phone';
import { collapsePermissionCards } from '../permission-cards.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { PhoneContext } from './context.js';
import { phoneRoomRows, phoneCornerRoomEnrichment } from './corner-reads.js';
import { phoneProjectAgentTurns, phoneProjectPendingAgentCommands, phoneProjectRoomMessages, phoneAttachmentFacts } from './message-enrichment.js';
import { phoneProjectMembers } from './roster.js';
import { roomHeader, projectedMessage, messageOrder, decorateAttachments } from './read-projection.js';
import { phoneDecorateCornerOpenCards, phoneDecorateMessageCards } from './message-decoration.js';
import { unix, roomFilters, SLOW_ROOM_READ_MS, messageId } from './values.js';



  export async function phoneReadRoom(ctx: PhoneContext, roomId: string, viewerId: string): Promise<RoomView | null> {
    const readStartedAt = performance.now();
    const spans = new Map<string, number>();
    const measured = async <T>(operation: string, work: Promise<T>): Promise<T> => {
      const startedAt = performance.now();
      try {
        return await work;
      } finally {
        spans.set(operation, performance.now() - startedAt);
      }
    };
    const rows = await measured('data', phoneRoomRows(ctx, roomId, viewerId));
    if (!rows) return null;
    if ((rows.starter_onboarding_pending)) ctx.starterOnboarding?.open(roomId, viewerId);
    const room = rows.room;
    const corner = rows.corner;
    const parent = corner?.parent ?? undefined;
    const facts = corner?.facts ?? undefined;
    const cornerBrief = corner?.brief ? projectCornerBrief(roomId, corner.brief) : undefined;
    const briefingRows = corner?.briefing ?? [];
    const cornerLifecycle = corner
      ? {
          lifecycle: facts?.lifecycle ?? {
            lifecycle: 'unknown' as const,
            checks: 'unknown' as const,
          },
          owed: corner.owed,
        }
      : undefined;
    const latestAgentTurns = phoneProjectAgentTurns(ctx, rows.turns);
    const pendingAgentCommands = phoneProjectPendingAgentCommands(ctx, rows.pending_commands);
    const initialMessageResult = phoneProjectRoomMessages(ctx,
      rows.transcript,
      rows.activity,
      corner?.tools ?? [],
      latestAgentTurns,
      Boolean(corner),
      viewerId,
    );
    const enrichment = corner
      ? await measured(
          'enrichment',
          phoneCornerRoomEnrichment(ctx, room, rows, initialMessageResult, viewerId),
        )
      : undefined;
    if (enrichment) {
      const presenceByMember = new Map(enrichment.presence.map((item) => [item.id, item]));
      for (const member of rows.members) {
        const item = presenceByMember.get(member.id);
        member.presence_body = item?.presence_body ?? null;
        member.presence_updated_at = item?.presence_updated_at ?? null;
      }
      const tagsByMessage = new Map(enrichment.tags.map((item) => [item.id, item.tagged_ids]));
      const bookmarked = new Set(enrichment.bookmarks.map((item) => item.message_id));
      const reported = new Set(enrichment.reports.map((item) => item.trigger_message_id));
      for (const message of [
        ...rows.transcript,
        ...briefingRows,
        ...rows.activity,
        ...(corner?.tools ?? []),
      ]) {
        message.tagged_ids = tagsByMessage.get(message.id) ?? [];
        message.bookmarked = bookmarked.has(message.id);
        message.feedback_reported = reported.has(message.id);
      }
    }
    const allMembers = phoneProjectMembers(ctx, rows.members, roomId);
    const messageResult = enrichment
      ? phoneProjectRoomMessages(ctx,
          rows.transcript,
          rows.activity,
          corner?.tools ?? [],
          latestAgentTurns,
          Boolean(corner),
          viewerId,
        )
      : initialMessageResult;
    const allowAutoMerge = enrichment?.allow_auto_merge ?? rows.allow_auto_merge;
    const members = allMembers.slice(0, ROOM_VIEW_MEMBER_LIMIT);
    const briefAuthorHandle = corner?.brief?.author_handle;
    const { messages, toolRows } = messageResult;
    const plan = facts?.plan;
    const paintedRoom = roomHeader(room, ctx.publicOrigin);
    const briefing = await phoneDecorateCornerOpenCards(ctx, room.parent_id ?? roomId, collapsePermissionCards(
      briefingRows.map((row) => projectedMessage(row, ctx.publicOrigin)).sort(messageOrder),
    ));
    const [attachmentFacts, appMessages] = await Promise.all([
      (corner)
        ? Promise.resolve(
            enrichment?.attachmentFacts ?? { expired: new Set<string>(), artifacts: new Map() },
          )
        : measured('media', phoneAttachmentFacts(ctx, messages, toolRows, briefing)),
      measured('app-metadata', phoneDecorateMessageCards(ctx, roomId, messages, viewerId)),
    ]);
    const projectionStartedAt = performance.now();
    const view: RoomView = {
      room:
        room.parent_id && facts?.objective
          ? { ...paintedRoom, about: facts.objective }
          : paintedRoom,
      messages: decorateAttachments(appMessages, attachmentFacts),
      ...(!room.parent_id ? { leaveDeletesRoom: room.leave_deletes_room === true } : {}),
      ...(toolRows.length ? { toolRows: decorateAttachments(toolRows, attachmentFacts) } : {}),
      members,
      latestAgentTurns,
      pendingAgentCommands,
      viewer: {
        ...(!room.parent_id && room.read_cursor ? { readCursor: room.read_cursor } : {}),
        identity: members.find((member) => member.identity.pubkey === viewerId)?.identity ?? {
          pubkey: viewerId,
          kind: 'human',
          name: `Person ${viewerId.slice(0, 8)}`,
        },
        // The Workspace role: a Room, corner or DM role grants nothing.
        role: room.workspace_role,
        permissions: {
          send:
            room.workspace_role !== 'spectator' &&
            !room.archived_at &&
            !room.direct_participants?.includes(SYSTEM_IDENTITY_ID),
          manage: room.workspace_role === 'owner' || room.workspace_role === 'admin',
        },
        ...(room.viewer_push_muted ? { pushMuted: true } : {}),
      },
      ...(room.direct_participants?.length === 2
        ? { directMessage: { participants: room.direct_participants as [string, string] } }
        : {}),
      ...(parent ? { parent: roomHeader(parent, ctx.publicOrigin) } : {}),
      ...(room.parent_id && facts?.owner_agent_id
        ? { cornerOpenerAgentId: facts.owner_agent_id }
        : {}),
      briefing: decorateAttachments(briefing, attachmentFacts),
      ...(room.parent_id && plan ? { cornerPlan: plan } : {}),
      ...(cornerBrief
        ? {
            cornerBrief: {
              ...(briefAuthorHandle
                ? { authorHandle: briefAuthorHandle }
                : {}),
              revision: cornerBrief.revision,
              spec: cornerBrief.spec,
              ...(cornerBrief.approval
                ? {
                    approval: {
                      sourceMessageId: cornerBrief.approval.sourceMessageId,
                      text: cornerBrief.approval.text,
                      approverName: cornerBrief.approval.approverName,
                    },
                  }
                : {}),
              attachments: cornerBrief.attachments.map((file) => ({
                title: file.title,
                purpose: file.purpose,
                required: file.required,
                url: `${ctx.publicOrigin}/v1/media/${file.objectId}`,
              })),
            },
          }
        : {}),
      ...((parent ?? room).repository_key && (parent ?? room).repository_remote
        ? {
            repository: {
              key: (parent ?? room).repository_key!,
              name:
                (parent ?? room).repository_name ??
                (parent ?? room).repository_key!.split('/').at(-1) ??
                (parent ?? room).repository_key!,
              remote: (parent ?? room).repository_remote!,
              targetBranch: (parent ?? room).repository_target_branch,
              updatedAt: unix(
                (parent ?? room).repository_updated_at ?? (parent ?? room).updated_at,
              ),
              ...((parent ?? room).github_installation_id
                ? { githubInstallationId: Number((parent ?? room).github_installation_id) }
                : {}),
              githubEventsEnabled: true,
              ...(typeof allowAutoMerge === 'boolean' ? { allowAutoMerge } : {}),
            },
          }
        : {}),
      repositoryResolution: (parent ?? room).repository_resolution,
      ...(room.parent_id ? { cornerLocked: facts?.locked === true } : {}),
      ...(cornerLifecycle ? { cornerLifecycle: cornerLifecycle.lifecycle } : {}),
      ...(cornerLifecycle?.owed !== undefined ? { cornerOwed: cornerLifecycle.owed } : {}),
      watchFilters: room.archived_at ? [] : roomFilters(
        roomId,
        room.workspace_id,
        room.parent_id ? [room.parent_id] : [],
        allMembers,
      ),
    };
    spans.set('projection', performance.now() - projectionStartedAt);
    const durationMs = performance.now() - readStartedAt;
    if (durationMs >= SLOW_ROOM_READ_MS) {
      const pool = ctx.database.poolCounts?.();
      console.warn(
        '[slow-operation]',
        JSON.stringify({
          operation: 'phone.read_room',
          durationMs: Math.round(durationMs),
          spans: Object.fromEntries(
            [...spans].map(([operation, duration]) => [operation, Math.round(duration)]),
          ),
          ...(pool ? { pool: { total: pool.total, idle: pool.idle, waiting: pool.waiting } } : {}),
        }),
      );
    }

    return view;
  }


  /** Resolve only coordinates readable through current Room and Workspace membership. */
  export async function phoneResolveMessageLink(ctx: PhoneContext, messageId: string, viewerId: string) {
    const result = await ctx.database.query<{ room_id: string; workspace_id: string }>(
      `SELECT room.id room_id,room.workspace_id FROM messages message
       JOIN rooms room ON room.id=message.room_id
       JOIN memberships member ON member.room_id=COALESCE(room.parent_id,room.id)
         AND member.identity_id=$2 AND member.removed_at IS NULL
       JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
         AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
         AND workspace_member.removed_at IS NULL
       WHERE message.id=$1 AND message.deleted_at IS NULL`,
      [messageId, viewerId],
    );
    const row = result.rows[0];
    return row ? { roomId: row.room_id, messageId, workspaceId: row.workspace_id } : null;
  }
